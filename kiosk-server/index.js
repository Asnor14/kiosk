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

// --- DYNAMIC SERIAL PORT CONFIGURATION ---
let port = null;
let currentPortPath = process.env.SERIAL_PORT || 'COM5'; // Default

const connectToPort = (path) => {
  // 1. Close existing if open
  if (port && port.isOpen) {
    console.log('Closing previous port...');
    port.close();
  }

  currentPortPath = path;

  try {
    console.log(`🔌 Attempting to connect to ${path}...`);
    port = new SerialPort({ path: path, baudRate: 9600 });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    port.on('open', () => {
      console.log(`✅ Serial connected on ${path}`);
      io.emit('status-update', { port: path, status: 'connected' });
    });

    parser.on('data', (data) => {
      const uid = data.trim();
      console.log('💳 RFID Scanned:', uid);
      io.emit('rfid-tag', uid);
    });

    port.on('error', (err) => {
      console.error(`⚠️ Serial Error on ${path}:`, err.message);
      io.emit('status-update', { port: path, status: 'error' });
    });

  } catch (error) {
    console.log(`❌ Could not open ${path}. Ensure ESP8266 is connected.`);
    io.emit('status-update', { port: path, status: 'failed' });
  }
};

// Initial Connection
connectToPort(currentPortPath);

// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
  console.log('💻 Client connected');

  // Send current config on connect
  socket.emit('current-config', { port: currentPortPath });

  // Handle Port Change Request from Frontend
  socket.on('change-port', (newPath) => {
    console.log(`🔄 Switching port to ${newPath}`);
    connectToPort(newPath);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Kiosk Server running on http://localhost:${PORT}`);
});