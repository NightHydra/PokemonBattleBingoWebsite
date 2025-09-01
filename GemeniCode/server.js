const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const LOBBIES = {};

const BASE_ACHIEVEMENTS = [
    { name: "First Blood", description: "Secure the first elimination of the game." },
    { name: "Pacifist", description: "Win a round without eliminating any opponents." },
    { name: "The Collector", description: "Collect 5 different power-ups in one round." },
    { name: "Sniper", description: "Eliminate an opponent from more than 100 meters away." },
    { name: "Unstoppable", description: "Eliminate 3 opponents in a row without taking damage." },
    { name: "Team Player", description: "Revive a teammate." },
    { name: "Solo Victory", description: "Win a round as the last person standing on your team." },
    { name: "Architect", description: "Build a structure with at least 50 pieces." },
    { name: "The Hoarder", description: "Have a full inventory of all item slots." },
    { name: "Marksman", description: "Land 10 headshots in a single round." },
    { name: "Medic", description: "Heal a total of 500 health to your teammates." },
    { name: "Explorer", description: "Discover a new area on the map." },
    { name: "Stealthy", description: "Eliminate an opponent with a melee attack." },
    { name: "Treasure Hunter", description: "Open 5 supply drops in a single game." },
    { name: "Lucky Shot", description: "Eliminate an opponent with a grenade or other explosive." },
    { name: "Hot Drop", description: "Eliminate an opponent within 30 seconds of landing." },
    { name: "The Bait", description: "Lure an enemy into a trap set by your teammate." },
    { name: "Close Call", description: "Win a fight with less than 10 health remaining." },
    { name: "Full Squad", description: "Eliminate an entire enemy squad by yourself." },
    { name: "The Flash", description: "Run for 1,000 meters in under a minute." },
    { name: "King of the Hill", description: "Be the last person alive in the final zone." },
    { name: "The Juggernaut", description: "Absorb more than 1,000 damage in a single round." },
    { name: "Supply Run", description: "Open 10 loot containers in a single game." },
    { name: "Master Builder", description: "Build a defensive wall while under heavy fire." },
    { name: "Grounded", description: "Eliminate a flying opponent." }
];

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Endpoint to serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to create a new lobby
app.post('/api/create-lobby', (req, res) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    const adminCode = Math.random().toString(36).substring(2, 8);

    // Create a randomized bingo board
    const bingoBoard = [...BASE_ACHIEVEMENTS]
        .sort(() => 0.5 - Math.random())
        .slice(0, 25);

    LOBBIES[roomCode] = {
        adminCode,
        bingoBoard,
        participants: [],
        pendingParticipants: [],
        chat: []
    };

    console.log(`Lobby created: ${roomCode} with admin code: ${adminCode}`);
    res.json({ roomCode, adminCode });
});

// Endpoint for participants to join a lobby
app.post('/api/join-lobby', (req, res) => {
    const { roomCode, username, role, adminCode } = req.body;
    const lobby = LOBBIES[roomCode];

    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found.' });
    }
    
    // Check if the user is a participant trying to join with a code
    if (role === 'participant') {
        return res.status(400).json({ error: 'Participants cannot join directly. They must request access.' });
    }

    if (role === 'admin') {
        if (adminCode !== lobby.adminCode) {
            return res.status(401).json({ error: 'Invalid admin code.' });
        }
        console.log(`Admin joined lobby ${roomCode}`);
        return res.json({ success: true, lobbyData: lobby });
    }

    res.status(400).json({ error: 'Invalid role or request.' });
});

// Socket.IO for real-time communication
io.on('connection', (socket) => {
    console.log('a user connected');

    socket.on('joinRoom', ({ roomCode }) => {
        socket.join(roomCode);
        console.log(`User joined socket room: ${roomCode}`);
        // Send initial state to the new user
        const lobby = LOBBIES[roomCode];
        if (lobby) {
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('requestJoin', ({ roomCode, username }) => {
        const lobby = LOBBIES[roomCode];
        if (lobby) {
            // Check if the username is already in active or pending lists
            const isUsernameTaken = lobby.participants.some(p => p.username === username) || lobby.pendingParticipants.some(p => p.username === username);
            if (isUsernameTaken) {
                socket.emit('joinError', 'Username already exists or is pending approval.');
                return;
            }
            // Store username and socket.id in pending list
            lobby.pendingParticipants.push({ username, socketId: socket.id });
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('approveJoin', ({ roomCode, username, team }) => {
        const lobby = LOBBIES[roomCode];
        if (lobby) {
            // Find the pending participant's object and get their socketId
            const pendingParticipant = lobby.pendingParticipants.find(p => p.username === username);
            if (!pendingParticipant) return; // Participant not found in pending list

            // Remove from pending list
            lobby.pendingParticipants = lobby.pendingParticipants.filter(p => p.username !== username);
            
            // Add to active participants
            lobby.participants.push({
                username,
                team,
                pendingReview: [],
                completedAchievements: []
            });
            
            // Emit full lobby update to everyone
            io.to(roomCode).emit('lobbyUpdate', lobby);
            
            // Emit specific approval event to only the approved participant
            io.to(pendingParticipant.socketId).emit('participantApproved', { username });
        }
    });

    socket.on('requestReview', ({ roomCode, username, achievements }) => {
        const lobby = LOBBIES[roomCode];
        const participant = lobby.participants.find(p => p.username === username);
        if (lobby && participant) {
            participant.pendingReview = [...new Set([...participant.pendingReview, ...achievements])];
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('markComplete', ({ roomCode, username, achievementName, team }) => {
        const lobby = LOBBIES[roomCode];
        const participant = lobby.participants.find(p => p.username === username);
        if (lobby && participant) {
            
            // Remove from pending
            participant.pendingReview = participant.pendingReview.filter(name => name !== achievementName);

            // Add to completed
            const existingAchievement = participant.completedAchievements.find(a => a.name === achievementName);
            if (!existingAchievement) {
                participant.completedAchievements.push({ name: achievementName, team });
            }

            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
