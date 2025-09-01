const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Load achievements from achievements.json
let achievements = [];
const achievementsFilePath = path.join(__dirname, 'achievements.json');
try {
    const data = fs.readFileSync(achievementsFilePath, 'utf8');
    achievements = JSON.parse(data);
    console.log('Achievements loaded successfully.');
} catch (error) {
    console.error('Failed to load achievements.json:', error);
    console.error('Using an empty array for achievements.');
}

const lobbies = {};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to create a new lobby
app.post('/api/create-lobby', (req, res) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const adminCode = Math.random().toString(36).substring(2, 12);
    const boardSize = req.body.boardSize || 5;

    // Shuffle achievements and select a subset for the board
    const shuffledAchievements = [...achievements].sort(() => 0.5 - Math.random());
    const bingoBoard = shuffledAchievements.slice(0, boardSize * boardSize);

    lobbies[roomCode] = {
        adminCode: adminCode,
        boardSize: boardSize,
        bingoBoard: bingoBoard,
        pendingParticipants: [],
        participants: [],
        pendingRequests: []
    };

    console.log(`Lobby created: ${roomCode}`);
    res.json({ roomCode, adminCode });
});

// API endpoint for admin to join a lobby
app.post('/api/join-lobby', (req, res) => {
    const { roomCode, adminCode } = req.body;
    const lobby = lobbies[roomCode];

    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found.' });
    }

    if (lobby.adminCode !== adminCode) {
        return res.status(401).json({ error: 'Invalid admin code.' });
    }

    res.json({ message: 'Admin login successful.' });
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('joinRoom', ({ roomCode }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            socket.join(roomCode);
            socket.emit('lobbyUpdate', lobby);
            console.log(`Socket ${socket.id} joined room ${roomCode}`);
        }
    });

    socket.on('requestJoin', ({ roomCode, username }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const isUsernameTaken = lobby.participants.some(p => p.username === username) || lobby.pendingParticipants.some(p => p.username === username);
            if (isUsernameTaken) {
                socket.emit('custom-alert', { title: 'Username Taken', message: 'That username is already in use in this lobby.' });
                return;
            }
            lobby.pendingParticipants.push({ id: socket.id, username });
            io.to(roomCode).emit('lobbyUpdate', lobby);
            console.log(`User ${username} requested to join room ${roomCode}`);
        }
    });

    socket.on('approveJoin', ({ roomCode, username, team }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const pendingUserIndex = lobby.pendingParticipants.findIndex(p => p.username === username);
            if (pendingUserIndex !== -1) {
                const pendingUser = lobby.pendingParticipants.splice(pendingUserIndex, 1)[0];
                const newParticipant = {
                    id: pendingUser.id,
                    username,
                    team,
                    completedAchievements: [],
                    pendingReview: []
                };
                lobby.participants.push(newParticipant);
                // Tell the specific user they have been approved
                io.to(pendingUser.id).emit('participantApproved', { username });
                io.to(roomCode).emit('lobbyUpdate', lobby);
                console.log(`User ${username} approved for room ${roomCode} on team ${team}`);
            }
        }
    });
    
    socket.on('requestReview', ({ roomCode, username, achievements }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                achievements.forEach(achName => {
                    if (!participant.pendingReview.includes(achName)) {
                        participant.pendingReview.push(achName);
                    }
                });
                
                // Add to admin's pending requests
                achievements.forEach(achName => {
                    const existingRequest = lobby.pendingRequests.find(req => req.username === username && req.achievementName === achName);
                    if (!existingRequest) {
                         lobby.pendingRequests.push({ username, achievementName: achName });
                    }
                });

                io.to(roomCode).emit('lobbyUpdate', lobby);
                console.log(`Review requested by ${username} in room ${roomCode} for: ${achievements.join(', ')}`);
            }
        }
    });
    
    socket.on('markComplete', ({ roomCode, username, achievementName, team }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                // Check if the achievement is a pending review for the user
                const pendingIndex = participant.pendingReview.indexOf(achievementName);
                if (pendingIndex > -1) {
                    participant.pendingReview.splice(pendingIndex, 1);
                }

                // Add to the participant's completed list
                participant.completedAchievements.push({ name: achievementName, team });
            
                // Remove from the admin's pending requests
                const requestIndex = lobby.pendingRequests.findIndex(req => req.username === username && req.achievementName === achievementName);
                if (requestIndex > -1) {
                    lobby.pendingRequests.splice(requestIndex, 1);
                }

                io.to(roomCode).emit('lobbyUpdate', lobby);
                console.log(`Achievement '${achievementName}' marked complete for ${username} in room ${roomCode}`);
            }
        }
    });

    socket.on('dismissReview', ({ roomCode, username, achievementName }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
             const participant = lobby.participants.find(p => p.username === username);
             if (participant) {
                const pendingIndex = participant.pendingReview.indexOf(achievementName);
                if (pendingIndex > -1) {
                    participant.pendingReview.splice(pendingIndex, 1);
                }
             }

            const requestIndex = lobby.pendingRequests.findIndex(req => req.username === username && req.achievementName === achievementName);
            if (requestIndex > -1) {
                lobby.pendingRequests.splice(requestIndex, 1);
            }

            io.to(roomCode).emit('lobbyUpdate', lobby);
            console.log(`Review request for '${achievementName}' dismissed for ${username} in room ${roomCode}`);
        }
    });
    
    socket.on('manualChange', ({ roomCode, achievementName, newTeam }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const existingAchIndex = lobby.bingoBoard.findIndex(ach => ach.name === achievementName);
            if (existingAchIndex !== -1) {
                const existingAch = lobby.bingoBoard[existingAchIndex];
                
                if (newTeam) {
                    existingAch.team = newTeam;
                } else {
                    delete existingAch.team;
                }
            }
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });
    
    socket.on('teamMessage', (data) => {
        const { roomCode, username, message, team } = data;
        io.to(roomCode).emit('teamMessage', { username, message, team });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        for (const roomCode in lobbies) {
            const lobby = lobbies[roomCode];
            const participantIndex = lobby.participants.findIndex(p => p.id === socket.id);
            if (participantIndex !== -1) {
                lobby.participants.splice(participantIndex, 1);
                io.to(roomCode).emit('lobbyUpdate', lobby);
                console.log(`Participant with ID ${socket.id} left room ${roomCode}`);
            } else {
                const pendingIndex = lobby.pendingParticipants.findIndex(p => p.id === socket.id);
                if (pendingIndex !== -1) {
                    lobby.pendingParticipants.splice(pendingIndex, 1);
                    io.to(roomCode).emit('lobbyUpdate', lobby);
                    console.log(`Pending user with ID ${socket.id} left room ${roomCode}`);
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
