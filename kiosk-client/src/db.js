import Dexie from 'dexie';

export const db = new Dexie('KioskOfflineDB');

// Bump version to 10 to update the schema
db.version(59).stores({
  // Added 'descriptor' to cache the face data offline
  students: 'id, student_id, rfid_uid, full_name, enrolled_subjects, face_image_url, descriptor', 
  
  // Matches public.schedules
  schedules: 'id, subject_code, subject_name, time_start, time_end, days, kiosk_id',
  
  // Local logs
  logs: '++local_id, student_id, subject_code, date, sync_status' 
});