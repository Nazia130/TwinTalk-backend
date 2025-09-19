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

// CSV file path
const signupFile = path.join(__dirname, "signup.csv");

// Ensure signup.csv exists with headers
if (!fs.existsSync(signupFile)) {
  fs.writeFileSync(signupFile, "name,email,password\n", "utf8");
}

// --- Serve Frontend ---
app.use(express.static(path.join(__dirname, "../frontend")));

// Default route -> auth.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/auth.html"));
});

// --- Signup Endpoint ---
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }

  // Read existing users
  fs.readFile(signupFile, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading signup.csv:", err);
      return res.status(500).json({ message: "Signup failed" });
    }

    const users = data
      .trim()
      .split("\n")
      .slice(1) // skip header
      .map(line => {
        const [uName, uEmail, uPass] = line.split(",");
        return { name: uName, email: uEmail, password: uPass };
      });

    if (users.find(u => u.email === email)) {
      return res.status(400).json({ message: "User already exists. Please login." });
    }

    // Append new user
    fs.appendFile(signupFile, `${name},${email},${password}\n`, err => {
      if (err) {
        console.error("Error writing to signup.csv:", err);
        return res.status(500).json({ message: "Signup failed" });
      }
      console.log("User signed up:", email);
      res.json({ success: true, message: "Signup successful" });
    });
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
      .slice(1) // skip header
      .map(line => {
        const [name, uEmail, uPass] = line.split(",");
        return { name, email: uEmail, password: uPass };
      });

    const user = users.find(u => u.email === email && u.password === password);

    if (user) {
      console.log("User logged in:", email);
      res.json({ success: true, message: "Login successful", user: { name: user.name, email: user.email } });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials. Please sign up first." });
    }
  });
});

// --- Fallback for unknown routes ---
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/auth.html"));
});

// --- Socket.IO ---
io.on("connection", socket => {
  console.log("A user connected:", socket.id);

  socket.on("join-room", roomId => {
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);
  });

  socket.on("signal", data => {
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
