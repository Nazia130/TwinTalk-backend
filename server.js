// server.js – TwinTalk full server (auth + signalling + history + recording)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  } 
});

// ---------- CONFIG / PATHS ----------
const tryPaths = [
  path.join(__dirname, "frontend"),
  path.join(__dirname, "../frontend"),
  path.join(__dirname, "./public"),
  __dirname
];
let frontendPath =
  tryPaths.find(
    (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()
  ) || path.join(__dirname, "frontend");
console.log("ℹ️ Using frontend path:", frontendPath);

const signupFile = path.join(__dirname, "signup.csv");
const historyFile = path.join(__dirname, "history.csv");

// ---------- RECORDING CONFIG ----------
const recordingsDir = path.join(__dirname, 'recordings');
const recordingsDB = path.join(__dirname, 'recordings.json');

// Check if node-media-server is available
let NodeMediaServer;
let nms = null;

try {
  NodeMediaServer = require('node-media-server');
  
  // RTMP server configuration for recording
  const rtmpConfig = {
    rtmp: {
      port: 1935,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60
    },
    http: {
      port: 8000,
      allow_origin: '*',
      mediaroot: './recordings'
    },
    auth: {
      play: false,
      publish: false
    }
  };

  nms = new NodeMediaServer(rtmpConfig);
  console.log('✅ Node Media Server loaded successfully');
} catch (error) {
  console.warn('❌ Node Media Server not available. Recording feature will be limited.');
  console.log('💡 Run: npm install node-media-server');
}

// Ensure recordings directory exists
async function ensureRecordingsDir() {
  try {
    await fs.promises.access(recordingsDir);
    console.log('✅ Recordings directory exists');
  } catch {
    await fs.promises.mkdir(recordingsDir, { recursive: true });
    console.log('✅ Created recordings directory');
  }
}

// Load recordings database
async function loadRecordingsDB() {
  try {
    const data = await fs.promises.readFile(recordingsDB, 'utf8');
    return JSON.parse(data);
  } catch {
    console.log('📁 Creating new recordings database');
    return [];
  }
}

// Save recordings database
async function saveRecordingsDB(data) {
  try {
    await fs.promises.writeFile(recordingsDB, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('❌ Failed to save recordings DB:', error);
  }
}

// Initialize recordings system
ensureRecordingsDir().then(() => {
  if (nms) {
    try {
      nms.run();
      console.log('🎥 Recording server started on port 1935');
    } catch (error) {
      console.error('❌ Failed to start recording server:', error);
      console.log('💡 This might be due to port 1935 being in use');
    }
  }
}).catch(console.error);

// ---------- MIDDLEWARE ----------
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ---------- CSV HELPERS ----------
function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf8");
    console.log(`✅ Created file: ${path.basename(filePath)}`);
  }
}

function readUsers() {
  ensureFile(signupFile);
  try {
    const raw = fs.readFileSync(signupFile, "utf8").replace(/\r/g, "").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => {
        const parts = line.split(",");
        return {
          name: (parts[0] || "").trim(),
          email: ((parts[1] || "").trim() || "").toLowerCase(),
          password: (parts[2] || "").trim(),
        };
      })
      .filter((u) => u.email);
  } catch (error) {
    console.error('❌ Error reading users:', error);
    return [];
  }
}

function appendUser({ name, email, password }) {
  ensureFile(signupFile);
  const line = `${name.replace(/,/g, " ")} , ${email.toLowerCase()} , ${password.replace(
    /[\r\n]/g, " "
  )}\n`;
  fs.appendFileSync(signupFile, line, "utf8");
}

// ---------- ROUTES ----------

// ✅ Serve auth.html first (always as homepage)
app.get("/", (req, res) => {
  const authPath = path.join(frontendPath, "auth.html");
  if (fs.existsSync(authPath)) {
    return res.sendFile(authPath);
  }
  res.sendFile(path.join(frontendPath, "index.html"));
});

// ✅ Static serve after root route
app.use(express.static(frontendPath));

// Serve socket.io client
app.get("/socket.io/socket.io.js", (req, res) => {
  res.sendFile(path.join(__dirname, "node_modules/socket.io/client-dist/socket.io.min.js"));
});

// ---------- SIGNUP ----------
app.post("/signup", (req, res) => {
  try {
    let { name, email, password } = req.body || {};
    name = (name || "").trim();
    email = (email || "").trim().toLowerCase();
    password = (password || "").trim();

    if (!name || !email || !password)
      return res.status(400).json({ message: "All fields required" });

    const users = readUsers();
    if (users.find((u) => u.email === email))
      return res
        .status(400)
        .json({ message: "User already signed up, please sign in." });

    appendUser({ name, email, password });
    console.log("✅ New signup:", email);
    return res.json({ success: true, message: "Signup successful, please sign in." });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ message: "Signup failed" });
  }
});

// ---------- LOGIN ----------
app.post("/login", (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = (email || "").trim().toLowerCase();
    password = (password || "").trim();

    if (!email || !password)
      return res.status(400).json({ message: "Email and password required." });

    const users = readUsers();
    const found = users.find(
      (u) => u.email === email && u.password === password
    );

    if (found) {
      console.log("✅ Login:", email);
      return res.json({
        success: true,
        message: "Login successful",
        user: { name: found.name, email: found.email },
      });
    } else {
      return res.status(401).json({ message: "Invalid email or password." });
    }
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Login failed" });
  }
});

// ---------- SIMPLE SUMMARIZER + HISTORY ----------
function simpleSummarize(text) {
  const clean = (text || "").replace(/\n/g, " ").replace(/[^a-zA-Z0-9. ]/g, " ");
  const sentences = clean.split(/[.?!]/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return "No content.";
  const freq = {};
  clean
    .toLowerCase()
    .split(/\s+/)
    .forEach((w) => {
      if (w.length > 3) freq[w] = (freq[w] || 0) + 1;
    });
  const scored = sentences.map((s) => {
    let score = 0;
    s.toLowerCase()
      .split(/\s+/)
      .forEach((w) => (score += freq[w] || 0));
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, 4)
    .map((x) => "• " + x.s)
    .join("\n");
}

app.post("/save-summary", (req, res) => {
  try {
    const { meetingId, transcript, userEmail } = req.body || {};
    if (!meetingId || !transcript || !userEmail)
      return res.status(400).json({ message: "Missing fields" });

    const summary = simpleSummarize(transcript);
    const date = new Date().toLocaleString("en-IN", { hour12: false });
    const row = `"${String(userEmail).toLowerCase()}","${date}","${String(
      meetingId
    ).replace(/"/g, "'")}","${String(summary).replace(/"/g, "'")}"\n`;
    fs.appendFileSync(historyFile, row, "utf8");
    console.log(`📝 Saved summary for ${userEmail} [${meetingId}]`);
    return res.json({ success: true, summary });
  } catch (err) {
    console.error("save-summary error:", err);
    return res.status(500).json({ message: "Save failed" });
  }
});

app.get("/history", (req, res) => {
  try {
    const email = (req.query.email || "").trim().toLowerCase();
    if (!email) return res.json([]);
    if (!fs.existsSync(historyFile)) return res.json([]);

    const raw = fs.readFileSync(historyFile, "utf8").replace(/\r/g, "").trim();
    if (!raw) return res.json([]);
    const rows = raw
      .split("\n")
      .map((line) => {
        const parts = line
          .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
          .map((s) => s.replace(/(^"|"$)/g, ""));
        return {
          userEmail: (parts[0] || "").toLowerCase(),
          date: parts[1] || "",
          meetingId: parts[2] || "",
          summary: parts[3] || ""
        };
      })
      .filter((r) => r.userEmail === email);
    return res.json(rows);
  } catch (err) {
    console.error("history read error:", err);
    return res.status(500).json({ message: "Read error" });
  }
});

// ---------- RECORDING ROUTES ----------

// Start recording
app.post('/start-recording', async (req, res) => {
  try {
    const { roomId, userEmail, recordingId } = req.body;
    
    if (!roomId || !userEmail) {
      return res.status(400).json({ message: 'Room ID and user email required' });
    }

    // Check if recording server is available
    if (!nms) {
      return res.status(503).json({ 
        message: 'Recording service temporarily unavailable. Please try again later.' 
      });
    }

    const recordings = await loadRecordingsDB();
    
    // Check if already recording
    const existingRecording = recordings.find(r => r.roomId === roomId && r.status === 'recording');
    if (existingRecording) {
      return res.status(400).json({ message: 'Recording already in progress for this room' });
    }

    const recording = {
      id: recordingId || `rec_${Date.now()}`,
      roomId,
      userEmail,
      startTime: new Date().toISOString(),
      status: 'recording',
      fileName: `${roomId}_${Date.now()}.flv`
    };

    recordings.push(recording);
    await saveRecordingsDB(recordings);

    console.log(`🎥 Started recording: ${recording.id} for room ${roomId}`);
    res.json({ 
      success: true, 
      recordingId: recording.id,
      message: 'Recording started successfully'
    });

  } catch (err) {
    console.error('Start recording error:', err);
    res.status(500).json({ message: 'Failed to start recording' });
  }
});

// Stop recording
app.post('/stop-recording', async (req, res) => {
  try {
    const { recordingId, roomId } = req.body;
    
    const recordings = await loadRecordingsDB();
    const recordingIndex = recordings.findIndex(r => 
      (recordingId && r.id === recordingId) || (roomId && r.roomId === roomId && r.status === 'recording')
    );

    if (recordingIndex === -1) {
      return res.status(404).json({ message: 'No active recording found' });
    }

    recordings[recordingIndex].status = 'completed';
    recordings[recordingIndex].endTime = new Date().toISOString();
    
    await saveRecordingsDB(recordings);

    console.log(`🛑 Stopped recording: ${recordings[recordingIndex].id}`);
    res.json({ 
      success: true, 
      recording: recordings[recordingIndex],
      message: 'Recording saved successfully'
    });

  } catch (err) {
    console.error('Stop recording error:', err);
    res.status(500).json({ message: 'Failed to stop recording' });
  }
});

// Get user recordings
app.get('/recordings', async (req, res) => {
  try {
    const userEmail = (req.query.email || '').toLowerCase();
    if (!userEmail) {
      return res.status(400).json({ message: 'User email required' });
    }

    const recordings = await loadRecordingsDB();
    const userRecordings = recordings.filter(r => 
      r.userEmail.toLowerCase() === userEmail && r.status === 'completed'
    );

    res.json(userRecordings);

  } catch (err) {
    console.error('Get recordings error:', err);
    res.status(500).json({ message: 'Failed to get recordings' });
  }
});

// Delete recording
app.delete('/recordings/:recordingId', async (req, res) => {
  try {
    const { recordingId } = req.params;
    const userEmail = (req.query.email || '').toLowerCase();

    const recordings = await loadRecordingsDB();
    const recordingIndex = recordings.findIndex(r => 
      r.id === recordingId && r.userEmail.toLowerCase() === userEmail
    );

    if (recordingIndex === -1) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    const recording = recordings[recordingIndex];
    
    // Delete the file if it exists
    try {
      const filePath = path.join(recordingsDir, recording.fileName);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        console.log(`🗑️ Deleted recording file: ${recording.fileName}`);
      }
    } catch (err) {
      console.warn('Could not delete recording file:', err);
    }

    recordings.splice(recordingIndex, 1);
    await saveRecordingsDB(recordings);

    console.log(`🗑️ Deleted recording: ${recordingId}`);
    res.json({ success: true, message: 'Recording deleted successfully' });

  } catch (err) {
    console.error('Delete recording error:', err);
    res.status(500).json({ message: 'Failed to delete recording' });
  }
});

// Serve recording files
app.use('/recordings', express.static(recordingsDir));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    recording: nms ? 'available' : 'unavailable',
    timestamp: new Date().toISOString()
  });
});

// ---------- SOCKET.IO (signalling) ----------
const roomPeers = {};

io.on("connection", (socket) => {
  console.log("🔗 Socket connected:", socket.id);

  socket.on("join-room", (data) => {
    const { roomId, name } = data || {};
    if (!roomId) return;
    
    socket.join(roomId);
    
    if (!roomPeers[roomId]) {
      roomPeers[roomId] = {};
    }
    
    roomPeers[roomId][socket.id] = { 
      name: name || "Guest", 
      avatar: null 
    };

    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return;

    const peerIds = Array.from(room).filter(id => id !== socket.id);
    const peers = peerIds.map(peerId => ({
      peerId: peerId,
      name: roomPeers[roomId]?.[peerId]?.name || "User"
    }));

    console.log(`📨 Sending ${peers.length} existing peers to ${socket.id}`);
    socket.emit("existing-peers", { peers });

    socket.to(roomId).emit("peer-joined", {
      peerId: socket.id,
      name: roomPeers[roomId][socket.id].name
    });

    console.log(`👥 ${name} joined ${roomId} (${peers.length} peers in room)`);
  });

  // WebRTC signaling
  socket.on("webrtc-offer", ({ to, sdp }) => {
    if (io.sockets.sockets.has(to)) {
      io.to(to).emit("webrtc-offer", { from: socket.id, sdp });
    }
  });
  
  socket.on("webrtc-answer", ({ to, sdp }) => {
    if (io.sockets.sockets.has(to)) {
      io.to(to).emit("webrtc-answer", { from: socket.id, sdp });
    }
  });
  
  socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
    if (io.sockets.sockets.has(to)) {
      io.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate });
    }
  });

  // Chat messages
  socket.on("chat-message", ({ roomId, name, message }) => {
    const timestamp = new Date().toISOString();
    io.to(roomId).emit("chat-message", { 
      name, 
      message,
      timestamp 
    });
  });

  // Avatar handling
  socket.on("set-avatar", ({ roomId, avatar, name }) => {
    if (roomPeers[roomId] && roomPeers[roomId][socket.id]) {
      roomPeers[roomId][socket.id].avatar = avatar;
    }
    
    socket.to(roomId).emit("peer-avatar", { 
      peerId: socket.id, 
      avatar, 
      name: name || roomPeers[roomId]?.[socket.id]?.name 
    });
  });

  socket.on("avatar-off", ({ roomId, name }) => {
    if (roomPeers[roomId] && roomPeers[roomId][socket.id]) {
      roomPeers[roomId][socket.id].avatar = null;
    }
    
    socket.to(roomId).emit("avatar-off", { 
      peerId: socket.id, 
      name: name || roomPeers[roomId]?.[socket.id]?.name 
    });
  });

  // Leave meeting
  socket.on("leave-meeting", ({ roomId, name }) => {
    socket.to(roomId).emit("peer-left", { 
      peerId: socket.id, 
      name: name || roomPeers[roomId]?.[socket.id]?.name 
    });
    
    if (roomPeers[roomId]) {
      delete roomPeers[roomId][socket.id];
      if (Object.keys(roomPeers[roomId]).length === 0) {
        delete roomPeers[roomId];
      }
    }
    
    socket.leave(roomId);
    console.log(`🚪 ${name} left meeting ${roomId}`);
  });

  socket.on("disconnect", () => {
    console.log(`❌ Socket disconnected: ${socket.id}`);
    
    Object.entries(roomPeers).forEach(([roomId, peers]) => {
      if (peers[socket.id]) {
        const peerName = peers[socket.id].name;
        socket.to(roomId).emit("peer-left", { 
          peerId: socket.id, 
          name: peerName 
        });
        
        delete roomPeers[roomId][socket.id];
        if (Object.keys(roomPeers[roomId]).length === 0) {
          delete roomPeers[roomId];
        }
        
        console.log(`❌ ${peerName} disconnected from ${roomId}`);
      }
    });
  });
});

// ---------- START ----------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🎥 Recording: ${nms ? 'Available' : 'Not available (install node-media-server)'}`);
});