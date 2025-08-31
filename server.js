import express from "express";
import bodyParser from "body-parser";

const app = express();
const PORT = 3000;

// Middleware
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory lobbies (for demo)
let lobbies = {};

// Utility to generate 6-digit numeric codes
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Home screen
app.get("/", (req, res) => {
  res.render("home");
});

// Host options screen (new)
app.get("/host/options", (req, res) => {
  res.render("host-options");
});

// Create new room (auto-generate codes)
app.post("/host/create", (req, res) => {
  const roomCode = generateCode();
  const adminCode = generateCode();

  lobbies[roomCode] = {
    adminCode,
    participants: []
  };

  res.redirect(`/host/lobby/${roomCode}`);
});

// Host login screen (join existing)
app.get("/host/login", (req, res) => {
  res.render("host-login", { error: null });
});

// Host login submit
app.post("/host/login", (req, res) => {
  const { roomCode, adminCode } = req.body;
  const lobby = lobbies[roomCode];
  if (lobby && lobby.adminCode === adminCode) {
    res.redirect(`/host/lobby/${roomCode}`);
  } else {
    res.render("host-login", { error: "Invalid room or admin code" });
  }
});

// Host lobby
app.get("/host/lobby/:roomCode", (req, res) => {
  const roomCode = req.params.roomCode;
  const lobby = lobbies[roomCode];
  if (lobby) {
    const queue = lobby.participants.filter(p => p.requested);
    res.render("host-lobby", { roomCode, adminCode: lobby.adminCode, participants: queue });
  } else {
    res.redirect("/");
  }
});

// Participant login screen
app.get("/participant", (req, res) => {
  res.render("participant-login", { error: null });
});

// Participant login submit
app.post("/participant", (req, res) => {
  const { username, roomCode } = req.body;
  const lobby = lobbies[roomCode];
  if (lobby) {
    lobby.participants.push({ username, requested: false });
    res.redirect(`/participant/lobby/${roomCode}/${username}`);
  } else {
    res.render("participant-login", { error: "Invalid room code" });
  }
});

// Participant lobby screen
app.get("/participant/lobby/:roomCode/:username", (req, res) => {
  const { roomCode, username } = req.params;
  res.render("participant-lobby", { roomCode, username });
});

// Participant requests review
app.post("/participant/request", (req, res) => {
  const { username, roomCode } = req.body;
  const lobby = lobbies[roomCode];
  if (lobby) {
    const user = lobby.participants.find(p => p.username === username);
    if (user) user.requested = true;
    res.redirect(`/participant/lobby/${roomCode}/${username}`);
  } else {
    res.redirect("/participant");
  }
});

// Show the login form
app.get("/host/login", (req, res) => {
  res.render("host-login", { error: null });
});

// Handle the form submission
app.post("/host/login", (req, res) => {
  const { roomCode, adminCode } = req.body;
  const lobby = lobbies[roomCode];

  if (lobby && lobby.adminCode === adminCode) {
    res.redirect(`/host/lobby/${roomCode}`);
  } else {
    res.render("host-login", { error: "Invalid room or admin code" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});