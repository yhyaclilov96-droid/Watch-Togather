const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};
const MAX_CHAT_LENGTH = 2000;

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

function setSocketSession(socket, roomCode, username) {
  socket.data.username = username;
  socket.data.roomCode = roomCode;
}

function getRoomContext(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode || !socket.rooms.has(roomCode)) return null;

  const room = rooms[roomCode];
  if (!room) return null;

  const user = room.users.find((u) => u.id === socket.id);
  if (!user) return null;

  return {
    roomCode,
    room,
    username: socket.data.username || user.username,
  };
}

function isPeerInSameRoom(socket, targetSocketId) {
  const target = io.sockets.sockets.get(targetSocketId);
  if (!target) return false;

  const roomCode = socket.data.roomCode;
  return (
    !!roomCode &&
    roomCode === target.data.roomCode &&
    socket.rooms.has(roomCode) &&
    target.rooms.has(roomCode)
  );
}

function addUserToRoom(socket, room, roomCode, username) {
  room.users = room.users.filter((u) => u.username !== username);
  room.users.push({ id: socket.id, username });
  socket.join(roomCode);
  setSocketSession(socket, roomCode, username);
}

io.on("connection", (socket) => {
  console.log(`Yeni istifadəçi: ${socket.id}`);

  socket.on("create-room", ({ username, roomCode, password }) => {
    if (!username || !roomCode || !password) return;

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
    setSocketSession(socket, roomCode, username);
    socket.emit("room-joined", { roomCode, username });
    emitUserList(roomCode);
  });

  socket.on("join-room", ({ username, roomCode, password }) => {
    if (!username || !roomCode || !password) return;

    const room = rooms[roomCode];
    if (!room) return socket.emit("error-msg", "Otaq tapılmadı.");
    if (room.password !== password)
      return socket.emit("error-msg", "Parol yanlışdır.");

    addUserToRoom(socket, room, roomCode, username);
    socket.emit("room-joined", { roomCode, username });
    socket.to(roomCode).emit("sys-message", `${username} otağa qoşuldu.`);
    emitUserList(roomCode);

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

  socket.on("rejoin-room", ({ username, roomCode, password }) => {
    if (!username || !roomCode || !password) return;

    const room = rooms[roomCode];
    if (!room) {
      return socket.emit("session-expired");
    }
    if (room.password !== password) {
      return socket.emit("error-msg", "Parol yanlışdır.");
    }

    addUserToRoom(socket, room, roomCode, username);
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

  socket.on("register-broadcaster", () => {
    const ctx = getRoomContext(socket);
    if (!ctx) return;

    ctx.room.broadcaster = socket.id;
    ctx.room.broadcasterUsername = ctx.username;
    socket.to(ctx.roomCode).emit("broadcaster-active", socket.id);
  });

  socket.on("watcher-request", ({ broadcasterId }) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !broadcasterId) return;
    if (ctx.room.broadcaster !== broadcasterId) return;
    if (!isPeerInSameRoom(socket, broadcasterId)) return;

    socket.to(broadcasterId).emit("watcher-request", socket.id);
  });

  socket.on("webrtc-offer", ({ watcherId, sdp }) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !watcherId || !sdp) return;
    if (ctx.room.broadcaster !== socket.id) return;
    if (!isPeerInSameRoom(socket, watcherId)) return;

    socket
      .to(watcherId)
      .emit("webrtc-offer", { broadcasterId: socket.id, sdp });
  });

  socket.on("webrtc-answer", ({ broadcasterId, sdp }) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !broadcasterId || !sdp) return;
    if (ctx.room.broadcaster !== broadcasterId) return;
    if (!isPeerInSameRoom(socket, broadcasterId)) return;

    socket
      .to(broadcasterId)
      .emit("webrtc-answer", { watcherId: socket.id, sdp });
  });

  socket.on("webrtc-ice", ({ target, candidate }) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !target || !candidate) return;
    if (!isPeerInSameRoom(socket, target)) return;

    socket.to(target).emit("webrtc-ice", { sender: socket.id, candidate });
  });

  socket.on("broadcaster-disconnected", () => {
    const ctx = getRoomContext(socket);
    if (!ctx) return;
    if (ctx.room.broadcaster !== socket.id) return;

    ctx.room.broadcaster = null;
    ctx.room.broadcasterUsername = null;
    socket.to(ctx.roomCode).emit("broadcaster-stopped");
  });

  socket.on("send-chat", ({ message }) => {
    const ctx = getRoomContext(socket);
    if (!ctx) return;

    const text = String(message ?? "").trim();
    if (!text || text.length > MAX_CHAT_LENGTH) return;

    io.to(ctx.roomCode).emit("receive-chat", {
      username: ctx.username,
      message: text,
    });
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms[roomCode];
    if (!room) return;

    const userIndex = room.users.findIndex((u) => u.id === socket.id);
    if (userIndex === -1) return;

    const username = room.users[userIndex].username;
    room.users.splice(userIndex, 1);
    socket.to(roomCode).emit("sys-message", `${username} otaqdan ayrıldı.`);

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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server işə düşdü: http://localhost:${PORT}`);
});
