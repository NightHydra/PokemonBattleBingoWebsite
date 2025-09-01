const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const LOBBIES = {};

let ACHIEVEMENTS = [];

// Attempt to read achievements from achievements.json
const achievementsFilePath = path.join(__dirname, 'achievements.json');
try {
    const fileContent = fs.readFileSync(achievementsFilePath, 'utf8');
    const loadedAchievements = JSON.parse(fileContent);
    if (Array.isArray(loadedAchievements) && loadedAchievements.length > 0) {
        ACHIEVEMENTS = loadedAchievements;
        console.log(`Successfully loaded ${ACHIEVEMENTS.length} achievements from achievements.json.`);
    } else {
        console.warn('achievements.json is empty or not a valid array. The application may not function correctly.');
    }
} catch (error) {
    console.error('Error reading achievements.json. The application will not function correctly without an achievements file.');
    console.error(error);
}


app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Endpoint to serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to create a new lobby
app.post('/api/create-lobby', (req, res) => {
    const boardSize = parseInt(req.body.boardSize, 10);
    if (isNaN(boardSize) || boardSize < 3 || boardSize > 16) {
        return res.status(400).json({ error: 'Invalid board size. Must be between 3 and 16.' });
    }

    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    const adminCode = Math.random().toString(36).substring(2, 8);
    const requiredAchievements = boardSize * boardSize;

    if (ACHIEVEMENTS.length === 0) {
        return res.status(500).json({ error: "No achievements found. Please ensure achievements.json is a valid file." });
    }

    if (ACHIEVEMENTS.length < requiredAchievements) {
        return res.status(500).json({ error: `Not enough achievements to create a ${boardSize}x${boardSize} board. Please try a smaller size.` });
    }

    // Create a randomized bingo board and add the 'team' property
    const bingoBoard = [...ACHIEVEMENTS]
        .sort(() => 0.5 - Math.random())
        .slice(0, requiredAchievements)
        .map(achievement => ({ ...achievement, team: null }));

    LOBBIES[roomCode] = {
        adminCode,
        boardSize,
        bingoBoard,
        participants: [],
        pendingParticipants: [],
        pendingRequests: []
    };

    console.log(`Lobby created: ${roomCode} with admin code: ${adminCode} and board size ${boardSize}x${boardSize}`);
    res.json({ roomCode, adminCode, boardSize });
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
        return res.json({ success: true, lobbyData: lobby, boardSize: lobby.boardSize });
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
                pendingReview: []
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
            // Add to the participant's list for their own board's yellow squares
            participant.pendingReview = [...new Set([...participant.pendingReview, ...achievements])];
            
            // Add individual requests to the global ordered list for the admin
            achievements.forEach(achievementName => {
                lobby.pendingRequests.push({ username, achievementName });
            });
            
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('markComplete', ({ roomCode, username, achievementName, team }) => {
        const lobby = LOBBIES[roomCode];
        const participant = lobby.participants.find(p => p.username === username);
        if (lobby) {
            
            // Remove from participant's local pending list
            if (participant) {
                participant.pendingReview = participant.pendingReview.filter(name => name !== achievementName);
            }

            // Find the achievement on the main board and set its team
            const achievementOnBoard = lobby.bingoBoard.find(a => a.name === achievementName);
            if (achievementOnBoard) {
                achievementOnBoard.team = team;
            }
            
            // Automatically clear all pending requests for this achievement from the global queue
            lobby.pendingRequests = lobby.pendingRequests.filter(req => req.achievementName !== achievementName);

            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('dismissReview', ({ roomCode, username, achievementName }) => {
        const lobby = LOBBIES[roomCode];
        const participant = lobby.participants.find(p => p.username === username);

        if (lobby && participant) {
            // Remove the achievement from the participant's pending list
            participant.pendingReview = participant.pendingReview.filter(name => name !== achievementName);

            // Remove the specific request from the global pending requests queue
            lobby.pendingRequests = lobby.pendingRequests.filter(req => !(req.username === username && req.achievementName === achievementName));
            
            // Send the updated lobby state to all connected clients
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });
    
    socket.on('manualChange', ({ roomCode, achievementName, newTeam }) => {
        const lobby = LOBBIES[roomCode];
        if (lobby) {
            // Clear any pending requests for this achievement first
            lobby.pendingRequests = lobby.pendingRequests.filter(req => req.achievementName !== achievementName);
            
            // Find the achievement on the main board and set its team
            const achievementOnBoard = lobby.bingoBoard.find(a => a.name === achievementName);
            if (achievementOnBoard) {
                achievementOnBoard.team = newTeam;
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
