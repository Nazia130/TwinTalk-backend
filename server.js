const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Paths
const signupFile = path.join(__dirname, "signup.csv");

// --- Serve Frontend ---
// Default -> auth.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/auth.html"));
});
app.use(express.static(path.join(__dirname, "../frontend")));

// --- Signup Endpoint ---
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;

  // Validate fields
  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields required" });
  }

  // Append user to signup.csv
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

  // Read signup.csv and check credentials
  fs.readFile(signupFile, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading signup.csv:", err);
      return res.status(500).json({ message: "Login failed" });
    }

    const users = data.trim().split("\n").map(line => {
      const [name, userEmail, userPass] = line.split(",");
      return { name, email: userEmail, password: userPass };
    });

    const user = users.find(u => u.email === email && u.password === password);

    if (user) {
      console.log("User logged in:", email);
      res.json({ success: true, message: "Login successful" });
    } else {
      res.json({ success: false, message: "Invalid credentials" });
    }
  });
});

// --- Fallback for unknown routes ---
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/auth.html"));
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
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
