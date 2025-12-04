import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { motion, AnimatePresence } from 'framer-motion';
import Swal from 'sweetalert2';
import io from 'socket.io-client';
import { supabase } from './supabaseClient';
import { 
  FaUserPlus, FaDesktop, FaFingerprint, 
  FaArrowLeft, FaCamera, FaCheckCircle, FaUserShield, FaWifi 
} from 'react-icons/fa';
import './styles.css';

// Connect to Local Kiosk Server (RFID)
const socket = io('http://localhost:4000');

function App() {
  const [view, setView] = useState('menu'); 
  const [deviceKey, setDeviceKey] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  
  const [students, setStudents] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [loadingText, setLoadingText] = useState('');

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
      console.error(e);
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
      handleRegistrationScan(uid);
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

  const startRegister = () => {
    setView('register_scan');
  };

  // UPDATED FUNCTION: Correctly handles Pending Registrations Schema
  const handleRegistrationScan = async (uid) => {
    // 1. Popup to ask for Student ID
    const { value: studentId } = await Swal.fire({
      title: 'Card Detected!',
      html: `
        <p>UID: <strong>${uid}</strong></p>
        <p class="mt-2">Please enter your Student ID to link this card.</p>
      `,
      input: 'text',
      inputLabel: 'Student ID',
      inputPlaceholder: 'e.g. 2023-12345',
      showCancelButton: true,
      confirmButtonText: 'Save & Link',
      confirmButtonColor: '#2ecc71',
      cancelButtonColor: '#d33',
      inputValidator: (value) => {
        if (!value) return 'You need to write your Student ID!';
      }
    });

    if (studentId) {
      setLoadingText('Verifying ID...');

      try {
        // --- CHECK 1: Is student already in the main 'students' table? ---
        const { data: existingStudent, error: findError } = await supabase
          .from('students')
          .select('*')
          .eq('student_id', studentId)
          .maybeSingle();

        if (findError) throw findError;

        if (existingStudent) {
          // A. Student exists: Just update RFID
          const { error: updateError } = await supabase
            .from('students')
            .update({ rfid_uid: uid })
            .eq('id', existingStudent.id);

          setLoadingText('');

          if (updateError) throw updateError;

          await Swal.fire({
            icon: 'success',
            title: 'Linked Successfully!',
            text: `RFID Card assigned to ${existingStudent.full_name}`,
            timer: 2000,
            showConfirmButton: false
          });
          setView('menu');
          return;
        }

        // --- CHECK 2: Is student in 'pending_registrations' table? ---
        const { data: pendingStudent, error: pendingError } = await supabase
          .from('pending_registrations') 
          .select('*')
          .eq('student_id', studentId)
          .maybeSingle();

        if (pendingError) throw pendingError;

        if (pendingStudent) {
          // B. Student found in Pending: Approve them automatically
          setLoadingText('Approving Student...');
          
          console.log("Pending Student Found:", pendingStudent);

          // Construct full name from parts
          const middleName = pendingStudent.middle_name ? ` ${pendingStudent.middle_name} ` : ' ';
          const fullName = `${pendingStudent.given_name}${middleName}${pendingStudent.surname}`;

          // 1. Move to main 'students' table with exact schema mapping
          const { error: insertError } = await supabase
            .from('students')
            .insert([{
              student_id: pendingStudent.student_id,
              full_name: fullName.trim(), // Combine names
              course: pendingStudent.course,
              face_image_url: pendingStudent.face_image_url,
              enrolled_subjects: pendingStudent.enrolled_subjects,
              rfid_uid: uid // Assign the new RFID immediately
            }]);

          if (insertError) {
            console.error("Insert Failed:", insertError);
            throw new Error(`Insert failed: ${insertError.message}`);
          }

          // 2. Remove from 'pending_registrations'
          const { error: deleteError } = await supabase
            .from('pending_registrations')
            .delete()
            .eq('id', pendingStudent.id);
            
          if (deleteError) console.error("Warning: Could not delete from pending", deleteError);

          setLoadingText('');

          await Swal.fire({
            icon: 'success',
            title: 'Approved & Registered!',
            html: `Student <strong>${fullName}</strong> has been approved and linked.`,
            timer: 3000,
            showConfirmButton: false
          });
          
          // Refresh local data
          await syncDataAndTrain();
          setView('menu');
          return;
        }

        // --- CHECK 3: Student not found anywhere ---
        setLoadingText('');
        Swal.fire({
          icon: 'error',
          title: 'Student Not Found',
          text: 'Please register first on our website by uploading your COR or go to the Admin office.',
          confirmButtonColor: '#3085d6'
        });

      } catch (err) {
        setLoadingText('');
        console.error("FULL ERROR OBJECT:", err);
        Swal.fire('Error', err.message || 'Database operation failed.', 'error');
      }
    }
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
        Swal.fire({icon: 'error', title: 'Server Error', text: 'Cannot reach Admin Server'});
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

  return (
    <div className="container">
      {/* Hidden element to store view state for Socket.io listener */}
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

        {/* 3. REGISTER SCAN MODE (New) */}
        {view === 'register_scan' && (
          <motion.div key="register_scan" initial={{scale:0.9, opacity:0}} animate={{scale:1, opacity:1}} exit={{scale:0.9, opacity:0}} className="flex flex-col items-center justify-center h-full">
            <div className="bg-white p-10 rounded-2xl shadow-xl flex flex-col items-center text-gray-800">
              <div className="animate-pulse mb-6">
                <FaWifi style={{ fontSize: '5rem', color: '#FF6600' }} />
              </div>
              <h2 className="text-3xl font-bold mb-2">Scan RFID Card</h2>
              <p className="text-lg opacity-70">Tap the card on the reader to register</p>
            </div>
            <button className="btn btn-outline mt-8 bg-white text-gray-800 hover:bg-gray-200" onClick={() => setView('menu')}>
              <FaArrowLeft/> Return to Menu
            </button>
          </motion.div>
        )}

        {/* 4. IDLE MODE (AFK) */}
        {view === 'idle' && (
          <motion.div key="idle" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={startAttendanceMode} className="idle-container relative w-full h-full flex flex-col items-center justify-center">
            
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

        {/* 5. ATTENDANCE CAMERA VIEW */}
        {view === 'attendance' && (
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
                  <span className="flex items-center gap-2"><FaCamera/> Look at camera & Tap RFID</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;