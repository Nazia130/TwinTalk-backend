// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- Paths ----------
const signupFile = path.join(__dirname, "signup.csv");
const frontendPath = path.join(__dirname, "frontend");
const historyFile = path.join(__dirname, "history.csv");

// ---------- Serve Frontend ----------
app.use(express.static(frontendPath));
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "auth.html"));
});

// ---------- Signup ----------
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields required" });
  }
  const userLine = `${name},${email},${password}\n`;
  fs.appendFile(signupFile, userLine, (err) => {
    if (err) return res.status(500).json({ message: "Signup failed" });
    console.log("✅ User signed up:", email);
    res.json({ message: "Signup successful" });
  });
});

// ---------- Login ----------
app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password required" });
  }
  fs.readFile(signupFile, "utf8", (err, data) => {
    if (err) return res.status(500).json({ message: "Login failed" });
    const users = data
      .trim()
      .split("\n")
      .map((line) => {
        const [name, userEmail, userPass] = line.split(",");
        return { name, email: userEmail, password: userPass };
      });
    const user = users.find((u) => u.email === email && u.password === password);
    if (user) {
      console.log("✅ User logged in:", email);
      res.json({ success: true, message: "Login successful", user });
    } else {
      res.json({ success: false, message: "Invalid credentials" });
    }
  });
});

// ---------- Contact ----------
app.post("/contact", async (req, res) => {
  const { name, email, message } = req.body;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.status(500).send("Email environment variables not set.");
  }
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: email,
      to: process.env.EMAIL_USER,
      subject: `Contact Form: ${name}`,
      text: message,
    });
    res.send("✅ Message sent successfully!");
  } catch (err) {
    console.error("❌ Error sending email:", err);
    res.status(500).send("Failed to send message.");
  }
});


// ==========================
// 📌 NLP-Style Summarizer
// ==========================
function simpleSummarize(text) {
  // 1. Normalize
  const clean = text.replace(/\n/g, " ").replace(/[^a-zA-Z0-9. ]/g, " ");
  const sentences = clean.split(/[.?!]/).map(s => s.trim()).filter(Boolean);

  // 2. Score words by frequency
  const freq = {};
  const words = clean.toLowerCase().split(/\s+/);
  words.forEach(w => { if (w.length > 3) freq[w] = (freq[w] || 0) + 1; });

  // 3. Rank sentences
  const scored = sentences.map(s => {
    let score = 0;
    s.toLowerCase().split(/\s+/).forEach(w => { score += freq[w] || 0; });
    return { s, score };
  });

  // 4. Pick top 5 sentences
  scored.sort((a, b) => b.score - a.score);
  const summary = scored.slice(0, 5).map(x => "• " + x.s.trim()).join("\n");

  return summary || "No significant content to summarize.";
}


// ==========================
// 📁 Meeting History Routes
// ==========================
app.post("/save-summary", (req, res) => {
  const { meetingId, transcript } = req.body;
  if (!meetingId || !transcript) {
    return res.status(400).json({ message: "meetingId and transcript required" });
  }

  const summary = simpleSummarize(transcript);
  const date = new Date().toLocaleString("en-IN", { hour12: false });

  const row = `"${date}","${meetingId.replace(/"/g, "'")}","${summary.replace(/"/g, "'")}"\n`;
  fs.appendFile(historyFile, row, (err) => {
    if (err) return res.status(500).json({ message: "Failed to save summary" });
    console.log(`✅ Summary saved for [${meetingId}]`);
    res.json({ message: "Summary saved", summary });
  });
});

app.get("/history", (req, res) => {
  if (!fs.existsSync(historyFile)) return res.json([]);
  fs.readFile(historyFile, "utf8", (err, data) => {
    if (err) return res.status(500).json({ message: "Error reading history" });

    const rows = data.trim().split("\n").map(line => {
      const [date, meetingId, summary] = line
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map(s => s.replace(/(^"|"$)/g, ""));
      return { date, meetingId, summary };
    });

    res.json(rows);
  });
});
// 🗑 DELETE a history entry by index
app.delete("/history/:index", (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx)) return res.status(400).json({ message: "Invalid index" });

  if (!fs.existsSync(historyFile)) return res.status(404).json({ message: "History file not found" });

  fs.readFile(historyFile, "utf8", (err, data) => {
    if (err) return res.status(500).json({ message: "Error reading history file" });

    let rows = data.trim().split("\n");
    if (idx < 0 || idx >= rows.length) {
      return res.status(404).json({ message: "Entry not found" });
    }

    // Remove the entry at idx
    rows.splice(idx, 1);

    // Rewrite the file
    fs.writeFile(historyFile, rows.join("\n") + (rows.length ? "\n" : ""), (err) => {
      if (err) return res.status(500).json({ message: "Failed to delete entry" });
      console.log(`🗑 Deleted history entry at index ${idx}`);
      res.json({ message: "Entry deleted successfully" });
    });
  });
});



// ==========================
// 🔌 Socket.IO Signalling
// ==========================
io.on("connection", (socket) => {
  console.log("🔗 Connected:", socket.id);

  socket.on("join-room", (arg1, arg2, arg3) => {
    let roomId, name;
    if (arg1 && typeof arg1 === "object") {
      roomId = arg1.roomId;
      name = arg1.name;
    } else {
      roomId = arg1;
      name = arg3;
    }
    if (!roomId) roomId = "default";
    if (!name) name = "Guest";

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    const room = io.sockets.adapter.rooms.get(roomId);
    const peers = room ? [...room].filter((id) => id !== socket.id) : [];

    socket.emit("existing-peers", { peers });
    socket.to(roomId).emit("peer-joined", { peerId: socket.id, name });

    console.log(`[${roomId}] ${name} joined.`);
  });

  socket.on("webrtc-offer", ({ to, sdp }) => io.to(to).emit("webrtc-offer", { from: socket.id, sdp }));
  socket.on("webrtc-answer", ({ to, sdp }) => io.to(to).emit("webrtc-answer", { from: socket.id, sdp }));
  socket.on("webrtc-ice-candidate", ({ to, candidate }) => io.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate }));

  socket.on("chat-message", ({ roomId, name, message }) =>
    io.to(roomId).emit("chat-message", { name, message })
  );

  socket.on("set-avatar", ({ roomId, avatar, name }) => {
    socket.to(roomId).emit("peer-avatar", { peerId: socket.id, avatar, name });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit("peer-left", { peerId: socket.id });
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});


// ==========================
// 🚀 Start Server
// ==========================
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
