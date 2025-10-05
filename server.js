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
  cors: { origin: "*" }
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Paths
const signupFile = path.join(__dirname, "signup.csv");
const frontendPath = path.join(__dirname, "frontend");

// --- Serve Frontend ---
app.use(express.static(frontendPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "auth.html"));
});

// Fallback for unknown routes -> SPA style
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(frontendPath, "auth.html"));
});

// --- Signup Endpoint ---
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields required" });
  }
  const userLine = `${name},${email},${password}\n`;
  fs.appendFile(signupFile, userLine, (err) => {
    if (err) {
      console.error("Error writing signup.csv:", err);
      return res.status(500).json({ message: "Signup failed" });
    }
    console.log("User signed up:", email);
    res.json({ message: "Signup successful" });
  });
});

// --- Login Endpoint ---
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

// --- Contact Endpoint (Email) ---
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

// -----------------------
// Socket.IO — Signaling
// -----------------------
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // --- Join Room (handles new & old emit styles) ---
  socket.on("join-room", (arg1, arg2, arg3) => {
    let roomId, name;

    // New style: socket.emit("join-room", { roomId, name })
    if (arg1 && typeof arg1 === "object") {
      roomId = arg1.roomId;
      name = arg1.name;
    } else {
      // Old style: socket.emit("join-room", roomId, socket.id, name)
      roomId = arg1;
      name = arg3; // arg2 was socket.id in old code
    }

    if (!roomId || typeof roomId !== "string") {
      console.warn("join-room called without a valid roomId; defaulting to 'default'");
      roomId = "default";
    }
    if (!name || typeof name !== "string") {
      name = "Guest";
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    // List current peers in room (excluding self)
    const room = io.sockets.adapter.rooms.get(roomId);
    const peers = room ? [...room].filter((id) => id !== socket.id) : [];

    // Tell the new client who's already here
    socket.emit("existing-peers", { peers });

    // Tell others someone joined
    socket.to(roomId).emit("peer-joined", { peerId: socket.id, name: socket.data.name });

    console.log(`[${roomId}] ${socket.id} (${socket.data.name}) joined. Peers: ${peers.length}`);
  });

  // --- WebRTC relay ---
  socket.on("webrtc-offer", ({ to, sdp }) => {
    io.to(to).emit("webrtc-offer", { from: socket.id, sdp });
  });

  socket.on("webrtc-answer", ({ to, sdp }) => {
    io.to(to).emit("webrtc-answer", { from: socket.id, sdp });
  });

  socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate });
  });

  // --- Chat + Emoji ---
  socket.on("chat-message", ({ roomId, name, message }) => {
    io.to(roomId).emit("chat-message", { name, message });
  });

  socket.on("emoji", ({ roomId, name, emoji }) => {
    io.to(roomId).emit("emoji", { name, emoji });
  });

  // --- Leaving ---
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("peer-left", { peerId: socket.id });
      console.log(`[${roomId}] ${socket.id} left.`);
    } else {
      console.log("Disconnected:", socket.id);
    }
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
