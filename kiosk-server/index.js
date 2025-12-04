const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- SERIAL PORT CONFIGURATION ---
const portPath = process.env.SERIAL_PORT || 'COM6'; 
let port;

try {
  port = new SerialPort({ path: portPath, baudRate: 9600 });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  port.on('open', () => {
    console.log(`🔌 Serial connected on ${portPath}`);
  });

  parser.on('data', (data) => {
    const uid = data.trim();
    console.log('💳 RFID Scanned:', uid);
    // Broadcast RFID UID to React Client
    io.emit('rfid-tag', uid); 
  });

  port.on('error', (err) => {
    console.error('Serial Error:', err.message);
  });
} catch (error) {
  console.log('⚠️ Serial Port not found. Ensure ESP8266 is connected.');
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Kiosk Server running on http://localhost:${PORT}`);
});