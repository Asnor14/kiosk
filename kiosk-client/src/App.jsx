import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { motion, AnimatePresence } from 'framer-motion';
import Swal from 'sweetalert2';
import io from 'socket.io-client';
import { supabase } from './supabaseClient';
import { db } from './db'; 
import { 
  FaUserPlus, FaDesktop, FaFingerprint, FaCog,
  FaArrowLeft, FaCamera, FaPowerOff, FaWifi, FaVideoSlash, FaSignOutAlt, 
  FaIdCard, FaSync, FaCloudUploadAlt, FaDatabase, FaClock, FaCheckCircle, FaUserCheck
} from 'react-icons/fa';
import './styles.css';

// Connect to Hardware Server (Localhost works offline)
const socket = io('http://localhost:4000');

const generatePorts = () => {
  const ports = [];
  for (let i = 1; i <= 10; i++) ports.push(`COM${i}`);
  ports.push('/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyACM1');
  return ports;
};

// --- CONFIGURATION ---
const REQUIRE_FACE_RECOGNITION = true; // Enforce Face Scan before RFID

function App() {
  const [view, setView] = useState('menu'); 
  const [deviceKey, setDeviceKey] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  const [deviceName, setDeviceName] = useState(null);
  
  // Data State
  const [studentsCount, setStudentsCount] = useState(0);
  const [schedules, setSchedules] = useState([]); 
  const [pendingUploads, setPendingUploads] = useState(0);
  
  // System State
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [loadingText, setLoadingText] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Recognition State
  const [recognizedUser, setRecognizedUser] = useState(null); // { id: '123', name: 'John' }

  // Settings
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [selectedPort, setSelectedPort] = useState('COM5');
  const [portStatus, setPortStatus] = useState('unknown');
  
  // Timer State
  const [timeLeft, setTimeLeft] = useState(30);

  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const lastScannedRef = useRef({ uid: '', time: 0 });

  // --- 1. INITIALIZATION ---
  useEffect(() => {
    const init = async () => {
      setLoadingText('Starting System...');
      
      // Load AI Models from local public folder (Works Offline)
      await loadModels();
      
      await cleanupDailyLogs();
      
      // Load Data from Dexie (Works Offline)
      await updateLocalStats(); 

      socket.on('rfid-tag', (uid) => handleRfidScan(uid));
      socket.on('current-config', (config) => setSelectedPort(config.port));
      socket.on('status-update', (data) => setPortStatus(data.status));

      window.addEventListener('online', () => { setIsOnline(true); uploadLogs(); });
      window.addEventListener('offline', () => setIsOnline(false));

      const storedKey = localStorage.getItem('kiosk_key');
      if (storedKey) {
        setDeviceKey(storedKey);
        verifySession(storedKey);
      } else {
        setLoadingText('');
      }

      // Background Sync Loop
      const syncInterval = setInterval(() => {
        if(navigator.onLine && deviceId) {
          uploadLogs();
          downloadDataToLocal(deviceId);
        }
      }, 30000);

      return () => clearInterval(syncInterval);
    };
    init();

    return () => {
      socket.off('rfid-tag');
      socket.off('current-config');
      socket.off('status-update');
    };
  }, []);

  // --- VISUAL COUNTDOWN TIMER ---
  useEffect(() => {
    let timer;
    if (view === 'attendance') {
      timer = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            Swal.close(); 
            setView('idle');
            setRecognizedUser(null);
            return 30;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [view]);

  const resetActivityTimer = () => {
    setTimeLeft(30);
  };

  // --- 2. REALTIME LISTENER ---
  useEffect(() => {
    if (!deviceId || !isOnline) return;

    const channel = supabase.channel('kiosk-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedules' }, 
        () => downloadDataToLocal(deviceId)
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, 
        () => downloadDataToLocal(deviceId)
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [deviceId, isOnline]);


  // --- 3. SYNC ENGINE ---
  const cleanupDailyLogs = async () => {
    const today = new Date().toISOString().split('T')[0];
    await db.logs.where('date').notEqual(today).delete();
  };

  const updateLocalStats = async () => {
    // This runs offline. It pulls data from Dexie DB.
    const sCount = await db.students.count();
    const lCount = await db.logs.where('sync_status').equals('pending').count();
    const sch = await db.schedules.toArray();
    
    setStudentsCount(sCount);
    setPendingUploads(lCount);
    setSchedules(sch);

    // Initialize Face Matcher using local Dexie data
    const localStudents = await db.students.toArray();
    if(cameraEnabled && localStudents.length > 0 && !faceMatcher) {
       await prepareFaceMatcher(localStudents);
    }
  };

  const downloadDataToLocal = async (currentKioskId) => {
    if(!navigator.onLine) return;
    setIsSyncing(true);
    
    try {
      const { data: stdData } = await supabase.from('students').select('*');
      const { data: schData } = await supabase.from('schedules').select('*');

      // CRITICAL: Preserve existing face descriptors so we don't need to re-download images
      const existingStudents = await db.students.toArray();
      const descriptorMap = {};
      existingStudents.forEach(s => {
         // Map student_id to their calculated face descriptor
         if(s.descriptor) descriptorMap[s.student_id] = s.descriptor;
      });

      const mergedStudents = stdData.map(s => ({
         ...s,
         // If we have a local descriptor, keep it. Otherwise null.
         descriptor: (descriptorMap[s.student_id]) ? descriptorMap[s.student_id] : null
      }));

      await db.transaction('rw', db.students, db.schedules, async () => {
        await db.students.clear();
        await db.schedules.clear();

        if (mergedStudents?.length) await db.students.bulkPut(mergedStudents);
        if (schData?.length) await db.schedules.bulkPut(schData);
      });
      
      await updateLocalStats();
      console.log("✅ Sync Complete");

    } catch (error) {
      console.error("Sync Down Error:", error);
    }
    setIsSyncing(false);
  };

  const uploadLogs = async () => {
    if (!navigator.onLine) return;
    const pendingLogs = await db.logs.where('sync_status').equals('pending').toArray();
    if (pendingLogs.length === 0) return;

    try {
      const logsToUpload = pendingLogs.map(({ local_id, ...log }) => ({
        ...log,
        sync_status: 'synced'
      }));

      const { error } = await supabase.from('attendance_logs').upsert(logsToUpload, { onConflict: 'student_id, subject_code, date' });

      if (!error) {
        const ids = pendingLogs.map(l => l.local_id);
        await db.logs.bulkUpdate(ids.map(id => ({ key: id, changes: { sync_status: 'synced' } })));
        updateLocalStats();
      }
    } catch (err) {
      console.error("Upload Error:", err);
    }
  };

  // --- 4. ATTENDANCE LOGIC (WITH ENFORCEMENT) ---
  const processAttendance = async (uid) => {
    const nowTs = Date.now();
    const cleanUid = uid.toString().trim();
    if (lastScannedRef.current.uid === cleanUid && (nowTs - lastScannedRef.current.time) < 5000) return;
    lastScannedRef.current = { uid: cleanUid, time: nowTs };

    resetActivityTimer();

    // B. FIND STUDENT (Offline via Dexie)
    let student = await db.students.where('rfid_uid').equals(cleanUid).first();
    if (!student) {
       student = await db.students.filter(s => s.rfid_uid && s.rfid_uid.toLowerCase() === cleanUid.toLowerCase()).first();
    }

    if (!student) {
      return Swal.fire({ icon: 'error', title: 'Not Registered', text: `UID: ${cleanUid}`, timer: 2000, showConfirmButton: false });
    }

    // --- C. FACE RECOGNITION ENFORCEMENT ---
    if (REQUIRE_FACE_RECOGNITION && cameraEnabled && modelsLoaded) {
       // Check if the camera currently sees the person who owns this card
       if (!recognizedUser || recognizedUser.id !== student.student_id) {
          return Swal.fire({ 
             icon: 'warning', 
             title: 'Face Mismatch', 
             html: `Card: <b>${student.full_name}</b><br>Please look at the camera to verify identity.`, 
             timer: 3000, 
             showConfirmButton: false,
             background: '#1B1B1B', 
             color: '#FFE7D0'
          });
       }
    }
    // -----------------------------------------

    // D. CHECK SCHEDULE (Offline via Dexie)
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'short' });

    const allSchedules = await db.schedules.where('kiosk_id').equals(deviceId).toArray();

    const activeClass = allSchedules.find(s => {
      if (!s.days || !s.days.includes(currentDay)) return false;
      return currentTime >= s.time_start.substring(0, 5) && currentTime <= s.time_end.substring(0, 5);
    });

    if (!activeClass) {
      return Swal.fire({ icon: 'warning', title: 'No Class', text: `${currentTime} (${currentDay})`, timer: 2000, showConfirmButton: false });
    }

    // E. CHECK ENROLLMENT
    const enrolledArr = student.enrolled_subjects ? student.enrolled_subjects.split(',') : [];
    if (!enrolledArr.some(code => code.trim() === activeClass.subject_code)) {
      return Swal.fire({ icon: 'error', title: 'Not Enrolled', text: activeClass.subject_name, timer: 2000, showConfirmButton: false });
    }

    // F. CHECK DUPLICATE (Offline via Dexie)
    const today = now.toISOString().split('T')[0];
    const existingLog = await db.logs.where({ student_id: student.student_id, subject_code: activeClass.subject_code, date: today }).first();

    if (existingLog) {
       return Swal.fire({ icon: 'info', title: 'Already Present', text: `${student.full_name}`, timer: 2000, showConfirmButton: false });
    }

    // G. SAVE LOG (Locally first)
    await db.logs.add({
      student_id: student.student_id,
      student_name: student.full_name,
      subject_code: activeClass.subject_code,
      kiosk_id: deviceId,
      date: today,
      timestamp: now.toISOString(),
      status: 'present',
      sync_status: 'pending'
    });

    updateLocalStats(); 

    Swal.fire({
      icon: 'success',
      title: 'Verified & Present!',
      html: `<h2 style="color:#FC6E20; font-weight:bold">${student.full_name}</h2><p style="margin:0">${activeClass.subject_name}</p>`,
      background: '#1B1B1B', 
      color: '#FFE7D0',
      timer: 2000, 
      showConfirmButton: false
    });

    setRecognizedUser(null); // Reset for next person
    if (navigator.onLine) uploadLogs();
  };

  // --- 5. AUTH & SESSION ---
  const loginKiosk = async () => {
    if (!deviceKey) return;
    setLoadingText('Verifying Key...');
    try {
      if(navigator.onLine) {
        const { data, error } = await supabase.from('devices').select('*').eq('connection_key', deviceKey).single();
        if (error || !data) throw new Error("Invalid Key");
        localStorage.setItem('kiosk_key', deviceKey);
        setupSession(data);
      } else {
        Swal.fire('Offline', 'Connect to internet for initial login.', 'warning');
        setLoadingText('');
      }
    } catch (e) {
      Swal.fire('Error', 'Invalid Key', 'error');
      setLoadingText('');
    }
  };

  const verifySession = async (key) => {
    if (!navigator.onLine) {
        // Offline Session Recovery
        const cachedId = localStorage.getItem('kiosk_id');
        const cachedName = localStorage.getItem('kiosk_name');
        if(cachedId) {
           setDeviceId(parseInt(cachedId));
           setDeviceName(cachedName || 'Kiosk');
           await updateLocalStats(); 
           setView('idle');
        }
        setLoadingText('');
        return;
    }
    try {
      const { data } = await supabase.from('devices').select('*').eq('connection_key', key).single();
      if (data) setupSession(data);
      else localStorage.removeItem('kiosk_key');
    } catch (e) { setLoadingText(''); }
  };

  const setupSession = async (deviceData) => {
    setDeviceId(deviceData.id);
    setDeviceName(deviceData.device_name);
    setCameraEnabled(deviceData.camera_enabled !== false);
    localStorage.setItem('kiosk_id', deviceData.id);
    localStorage.setItem('kiosk_name', deviceData.device_name);

    if(navigator.onLine) {
      await supabase.from('devices').update({ status: 'online' }).eq('id', deviceData.id);
      await downloadDataToLocal(deviceData.id);
    } else {
      await updateLocalStats();
    }
    setView('idle');
    setLoadingText('');
  };

  const handleKioskExit = async () => {
      const { value: key } = await Swal.fire({
        title: 'Disconnect?', input: 'password', showCancelButton: true, confirmButtonColor: '#d33', confirmButtonText: 'Exit', background: '#1B1B1B', color: '#FFE7D0'
      });
      if (key === deviceKey) {
         if(navigator.onLine) await supabase.from('devices').update({ status: 'offline' }).eq('id', deviceId);
         localStorage.clear();
         setDeviceId(null);
         setView('menu');
      } else {
         Swal.fire('Error', 'Invalid Key', 'error');
      }
  };

  // --- 6. HELPERS & MODEL LOADING ---
  const loadModels = async () => {
    // Models are loaded from the /public/models folder on the local device
    // This allows it to work offline as long as the app assets are loaded
    const MODEL_URL = '/models'; 
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      ]);
      setModelsLoaded(true);
    } catch(e) { console.error("Model Error", e); }
  };
  
  // --- OFFLINE-READY FACE MATCHER ---
  const prepareFaceMatcher = async (studentList) => {
    if (!cameraEnabled || !studentList) return;
    
    // Only block UI if we actually have processing to do
    const needsProcessing = studentList.some(s => s.face_image_url && !s.descriptor);
    if(needsProcessing) setLoadingText('Training Face AI...');
    
    const labeledDescriptors = [];
    const updatesToDb = []; 

    for (const student of studentList) {
        if (!student.face_image_url) continue;

        let descriptorFloat32;

        // 1. OFFLINE CHECK: Check if we already have the descriptor in Dexie
        if (student.descriptor) {
            // Restore descriptor from local DB (Instant, no internet needed)
            descriptorFloat32 = new Float32Array(Object.values(student.descriptor));
        } else {
            // 2. ONLINE FALLBACK: Fetch image and calculate (Only runs if online)
            if(navigator.onLine) {
                try {
                    const img = await faceapi.fetchImage(student.face_image_url);
                    const detections = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
                    
                    if (detections) {
                        descriptorFloat32 = detections.descriptor;
                        // Save to Dexie so next time we can be offline
                        updatesToDb.push({ key: student.id, changes: { descriptor: descriptorFloat32 } });
                    }
                } catch (err) {
                    console.warn(`Skipping face for ${student.student_id} (Offline or Error)`);
                }
            }
        }

        if (descriptorFloat32) {
            labeledDescriptors.push(new faceapi.LabeledFaceDescriptors(student.student_id, [descriptorFloat32]));
        }
    }

    // Batch update Dexie with any new descriptors calculated
    if (updatesToDb.length > 0) {
        await db.students.bulkUpdate(updatesToDb);
    }

    if (labeledDescriptors.length > 0) {
        setFaceMatcher(new faceapi.FaceMatcher(labeledDescriptors, 0.6));
    }
    setLoadingText('');
  };

  const handleRfidScan = (uid) => {
    const cleanUid = uid.toString().trim();
    const currentView = document.getElementById('app-view-state')?.getAttribute('data-view');
    if (currentView === 'register_scan') handleRegistrationScan(cleanUid);
    else if (currentView === 'attendance') processAttendance(cleanUid);
  };

  const handleRegistrationScan = async (uid) => {
     if(!navigator.onLine) return Swal.fire('Offline', 'Registration requires internet', 'warning');
     const { value: studentId } = await Swal.fire({
        title: 'New Card', html: `UID: <code>${uid}</code><br>Enter Student ID:`, input: 'text', showCancelButton: true, confirmButtonText: 'Link', background: '#1B1B1B', color: '#FFE7D0'
     });
     
     if(studentId) {
        setLoadingText('Linking...');
        try {
           const { data: pending } = await supabase.from('pending_registrations').select('*').eq('student_id', studentId).maybeSingle();
           if (pending) {
             await supabase.from('students').insert([{
               full_name: `${pending.given_name} ${pending.surname}`,
               student_id: pending.student_id, course: pending.course, rfid_uid: uid, face_image_url: pending.face_image_url, enrolled_subjects: pending.enrolled_subjects
             }]);
             await supabase.from('pending_registrations').delete().eq('id', pending.id);
             Swal.fire('Success', 'Student Linked!', 'success');
             setView('menu');
           } else {
             const { data: existing } = await supabase.from('students').select('*').eq('student_id', studentId).maybeSingle();
             if(existing) {
                await supabase.from('students').update({ rfid_uid: uid }).eq('id', existing.id);
                Swal.fire('Success', 'Card Updated!', 'success');
                setView('menu');
             } else {
                Swal.fire('Error', 'Student ID not found.', 'error');
             }
           }
        } catch(e) { Swal.fire('Error', e.message, 'error'); }
        setLoadingText('');
     }
  };

  const handleAppExit = () => {
      Swal.fire({
        title: 'Admin Password', input: 'password', showCancelButton: true, confirmButtonText: 'Close App', confirmButtonColor: '#d33', background: '#1B1B1B', color: '#FFE7D0'
      }).then((result) => {
         if(result.value === 'admin123') window.close(); 
      });
  };
  
  const handlePortChange = (e) => {
     setSelectedPort(e.target.value);
     socket.emit('change-port', e.target.value);
  };
  
  const startAttendance = () => {
     setTimeLeft(30); 
     setRecognizedUser(null);
     setView('attendance');
     if(navigator.onLine) uploadLogs();
  };

  const handleVideoOnPlay = () => {
    const interval = setInterval(async () => {
      if (cameraEnabled && webcamRef.current && webcamRef.current.video.readyState === 4 && canvasRef.current) {
        const video = webcamRef.current.video;
        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        
        if(canvasRef.current.width !== displaySize.width) faceapi.matchDimensions(canvasRef.current, displaySize);

        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
        const resized = faceapi.resizeResults(detections, displaySize);
        canvasRef.current.getContext('2d').clearRect(0, 0, displaySize.width, displaySize.height);
        
        if (resized.length === 0) {
            // No face seen
        }

        if (faceMatcher && resized.length > 0) {
          const bestResult = resized[0];
          const match = faceMatcher.findBestMatch(bestResult.descriptor);
          const box = bestResult.detection.box;
          
          if (match.label !== 'unknown') {
             // We found a registered student
             const student = await db.students.where('student_id').equals(match.label).first();
             const name = student ? student.full_name : match.label;
             
             if (!recognizedUser || recognizedUser.id !== match.label) {
                 setRecognizedUser({ id: match.label, name: name });
                 resetActivityTimer(); 
             }

             const drawBox = new faceapi.draw.DrawBox(box, { label: "Verified: Tap Card", boxColor: '#2ecc71' });
             drawBox.draw(canvasRef.current);
          } else {
             new faceapi.draw.DrawBox(box, { label: "Unknown", boxColor: '#e74c3c' }).draw(canvasRef.current);
          }
        }
      }
    }, 200);
    return () => clearInterval(interval);
  };

  return (
    <div className="container">
      <div id="app-view-state" data-view={view} style={{display:'none'}}></div>
      
      {isSyncing && (
         <div className="fixed top-4 left-4 bg-brand-orange text-white px-4 py-2 rounded-full z-50 flex items-center gap-2 shadow-lg animate-pulse">
            <FaSync className="animate-spin"/> Updating Data...
         </div>
      )}

      {loadingText && <div className="loading-overlay"><div className="spinner"></div><h2>{loadingText}</h2></div>}

      <AnimatePresence mode='wait'>
        
        {view === 'menu' && (
          <motion.div key="menu" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="card-grid">
            <div className="menu-card" onClick={() => setView('register_scan')}>
              <FaUserPlus className="icon"/><span className="label">Register</span>
            </div>
            <div className="menu-card" onClick={() => setView('login')}>
              <FaDesktop className="icon"/><span className="label">Kiosk Mode</span>
            </div>
            <div className="menu-card" onClick={() => setView('settings')}>
              <FaCog className="icon"/><span className="label">Settings</span>
            </div>
          </motion.div>
        )}

        {view === 'settings' && (
          <motion.div key="settings" initial={{x:50}} animate={{x:0}} exit={{x:-50}} className="settings-panel">
             <h2 className="text-2xl mb-4 font-bold text-white">Device Settings</h2>
             <div className="bg-black/40 p-4 rounded-xl w-full mb-6 text-sm text-left">
                <h3 className="text-brand-orange font-bold mb-2 flex items-center gap-2"><FaDatabase/> Local Data Status</h3>
                <div className="flex justify-between border-b border-white/10 py-1"><span>Cached Students:</span><span className="font-mono">{studentsCount}</span></div>
                <div className="flex justify-between border-b border-white/10 py-1"><span>Cached Schedules:</span><span className="font-mono">{schedules.length}</span></div>
                <div className="flex justify-between pt-1"><span>Logs to Upload:</span><span className="font-mono text-yellow-400">{pendingUploads}</span></div>
                <button onClick={() => downloadDataToLocal(deviceId)} className="mt-3 bg-brand-charcoal hover:bg-gray-700 w-full py-2 rounded text-xs">Force Re-Sync & Retrain</button>
             </div>
             <div className="input-group">
               <label className="input-label">Serial Port</label>
               <select className="kiosk-select" value={selectedPort} onChange={handlePortChange}>
                  {generatePorts().map(p => <option key={p} value={p}>{p}</option>)}
               </select>
               <p className="text-xs text-right mt-1 opacity-70">Status: {portStatus}</p>
             </div>
             <div className="btn-group-vertical">
               <button className="btn btn-danger" onClick={handleAppExit}>Exit Application</button>
               <button className="btn btn-secondary" onClick={()=>setView('menu')}>Back</button>
             </div>
          </motion.div>
        )}

        {view === 'login' && (
          <motion.div key="login" className="login-container">
            <h2 className="title">Kiosk Login</h2>
            <input className="kiosk-input" type="password" value={deviceKey} onChange={e=>setDeviceKey(e.target.value)} placeholder="Enter Device Key"/>
            <div className="btn-group">
              <button className="btn btn-secondary" onClick={()=>setView('menu')}>Cancel</button>
              <button className="btn btn-primary" onClick={loginKiosk}>Sync & Start</button>
            </div>
          </motion.div>
        )}

        {view === 'idle' && (
          <motion.div key="idle" onClick={startAttendance} className="idle-container">
             <div className="status-bar">
                <div className={`status-pill ${isOnline?'online':'offline'}`}>
                   {isOnline ? <FaWifi/> : <FaVideoSlash/>} {isOnline ? 'Online' : 'Offline'}
                </div>
                {pendingUploads > 0 && <div className="status-pill warning"><FaCloudUploadAlt/> {pendingUploads} Pending</div>}
             </div>
             <button onClick={(e)=>{e.stopPropagation(); handleKioskExit()}} className="exit-link"><FaSignOutAlt/> Disconnect</button>
             <div className="idle-content">
                <h1>Smart<br/>Attendance</h1>
                <p>Touch to Start</p>
                <motion.div animate={{y:[0,15,0]}} transition={{repeat:Infinity, duration:2}} className="fingerprint"><FaFingerprint/></motion.div>
                <div className="footer-info">
                   <span className="device-name">{deviceName || 'Kiosk'}</span><span className="separator">|</span><span>{selectedPort}</span>
                </div>
             </div>
          </motion.div>
        )}

        {view === 'attendance' && (
          <motion.div key="att" className="camera-view">
             <div className="timer-badge">
                <FaClock/> Closing in {timeLeft}s
             </div>

             <div className="camera-wrapper">
                {cameraEnabled && modelsLoaded ? (
                   <>
                    <Webcam audio={false} ref={webcamRef} className="webcam" onUserMedia={handleVideoOnPlay} mirrored={true} />
                    <canvas ref={canvasRef} className="canvas-overlay"/>
                    <div className="overlay-message">
                        {recognizedUser ? (
                            <div className="badge success-badge" style={{background:'rgba(46,204,113,0.9)', border:'1px solid #27ae60'}}>
                                <FaUserCheck/> Hello, {recognizedUser.name.split(' ')[0]}!<br/><span style={{fontSize:'0.8em'}}>Please Tap Card</span>
                            </div>
                        ) : (
                            <div className="badge"><FaCamera/> Look at Camera</div>
                        )}
                    </div>
                   </>
                ) : (
                   <div className="camera-off">
                      <FaIdCard size={80} className="text-orange animate-bounce mb-4"/>
                      <h3 className="text-2xl font-bold">Face Scan Disabled</h3>
                      <p>Tap RFID card to log attendance</p>
                   </div>
                )}
             </div>
             <button className="btn btn-secondary mt-4" onClick={()=>setView('idle')}>Cancel & Sleep</button>
          </motion.div>
        )}

        {view === 'register_scan' && (
           <motion.div key="reg" className="scan-container">
              <FaWifi size={60} className="text-orange animate-pulse mb-4"/>
              <h2>Scan Card to Register</h2>
              <button className="btn btn-secondary mt-6" onClick={()=>setView('menu')}>Back</button>
           </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;