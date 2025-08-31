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
        participants: {},
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

    if (role === 'participant') {
        if (!username) {
            return res.status(400).json({ error: 'Username is required.' });
        }
        if (lobby.participants[username]) {
            return res.status(409).json({ error: 'Username already exists in this lobby.' });
        }
        lobby.participants[username] = {
            pendingReview: [],
            completedAchievements: []
        };
        console.log(`Participant ${username} joined lobby ${roomCode}`);
        io.to(roomCode).emit('lobbyUpdate', lobby);
        return res.json({ success: true, lobbyData: lobby });
    } else if (role === 'admin') {
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

    socket.on('requestReview', ({ roomCode, username, achievements }) => {
        const lobby = LOBBIES[roomCode];
        if (lobby && lobby.participants[username]) {
            const participant = lobby.participants[username];
            participant.pendingReview = [...new Set([...participant.pendingReview, ...achievements])];
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('markComplete', ({ roomCode, username, achievementName }) => {
        const lobby = LOBBIES[roomCode];
        if (lobby && lobby.participants[username]) {
            const participant = lobby.participants[username];
            
            // Remove from pending
            participant.pendingReview = participant.pendingReview.filter(name => name !== achievementName);

            // Add to completed
            if (!participant.completedAchievements.includes(achievementName)) {
                participant.completedAchievements.push(achievementName);
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
