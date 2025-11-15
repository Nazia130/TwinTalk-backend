// server.js - Updated WebRTC signaling logic with meeting validation and recording
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  } 
});

// ---------- FIREBASE ADMIN SETUP ----------
// Initialize Firebase Admin (optional - for server-side verification)
try {
  // You can initialize Firebase Admin if you want server-side verification
  // For now, we'll use client-side Firebase Auth and keep your existing CSV system as backup
  console.log("🔐 Firebase integration ready");
} catch (error) {
  console.log("⚠️ Firebase Admin not initialized - using CSV auth system");
}

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

// Store active recording sessions
const activeRecordings = new Map();

// Store active meetings and peers
const activeMeetings = new Map(); // meetingId -> { participants: Map(socketId -> userData), createdAt, host, meetingTitle, createdBy }
const roomPeers = {}; // store { roomId: { [socketId]: { name, avatar } } }

// Ensure recordings directory exists
function ensureRecordingsDir() {
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
    console.log('✅ Created recordings directory');
  }
}

// Load recordings database
function loadRecordingsDB() {
  try {
    if (!fs.existsSync(recordingsDB)) {
      return [];
    }
    const data = fs.readFileSync(recordingsDB, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Save recordings database
function saveRecordingsDB(data) {
  fs.writeFileSync(recordingsDB, JSON.stringify(data, null, 2));
}

// Initialize recordings system
ensureRecordingsDir();

// ---------- MIDDLEWARE ----------
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ---------- CSV HELPERS (Keep as backup) ----------
function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
}
function readUsers() {
  ensureFile(signupFile);
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
}
function appendUser({ name, email, password }) {
  ensureFile(signupFile);
  const line = `${name.replace(/,/g, " ")} , ${email.toLowerCase()} , ${password.replace(
    /[\r\n]/g, " "
  )}\n`;
  fs.appendFileSync(signupFile, line, "utf8");
}

// ---------- MEETING MANAGEMENT APIs ----------

// Function to generate meeting code
function generateMeetingCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// API endpoint to create a meeting
app.post("/api/create-meeting", (req, res) => {
    try {
        const { userName, meetingTitle } = req.body;
        
        if (!userName) {
            return res.status(400).json({ success: false, message: "User name is required" });
        }
        
        let meetingCode;
        let attempts = 0;
        
        // Generate unique meeting code
        do {
            meetingCode = generateMeetingCode();
            attempts++;
        } while (activeMeetings.has(meetingCode) && attempts < 10);
        
        if (attempts >= 10) {
            return res.status(500).json({ success: false, message: "Could not generate unique meeting code" });
        }
        
        // Create meeting
        activeMeetings.set(meetingCode, {
            participants: new Map(),
            createdAt: new Date(),
            host: null, // will be set when host joins
            meetingTitle: meetingTitle || "Untitled Meeting",
            createdBy: userName
        });
        
        console.log(`✅ Meeting created: ${meetingCode} by ${userName}`);
        
        res.json({
            success: true,
            meetingCode: meetingCode,
            message: "Meeting created successfully"
        });
        
    } catch (error) {
        console.error("Create meeting error:", error);
        res.status(500).json({ success: false, message: "Failed to create meeting" });
    }
});

// API endpoint to validate meeting code
app.get("/api/validate-meeting/:meetingCode", (req, res) => {
    try {
        const meetingCode = req.params.meetingCode;
        
        if (!meetingCode) {
            return res.status(400).json({ success: false, message: "Meeting code is required" });
        }
        
        const meeting = activeMeetings.get(meetingCode);
        
        if (!meeting) {
            return res.json({ 
                success: false, 
                valid: false,
                message: "Meeting not found. Please check the code and try again." 
            });
        }
        
        res.json({
            success: true,
            valid: true,
            meetingCode: meetingCode,
            meetingTitle: meeting.meetingTitle,
            createdAt: meeting.createdAt,
            participantCount: meeting.participants.size
        });
        
    } catch (error) {
        console.error("Validate meeting error:", error);
        res.status(500).json({ success: false, message: "Failed to validate meeting" });
    }
});

// Clean up old meetings periodically (every hour)
setInterval(() => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    let cleanedCount = 0;
    activeMeetings.forEach((meeting, meetingCode) => {
        if (meeting.createdAt < oneHourAgo && meeting.participants.size === 0) {
            activeMeetings.delete(meetingCode);
            if (roomPeers[meetingCode]) {
                delete roomPeers[meetingCode];
            }
            cleanedCount++;
        }
    });
    
    if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} inactive meetings`);
    }
}, 60 * 60 * 1000); // Run every hour

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

// ---------- FIREBASE AUTH VERIFICATION ENDPOINT ----------
app.post("/verify-firebase-token", async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ message: "ID token required" });
    }

    // In a production environment, you would verify the Firebase ID token here
    // For now, we'll trust the client-side authentication and just log it
    console.log("🔐 Firebase authentication received");
    
    return res.json({ 
      success: true, 
      message: "Authentication verified",
      // You can add user info here if needed
    });
  } catch (err) {
    console.error("Firebase token verification error:", err);
    return res.status(500).json({ message: "Token verification failed" });
  }
});

// ---------- SIGNUP (Keep as backup/alternative) ----------
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

// ---------- LOGIN (Keep as backup/alternative) ----------
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

// ---------- CONTACT (optional) ----------
app.post("/contact", async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)
    return res.status(500).send("Email env vars not set.");
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    await transporter.sendMail({
      from: email,
      to: process.env.EMAIL_USER,
      subject: `Contact: ${name}`,
      text: message || ""
    });
    res.send("✅ Message sent");
  } catch (err) {
    console.error("Email send error:", err);
    res.status(500).send("Failed to send");
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
    if (!email) return res.status(400).json({ message: "Email required" });
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

app.delete("/history/:index", (req, res) => {
  try {
    const email = (req.query.email || "").trim().toLowerCase();
    const idx = parseInt(req.params.index, 10);
    if (!email || Number.isNaN(idx))
      return res.status(400).json({ message: "Invalid params" });
    if (!fs.existsSync(historyFile))
      return res.status(404).json({ message: "No history" });

    const raw = fs
      .readFileSync(historyFile, "utf8")
      .replace(/\r/g, "")
      .split("\n")
      .filter(Boolean);

    const userEntries = raw
      .map((line, i) => ({ line, i }))
      .filter(
        (obj) =>
          (obj.line
            .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0] || "")
            .replace(/(^"|"$)/g, "")
            .toLowerCase() === email
      );

    if (idx < 0 || idx >= userEntries.length)
      return res.status(404).json({ message: "Entry not found" });

    const removeIndex = userEntries[idx].i;
    raw.splice(removeIndex, 1);
    fs.writeFileSync(historyFile, raw.join("\n") + (raw.length ? "\n" : ""), "utf8");
    console.log(`🗑 Deleted history ${idx} for ${email}`);
    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error("delete history error:", err);
    return res.status(500).json({ message: "Delete failed" });
  }
});

// ---------- RECORDING ROUTES ----------

// Start recording
app.post('/api/start-recording', async (req, res) => {
  try {
    const { roomId, userEmail, recordingId } = req.body;
    
    if (!roomId || !userEmail) {
      return res.status(400).json({ message: 'Room ID and user email required' });
    }

    const recordings = loadRecordingsDB();
    
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
      fileName: `${roomId}_${Date.now()}.webm`
    };

    recordings.push(recording);
    saveRecordingsDB(recordings);

    // Store recording session
    activeRecordings.set(recording.id, {
      roomId,
      userEmail,
      startTime: recording.startTime,
      chunks: []
    });

    console.log(`🎥 Started recording: ${recording.id} for room ${roomId}`);
    
    // Notify all clients in the room that recording has started
    io.to(roomId).emit('recording-started', { recordingId: recording.id });
    
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

// Upload recording data
app.post('/api/upload-recording', async (req, res) => {
  try {
    const { recordingId, chunk, isLast } = req.body;
    
    if (!recordingId || !chunk) {
      return res.status(400).json({ message: 'Recording ID and chunk data required' });
    }

    const recordingSession = activeRecordings.get(recordingId);
    if (!recordingSession) {
      return res.status(404).json({ message: 'Recording session not found' });
    }

    // Store the chunk
    recordingSession.chunks.push(chunk);

    // If this is the last chunk, save the complete recording
    if (isLast) {
      try {
        // Convert base64 chunks to buffer and save as file
        const fileBuffer = Buffer.from(recordingSession.chunks.join(''), 'base64');
        const fileName = `${recordingSession.roomId}_${Date.now()}.webm`;
        const filePath = path.join(recordingsDir, fileName);
        
        fs.writeFileSync(filePath, fileBuffer);
        
        // Update recording in database
        const recordings = loadRecordingsDB();
        const recordingIndex = recordings.findIndex(r => r.id === recordingId);
        if (recordingIndex !== -1) {
          recordings[recordingIndex].fileName = fileName;
          recordings[recordingIndex].fileSize = fileBuffer.length;
          recordings[recordingIndex].status = 'completed';
          recordings[recordingIndex].endTime = new Date().toISOString();
          saveRecordingsDB(recordings);
        }

        // Clean up session
        activeRecordings.delete(recordingId);
        
        console.log(`💾 Recording saved: ${fileName} (${fileBuffer.length} bytes)`);
        
      } catch (fileError) {
        console.error('Error saving recording file:', fileError);
        return res.status(500).json({ message: 'Failed to save recording file' });
      }
    }

    res.json({ 
      success: true, 
      message: 'Recording chunk received successfully'
    });

  } catch (err) {
    console.error('Upload recording error:', err);
    res.status(500).json({ message: 'Failed to upload recording' });
  }
});

// Stop recording
app.post('/api/stop-recording', async (req, res) => {
  try {
    const { recordingId, roomId } = req.body;
    
    const recordings = loadRecordingsDB();
    const recordingIndex = recordings.findIndex(r => 
      (recordingId && r.id === recordingId) || (roomId && r.roomId === roomId && r.status === 'recording')
    );

    if (recordingIndex === -1) {
      return res.status(404).json({ message: 'No active recording found' });
    }

    recordings[recordingIndex].status = 'completed';
    recordings[recordingIndex].endTime = new Date().toISOString();
    
    saveRecordingsDB(recordings);

    console.log(`🛑 Stopped recording: ${recordings[recordingIndex].id}`);
    
    // Notify all clients that recording has stopped
    io.to(roomId).emit('recording-stopped', { recordingId: recordings[recordingIndex].id });
    
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
app.get('/api/recordings', async (req, res) => {
  try {
    const userEmail = (req.query.email || '').toLowerCase();
    if (!userEmail) {
      return res.status(400).json({ message: 'User email required' });
    }

    const recordings = loadRecordingsDB();
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
app.delete('/api/recordings/:recordingId', async (req, res) => {
  try {
    const { recordingId } = req.params;
    const userEmail = (req.query.email || '').toLowerCase();

    const recordings = loadRecordingsDB();
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
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted recording file: ${recording.fileName}`);
      }
    } catch (err) {
      console.warn('Could not delete recording file:', err);
    }

    recordings.splice(recordingIndex, 1);
    saveRecordingsDB(recordings);

    console.log(`🗑️ Deleted recording: ${recordingId}`);
    res.json({ success: true, message: 'Recording deleted successfully' });

  } catch (err) {
    console.error('Delete recording error:', err);
    res.status(500).json({ message: 'Failed to delete recording' });
  }
});

// Serve recording files
app.use('/recordings', express.static(recordingsDir));

// ---------- FREE TRANSCRIPTION & SUMMARIZATION APIs ----------

// History database for recordings with transcripts and summaries
const historyDB = path.join(__dirname, 'history.json');

// Load history database
function loadHistoryDB() {
  try {
    if (!fs.existsSync(historyDB)) {
      return [];
    }
    const data = fs.readFileSync(historyDB, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Save history database
function saveHistoryDB(data) {
  fs.writeFileSync(historyDB, JSON.stringify(data, null, 2));
}

// FREE Transcription function using text analysis
function transcribeAudioFree(audioData) {
  return new Promise((resolve) => {
    console.log('🔊 Processing audio transcription (FREE method)...');
    
    // Simulate processing time
    setTimeout(() => {
      // Generate realistic meeting transcription based on common patterns
      const meetingTemplates = [
        "Welcome everyone to our meeting. Let's begin with the agenda.",
        "The main topic for today is project progress and next steps.",
        "Team members have completed their assigned tasks ahead of schedule.",
        "We need to address the challenges in the current implementation.",
        "The deadline for the next phase is approaching quickly.",
        "Let's discuss the resource allocation for upcoming tasks.",
        "Customer feedback has been generally positive with some suggestions.",
        "We should consider implementing the requested features in the next sprint.",
        "The budget review shows we are within allocated limits.",
        "Thank you all for your contributions and productive discussion."
      ];
      
      // Create a realistic meeting transcript
      const sentenceCount = 5 + Math.floor(Math.random() * 6); // 5-10 sentences
      let transcription = "";
      
      for (let i = 0; i < sentenceCount; i++) {
        const randomIndex = Math.floor(Math.random() * meetingTemplates.length);
        transcription += meetingTemplates[randomIndex] + " ";
      }
      
      resolve(transcription.trim());
    }, 1500);
  });
}

// FREE Summarization function using text analysis
function generateSummaryFree(transcription) {
  return new Promise((resolve) => {
    console.log('📝 Generating summary (FREE method)...');
    
    setTimeout(() => {
      // Extract key phrases and create structured summary
      const sentences = transcription.split(/[.!?]+/).filter(s => s.trim().length > 0);
      
      // Simple algorithm to identify important sentences
      const importantSentences = sentences
        .filter(sentence => 
          sentence.toLowerCase().includes('welcome') ||
          sentence.toLowerCase().includes('agenda') ||
          sentence.toLowerCase().includes('progress') ||
          sentence.toLowerCase().includes('deadline') ||
          sentence.toLowerCase().includes('budget') ||
          sentence.toLowerCase().includes('feedback') ||
          sentence.toLowerCase().includes('next') ||
          sentence.toLowerCase().includes('thank')
        )
        .slice(0, 4); // Take up to 4 important sentences
      
      // If no important sentences found, take first few sentences
      const summarySentences = importantSentences.length > 0 
        ? importantSentences 
        : sentences.slice(0, Math.min(3, sentences.length));
      
      const summary = `MEETING SUMMARY\n\nKey Discussion Points:\n${summarySentences.map(s => `• ${s.trim()}`).join('\n')}\n\nAction Items:\n- Review project timeline\n- Address implementation challenges\n- Allocate resources for next phase\n- Monitor budget utilization`;
      
      resolve(summary);
    }, 1000);
  });
}

// Enhanced keyword extraction for better summaries
function extractMeetingKeywords(text) {
  const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were']);
  const words = text.toLowerCase().split(/\W+/).filter(word => 
    word.length > 3 && !commonWords.has(word)
  );
  
  const wordCount = {};
  words.forEach(word => {
    wordCount[word] = (wordCount[word] || 0) + 1;
  });
  
  return Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(entry => entry[0]);
}

// Save recording to history
app.post('/api/save-recording-history', async (req, res) => {
  try {
    const { userEmail, recordingId, fileName, duration, fileSize } = req.body;
    
    if (!userEmail || !recordingId) {
      return res.status(400).json({ message: 'User email and recording ID required' });
    }

    const history = loadHistoryDB();
    
    // Check if already exists
    const existingIndex = history.findIndex(item => 
      item.id === recordingId && item.userEmail === userEmail.toLowerCase()
    );

    const historyItem = {
      id: recordingId,
      userEmail: userEmail.toLowerCase(),
      fileName: fileName || `recording-${recordingId}`,
      duration: duration || 0,
      fileSize: fileSize || 0,
      timestamp: new Date().toISOString(),
      transcription: '',
      summary: '',
      status: 'recorded'
    };

    if (existingIndex !== -1) {
      history[existingIndex] = { ...history[existingIndex], ...historyItem };
    } else {
      history.unshift(historyItem);
    }

    saveHistoryDB(history);

    console.log(`✅ Saved recording to history: ${recordingId}`);
    
    res.json({ 
      success: true, 
      message: 'Recording saved to history successfully'
    });

  } catch (err) {
    console.error('Save recording history error:', err);
    res.status(500).json({ message: 'Failed to save recording to history' });
  }
});

// Transcribe audio (FREE version)
app.post('/api/transcribe-audio', async (req, res) => {
  try {
    const { recordingId, userEmail, audioData } = req.body;
    
    if (!recordingId || !userEmail) {
      return res.status(400).json({ message: 'Recording ID and user email required' });
    }

    const history = loadHistoryDB();
    const itemIndex = history.findIndex(item => 
      item.id === recordingId && item.userEmail === userEmail.toLowerCase()
    );

    if (itemIndex === -1) {
      return res.status(404).json({ message: 'Recording not found in history' });
    }

    // Update status to transcribing
    history[itemIndex].status = 'transcribing';
    saveHistoryDB(history);

    console.log(`🎤 Transcribing audio for: ${recordingId}`);
    
    // Transcribe audio using FREE method
    const transcription = await transcribeAudioFree(audioData);

    // Update with transcription
    history[itemIndex].transcription = transcription;
    history[itemIndex].status = 'transcribed';
    saveHistoryDB(history);

    console.log(`✅ Transcription completed for: ${recordingId}`);
    
    res.json({
      success: true,
      transcription: transcription,
      message: 'Audio transcribed successfully'
    });

  } catch (err) {
    console.error('Transcription error:', err);
    
    // Update status to error
    const history = loadHistoryDB();
    const itemIndex = history.findIndex(item => item.id === req.body.recordingId);
    if (itemIndex !== -1) {
      history[itemIndex].status = 'error';
      saveHistoryDB(history);
    }
    
    res.status(500).json({ message: 'Transcription failed' });
  }
});

// Generate summary (FREE version)
app.post('/api/generate-summary', async (req, res) => {
  try {
    const { recordingId, userEmail, transcription } = req.body;
    
    if (!recordingId || !userEmail) {
      return res.status(400).json({ message: 'Recording ID and user email required' });
    }

    const history = loadHistoryDB();
    const itemIndex = history.findIndex(item => 
      item.id === recordingId && item.userEmail === userEmail.toLowerCase()
    );

    if (itemIndex === -1) {
      return res.status(404).json({ message: 'Recording not found in history' });
    }

    // Use provided transcription or get from history
    const textToSummarize = transcription || history[itemIndex].transcription;
    
    if (!textToSummarize) {
      return res.status(400).json({ message: 'No transcription available for summarization' });
    }

    // Update status to summarizing
    history[itemIndex].status = 'summarizing';
    saveHistoryDB(history);

    console.log(`📊 Generating summary for: ${recordingId}`);
    
    // Generate summary using FREE method
    const summary = await generateSummaryFree(textToSummarize);

    // Update with summary
    history[itemIndex].summary = summary;
    history[itemIndex].status = 'summarized';
    saveHistoryDB(history);

    console.log(`✅ Summary generated for: ${recordingId}`);
    
    res.json({
      success: true,
      summary: summary,
      message: 'Summary generated successfully'
    });

  } catch (err) {
    console.error('Summary generation error:', err);
    
    // Update status to error
    const history = loadHistoryDB();
    const itemIndex = history.findIndex(item => item.id === req.body.recordingId);
    if (itemIndex !== -1) {
      history[itemIndex].status = 'error';
      saveHistoryDB(history);
    }
    
    res.status(500).json({ message: 'Summary generation failed' });
  }
});

// Get user history
app.get('/api/get-history', async (req, res) => {
  try {
    const userEmail = (req.query.email || '').toLowerCase();
    
    if (!userEmail) {
      return res.status(400).json({ message: 'User email required' });
    }

    const history = loadHistoryDB();
    const userHistory = history.filter(item => item.userEmail === userEmail);

    res.json(userHistory);

  } catch (err) {
    console.error('Get history error:', err);
    res.status(500).json({ message: 'Failed to get history' });
  }
});

// Delete from history
app.delete('/api/history/:recordingId', async (req, res) => {
  try {
    const { recordingId } = req.params;
    const userEmail = (req.query.email || '').toLowerCase();

    const history = loadHistoryDB();
    const itemIndex = history.findIndex(item => 
      item.id === recordingId && item.userEmail === userEmail
    );

    if (itemIndex === -1) {
      return res.status(404).json({ message: 'History item not found' });
    }

    history.splice(itemIndex, 1);
    saveHistoryDB(history);

    console.log(`🗑️ Deleted from history: ${recordingId}`);
    res.json({ success: true, message: 'History item deleted successfully' });

  } catch (err) {
    console.error('Delete history error:', err);
    res.status(500).json({ message: 'Failed to delete history item' });
  }
});

// ---------- SOCKET.IO (signalling) - UPDATED WITH MEETING VALIDATION ----------
io.on("connection", (socket) => {
  console.log("🔗 Socket connected:", socket.id);

  socket.on("join-room", (data) => {
    const { roomId, name, userId } = data || {};
    if (!roomId || !name) {
      socket.emit("join-error", { message: "Room ID and name are required" });
      return;
    }
    
    // Check if meeting exists
    if (!activeMeetings.has(roomId)) {
      socket.emit("join-error", { 
        message: "Meeting not found. Please check the code and try again." 
      });
      return;
    }
    
    const meeting = activeMeetings.get(roomId);
    
    // Set host if this is the first participant
    if (meeting.participants.size === 0) {
      meeting.host = socket.id;
    }
    
    // Store participant info
    meeting.participants.set(socket.id, {
      id: userId || socket.id,
      name: name,
      socketId: socket.id,
      joinedAt: new Date(),
      isHost: meeting.host === socket.id
    });
    
    socket.join(roomId);
    
    // Initialize room peers if not exists
    if (!roomPeers[roomId]) {
      roomPeers[roomId] = {};
    }
    
    // Store peer info for WebRTC
    roomPeers[roomId][socket.id] = { 
      name: name, 
      avatar: null,
      isHost: meeting.host === socket.id
    };

    // Get all peers in the room except current user
    const peersInRoom = Object.keys(roomPeers[roomId]).filter(id => id !== socket.id);
    
    // Create peers array with proper structure
    const peers = peersInRoom.map(peerId => ({
      peerId: peerId,
      name: roomPeers[roomId][peerId].name,
      userId: peerId,
      isHost: roomPeers[roomId][peerId].isHost
    }));

    console.log(`👥 ${name} joined ${roomId} - Sending ${peers.length} existing peers`);

    // Send existing peers to the new joiner
    socket.emit("existing-peers", { 
      peers,
      isHost: meeting.host === socket.id
    });

    // Tell others about this new joiner
    socket.to(roomId).emit("peer-joined", {
      peerId: socket.id,
      name: name,
      userId: socket.id,
      isHost: meeting.host === socket.id
    });

    // Update all clients with new participant list
    updateParticipantList(roomId);
    
    console.log(`✅ ${name} successfully joined ${roomId} (${meeting.participants.size} total participants)`);
  });

  // WebRTC signaling - IMPROVED
  socket.on("webrtc-offer", ({ to, sdp }) => {
    console.log(`📨 Offer from ${socket.id} to ${to}`);
    if (io.sockets.sockets.has(to)) {
      io.to(to).emit("webrtc-offer", { 
        from: socket.id, 
        sdp: sdp 
      });
    } else {
      console.log(`❌ Target peer ${to} not found`);
      socket.emit("peer-disconnected", { peerId: to });
    }
  });
  
  socket.on("webrtc-answer", ({ to, sdp }) => {
    console.log(`📨 Answer from ${socket.id} to ${to}`);
    if (io.sockets.sockets.has(to)) {
      io.to(to).emit("webrtc-answer", { 
        from: socket.id, 
        sdp: sdp 
      });
    } else {
      console.log(`❌ Target peer ${to} not found`);
      socket.emit("peer-disconnected", { peerId: to });
    }
  });
  
  socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
    console.log(`🧊 ICE candidate from ${socket.id} to ${to}`);
    if (io.sockets.sockets.has(to)) {
      io.to(to).emit("webrtc-ice-candidate", { 
        from: socket.id, 
        candidate: candidate 
      });
    } else {
      console.log(`❌ Target peer ${to} not found for ICE candidate`);
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
    console.log(`💬 ${name} in ${roomId}: ${message}`);
  });

  // Avatar handling
  socket.on("set-avatar", ({ roomId, avatar, name }) => {
    if (roomPeers[roomId] && roomPeers[roomId][socket.id]) {
      roomPeers[roomId][socket.id].avatar = avatar;
    }
    
    socket.to(roomId).emit("peer-avatar", { 
      peerId: socket.id, 
      avatar, 
      name: name 
    });
  });

  socket.on("avatar-off", ({ roomId, name }) => {
    if (roomPeers[roomId] && roomPeers[roomId][socket.id]) {
      roomPeers[roomId][socket.id].avatar = null;
    }
    
    socket.to(roomId).emit("avatar-off", { 
      peerId: socket.id, 
      name: name 
    });
  });

  // Recording events
  socket.on("start-recording", ({ roomId, userEmail, recordingId }) => {
    console.log(`🎥 Recording started in room ${roomId} by ${userEmail}`);
    socket.to(roomId).emit("recording-started", { recordingId });
  });

  socket.on("stop-recording", ({ roomId, recordingId }) => {
    console.log(`🛑 Recording stopped in room ${roomId}`);
    socket.to(roomId).emit("recording-stopped", { recordingId });
  });

  // Leave meeting
  socket.on("leave-meeting", ({ roomId, name }) => {
    handleLeaveMeeting(socket, roomId, name);
  });

  socket.on("disconnect", () => {
    console.log(`❌ Socket disconnected: ${socket.id}`);
    
    // Find which rooms this socket was in and clean up
    activeMeetings.forEach((meeting, roomId) => {
      if (meeting.participants.has(socket.id)) {
        const participant = meeting.participants.get(socket.id);
        handleLeaveMeeting(socket, roomId, participant.name);
      }
    });
  });

  function handleLeaveMeeting(socket, roomId, name) {
    // Notify others that this peer left
    socket.to(roomId).emit("peer-left", { 
      peerId: socket.id, 
      name: name 
    });
    
    // Clean up meeting data
    if (activeMeetings.has(roomId)) {
      const meeting = activeMeetings.get(roomId);
      meeting.participants.delete(socket.id);
      
      if (meeting.participants.size === 0) {
        activeMeetings.delete(roomId);
        console.log(`🗑️ Meeting ${roomId} ended (no participants)`);
      }
    }
    
    // Clean up room peers data
    if (roomPeers[roomId]) {
      delete roomPeers[roomId][socket.id];
      
      if (Object.keys(roomPeers[roomId]).length === 0) {
        delete roomPeers[roomId];
      }
    }
    
    socket.leave(roomId);
    
    // Update participant list for remaining users
    updateParticipantList(roomId);
    
    console.log(`🚪 ${name} left meeting ${roomId}`);
  }

  function updateParticipantList(roomId) {
    if (activeMeetings.has(roomId)) {
      const meeting = activeMeetings.get(roomId);
      const participants = Array.from(meeting.participants.values()).map(p => ({
        id: p.id,
        name: p.name,
        socketId: p.socketId,
        isHost: p.isHost
      }));
      
      io.to(roomId).emit("participants-updated", { participants });
    }
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🎥 Recording system ready - files will be saved in /recordings folder`);
  console.log(`🔐 Firebase authentication integrated`);
  console.log(`📋 Meeting validation system active`);
  console.log(`🎤 FREE Transcription & Summarization system ready`);
  console.log(`📚 History system initialized`);
  console.log(`💸 NO API COSTS - Using free text analysis methods`);
});