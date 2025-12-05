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
  FaArrowLeft, FaCamera, FaPowerOff, FaWifi, FaVideoSlash, FaSignOutAlt, FaIdCard, FaSync, FaCloudUploadAlt, FaDatabase
} from 'react-icons/fa';
import './styles.css';

// Connect to Hardware Server
const socket = io('http://localhost:4000');

const generatePorts = () => {
  const ports = [];
  for (let i = 1; i <= 10; i++) ports.push(`COM${i}`);
  ports.push('/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyACM1');
  return ports;
};

function App() {
  const [view, setView] = useState('menu'); 
  const [deviceKey, setDeviceKey] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  const [deviceName, setDeviceName] = useState(null);
  
  // Data State
  const [studentsCount, setStudentsCount] = useState(0);
  const [schedulesCount, setSchedulesCount] = useState(0); // Changed to count to avoid massive array in state
  const [pendingUploads, setPendingUploads] = useState(0);
  
  // System State
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [loadingText, setLoadingText] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Settings
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [selectedPort, setSelectedPort] = useState('COM6');
  const [portStatus, setPortStatus] = useState('unknown');

  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const lastScannedRef = useRef({ uid: '', time: 0 });

  // --- 1. INITIALIZATION ---
  useEffect(() => {
    const init = async () => {
      setLoadingText('Starting System...');
      
      await loadModels();
      
      // FIX: Clean up OLD logs (yesterday or older) on boot
      // This ensures the DB doesn't get huge, but keeps TODAY'S logs for duplicate checking
      await cleanupDailyLogs();
      
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

      // Background Sync
      const syncInterval = setInterval(() => {
        if(navigator.onLine && deviceId) {
          uploadLogs();
          // Optional: Silent refresh of schedules every 2 mins to be safe
          downloadDataToLocal(deviceId); 
        }
      }, 120000);

      return () => clearInterval(syncInterval);
    };
    init();

    return () => {
      socket.off('rfid-tag');
      socket.off('current-config');
      socket.off('status-update');
    };
  }, []);

  // --- 2. REALTIME LISTENER ---
  useEffect(() => {
    if (!deviceId || !isOnline) return;

    const channel = supabase.channel('kiosk-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedules' }, 
        () => {
          console.log("🔔 Schedules changed. Syncing...");
          // FIX: Trigger download immediately so Dexie is fresh
          downloadDataToLocal(deviceId);
        }
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, 
        () => {
          console.log("🔔 Students changed. Syncing...");
          downloadDataToLocal(deviceId);
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [deviceId, isOnline]);


  // --- 3. SYNC ENGINE ---
  
  // FIX: Delete logs from yesterday so they don't block attendance today
  const cleanupDailyLogs = async () => {
    const today = new Date().toISOString().split('T')[0];
    // Delete any log where date is NOT today
    await db.logs.where('date').notEqual(today).delete();
  };

  const updateLocalStats = async () => {
    const sCount = await db.students.count();
    const schCount = await db.schedules.count();
    // Only count 'pending' for the UI badge
    const lCount = await db.logs.where('sync_status').equals('pending').count();
    
    setStudentsCount(sCount);
    setSchedulesCount(schCount);
    setPendingUploads(lCount);
  };

  const downloadDataToLocal = async (currentKioskId) => {
    if(!navigator.onLine) return;
    setIsSyncing(true);
    
    try {
      const { data: stdData } = await supabase.from('students').select('*');
      const { data: schData } = await supabase.from('schedules').select('*');

      await db.transaction('rw', db.students, db.schedules, async () => {
        // FIX: Clear tables explicitly to handle deletions from Admin
        await db.students.clear();
        await db.schedules.clear();

        if (stdData && stdData.length > 0) await db.students.bulkPut(stdData);
        if (schData && schData.length > 0) await db.schedules.bulkPut(schData);
      });
      
      await updateLocalStats();
      if (cameraEnabled && stdData) prepareFaceMatcher(stdData);
      console.log("✅ Dexie Sync Complete");

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
        // FIX: DO NOT DELETE LOGS. Update status to 'synced'.
        // This keeps the record in Dexie so we can detect duplicates locally for the rest of the day.
        const ids = pendingLogs.map(l => l.local_id);
        await db.logs.bulkUpdate(ids.map(id => ({ key: id, changes: { sync_status: 'synced' } })));
        
        updateLocalStats();
      }
    } catch (err) {
      console.error("Upload Error:", err);
    }
  };

  // --- 4. ATTENDANCE LOGIC ---
  const processAttendance = async (uid) => {
    // A. RAPID FIRE PREVENTION
    const nowTs = Date.now();
    const cleanUid = uid.toString().trim();
    if (lastScannedRef.current.uid === cleanUid && (nowTs - lastScannedRef.current.time) < 5000) return;
    lastScannedRef.current = { uid: cleanUid, time: nowTs };

    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => setView('idle'), 20000);

    // B. FIND STUDENT (Local)
    let student = await db.students.where('rfid_uid').equals(cleanUid).first();
    if (!student) {
       student = await db.students.filter(s => s.rfid_uid && s.rfid_uid.toLowerCase() === cleanUid.toLowerCase()).first();
    }
    if (!student) return Swal.fire({ icon: 'error', title: 'Not Registered', timer: 3000 });

    // C. CHECK SCHEDULE (FIX: Query DB directly to ensure freshness)
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'short' });

    // FIX: Fetch schedules from Dexie inside this function. 
    // This ignores stale React state and gets the raw DB data immediately after sync.
    const allSchedules = await db.schedules.where('kiosk_id').equals(deviceId).toArray();

    const activeClass = allSchedules.find(s => {
      if (!s.days || !s.days.includes(currentDay)) return false;
      // Handle "08:00:00" vs "08:00"
      const start = s.time_start.substring(0, 5);
      const end = s.time_end.substring(0, 5);
      return currentTime >= start && currentTime <= end;
    });

    if (!activeClass) {
      return Swal.fire({ icon: 'warning', title: 'No Class Scheduled', text: `Time: ${currentTime}`, timer: 3000 });
    }

    // D. CHECK ENROLLMENT
    const enrolledArr = student.enrolled_subjects ? student.enrolled_subjects.split(',') : [];
    const isEnrolled = enrolledArr.some(code => code.trim() === activeClass.subject_code);
    if (!isEnrolled) return Swal.fire({ icon: 'error', title: 'Not Enrolled', text: activeClass.subject_name, timer: 3000 });

    // E. CHECK DUPLICATE (FIX: Checks Dexie which now KEEPS synced logs)
    const today = now.toISOString().split('T')[0];
    const existingLog = await db.logs
      .where({ student_id: student.student_id, subject_code: activeClass.subject_code, date: today })
      .first();

    if (existingLog) {
       return Swal.fire({ 
         icon: 'info', 
         title: 'Already Present', 
         text: `Attendance recorded at ${new Date(existingLog.timestamp).toLocaleTimeString()}`, 
         timer: 3000, showConfirmButton: false 
       });
    }

    // F. SAVE LOG
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

    // G. SUCCESS
    Swal.fire({
      icon: 'success',
      title: 'Welcome!',
      html: `<h2 style="color:#FC6E20">${student.full_name}</h2><p>${activeClass.subject_name}</p>`,
      timer: 2000, showConfirmButton: false
    });

    if (navigator.onLine) uploadLogs();
    setView('idle');
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
      Swal.fire('Error', 'Invalid Connection Key', 'error');
      setLoadingText('');
    }
  };

  const verifySession = async (key) => {
    if (!navigator.onLine) {
        const cachedId = localStorage.getItem('kiosk_id');
        const cachedName = localStorage.getItem('kiosk_name');
        if(cachedId) {
           setDeviceId(cachedId);
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
         setDeviceName(null);
         setDeviceKey('');
         setView('menu');
      } else {
         Swal.fire('Error', 'Invalid Key', 'error');
      }
  };

  // --- 6. HELPERS ---
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
    } catch(e) { console.error("Model Error", e); }
  };
  
  const prepareFaceMatcher = async (studentList) => {
    if (!cameraEnabled || !studentList) return;
    const labeledDescriptors = await Promise.all(
      studentList.map(async (student) => {
        if (!student.face_image_url) return null;
        try {
          const img = await faceapi.fetchImage(student.face_image_url);
          const detections = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
          if (!detections) return null;
          return new faceapi.LabeledFaceDescriptors(student.student_id, [detections.descriptor]);
        } catch { return null; }
      })
    );
    const valid = labeledDescriptors.filter(d => d !== null);
    if (valid.length > 0) setFaceMatcher(new faceapi.FaceMatcher(valid, 0.6));
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
     setView('attendance');
     if(navigator.onLine) uploadLogs();
     if(idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
     idleTimeoutRef.current = setTimeout(() => setView('idle'), 20000);
  };

  const handleVideoOnPlay = () => {
    const interval = setInterval(async () => {
      if (cameraEnabled && webcamRef.current && webcamRef.current.video.readyState === 4 && canvasRef.current) {
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
            const label = match ? match.full_name : "Unknown";
            const color = match ? '#2ecc71' : '#e74c3c';
            new faceapi.draw.DrawBox(box, { label, boxColor: color }).draw(canvasRef.current);
          });
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
            <FaSync className="animate-spin"/> Updating Database...
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
                <div className="flex justify-between border-b border-white/10 py-1"><span>Cached Schedules:</span><span className="font-mono">{schedulesCount}</span></div>
                <div className="flex justify-between pt-1"><span>Logs to Upload:</span><span className="font-mono text-yellow-400">{pendingUploads}</span></div>
                <button onClick={() => downloadDataToLocal(deviceId)} className="mt-3 bg-brand-charcoal hover:bg-gray-700 w-full py-2 rounded text-xs">Force Re-Sync</button>
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
             <div className="camera-wrapper">
                {cameraEnabled && modelsLoaded ? (
                   <>
                    <Webcam audio={false} ref={webcamRef} className="webcam" onUserMedia={handleVideoOnPlay}/>
                    <canvas ref={canvasRef} className="canvas-overlay"/>
                    <div className="overlay-message"><div className="badge"><FaCamera/> Face Scan Active</div></div>
                   </>
                ) : (
                   <div className="camera-off">
                      <FaIdCard size={80} className="text-orange animate-bounce mb-4"/>
                      <h3 className="text-2xl font-bold">Face Scan Disabled</h3>
                      <p>Tap RFID card to log attendance</p>
                   </div>
                )}
             </div>
             <button className="btn btn-secondary mt-4" onClick={()=>setView('idle')}>Cancel</button>
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