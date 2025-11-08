// server.js – TwinTalk full server (auth + signalling + history)
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

// ---------- MIDDLEWARE ----------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- CSV HELPERS ----------
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
    /[\r\n]/g,
    " "
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

// ---------- CONTACT ----------
app.post("/contact", async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)
    return res.status(500).send("Email env vars not set.");
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: email,
      to: process.env.EMAIL_USER,
      subject: `Contact: ${name}`,
      text: message || "",
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
          summary: parts[3] || "",
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
    fs.writeFileSync(
      historyFile,
      raw.join("\n") + (raw.length ? "\n" : ""),
      "utf8"
    );
    console.log(`🗑 Deleted history ${idx} for ${email}`);
    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error("delete history error:", err);
    return res.status(500).json({ message: "Delete failed" });
  }
});

// ---------- SOCKET.IO (signalling) ----------
const roomNames = {}; // store { socketId: { name, roomId } }

io.on("connection", (socket) => {
  console.log("🔗 Socket connected:", socket.id);

  socket.on("join-room", (data) => {
    const { roomId, name } = data || {};
    if (!roomId) return;
    socket.join(roomId);
    roomNames[socket.id] = { name: name || "Guest", roomId };

    // collect peers with names
    const room = io.sockets.adapter.rooms.get(roomId);
    const peers =
      room && room.size
        ? [...room].filter((id) => id !== socket.id).map((id) => ({
            peerId: id,
            name: roomNames[id]?.name || "Participant",
          }))
        : [];

    // send existing peers (with names) to the new joiner
    socket.emit("existing-peers", { peers });

    // tell others about this joiner
    socket.to(roomId).emit("peer-joined", {
      peerId: socket.id,
      name: roomNames[socket.id].name,
    });

    console.log(`👥 ${roomNames[socket.id].name} joined ${roomId} (${peers.length} peers)`);
  });

  socket.on("webrtc-offer", ({ to, sdp }) =>
    io.to(to).emit("webrtc-offer", { from: socket.id, sdp })
  );
  socket.on("webrtc-answer", ({ to, sdp }) =>
    io.to(to).emit("webrtc-answer", { from: socket.id, sdp })
  );
  socket.on("webrtc-ice-candidate", ({ to, candidate }) =>
    io.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate })
  );

  socket.on("chat-message", ({ roomId, name, message }) =>
    io.to(roomId).emit("chat-message", { name, message })
  );

  socket.on("set-avatar", ({ roomId, avatar, name }) =>
    socket.to(roomId).emit("peer-avatar", { peerId: socket.id, avatar, name })
  );

  socket.on("disconnect", () => {
    const data = roomNames[socket.id];
    if (data?.roomId) {
      socket
        .to(data.roomId)
        .emit("peer-left", { peerId: socket.id, name: data.name });
      console.log(`❌ ${data.name} left ${data.roomId}`);
    }
    delete roomNames[socket.id];
  });
});

// ---------- START ----------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
