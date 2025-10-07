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

// -------- Paths --------
const signupFile = path.join(__dirname, "signup.csv");
const frontendPath = path.join(__dirname, "frontend");
const historyFile = path.join(__dirname, "history.csv");

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(frontendPath));

// -------- Routes --------
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "auth.html")));

// ---------- Signup ----------
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: "All fields required" });

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
  if (!email || !password) return res.status(400).json({ message: "Email and password required" });

  fs.readFile(signupFile, "utf8", (err, data) => {
    if (err) return res.status(500).json({ message: "Login failed" });
    const users = data.trim().split("\n").map(line => {
      const [name, userEmail, userPass] = line.split(",");
      return { name, email: userEmail, password: userPass };
    });
    const user = users.find(u => u.email === email && u.password === password);
    if (user) {
      console.log("✅ User logged in:", email);
      res.json({ success: true, message: "Login successful", user });
    } else res.json({ success: false, message: "Invalid credentials" });
  });
});

// ---------- Contact ----------
app.post("/contact", async (req, res) => {
  const { name, email, message } = req.body;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)
    return res.status(500).send("Email environment variables not set.");
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
    console.error("❌ Email error:", err);
    res.status(500).send("Failed to send message.");
  }
});

// ---------- NLP-style Summarizer ----------
function simpleSummarize(text) {
  const clean = text.replace(/\n/g, " ").replace(/[^a-zA-Z0-9. ]/g, " ");
  const sentences = clean.split(/[.?!]/).map(s => s.trim()).filter(Boolean);
  const freq = {};
  clean.toLowerCase().split(/\s+/).forEach(w => { if (w.length > 3) freq[w] = (freq[w] || 0) + 1; });
  const scored = sentences.map(s => {
    let score = 0;
    s.toLowerCase().split(/\s+/).forEach(w => score += freq[w] || 0);
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(x => "• " + x.s.trim()).join("\n") || "No significant content.";
}

// ---------- History ----------
app.post("/save-summary", (req, res) => {
  const { meetingId, transcript } = req.body;
  if (!meetingId || !transcript) return res.status(400).json({ message: "meetingId and transcript required" });

  const summary = simpleSummarize(transcript);
  const date = new Date().toLocaleString("en-IN", { hour12: false });
  const row = `"${date}","${meetingId.replace(/"/g, "'")}","${summary.replace(/"/g, "'")}"\n`;
  fs.appendFile(historyFile, row, (err) => {
    if (err) return res.status(500).json({ message: "Save failed" });
    console.log(`✅ Summary saved for [${meetingId}]`);
    res.json({ message: "Summary saved", summary });
  });
});

app.get("/history", (req, res) => {
  if (!fs.existsSync(historyFile)) return res.json([]);
  fs.readFile(historyFile, "utf8", (err, data) => {
    if (err) return res.status(500).json({ message: "Read error" });
    const rows = data.trim().split("\n").map(line => {
      const [date, meetingId, summary] = line
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map(s => s.replace(/(^"|"$)/g, ""));
      return { date, meetingId, summary };
    });
    res.json(rows);
  });
});

app.delete("/history/:index", (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx)) return res.status(400).json({ message: "Invalid index" });
  if (!fs.existsSync(historyFile)) return res.status(404).json({ message: "No history file" });

  fs.readFile(historyFile, "utf8", (err, data) => {
    if (err) return res.status(500).json({ message: "Read error" });
    let rows = data.trim().split("\n");
    if (idx < 0 || idx >= rows.length) return res.status(404).json({ message: "Entry not found" });

    rows.splice(idx, 1);
    fs.writeFile(historyFile, rows.join("\n") + (rows.length ? "\n" : ""), (err) => {
      if (err) return res.status(500).json({ message: "Delete failed" });
      console.log(`🗑 Deleted history entry [${idx}]`);
      res.json({ message: "Deleted" });
    });
  });
});

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  console.log("🔗 Connected:", socket.id);

  socket.on("join-room", (arg1, arg2, arg3) => {
    let roomId, name;
    if (arg1 && typeof arg1 === "object") { roomId = arg1.roomId; name = arg1.name; }
    else { roomId = arg1; name = arg3; }
    if (!roomId) roomId = "default";
    if (!name) name = "Guest";

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    const room = io.sockets.adapter.rooms.get(roomId);
    const peers = room ? [...room].filter(id => id !== socket.id) : [];
    socket.emit("existing-peers", { peers });
    socket.to(roomId).emit("peer-joined", { peerId: socket.id, name });

    console.log(`👥 [${roomId}] ${name} joined. Current peers: ${peers.length}`);
  });

  socket.on("webrtc-offer", ({ to, sdp }) => {
    console.log("➡️ Offer to", to);
    io.to(to).emit("webrtc-offer", { from: socket.id, sdp });
  });
  socket.on("webrtc-answer", ({ to, sdp }) => {
    console.log("⬅️ Answer to", to);
    io.to(to).emit("webrtc-answer", { from: socket.id, sdp });
  });
  socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
    console.log("❄️ ICE to", to);
    io.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate });
  });

  socket.on("chat-message", ({ roomId, name, message }) => {
    io.to(roomId).emit("chat-message", { name, message });
  });

  socket.on("set-avatar", ({ roomId, avatar, name }) => {
    socket.to(roomId).emit("peer-avatar", { peerId: socket.id, avatar, name });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit("peer-left", { peerId: socket.id });
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
