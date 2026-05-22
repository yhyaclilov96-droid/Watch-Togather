const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

function buildUserListPayload(room) {
  return {
    users: room.users.map((u) => ({
      username: u.username,
      isAdmin: u.username === room.adminUsername,
    })),
    count: room.users.length,
  };
}

function emitUserList(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("updateUserList", buildUserListPayload(room));
}

io.on("connection", (socket) => {
  console.log(`Yeni istifadəçi: ${socket.id}`);

  socket.on("create-room", ({ username, roomCode, password }) => {
    if (rooms[roomCode])
      return socket.emit("error-msg", "Bu otaq kodu artıq mövcuddur.");

    rooms[roomCode] = {
      password: password,
      users: [{ id: socket.id, username: username }],
      adminUsername: username,
      broadcaster: null,
      broadcasterUsername: null,
    };
    socket.join(roomCode);
    socket.emit("room-joined", { roomCode, username });
    emitUserList(roomCode);
  });

  socket.on("join-room", ({ username, roomCode, password }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("error-msg", "Otaq tapılmadı.");
    if (room.password !== password)
      return socket.emit("error-msg", "Parol yanlışdır.");

    room.users.push({ id: socket.id, username });
    socket.join(roomCode);
    socket.emit("room-joined", { roomCode, username });
    socket.to(roomCode).emit("sys-message", `${username} otağa qoşuldu.`);
    emitUserList(roomCode);

    // Otaqda artıq yayım edən (ekran paylaşan) varsa, yeni gələnə xəbər ver
    if (room.broadcaster) {
      const broadcasterSocket = io.sockets.sockets.get(room.broadcaster);
      if (broadcasterSocket) {
        socket.emit("broadcaster-active", room.broadcaster);
      } else {
        room.broadcaster = null;
        room.broadcasterUsername = null;
      }
    }
  });

  // Sessiya bərpası (yenidən qoşulma / səhifə yenilənməsi)
  socket.on("rejoin-room", ({ username, roomCode, password }) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit("session-expired");
    }
    if (room.password !== password) {
      return socket.emit("error-msg", "Parol yanlışdır.");
    }

    room.users = room.users.filter((u) => u.username !== username);
    room.users.push({ id: socket.id, username });

    socket.join(roomCode);
    socket.emit("room-joined", { roomCode, username, reconnected: true });
    emitUserList(roomCode);

    if (room.broadcasterUsername === username) {
      room.broadcaster = socket.id;
      socket.to(roomCode).emit("broadcaster-active", socket.id);
    } else if (room.broadcaster) {
      const broadcasterSocket = io.sockets.sockets.get(room.broadcaster);
      if (broadcasterSocket) {
        socket.emit("broadcaster-active", room.broadcaster);
      } else {
        room.broadcaster = null;
        room.broadcasterUsername = null;
      }
    }
  });

  // --- WebRTC Siqnalizasiyası ---

  // 1. Ekranı paylaşan şəxs özünü otağa qeydiyyatdan keçirir
  socket.on("register-broadcaster", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    const user = room.users.find((u) => u.id === socket.id);
    room.broadcaster = socket.id;
    room.broadcasterUsername = user ? user.username : null;
    socket.to(roomCode).emit("broadcaster-active", socket.id);
  });

  // 2. İzləyici ekran paylaşan şəxsdən yayımı istəyir
  socket.on("watcher-request", ({ broadcasterId }) => {
    socket.to(broadcasterId).emit("watcher-request", socket.id);
  });

  // 3. Yayımçı izləyiciyə P2P təklifi (Offer) göndərir
  socket.on("webrtc-offer", ({ watcherId, sdp }) => {
    socket
      .to(watcherId)
      .emit("webrtc-offer", { broadcasterId: socket.id, sdp });
  });

  // 4. İzləyici təklifi qəbul edib cavab (Answer) qaytarır
  socket.on("webrtc-answer", ({ broadcasterId, sdp }) => {
    socket
      .to(broadcasterId)
      .emit("webrtc-answer", { watcherId: socket.id, sdp });
  });

  // 5. Şəbəkə marşrutlarının (ICE Candidates) mübadiləsi
  socket.on("webrtc-ice", ({ target, candidate }) => {
    socket.to(target).emit("webrtc-ice", { sender: socket.id, candidate });
  });

  // Yayımçı paylaşımı dayandıranda
  socket.on("broadcaster-disconnected", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.broadcaster = null;
    room.broadcasterUsername = null;
    socket.to(roomCode).emit("broadcaster-stopped");
  });

  // Çat sistemi
  socket.on("send-chat", ({ roomCode, username, message }) => {
    io.to(roomCode).emit("receive-chat", { username, message });
  });

  socket.on("disconnect", () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const userIndex = room.users.findIndex((u) => u.id === socket.id);

      if (userIndex !== -1) {
        const username = room.users[userIndex].username;
        room.users.splice(userIndex, 1);
        socket.to(roomCode).emit("sys-message", `${username} otaqdan ayrıldı.`);

        // Əgər ayrılan şəxs ekranı paylaşan idisə
        if (room.broadcaster === socket.id) {
          room.broadcaster = null;
          room.broadcasterUsername = null;
          socket.to(roomCode).emit("broadcaster-stopped");
        }

        if (room.users.length === 0) {
          delete rooms[roomCode];
        } else {
          emitUserList(roomCode);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server işə düşdü: http://localhost:${PORT}`);
});
