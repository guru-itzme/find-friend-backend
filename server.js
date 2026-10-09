const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// NEW: Enable CORS so Netlify can talk to Render
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// --- ADMIN SECRETS & MEMORY ---

const ADMIN_PASSWORD = "findfriend123"; 
let waitingQueue = [];
let bannedIPs = new Set(); 

app.use(express.static(__dirname));

// --- SECURITY MIDDLEWARE ---
io.use((socket, next) => {
    const userIP = socket.handshake.address;
    if (bannedIPs.has(userIP)) {
        return next(new Error("You are permanently banned from Find Friend."));
    }
    next();
});

// --- HELPER: BROADCAST STATS TO ADMINS ---
function broadcastAdminStats() {
    io.to('admin_room').emit('admin_stats_update', {
        totalUsers: io.engine.clientsCount,
        queueCount: waitingQueue.length,
        bannedCount: bannedIPs.size
    });
}

io.on('connection', (socket) => {
    const userIP = socket.handshake.address;
    broadcastAdminStats(); 

    // --- ADMIN CONTROLS ---
    socket.on('admin_login', (password) => {
        if (password === ADMIN_PASSWORD) {
            socket.join('admin_room');
            socket.emit('admin_auth_success');
            broadcastAdminStats(); 
        } else {
            socket.emit('admin_auth_fail');
        }
    });

    socket.on('admin_ban_ip', (ipToBan) => {
        bannedIPs.add(ipToBan);
        
        for (let [id, s] of io.sockets.sockets.entries()) {
            if (s.handshake.address === ipToBan) {
                s.disconnect(true); 
            }
        }
        broadcastAdminStats();
    });

    // --- CORE CHAT LOGIC ---
    const handleLeave = (isReport = false, isSkip = false) => {
        waitingQueue = waitingQueue.filter((id) => id !== socket.id);
        
        const roomId = socket.currentRoom;
        if (roomId) {
            if (isReport) {
                const partnerSocket = [...io.sockets.sockets.values()].find(
                    s => s.currentRoom === roomId && s.id !== socket.id
                );
                if (partnerSocket) {
                    io.to('admin_room').emit('new_report', { ip: partnerSocket.handshake.address });
                }
            }

            const eventName = (isSkip || isReport) ? 'stranger_left' : 'stranger_offline';
            socket.to(roomId).emit(eventName);
            
            const partnerSocket = [...io.sockets.sockets.values()].find(
                s => s.currentRoom === roomId && s.id !== socket.id
            );
            if (partnerSocket) {
                partnerSocket.leave(roomId);
                partnerSocket.currentRoom = null;
            }
            
            socket.leave(roomId);
            socket.currentRoom = null;
        }
        broadcastAdminStats(); 
    };

    socket.on('find_stranger', () => {
        if (waitingQueue.includes(socket.id)) return;

        if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            const roomId = `room_${partnerId}_${socket.id}`;
            
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
                partnerSocket.join(roomId);
                socket.join(roomId);
                
                partnerSocket.currentRoom = roomId;
                socket.currentRoom = roomId;
                
                io.to(roomId).emit('chat_start', roomId);
            }
        } else {
            waitingQueue.push(socket.id);
            socket.emit('waiting');
        }
        broadcastAdminStats();
    });

    socket.on('send_message', (data) => {
        if (socket.currentRoom) {
            // Raw text is passed directly without filtering
            socket.to(socket.currentRoom).emit('receive_message', data.text);
        }
    });

    socket.on('typing', () => {
        if (socket.currentRoom) socket.to(socket.currentRoom).emit('stranger_typing');
    });

    socket.on('stop_typing', () => {
        if (socket.currentRoom) socket.to(socket.currentRoom).emit('stranger_stopped_typing');
    });

    socket.on('skip_chat', () => handleLeave(false, true));
    socket.on('report_user', () => handleLeave(true, true));
    
    socket.on('disconnect', () => {
        handleLeave(false, false);
        broadcastAdminStats(); 
    });
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
    console.log(`Server running at port ${PORT}`);
});