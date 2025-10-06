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
const io = new Server(server, {
  cors: { origin: "*" },
});

// ---------- Middleware ----------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- Paths ----------
const signupFile = path.join(__dirname, "signup.csv");
const frontendPath = path.join(__dirname, "frontend");

// ---------- Serve Frontend ----------
app.use(express.static(frontendPath));
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "auth.html"));
});

// Fallback for all unknown routes
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(frontendPath, "auth.html"));
});

// ---------- Signup ----------
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields required" });
  }

  const line = `${name},${email},${password}\n`;
  fs.appendFile(signupFile, line, (err) => {
    if (err) {
      console.error("Error writing signup.csv:", err);
      return res.status(500).json({ message: "Signup failed" });
    }
    console.log("User signed up:", email);
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
    if (err) {
      console.error("Error reading signup.csv:", err);
      return res.status(500).json({ message: "Login failed" });
    }

    const users = data
      .trim()
      .split("\n")
      .map((line) => {
        const [name, userEmail, userPass] = line.split(",");
        return { name, email: userEmail, password: userPass };
      });

    const user = users.find((u) => u.email === email && u.password === password);
    if (user) {
      console.log("User logged in:", email);
      res.json({ success: true, message: "Login successful", user });
    } else {
      res.json({ success: false, message: "Invalid credentials" });
    }
  });
});

// ---------- Contact Form ----------
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

// ---------- Socket.IO Signaling ----------
io.on("connection", (socket) => {
  console.log("🔗 Connected:", socket.id);

  // JOIN ROOM
  socket.on("join-room", ({ roomId, name }) => {
    if (!roomId) roomId = "default";
    if (!name) name = "Guest";

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    // List current peers in the room (excluding self)
    const room = io.sockets.adapter.rooms.get(roomId);
    const peers = room ? [...room].filter((id) => id !== socket.id) : [];

    // Send existing peers to the newcomer
    socket.emit("existing-peers", { peers });

    // Notify others that a new peer joined
    socket.to(roomId).emit("peer-joined", { peerId: socket.id, name });

    console.log(`[ROOM: ${roomId}] ${socket.id} (${name}) joined. Peers: ${peers.length}`);
  });

  // WebRTC Signaling
  socket.on("webrtc-offer", ({ to, sdp }) => {
    io.to(to).emit("webrtc-offer", { from: socket.id, sdp });
  });

  socket.on("webrtc-answer", ({ to, sdp }) => {
    io.to(to).emit("webrtc-answer", { from: socket.id, sdp });
  });

  socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate });
  });

  // Chat
  socket.on("chat-message", ({ roomId, name, message }) => {
    io.to(roomId).emit("chat-message", { name, message });
  });

  // Emoji
  socket.on("emoji", ({ roomId, name, emoji }) => {
    io.to(roomId).emit("emoji", { name, emoji });
  });

  // Disconnect
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("peer-left", { peerId: socket.id });
      console.log(`[ROOM: ${roomId}] ${socket.id} left.`);
    }
  });
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
