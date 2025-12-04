import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { motion, AnimatePresence } from 'framer-motion';
import Swal from 'sweetalert2';
import io from 'socket.io-client';
import { supabase } from './supabaseClient';

// CONFIG: Connect to Node Server on Laptop (Port 4000)
const socket = io('http://localhost:4000'); 

function App() {
  const [view, setView] = useState('menu'); // menu, register_face, register_scan, login, idle, attendance
  const [deviceKey, setDeviceKey] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  const [loading, setLoading] = useState(false);
  const webcamRef = useRef(null);
  
  // Data State
  const [students, setStudents] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [tempRegStudent, setTempRegStudent] = useState(null); // For registration flow

  // --- 1. INITIALIZATION ---
  useEffect(() => {
    loadModels();
    
    // Global RFID Listener
    socket.on('rfid-tag', (uid) => {
      handleRfidScan(uid);
    });

    return () => socket.off('rfid-tag');
  }, [view, students, schedules, tempRegStudent]); 

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
      console.error("❌ Model Load Error. Did you download models to public/models?", e);
    }
  };

  // --- 2. GLOBAL RFID HANDLER ---
  const handleRfidScan = async (uid) => {
    console.log("💳 RFID Scanned:", uid);

    if (view === 'register_scan') {
      completeRegistration(uid);
    } else if (view === 'attendance') {
      processAttendance(uid);
    }
  };

  // --- 3. FETCH DATA ---
  const syncData = async () => {
    const { data: std } = await supabase.from('students').select('*');
    const { data: sch } = await supabase.from('schedules').select('*');
    setStudents(std || []);
    setSchedules(sch || []);
    console.log("🔄 Data Synced");
  };

  // --- 4. VIEW LOGIC ---

  // A. REGISTER FLOW
  const startRegister = async () => {
    setView('register_face');
    await syncData();
    
    // Start face detection loop
    const interval = setInterval(async () => {
      if (webcamRef.current && webcamRef.current.video.readyState === 4) {
        const video = webcamRef.current.video;
        const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
        
        if (detection) {
          clearInterval(interval);
          
          // --- SIMULATION ---
          // Since we don't have labeled face descriptors stored yet, we'll prompt the admin
          // to confirm who this face belongs to for this demo.
          // In production, you would match `detection.descriptor` against DB.
          
          const { value: studentID } = await Swal.fire({
            title: 'Face Detected!',
            text: 'Enter Student ID to link this face:',
            input: 'text',
            imageUrl: detection.image, // Just a placeholder, real usage needs canvas extraction
            imageWidth: 200,
            background: '#F5EBFA',
            color: '#49225B',
            confirmButtonColor: '#FF6600'
          });

          const match = students.find(s => s.student_id === studentID);

          if (match) {
             setTempRegStudent(match);
             setView('register_scan');
             Swal.fire({
               title: `Hello ${match.given_name || match.full_name}`,
               text: `Please TAP your RFID card now to finish registration.`,
               icon: 'info',
               timer: 10000,
               showConfirmButton: false,
               background: '#F5EBFA',
               color: '#49225B'
             });
          } else {
             Swal.fire('Error', 'Student not found in database.', 'error');
             setView('menu');
          }
        }
      }
    }, 1000);
  };

  const completeRegistration = async (uid) => {
    if (!tempRegStudent) return;

    // Update Student with RFID
    const { error } = await supabase
      .from('students')
      .update({ rfid_uid: uid })
      .eq('id', tempRegStudent.id);

    if (!error) {
      Swal.fire({
        title: 'Success!', 
        text: 'RFID Linked successfully!', 
        icon: 'success',
        background: '#F5EBFA',
        color: '#49225B',
        confirmButtonColor: '#FF6600'
      });
      setView('menu');
      setTempRegStudent(null);
    } else {
      Swal.fire('Error', 'Failed to save RFID', 'error');
    }
  };

  // B. KIOSK MODE FLOW
  const loginKiosk = async () => {
    if (!deviceKey) return Swal.fire('Error', 'Enter a key', 'error');

    const { data, error } = await supabase
      .from('devices')
      .select('id, device_name')
      .eq('connection_key', deviceKey)
      .single();

    if (error || !data) {
      Swal.fire('Access Denied', 'Invalid Kiosk Key', 'error');
    } else {
      setDeviceId(data.id);
      await supabase.from('devices').update({ status: 'online' }).eq('id', data.id);
      await syncData();
      setView('idle');
    }
  };

  const startAttendance = () => {
    // Only allow if Face Recognition is conceptually "On" (as per requirements)
    // We start the camera view
    setView('attendance');
  };

  // C. ATTENDANCE LOGIC
  const processAttendance = async (uid) => {
    // 1. Find Student
    const student = students.find(s => s.rfid_uid === uid);
    
    if (!student) {
      return Swal.fire({ 
        title: 'Unknown Card', 
        text: 'Please register this card first.',
        icon: 'error', 
        timer: 2000, 
        showConfirmButton: false,
        background: '#F5EBFA',
        color: '#49225B'
      });
    }

    // 2. Check Schedule
    const now = new Date();
    const currentTime = now.toTimeString().split(' ')[0]; // HH:MM:SS
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'short' }); // Mon, Tue...

    const activeClass = schedules.find(sched => {
      const classDays = sched.days ? sched.days.split(',') : [];
      if (!classDays.includes(currentDay)) return false;
      return currentTime >= sched.time_start && currentTime <= sched.time_end;
    });

    if (!activeClass) {
      return Swal.fire({ 
        title: 'No Class Found', 
        text: 'You do not have a scheduled class right now.', 
        icon: 'warning', 
        timer: 3000,
        background: '#F5EBFA',
        color: '#49225B',
        confirmButtonColor: '#FF6600'
      });
    }

    // 3. Duplicate Check
    const todayStr = now.toISOString().split('T')[0];
    const { data: logs } = await supabase
      .from('attendance_logs')
      .select('*')
      .eq('student_id', student.student_id)
      .eq('subject_code', activeClass.subject_code)
      .eq('date', todayStr);

    if (logs && logs.length > 0) {
      return Swal.fire({ 
        title: 'Already Logged', 
        text: `You have already attended ${activeClass.subject_name} today.`, 
        icon: 'info', 
        timer: 3000,
        background: '#F5EBFA',
        color: '#49225B',
        confirmButtonColor: '#FF6600'
      });
    }

    // 4. Status (Late/Present) Logic
    let status = 'present';
    // Example: Grace period calculation
    // if (currentTime > activeClass.time_start + grace) status = 'late';

    // 5. Insert Log
    await supabase.from('attendance_logs').insert([{
      student_id: student.student_id,
      student_name: student.full_name,
      subject_code: activeClass.subject_code,
      kiosk_id: deviceId,
      date: todayStr,
      status: status
    }]);

    // 6. Success Popup
    await Swal.fire({
      title: 'Welcome!',
      html: `
        <div style="text-align: left;">
          <p><strong>Subject:</strong> ${activeClass.subject_name}</p>
          <p><strong>Name:</strong> ${student.full_name}</p>
          <p><strong>ID:</strong> ${student.student_id}</p>
          <p><strong>Status:</strong> ${status.toUpperCase()}</p>
          <p><strong>Time:</strong> ${now.toLocaleTimeString()}</p>
        </div>
      `,
      icon: 'success',
      timer: 4000,
      showConfirmButton: false,
      background: '#F5EBFA',
      color: '#49225B'
    });
    
    // Return to Idle
    setView('idle');
  };

  // --- ANIMATIONS ---
  const pageTransition = {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.95 }
  };

  return (
    <div className="container">
      <AnimatePresence mode='wait'>
        
        {/* MAIN MENU */}
        {view === 'menu' && (
          <motion.div key="menu" {...pageTransition} className="card-grid">
            <div className="menu-card" onClick={startRegister}>
              <span className="icon">📡</span>
              <span className="label">Register</span>
            </div>
            <div className="menu-card" onClick={() => setView('login')}>
              <span className="icon">🖥️</span>
              <span className="label">Kiosk Mode</span>
            </div>
            <div className="menu-card" onClick={() => window.close()}>
              <span className="icon">❌</span>
              <span className="label">Exit</span>
            </div>
          </motion.div>
        )}

        {/* KIOSK LOGIN */}
        {view === 'login' && (
          <motion.div key="login" {...pageTransition} className="flex flex-col items-center">
            <h2 style={{marginBottom: '20px'}}>Enter Connection Key</h2>
            <input 
              className="kiosk-input" 
              placeholder="kiosk_xxxxxx" 
              value={deviceKey} 
              onChange={e => setDeviceKey(e.target.value)} 
            />
            <div style={{display:'flex', gap: '10px'}}>
              <button className="btn btn-danger" onClick={() => setView('menu')}>Cancel</button>
              <button className="btn btn-primary" onClick={loginKiosk}>Connect</button>
            </div>
          </motion.div>
        )}

        {/* IDLE SCREEN (AFK) */}
        {view === 'idle' && (
          <motion.div key="idle" {...pageTransition} onClick={startAttendance} style={{cursor: 'pointer', textAlign: 'center'}}>
            <h1>Smart Attendance System</h1>
            <p>Tap anywhere to start</p>
            <div className="icon" style={{marginTop: '20px'}}>👆</div>
          </motion.div>
        )}

        {/* ATTENDANCE & REGISTER CAMERAS */}
        {(view === 'attendance' || view === 'register_face' || view === 'register_scan') && (
          <motion.div key="cam" {...pageTransition} className="flex flex-col items-center">
            <div className="camera-frame">
              {modelsLoaded && (
                <Webcam
                  audio={false}
                  ref={webcamRef}
                  screenshotFormat="image/jpeg"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              )}
              <div className="overlay-text">
                <h3>
                  {view === 'register_scan' ? 'Face Verified! Tap RFID...' : 'Scanning...'}
                </h3>
                <p>
                  {view === 'register_scan' 
                    ? 'Place your card on the reader' 
                    : 'Please look at the camera and tap your ID'}
                </p>
              </div>
            </div>
            
            <button 
              className="btn btn-outline" 
              onClick={() => {
                if (view === 'attendance') {
                  // Exit Logic: Ask for Key
                  Swal.fire({
                    title: 'Exit Kiosk?',
                    input: 'text',
                    inputLabel: 'Enter Connection Key to Close',
                    showCancelButton: true,
                    background: '#F5EBFA',
                    color: '#49225B',
                    confirmButtonColor: '#d33'
                  }).then((res) => {
                    if (res.value === deviceKey) {
                      if(deviceId) supabase.from('devices').update({ status: 'offline' }).eq('id', deviceId);
                      setView('menu');
                    } else if (res.isConfirmed) {
                      Swal.fire('Error', 'Wrong Key', 'error');
                    }
                  });
                } else {
                  setView('menu');
                }
              }}
            >
              {view === 'attendance' ? 'Exit Kiosk' : 'Cancel'}
            </button>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}

export default App;