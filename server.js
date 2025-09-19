// server.js
const express = require("express");
const http = require("http");
const open = require("open"); // Use open.default for Node v22+
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Paths
const signupFile = path.join(__dirname, "signup.csv");
const frontendPath = path.join(__dirname, "frontend"); // frontend is now inside backend

// --- Serve Frontend ---
app.use(express.static(frontendPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "auth.html"));
});

// Fallback for unknown routes
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
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
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

// --- Socket.IO ---
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);
  });

  socket.on("signal", (data) => {
    io.to(data.to).emit("signal", { from: data.from, signal: data.signal });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // auto-open browser
});
