import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { motion, AnimatePresence } from 'framer-motion';
import Swal from 'sweetalert2';
import io from 'socket.io-client';
import { supabase } from './supabaseClient';
import { 
  FaUserPlus, FaDesktop, FaFingerprint, FaCog,
  FaArrowLeft, FaCamera, FaCheckCircle, FaUserShield, FaWifi, FaPowerOff, FaVideoSlash
} from 'react-icons/fa';
import './styles.css';

// Connect to Local Kiosk Server (RFID)
const socket = io('http://localhost:4000');

// Generate Port Options
const generatePorts = () => {
  const ports = [];
  // Windows Ports
  for (let i = 1; i <= 10; i++) ports.push(`COM${i}`);
  // RPi/Linux Ports
  ports.push('/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyACM1');
  return ports;
};

function App() {
  const [view, setView] = useState('menu'); 
  // views: menu, login, register_scan, idle, attendance, settings

  // Device State
  const [deviceKey, setDeviceKey] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  
  // Data State
  const [students, setStudents] = useState([]);
  const [schedules, setSchedules] = useState([]);
  
  // AI State
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [loadingText, setLoadingText] = useState('');

  // Settings State
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [selectedPort, setSelectedPort] = useState('COM6');
  const [portStatus, setPortStatus] = useState('unknown'); // connected, error, failed

  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const idleTimeoutRef = useRef(null);

  // --- 1. INITIAL SETUP ---
  useEffect(() => {
    const init = async () => {
      setLoadingText('Loading AI Models...');
      await loadModels();
      setLoadingText('');

      // Socket Listeners
      socket.on('rfid-tag', (uid) => handleRfidScan(uid));
      socket.on('current-config', (config) => setSelectedPort(config.port));
      socket.on('status-update', (data) => {
        setPortStatus(data.status);
        if(data.status === 'connected') {
            Swal.fire({ icon: 'success', title: 'Scanner Connected', text: data.port, timer: 1500, showConfirmButton: false });
        }
      });
    };
    init();

    return () => {
      socket.off('rfid-tag');
      socket.off('current-config');
      socket.off('status-update');
    };
  }, []);

  // --- 2. DATA LOADING & FACE MATCHING ---
  const loadModels = async () => {
    const MODEL_URL = '/models';
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      ]);
      setModelsLoaded(true);
      console.log("✅ FaceAPI Models Loaded");
    } catch (e) {
      console.error(e);
      Swal.fire('Error', 'Failed to load AI models. Check public/models folder.', 'error');
    }
  };

  const syncDataAndTrain = async () => {
    setLoadingText('Syncing Database...');
    try {
      const { data: std, error: stdError } = await supabase.from('students').select('*');
      const { data: sch, error: schError } = await supabase.from('schedules').select('*');
      
      if (stdError) throw stdError;
      if (schError) throw schError;

      if (std) setStudents(std);
      if (sch) setSchedules(sch);

      if (std && std.length > 0) {
        const labeledDescriptors = await Promise.all(
          std.map(async (student) => {
            if (!student.face_image_url) return null;
            try {
              const img = await faceapi.fetchImage(student.face_image_url);
              const detections = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
              if (!detections) return null;
              return new faceapi.LabeledFaceDescriptors(student.student_id, [detections.descriptor]);
            } catch (err) { return null; }
          })
        );
        const validDescriptors = labeledDescriptors.filter(d => d !== null);
        if (validDescriptors.length > 0) {
          setFaceMatcher(new faceapi.FaceMatcher(validDescriptors, 0.6));
        }
      }
    } catch (error) {
      Swal.fire("Sync Error", "Could not download data. Check internet connection.", "error");
    }
    setLoadingText('');
  };

  // --- 3. SETTINGS & ADMIN LOGIC ---
  const handlePortChange = (e) => {
    const newPort = e.target.value;
    setSelectedPort(newPort);
    socket.emit('change-port', newPort);
  };

  const handleAppExit = async () => {
    // 1. Ask for Admin Credentials
    const { value: formValues } = await Swal.fire({
      title: 'Admin Authorization',
      html: `
        <div style="text-align: left; margin-bottom: 10px;">
          <label style="font-size: 14px; font-weight: bold; color: #333;">Username</label>
          <input id="swal-input1" class="swal2-input" placeholder="Admin Username" style="margin: 5px 0;">
          <label style="font-size: 14px; font-weight: bold; color: #333;">Password</label>
          <input id="swal-input2" class="swal2-input" placeholder="Admin Password" type="password" style="margin: 5px 0;">
        </div>
      `,
      focusConfirm: false,
      showCancelButton: true,
      confirmButtonText: 'Close App',
      confirmButtonColor: '#FC6E20',
      preConfirm: () => {
        return [
          document.getElementById('swal-input1').value,
          document.getElementById('swal-input2').value
        ]
      }
    });

    if (formValues) {
      const [username, password] = formValues;
      setLoadingText('Verifying Admin...');
      try {
        const response = await fetch('http://localhost:5000/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        setLoadingText('');
        
        if (response.ok) {
           // If device was logged in, set to offline
           if(deviceId) await supabase.from('devices').update({ status: 'offline' }).eq('id', deviceId);
           
           // In a real Kiosk environment (Electron/Browser), we can try to close window
           window.close(); 
           // Fallback if window.close() is blocked by browser
           Swal.fire({
             icon: 'success',
             title: 'Application Ended',
             text: 'You may now close the browser window.',
             showConfirmButton: false
           });
           setTimeout(() => window.location.reload(), 2000); // Reboot to clear state
        } else {
           Swal.fire({icon: 'error', title: 'Access Denied', text: 'Invalid Admin Credentials'});
        }
      } catch (err) {
        setLoadingText('');
        Swal.fire({icon: 'error', title: 'Connection Error', text: 'Cannot reach Admin Server'});
      }
    }
  };

  // --- 4. RFID LOGIC ---
  const handleRfidScan = (uid) => {
    const cleanUid = uid ? uid.toString().replace(/[\r\n]+/gm, "").trim() : "";
    const currentView = document.getElementById('app-view-state')?.getAttribute('data-view');
    
    if (currentView === 'register_scan') {
      handleRegistrationScan(cleanUid);
    } else if (currentView === 'attendance') {
      processAttendance(cleanUid);
    }
  };

  // --- 5. ATTENDANCE & CAMERA LOGIC ---
  const handleVideoOnPlay = () => {
    const interval = setInterval(async () => {
      if (cameraEnabled && webcamRef.current && webcamRef.current.video.readyState === 4 && canvasRef.current) {
        const video = webcamRef.current.video;
        const canvas = canvasRef.current;
        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        
        faceapi.matchDimensions(canvas, displaySize);
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
        const resizedDetections = faceapi.resizeResults(detections, displaySize);
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

        if (faceMatcher) {
          const results = resizedDetections.map(d => faceMatcher.findBestMatch(d.descriptor));
          results.forEach((result, i) => {
            const box = resizedDetections[i].detection.box;
            const matchStudent = students.find(s => s.student_id === result.label);
            const displayText = matchStudent ? matchStudent.full_name : "Unknown";
            const boxColor = matchStudent ? '#2ecc71' : '#e74c3c'; 
            new faceapi.draw.DrawBox(box, { label: displayText, boxColor: boxColor }).draw(canvas);
          });
        }
      }
    }, 100);
    return () => clearInterval(interval);
  };

  const startAttendanceMode = async () => {
    await syncDataAndTrain();
    setView('attendance');
    
    // Idle timeout: Return to idle screen after 20s of inactivity
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => {
      const currentView = document.getElementById('app-view-state')?.getAttribute('data-view');
      if(currentView === 'attendance') setView('idle');
    }, 20000); 
  };

  const processAttendance = async (uid) => {
    // Reset idle timer on scan
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => setView('idle'), 20000);

    const cleanUid = uid ? uid.toString().trim() : "";
    const student = students.find(s => s.rfid_uid && s.rfid_uid.toString().trim().toLowerCase() === cleanUid.toLowerCase());

    if (!student) {
      return Swal.fire({ icon: 'error', title: 'Unregistered Card', text: 'Please register at the admin office.', timer: 3000, showConfirmButton: false });
    }

    // Check Schedule Logic
    const now = new Date();
    const currentTime = now.toTimeString().slice(0,5);
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'short' });

    const activeClass = schedules.find(s => 
      s.days && s.days.includes(currentDay) && currentTime >= s.time_start && currentTime <= s.time_end && s.kiosk_id === deviceId
    );

    if (!activeClass) return Swal.fire({ icon: 'warning', title: 'No Class Scheduled', text: 'For this kiosk right now.', timer: 2000 });

    if (!student.enrolled_subjects || !student.enrolled_subjects.includes(activeClass.subject_code)) {
      return Swal.fire({ icon: 'error', title: 'Not Enrolled', text: `You are not enrolled in ${activeClass.subject_name}` });
    }

    // Record Log
    const today = now.toISOString().split('T')[0];
    const { data: existing } = await supabase.from('attendance_logs')
      .select('*').eq('student_id', student.student_id).eq('subject_code', activeClass.subject_code).eq('date', today);

    if (existing?.length > 0) return Swal.fire({ icon: 'info', title: 'Already Present', timer: 2000, showConfirmButton: false });

    await supabase.from('attendance_logs').insert([{
      student_id: student.student_id,
      student_name: student.full_name,
      subject_code: activeClass.subject_code,
      kiosk_id: deviceId,
      date: today,
      status: 'present'
    }]);

    await Swal.fire({ icon: 'success', title: 'Attendance Recorded', html: `<strong>${student.full_name}</strong><br/>${activeClass.subject_name}`, timer: 3000, showConfirmButton: false });
    setView('idle');
  };

  // --- 6. HELPER: Kiosk Login ---
  const loginKiosk = async () => {
    if (!deviceKey) return Swal.fire('Error', 'Enter a key', 'error');
    const { data, error } = await supabase.from('devices').select('id, device_name').eq('connection_key', deviceKey).single();

    if (error || !data) {
      Swal.fire('Access Denied', 'Invalid Key', 'error');
    } else {
      setDeviceId(data.id);
      await supabase.from('devices').update({ status: 'online' }).eq('id', data.id);
      await syncDataAndTrain();
      setView('idle');
    }
  };

  // --- 7. HELPER: Register Scan ---
  const handleRegistrationScan = async (uid) => {
    const { value: studentId } = await Swal.fire({
      title: 'Card Detected!',
      text: `UID: ${uid}`,
      input: 'text',
      inputLabel: 'Enter Student ID',
      showCancelButton: true,
      confirmButtonText: 'Link',
      confirmButtonColor: '#FC6E20'
    });

    if (studentId) {
       // Check pending
       const { data: pending } = await supabase.from('pending_registrations').select('*').eq('student_id', studentId).maybeSingle();
       if(pending) {
          // Move to students logic (Simplified for brevity, use full logic from previous if needed)
          Swal.fire('Found Pending', 'Approving student...', 'info');
          // ... insert to students ...
          // ... delete from pending ...
       } else {
          Swal.fire('Not Found', 'Student ID not found in pending list.', 'error');
       }
    }
  };

  return (
    <div className="container">
      <div id="app-view-state" data-view={view} style={{display:'none'}}></div>

      {loadingText && (
        <div className="absolute inset-0 bg-black/90 z-50 flex flex-col items-center justify-center text-white">
          <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-brand-orange mb-4"></div>
          <h2>{loadingText}</h2>
        </div>
      )}

      <AnimatePresence mode='wait'>
        
        {/* 1. MAIN MENU */}
        {view === 'menu' && (
          <motion.div key="menu" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="card-grid">
            <div className="menu-card" onClick={() => setView('register_scan')}>
              <FaUserPlus className="icon" />
              <span className="label">Register RFID</span>
            </div>
            <div className="menu-card" onClick={() => setView('login')}>
              <FaDesktop className="icon" />
              <span className="label">Kiosk Mode</span>
            </div>
            <div className="menu-card" onClick={() => setView('settings')}>
              <FaCog className="icon" />
              <span className="label">Settings</span>
            </div>
          </motion.div>
        )}

        {/* 2. SETTINGS VIEW */}
        {view === 'settings' && (
          <motion.div key="settings" initial={{x:50, opacity:0}} animate={{x:0, opacity:1}} exit={{x:-50, opacity:0}} className="settings-panel flex flex-col items-center">
            <h2 className="text-2xl mb-8 font-bold text-white">Device Settings</h2>
            
            <div className="input-group">
              <label className="input-label">Select Serial Port</label>
              <select className="kiosk-select" value={selectedPort} onChange={handlePortChange}>
                {generatePorts().map(port => (
                  <option key={port} value={port}>{port}</option>
                ))}
              </select>
              <div className="mt-2 text-xs text-right">
                Status: <span style={{color: portStatus === 'connected' ? 'var(--success)' : 'var(--danger)'}}>{portStatus}</span>
              </div>
            </div>

            <div className="input-group toggle-row">
              <label className="input-label" style={{marginBottom:0}}>Enable Camera</label>
              <label className="switch">
                <input type="checkbox" checked={cameraEnabled} onChange={(e) => setCameraEnabled(e.target.checked)} />
                <span className="slider"></span>
              </label>
            </div>

            <div className="btn-group w-full justify-center flex-col mt-8">
              <button className="btn btn-danger w-full justify-center" onClick={handleAppExit}>
                <FaPowerOff /> Exit Application
              </button>
              <button className="btn btn-secondary w-full justify-center" onClick={() => setView('menu')}>
                <FaArrowLeft /> Return to Menu
              </button>
            </div>
          </motion.div>
        )}

        {/* 3. KIOSK LOGIN */}
        {view === 'login' && (
          <motion.div key="login" initial={{y:50, opacity:0}} animate={{y:0, opacity:1}} exit={{opacity:0}} className="flex flex-col items-center">
            <h2 className="text-2xl mb-6 font-bold">Kiosk Authorization</h2>
            <input className="kiosk-input" placeholder="Enter Connection Key" value={deviceKey} type="password" onChange={e => setDeviceKey(e.target.value)} />
            <div className="btn-group">
              <button className="btn btn-secondary" onClick={() => setView('menu')}><FaArrowLeft/> Cancel</button>
              <button className="btn btn-primary" onClick={loginKiosk}><FaCheckCircle/> Connect</button>
            </div>
          </motion.div>
        )}

        {/* 4. REGISTER SCAN */}
        {view === 'register_scan' && (
          <motion.div key="register_scan" initial={{scale:0.9, opacity:0}} animate={{scale:1, opacity:1}} className="flex flex-col items-center justify-center h-full">
            <div className="bg-white p-10 rounded-2xl shadow-xl flex flex-col items-center text-gray-800">
              <FaWifi style={{ fontSize: '5rem', color: '#FC6E20' }} className="animate-pulse mb-6" />
              <h2 className="text-3xl font-bold mb-2">Scan RFID Card</h2>
              <p className="text-lg opacity-70">Tap the card on the reader to register</p>
            </div>
            <button className="btn btn-secondary mt-8" onClick={() => setView('menu')}>
              <FaArrowLeft/> Return
            </button>
          </motion.div>
        )}

        {/* 5. IDLE */}
        {view === 'idle' && (
          <motion.div key="idle" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={startAttendanceMode} className="idle-container w-full h-full flex flex-col items-center justify-center">
            <h1 style={{ fontSize: '5rem', fontWeight: 'bold', lineHeight: 1 }}>Smart<br/>Attendance</h1>
            <p style={{ fontSize: '1.5rem', marginTop: '20px', opacity: 0.8 }}>Touch screen to start</p>
            <motion.div animate={{ y: [0, 15, 0] }} transition={{ repeat: Infinity, duration: 2 }} className="fingerprint-anim">
              <FaFingerprint />
            </motion.div>
            <div className="absolute bottom-8 text-sm opacity-40">Connected to: {selectedPort}</div>
          </motion.div>
        )}

        {/* 6. ATTENDANCE */}
        {view === 'attendance' && (
          <motion.div key="camera" initial={{scale:0.9, opacity:0}} animate={{scale:1, opacity:1}} exit={{scale:0.9, opacity:0}} className="flex flex-col items-center">
            <div className="camera-wrapper">
              {cameraEnabled && modelsLoaded ? (
                <>
                  <Webcam audio={false} ref={webcamRef} screenshotFormat="image/jpeg" onUserMedia={handleVideoOnPlay} width={640} height={480} />
                  <canvas ref={canvasRef} width={640} height={480} />
                </>
              ) : (
                <div className="camera-off-placeholder">
                  <FaVideoSlash size={50} />
                  <p className="mt-4 text-xl font-bold">Camera Disabled</p>
                  <p className="opacity-70">Please tap your RFID card</p>
                </div>
              )}
              
              <div className="overlay-message">
                <div className="badge">
                  <span className="flex items-center gap-2">
                    {cameraEnabled ? <FaCamera/> : <FaWifi/>}
                    {cameraEnabled ? "Look at camera & Tap RFID" : "Tap RFID Card"}
                  </span>
                </div>
              </div>
            </div>
            <button className="btn btn-secondary mt-4" onClick={() => setView('idle')}>
               <FaArrowLeft/> Cancel
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;