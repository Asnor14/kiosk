import Dexie from 'dexie';

export const db = new Dexie('KioskOfflineDB');

// Define the schema (comma-separated keys to index)
db.version(7).stores({
  // Matches public.students
  students: 'id, student_id, rfid_uid, full_name, enrolled_subjects, face_image_url', 
  
  // Matches public.schedules
  schedules: 'id, subject_code, subject_name, time_start, time_end, days, kiosk_id',
  
  // Local logs (will be uploaded to public.attendance_logs)
  logs: '++local_id, student_id, subject_code, date, sync_status' 
});