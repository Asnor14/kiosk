import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { motion, AnimatePresence } from 'framer-motion';
import Swal from 'sweetalert2';
import io from 'socket.io-client';
import { supabase } from './supabaseClient';
import { 
  FaUserPlus, FaDesktop, FaSignOutAlt, FaFingerprint, 
  FaArrowLeft, FaCamera, FaIdCard, FaCheckCircle, FaUserShield 
} from 'react-icons/fa';
import './styles.css';

// Connect to Local Kiosk Server (RFID)
const socket = io('http://localhost:4000');

function App() {
  const [view, setView] = useState('menu'); 
  // views: menu, login, register_face, register_scan, idle, attendance
  
  const [deviceKey, setDeviceKey] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  
  const [students, setStudents] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [loadingText, setLoadingText] = useState('');
  
  const [tempRegStudent, setTempRegStudent] = useState(null);

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
    };
    init();

    return () => socket.off('rfid-tag');
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
      Swal.fire('Error', 'Failed to load AI models. Check public/models folder.', 'error');
    }
  };

  const syncDataAndTrain = async () => {
    setLoadingText('Syncing Database & Training Faces...');
    
    const { data: std } = await supabase.from('students').select('*');
    const { data: sch } = await supabase.from('schedules').select('*');
    
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
          } catch (err) {
            return null;
          }
        })
      );

      const validDescriptors = labeledDescriptors.filter(d => d !== null);
      if (validDescriptors.length > 0) {
        setFaceMatcher(new faceapi.FaceMatcher(validDescriptors, 0.6));
      }
    }
    setLoadingText('');
  };

  // --- 3. RFID LOGIC ROUTER ---
  const handleRfidScan = (uid) => {
    const currentView = document.getElementById('app-view-state')?.getAttribute('data-view');

    if (currentView === 'register_scan') {
      completeRegistration(uid);
    } else if (currentView === 'attendance') {
      processAttendance(uid);
    }
  };

  // --- 4. REAL-TIME FACE DETECTION LOOP ---
  const handleVideoOnPlay = () => {
    const interval = setInterval(async () => {
      if (webcamRef.current && webcamRef.current.video.readyState === 4 && canvasRef.current) {
        
        const video = webcamRef.current.video;
        const canvas = canvasRef.current;
        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        
        faceapi.matchDimensions(canvas, displaySize);

        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
          .withFaceLandmarks()
          .withFaceDescriptors();

        const resizedDetections = faceapi.resizeResults(detections, displaySize);
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

        if (faceMatcher) {
          const results = resizedDetections.map(d => faceMatcher.findBestMatch(d.descriptor));
          
          results.forEach((result, i) => {
            const box = resizedDetections[i].detection.box;
            const { label } = result;
            const matchStudent = students.find(s => s.student_id === label);
            const displayText = matchStudent ? matchStudent.full_name : "Unknown";
            const boxColor = matchStudent ? '#2ecc71' : '#e74c3c'; 

            const drawBox = new faceapi.draw.DrawBox(box, { label: displayText, boxColor: boxColor });
            drawBox.draw(canvas);
          });
        }
      }
    }, 100);
    return () => clearInterval(interval);
  };

  // --- 5. FLOW FUNCTIONS ---

  const startRegister = async () => {
    setLoadingText('Preparing Registration...');
    await syncDataAndTrain();
    setLoadingText('');
    setView('register_face');
  };

  const loginKiosk = async () => {
    if (!deviceKey) return Swal.fire('Error', 'Enter a key', 'error');
    
    const { data, error } = await supabase
      .from('devices')
      .select('id, device_name')
      .eq('connection_key', deviceKey)
      .single();

    if (error || !data) {
      Swal.fire('Access Denied', 'Invalid Key', 'error');
    } else {
      setDeviceId(data.id);
      await supabase.from('devices').update({ status: 'online' }).eq('id', data.id);
      await syncDataAndTrain();
      setView('idle');
    }
  };

  // --- NEW: ADMIN EXIT FUNCTION ---
  const handleAdminExit = async () => {
    const { value: formValues } = await Swal.fire({
      title: 'Admin Exit',
      html: `
        <div style="text-align: left; color: #333;">
          <label style="font-size: 12px; font-weight: bold;">Admin Username</label>
          <input id="swal-input1" class="swal2-input" placeholder="Username" style="margin-top: 5px;">
          <label style="font-size: 12px; font-weight: bold;">Admin Password</label>
          <input id="swal-input2" class="swal2-input" placeholder="Password" type="password" style="margin-top: 5px;">
        </div>
      `,
      background: '#F5EBFA',
      color: '#49225B',
      confirmButtonColor: '#FF6600',
      confirmButtonText: 'Exit Kiosk',
      focusConfirm: false,
      showCancelButton: true,
      preConfirm: () => {
        return [
          document.getElementById('swal-input1').value,
          document.getElementById('swal-input2').value
        ]
      }
    });

    if (formValues) {
      const [username, password] = formValues;
      
      try {
        // Call your existing Admin System Backend (Running on Port 5000)
        const response = await fetch('http://localhost:5000/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        if (response.ok) {
           if(deviceId) await supabase.from('devices').update({ status: 'offline' }).eq('id', deviceId);
           setView('menu');
           Swal.fire({icon: 'success', title: 'Kiosk Closed', timer: 1500, showConfirmButton: false});
        } else {
           Swal.fire({icon: 'error', title: 'Authentication Failed', text: 'Invalid Admin Credentials'});
        }
      } catch (err) {
        console.error(err);
        Swal.fire({icon: 'error', title: 'Server Error', text: 'Cannot reach Admin Server (Port 5000)'});
      }
    }
  };

  const startAttendanceMode = () => {
    setView('attendance');
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => {
      const currentView = document.getElementById('app-view-state')?.getAttribute('data-view');
      if(currentView === 'attendance') setView('idle');
    }, 20000); 
  };

  const processAttendance = async (uid) => {
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => setView('idle'), 20000);

    const student = students.find(s => s.rfid_uid === uid);
    if (!student) return Swal.fire({ icon: 'error', title: 'Unregistered Card', timer: 1500, showConfirmButton: false });

    const now = new Date();
    const currentTime = now.toTimeString().slice(0,5);
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'short' });

    const activeClass = schedules.find(s => 
      s.days.includes(currentDay) && currentTime >= s.time_start && currentTime <= s.time_end
    );

    if (!activeClass) return Swal.fire({ icon: 'warning', title: 'No Class Scheduled', timer: 2000 });

    const today = now.toISOString().split('T')[0];
    const { data: logs } = await supabase.from('attendance_logs')
      .select('*').eq('student_id', student.student_id).eq('subject_code', activeClass.subject_code).eq('date', today);

    if (logs?.length > 0) return Swal.fire({ icon: 'info', title: 'Already Present', timer: 2000, showConfirmButton: false });

    await supabase.from('attendance_logs').insert([{
      student_id: student.student_id,
      student_name: student.full_name,
      subject_code: activeClass.subject_code,
      kiosk_id: deviceId,
      date: today,
      status: 'present'
    }]);

    await Swal.fire({
      icon: 'success',
      title: 'Attendance Recorded',
      html: `<div style="text-align: left;"><strong>${student.full_name}</strong><br/>${activeClass.subject_name}<br/><span style="color:green">PRESENT</span></div>`,
      timer: 3000,
      showConfirmButton: false
    });
    setView('idle');
  };

  const completeRegistration = async (uid) => {
    if (!tempRegStudent) return;
    const { error } = await supabase.from('students').update({ rfid_uid: uid }).eq('id', tempRegStudent.id);
    if(!error) {
      Swal.fire('Linked!', 'RFID Card assigned successfully.', 'success');
      setTempRegStudent(null);
      setView('menu');
    }
  };

  return (
    <div className="container">
      <div id="app-view-state" data-view={view} style={{display:'none'}}></div>

      {loadingText && (
        <div className="absolute inset-0 bg-black/80 z-50 flex flex-col items-center justify-center text-white">
          <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-orange-500 mb-4"></div>
          <h2>{loadingText}</h2>
        </div>
      )}

      <AnimatePresence mode='wait'>
        
        {/* 1. MAIN MENU */}
        {view === 'menu' && (
          <motion.div key="menu" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="card-grid">
            <div className="menu-card" onClick={startRegister}>
              <FaUserPlus className="icon" />
              <span className="label">Register RFID</span>
            </div>
            <div className="menu-card" onClick={() => setView('login')}>
              <FaDesktop className="icon" />
              <span className="label">Kiosk Mode</span>
            </div>
          </motion.div>
        )}

        {/* 2. KIOSK LOGIN */}
        {view === 'login' && (
          <motion.div key="login" initial={{y:50, opacity:0}} animate={{y:0, opacity:1}} exit={{opacity:0}} className="flex flex-col items-center">
            <h2 className="text-2xl mb-6 font-bold">Kiosk Authorization</h2>
            <input className="kiosk-input" placeholder="Enter Connection Key" value={deviceKey} type="password" onChange={e => setDeviceKey(e.target.value)} />
            <div className="btn-group">
              <button className="btn btn-danger" onClick={() => setView('menu')}><FaArrowLeft/> Cancel</button>
              <button className="btn btn-primary" onClick={loginKiosk}><FaCheckCircle/> Connect</button>
            </div>
          </motion.div>
        )}

        {/* 3. IDLE MODE (AFK) */}
        {view === 'idle' && (
          <motion.div key="idle" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={startAttendanceMode} className="idle-container relative w-full h-full flex flex-col items-center justify-center">
            
            {/* NEW: ADMIN EXIT BUTTON (Top Right) */}
            <button 
              onClick={(e) => { e.stopPropagation(); handleAdminExit(); }}
              className="absolute top-8 right-8 flex items-center gap-2 bg-white/10 hover:bg-red-500/80 text-white px-4 py-2 rounded-full backdrop-blur-sm transition-colors z-50"
            >
              <FaUserShield /> <span>Admin Exit</span>
            </button>

            <h1 style={{ fontSize: '5rem', fontWeight: 'bold', lineHeight: 1 }}>Smart<br/>Attendance</h1>
            <p style={{ fontSize: '1.5rem', marginTop: '20px', opacity: 0.8 }}>Touch screen to start</p>
            <motion.div animate={{ y: [0, 15, 0] }} transition={{ repeat: Infinity, duration: 2 }} style={{ fontSize: '4rem', marginTop: '40px', color: 'var(--accent)' }}>
              <FaFingerprint />
            </motion.div>
          </motion.div>
        )}

        {/* 4. CAMERA VIEW */}
        {(view === 'attendance' || view === 'register_face') && (
          <motion.div key="camera" initial={{scale:0.9, opacity:0}} animate={{scale:1, opacity:1}} exit={{scale:0.9, opacity:0}} className="flex flex-col items-center">
            <div className="camera-wrapper">
              {modelsLoaded && (
                <>
                  <Webcam audio={false} ref={webcamRef} screenshotFormat="image/jpeg" onUserMedia={handleVideoOnPlay} width={640} height={480} />
                  <canvas ref={canvasRef} width={640} height={480} />
                </>
              )}
              <div className="overlay-message">
                <div className="badge">
                  {view === 'attendance' ? <span className="flex items-center gap-2"><FaCamera/> Look at camera & Tap RFID</span> : <span className="flex items-center gap-2"><FaIdCard/> Identifying Student...</span>}
                </div>
              </div>
            </div>

            {/* Control Buttons - No Exit in Attendance anymore */}
            <div className="btn-group">
              {view === 'register_face' && (
                 <button className="btn btn-outline" onClick={() => setView('menu')}>Cancel</button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;