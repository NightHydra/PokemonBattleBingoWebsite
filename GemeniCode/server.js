const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// In-memory data store for lobbies
const lobbies = {};

const achievements = [
    { name: "First Blood", description: "First to get an achievement." },
    { name: "Team Player", description: "Work with a teammate to complete an achievement." },
    { name: "Bingo!", description: "Complete a row, column, or diagonal." },
    { name: "Full Board", description: "Complete every achievement on the board." },
    { name: "Speed Demon", description: "Complete an achievement in under a minute." },
    { name: "Social Butterfly", description: "Complete an achievement with someone you just met." },
    { name: "Lone Wolf", description: "Complete an achievement by yourself." },
    { name: "Creative Solution", description: "Complete an achievement in an unconventional way." },
    { name: "Golden Star", description: "Get a perfect score on an achievement." },
    { name: "Epic Fail", description: "Attempt an achievement and fail spectacularly." },
    { name: "Ghost", description: "Complete an achievement without anyone noticing." },
    { name: "High Five", description: "High five everyone on your team." },
    { name: "Joke of the Day", description: "Tell a joke and make at least two people laugh." },
    { name: "Mime", description: "Communicate using only gestures for five minutes." },
    { name: "Soundtrack of Success", description: "Play a victory song after completing an achievement." },
    { name: "Secret Handshake", description: "Create a secret handshake with a teammate." },
    { name: "Time Traveler", description: "Correctly guess the time without looking at a clock." },
    { name: "Human Statue", description: "Stand perfectly still for one minute." },
    { name: "Memory Master", description: "Recite the first ten digits of pi from memory." },
    { name: "Ninja", description: "Silently sneak up on a teammate." },
    { name: "Copycat", description: "Imitate a teammate's mannerisms for two minutes." },
    { name: "The Architect", description: "Build the tallest tower using only office supplies." },
    { name: "The Magician", description: "Perform a simple magic trick." },
    { name: "Storyteller", description: "Create a five-sentence story with a teammate." },
    { name: "Mind Reader", description: "Guess a teammate's favorite color correctly." },
    { name: "Juggler", description: "Juggle two or more items for ten seconds." },
];

function generateBingoBoard(size) {
    const shuffled = [...achievements].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, size * size);
    
    // Refactored to return an object instead of an array
    return selected.reduce((board, achievement) => {
        board[achievement.name] = {
            ...achievement,
            team: null,
        };
        return board;
    }, {});
}

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

    socket.on('joinRoom', ({ roomCode }) => {
        const lobby = lobbies[roomCode];
        if (lobby) {
            socket.join(roomCode);
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
                lobby.pendingRequests = lobby.pendingRequests.filter(req => req.username !== username);
                achievements.forEach(achievementName => {
                    lobby.pendingRequests.push({ username, achievementName });
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

            // Direct access to the achievement object
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
            // Direct access to the achievement object
            const achievement = lobby.bingoBoard[achievementName];
            if (achievement) {
                achievement.team = newTeam;
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
        // Find and remove the disconnected user from all lobbies
        for (const roomCode in lobbies) {
            const lobby = lobbies[roomCode];
            lobby.participants = lobby.participants.filter(p => p.socketId !== socket.id);
            lobby.pendingParticipants = lobby.pendingParticipants.filter(p => p.socketId !== p.socketId);
            if (lobby.participants.length === 0 && lobby.pendingParticipants.length === 0) {
                delete lobbies[roomCode];
                console.log(`Lobby ${roomCode} disbanded.`);
            } else {
                io.to(roomCode).emit('lobbyUpdate', lobby);
            }
        }
    });
});

server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});
