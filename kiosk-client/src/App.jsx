import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { motion, AnimatePresence } from 'framer-motion';
import Swal from 'sweetalert2';
import io from 'socket.io-client';
import { supabase } from './supabaseClient';
import { 
  FaUserPlus, FaDesktop, FaFingerprint, FaCog,
  FaArrowLeft, FaCamera, FaCheckCircle, FaPowerOff, FaWifi, FaVideoSlash, FaSignOutAlt, FaIdCard
} from 'react-icons/fa';
import './styles.css';

// Connect to Local Kiosk Server (RFID)
const socket = io('http://localhost:4000');

// Generate Port Options
const generatePorts = () => {
  const ports = [];
  for (let i = 1; i <= 10; i++) ports.push(`COM${i}`);
  ports.push('/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyACM1');
  return ports;
};

function App() {
  const [view, setView] = useState('menu'); 
  // views: menu, login, register_scan, idle, attendance, settings

  const [deviceKey, setDeviceKey] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  const [deviceName, setDeviceName] = useState(null); // NEW: Store Device Name
  
  const [students, setStudents] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [loadingText, setLoadingText] = useState('');

  // Settings State
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [selectedPort, setSelectedPort] = useState('COM6');
  const [portStatus, setPortStatus] = useState('unknown');

  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const idleTimeoutRef = useRef(null);

  // --- 1. INITIAL SETUP ---
  useEffect(() => {
    const init = async () => {
      setLoadingText('Loading AI Models...');
      await loadModels();
      setLoadingText('');
      
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

  // --- 2. DATA LOADING ---
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
      Swal.fire('Error', 'Failed to load AI models.', 'error');
    }
  };

  const syncDataAndTrain = async () => {
    setLoadingText('Syncing Database...');
    try {
      const { data: std } = await supabase.from('students').select('*');
      const { data: sch } = await supabase.from('schedules').select('*');
      
      if (std) setStudents(std);
      if (sch) setSchedules(sch);

      // Only train if camera is enabled and we have students with images
      if (cameraEnabled && std && std.length > 0) {
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
      Swal.fire("Sync Error", "Could not download data.", "error");
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
    const { value: formValues } = await Swal.fire({
      title: 'Admin Authorization',
      html: `
        <input id="swal-input1" class="swal2-input" placeholder="Admin Username">
        <input id="swal-input2" class="swal2-input" placeholder="Admin Password" type="password">
      `,
      focusConfirm: false,
      showCancelButton: true,
      confirmButtonText: 'Close App',
      confirmButtonColor: '#d33',
      preConfirm: () => [
        document.getElementById('swal-input1').value,
        document.getElementById('swal-input2').value
      ]
    });

    if (formValues) {
      const [username, password] = formValues;
      setLoadingText('Verifying...');
      try {
        const response = await fetch('http://localhost:5000/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        
        setLoadingText('');
        if (response.ok) {
           if(deviceId) await supabase.from('devices').update({ status: 'offline' }).eq('id', deviceId);
           window.close();
           Swal.fire({ icon: 'success', title: 'Application Ended', text: 'You can close this window.' });
        } else {
           Swal.fire('Access Denied', 'Invalid Admin Credentials', 'error');
        }
      } catch (err) {
        setLoadingText('');
        Swal.fire('Connection Error', 'Cannot reach Admin Server', 'error');
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

  // --- 5. KIOSK LOGIC ---
  const loginKiosk = async () => {
    if (!deviceKey) return Swal.fire('Error', 'Enter a key', 'error');
    
    // UPDATED: Fetch Device Name and Camera Config
    const { data, error } = await supabase
      .from('devices')
      .select('id, device_name, camera_enabled') 
      .eq('connection_key', deviceKey)
      .single();

    if (error || !data) {
      Swal.fire('Access Denied', 'Invalid Key', 'error');
    } else {
      setDeviceId(data.id);
      setDeviceName(data.device_name); // Set Name
      setCameraEnabled(data.camera_enabled ?? true); // Set Camera/Face Rec status
      
      await supabase.from('devices').update({ status: 'online' }).eq('id', data.id);
      await syncDataAndTrain();
      setView('idle');
    }
  };

  const handleKioskExit = async () => {
    const { value: key } = await Swal.fire({
      title: 'Exit Kiosk Mode?',
      text: 'Enter Connection Key to disconnect',
      input: 'password',
      inputPlaceholder: 'Connection Key',
      showCancelButton: true,
      confirmButtonText: 'Exit & Offline',
      confirmButtonColor: '#d33',
      background: '#1B1B1B',
      color: '#FFE7D0'
    });

    if (key) {
      setLoadingText('Disconnecting...');
      const { data } = await supabase.from('devices').select('id').eq('connection_key', key).eq('id', deviceId).maybeSingle();

      if (data) {
        await supabase.from('devices').update({ status: 'offline' }).eq('id', deviceId);
        setView('menu');
        setDeviceId(null);
        setDeviceName(null); // Clear Name
        setDeviceKey('');
        Swal.fire({ icon: 'success', title: 'Offline', timer: 1500, showConfirmButton: false });
      } else {
        Swal.fire('Error', 'Invalid Key', 'error');
      }
      setLoadingText('');
    }
  };

  const startAttendanceMode = async () => {
    await syncDataAndTrain();
    setView('attendance');
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => setView('idle'), 20000); 
  };

  const processAttendance = async (uid) => {
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => setView('idle'), 20000);

    const cleanUid = uid.toString().trim().toLowerCase();
    const student = students.find(s => s.rfid_uid && s.rfid_uid.toLowerCase() === cleanUid);

    if (!student) return Swal.fire({ icon: 'error', title: 'Unregistered Card', timer: 2000, showConfirmButton: false });

    const now = new Date();
    const currentTime = now.toTimeString().slice(0,5);
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'short' });
    const today = now.toISOString().split('T')[0];

    const activeClass = schedules.find(s => 
      s.kiosk_id === deviceId && s.days.includes(currentDay) && currentTime >= s.time_start && currentTime <= s.time_end
    );

    if (!activeClass) return Swal.fire({ icon: 'warning', title: 'No Class Now', timer: 2000 });
    if (!student.enrolled_subjects?.includes(activeClass.subject_code)) return Swal.fire({ icon: 'error', title: 'Not Enrolled', text: `Class: ${activeClass.subject_name}` });

    const { data: existing } = await supabase.from('attendance_logs').select('*').eq('student_id', student.student_id).eq('subject_code', activeClass.subject_code).eq('date', today);
    if (existing?.length > 0) return Swal.fire({ icon: 'info', title: 'Already Present', timer: 2000, showConfirmButton: false });

    await supabase.from('attendance_logs').insert([{
      student_id: student.student_id, student_name: student.full_name, subject_code: activeClass.subject_code, kiosk_id: deviceId, date: today, status: 'present'
    }]);

    await Swal.fire({ icon: 'success', title: 'Welcome!', html: `<strong>${student.full_name}</strong><br/>${activeClass.subject_name}`, timer: 2000, showConfirmButton: false });
    setView('idle');
  };

  const handleRegistrationScan = async (uid) => {
    const { value: studentId } = await Swal.fire({
      title: 'Card Detected',
      text: `UID: ${uid}`,
      input: 'text',
      inputPlaceholder: 'Enter Student ID to Link',
      showCancelButton: true,
      confirmButtonText: 'Link'
    });

    if (studentId) {
      setLoadingText('Linking...');
      const { data: pending } = await supabase.from('pending_registrations').select('*').eq('student_id', studentId).maybeSingle();
      if (pending) {
        await supabase.from('students').insert([{
          full_name: `${pending.given_name} ${pending.surname}`,
          student_id: pending.student_id, course: pending.course, rfid_uid: uid, face_image_url: pending.face_image_url, enrolled_subjects: pending.enrolled_subjects
        }]);
        await supabase.from('pending_registrations').delete().eq('id', pending.id);
        Swal.fire('Success', 'Student Registered', 'success');
        setView('menu');
      } else {
        Swal.fire('Error', 'Student ID not found in Pending list', 'error');
      }
      setLoadingText('');
    }
  };

  // Video Handler
  const handleVideoOnPlay = () => {
    const interval = setInterval(async () => {
      if (cameraEnabled && webcamRef.current && webcamRef.current.video.readyState === 4) {
        const video = webcamRef.current.video;
        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        faceapi.matchDimensions(canvasRef.current, displaySize);
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
        const resized = faceapi.resizeResults(detections, displaySize);
        canvasRef.current.getContext('2d').clearRect(0, 0, displaySize.width, displaySize.height);
        
        if (faceMatcher) {
          const results = resized.map(d => faceMatcher.findBestMatch(d.descriptor));
          results.forEach((res, i) => {
            const box = resized[i].detection.box;
            const match = students.find(s => s.student_id === res.label);
            new faceapi.draw.DrawBox(box, { label: match ? match.full_name : "Unknown", boxColor: match ? '#2ecc71' : '#e74c3c' }).draw(canvasRef.current);
          });
        }
      }
    }, 100);
    return () => clearInterval(interval);
  };

  return (
    <div className="container">
      <div id="app-view-state" data-view={view} style={{display:'none'}}></div>
      {loadingText && <div className="loading-overlay"><div className="spinner"></div><h2>{loadingText}</h2></div>}

      <AnimatePresence mode='wait'>
        
        {/* 1. MENU */}
        {view === 'menu' && (
          <motion.div key="menu" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="card-grid">
            <div className="menu-card" onClick={() => setView('register_scan')}>
              <FaUserPlus className="icon" /><span className="label">Register RFID</span>
            </div>
            <div className="menu-card" onClick={() => setView('login')}>
              <FaDesktop className="icon" /><span className="label">Kiosk Mode</span>
            </div>
            <div className="menu-card" onClick={() => setView('settings')}>
              <FaCog className="icon" /><span className="label">Settings</span>
            </div>
          </motion.div>
        )}

        {/* 2. SETTINGS */}
        {view === 'settings' && (
          <motion.div key="settings" initial={{x:50, opacity:0}} animate={{x:0, opacity:1}} exit={{x:-50, opacity:0}} className="settings-panel">
            <h2 className="text-2xl mb-6 font-bold text-white">Device Settings</h2>
            
            <div className="input-group">
              <label className="input-label">Serial Port</label>
              <select className="kiosk-select" value={selectedPort} onChange={handlePortChange}>
                {generatePorts().map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <p className="mt-1 text-xs" style={{color: portStatus==='connected'?'var(--success)':'var(--danger)'}}>Status: {portStatus}</p>
            </div>

            <div className="input-group toggle-row">
              <label className="input-label" style={{marginBottom:0}}>Force Camera Enable</label>
              <label className="switch">
                <input type="checkbox" checked={cameraEnabled} onChange={e => setCameraEnabled(e.target.checked)} />
                <span className="slider"></span>
              </label>
            </div>

            <div className="btn-group-vertical">
              <button className="btn btn-danger full-width" onClick={handleAppExit}><FaPowerOff/> Exit Application</button>
              <button className="btn btn-secondary full-width" onClick={() => setView('menu')}><FaArrowLeft/> Back</button>
            </div>
          </motion.div>
        )}

        {/* 3. IDLE (KIOSK MODE) */}
        {view === 'idle' && (
          <motion.div key="idle" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={startAttendanceMode} className="idle-container">
            <button onClick={(e) => { e.stopPropagation(); handleKioskExit(); }} className="exit-link">
              <FaSignOutAlt /> Exit Kiosk
            </button>
            <div className="idle-content">
              <h1>Smart<br/>Attendance</h1>
              <p>Touch screen to start</p>
              <motion.div animate={{ y: [0, 15, 0] }} transition={{ repeat: Infinity, duration: 2 }} className="fingerprint">
                <FaFingerprint />
              </motion.div>
              {/* UPDATED FOOTER INFO */}
              <div className="footer-info">
                 <span className="device-name">{deviceName || 'Unknown Device'}</span>
                 <span className="separator">|</span>
                 <span className="port-name">Port: {selectedPort}</span>
              </div>
            </div>
          </motion.div>
        )}

        {/* 4. LOGIN */}
        {view === 'login' && (
          <motion.div key="login" initial={{y:50, opacity:0}} animate={{y:0, opacity:1}} exit={{opacity:0}} className="login-container">
            <h2 className="title">Kiosk Authorization</h2>
            <input className="kiosk-input" placeholder="Device Key" value={deviceKey} type="password" onChange={e => setDeviceKey(e.target.value)} />
            <div className="btn-group">
              <button className="btn btn-secondary" onClick={() => setView('menu')}><FaArrowLeft/> Cancel</button>
              <button className="btn btn-primary" onClick={loginKiosk}><FaCheckCircle/> Connect</button>
            </div>
          </motion.div>
        )}

        {/* 5. ATTENDANCE */}
        {view === 'attendance' && (
          <motion.div key="camera" initial={{scale:0.9}} animate={{scale:1}} exit={{opacity:0}} className="camera-view">
            <div className="camera-wrapper">
              {cameraEnabled && modelsLoaded ? (
                <>
                  <Webcam audio={false} ref={webcamRef} screenshotFormat="image/jpeg" className="webcam" />
                  <canvas ref={canvasRef} className="canvas-overlay" />
                </>
              ) : (
                /* NEW PLACEHOLDER WHEN CAMERA IS DISABLED */
                <div className="camera-off">
                  <FaIdCard size={80} className="mb-4 text-orange animate-bounce" />
                  <h3 className="text-2xl font-bold text-white mb-2">Face Recognition Disabled</h3>
                  <p className="text-white/70 text-center max-w-md px-4">
                    You can log in using only RFID since the teacher or admin allowed it.
                    <br/><br/>
                    <strong>Please Tap Your Card</strong>
                  </p>
                </div>
              )}
              
              {cameraEnabled && (
                <div className="overlay-message">
                  <div className="badge"><FaCamera/> Tap RFID Card</div>
                </div>
              )}
            </div>
            <button className="btn btn-secondary mt-4" onClick={() => setView('idle')}>Cancel</button>
          </motion.div>
        )}

        {/* 6. REGISTER SCAN */}
        {view === 'register_scan' && (
          <motion.div key="register_scan" initial={{scale:0.9}} animate={{scale:1}} exit={{opacity:0}} className="scan-container">
             <FaWifi className="scan-icon animate-pulse" />
             <h2>Scan RFID</h2>
             <button className="btn btn-secondary mt-8" onClick={() => setView('menu')}>Return</button>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}

export default App;