const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// In-memory data store for lobbies
const lobbies = {};

let achievements = [];

// Attempt to read achievements from achievements.json
const achievementsFilePath = path.join(__dirname, 'achievements.json');
try {
    const fileContent = fs.readFileSync(achievementsFilePath, 'utf8');
    const loadedAchievements = JSON.parse(fileContent);
    if (Array.isArray(loadedAchievements) && loadedAchievements.length > 0) {
        achievements = loadedAchievements;
        console.log(`Successfully loaded ${achievements.length} achievements from achievements.json.`);
    } else {
        console.warn('achievements.json is empty or not a valid array. The application may not function correctly.');
    }
} catch (error) {
    console.error('Error reading achievements.json. The application will not function correctly without an achievements file.');
    console.error(error);
}

function generateBingoBoard(size) {
    const shuffled = [...achievements].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, size * size);
    return selected.reduce((board, achievement) => {
        board[achievement.name] = {
            ...achievement,
            team: null,
        };
        return board;
    }, {});
}

// RESTORE LOBBY ENDPOINT
app.post('/api/restore-lobby', (req, res) => {
    const { saveData } = req.body;
    if (!saveData || !saveData.roomCode || !saveData.adminCode) {
        return res.status(400).json({ error: 'Invalid save data.' });
    }

    const roomCode = saveData.roomCode;
    // Wipe ephemeral connection data before restoring
    lobbies[roomCode] = {
        ...saveData,
        participants: saveData.participants.map(p => ({ ...p, socketId: null })),
        pendingParticipants: [],
        pendingRequests: saveData.pendingRequests || []
    };

    console.log(`Lobby restored from file: ${roomCode}`);
    res.json({ roomCode: lobbies[roomCode].roomCode, adminCode: lobbies[roomCode].adminCode });
});

app.post('/api/create-lobby', (req, res) => {
    const { boardSize } = req.body;
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    const adminCode = Math.random().toString(36).substring(2, 12);
    
    if (lobbies[roomCode]) {
        return res.status(409).json({ error: 'Room code collision, please try again.' });
    }

    lobbies[roomCode] = {
        roomCode,
        adminCode,
        boardSize,
        bingoBoard: generateBingoBoard(boardSize),
        participants: [],
        pendingParticipants: [],
        pendingRequests: [],
    };
    console.log(`Lobby created: ${roomCode}`);
    res.json({ roomCode, adminCode });
});

app.post('/api/join-lobby', (req, res) => {
    const { roomCode, role, adminCode } = req.body;
    const lobby = lobbies[roomCode];

    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found.' });
    }

    if (role === 'admin' && lobby.adminCode !== adminCode) {
        return res.status(401).json({ error: 'Invalid admin code.' });
    }

    res.json({ success: true });
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('joinRoom', ({ roomCode, username }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            socket.join(roomCode);
            
            // If this is a restoring user, re-link their socketId
            if (username) {
                const participant = lobby.participants.find(p => p.username === username);
                if (participant) participant.socketId = socket.id;
            }

            console.log(`${socket.id} joined room ${roomCode}`);
            io.to(roomCode).emit('lobbyUpdate', lobby);
        }
    });

    socket.on('requestJoin', ({ roomCode, username }) => {
        const lobby = lobbies[roomCode];
        if (lobby && !lobby.participants.some(p => p.username === username) && !lobby.pendingParticipants.some(p => p.username === username)) {
            lobby.pendingParticipants.push({ username, socketId: socket.id });
            console.log(`${username} requested to join lobby ${roomCode}`);
            io.to(roomCode).emit('lobbyUpdate', lobby);
        } else {
             io.to(socket.id).emit('participantApproved', { username: null, error: "Username already taken or room not found." });
        }
    });

    socket.on('approveJoin', ({ roomCode, username, team }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const pendingUser = lobby.pendingParticipants.find(p => p.username === username);
            if (pendingUser) {
                lobby.pendingParticipants = lobby.pendingParticipants.filter(p => p.username !== username);
                lobby.participants.push({ username, team, socketId: pendingUser.socketId, pendingReview: [] });
                console.log(`${username} approved and joined team ${team} in lobby ${roomCode}`);
                io.to(pendingUser.socketId).emit('participantApproved', { username });
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });

    socket.on('requestReview', ({ roomCode, username, achievements }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                participant.pendingReview = achievements;
                achievements.forEach(achievementName => {
                    // Prevent duplicate entries in the admin list
                    const exists = lobby.pendingRequests.some(r => r.username === username && r.achievementName === achievementName);
                    if (!exists) lobby.pendingRequests.push({ username, achievementName });
                });
                console.log(`${username} requested review for: ${achievements.join(', ')}`);
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });
    
    socket.on('markComplete', ({ roomCode, username, achievementName }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (!participant) return;

            const achievement = lobby.bingoBoard[achievementName];
            if (achievement) {
                achievement.team = participant.team;
                participant.pendingReview = participant.pendingReview.filter(a => a !== achievementName);
                lobby.pendingRequests = lobby.pendingRequests.filter(req => req.username !== username || req.achievementName !== achievementName);
                console.log(`Achievement '${achievementName}' marked for team ${participant.team} by ${username}`);
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });
    
    socket.on('dismissReview', ({ roomCode, username, achievementName }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                participant.pendingReview = participant.pendingReview.filter(a => a !== achievementName);
                lobby.pendingRequests = lobby.pendingRequests.filter(req => req.username !== username || req.achievementName !== achievementName);
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });
    
    socket.on('manualChange', ({ roomCode, achievementName, newTeam }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const achievement = lobby.bingoBoard[achievementName];
            if (achievement) {
                achievement.team = newTeam;
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });
    
    socket.on('sendChatMessage', ({ roomCode, message }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            const participant = lobby.participants.find(p => p.socketId === socket.id);
            if (participant) {
                const team = participant.team;
                const teamMembers = lobby.participants.filter(p => p.team === team);
                teamMembers.forEach(member => {
                    if (member.socketId) io.to(member.socketId).emit('chatMessage', { username: participant.username, message });
                });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
        for (const roomCode in lobbies) {
            const lobby = lobbies[roomCode];
            // Instead of deleting immediately, we just clear the socket link
            const p = lobby.participants.find(p => p.socketId === socket.id);
            if (p) p.socketId = null;
            
            lobby.pendingParticipants = lobby.pendingParticipants.filter(p => p.socketId !== socket.id);
            
            // Optional: Only delete if no one has been in the room for a long time
            // For now, keeping your existing cleanup logic but adapted for "Save/Load" reliability
            const activeParticipants = lobby.participants.filter(p => p.socketId !== null);
            if (activeParticipants.length === 0 && lobby.pendingParticipants.length === 0) {
                 // In a production app, you might want a timeout here before deletion
                 // delete lobbies[roomCode];
            } else {
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });
});

const os = require('os');
const listener = server.listen(0, () => {
    const port = listener.address().port;
    const networkInterfaces = os.networkInterfaces();
    let ipAddress = '127.0.0.1';
    for (const interfaceName in networkInterfaces) {
        for (const iface of networkInterfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ipAddress = iface.address;
                break;
            }
        }
    }
    console.log(`Server is running on http://${ipAddress}:${port}`);
});