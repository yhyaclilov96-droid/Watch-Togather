const SESSION_KEY = "watchTogether_session";
const WAS_BROADCASTER_KEY = "watchTogether_wasBroadcaster";

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 8000,
  timeout: 20000,
});

// DOM Elementləri
const authScreen = document.getElementById("auth-screen");
const playerScreen = document.getElementById("player-screen");
const inputUsername = document.getElementById("username");
const inputRoomCode = document.getElementById("room-code");
const inputRoomPass = document.getElementById("room-password");
const btnCreate = document.getElementById("btn-create");
const btnJoin = document.getElementById("btn-join");
const displayRoomCode = document.getElementById("display-room-code");
const displayUsername = document.getElementById("display-username");
const userAvatar = document.getElementById("user-avatar");
const btnCopyRoom = document.getElementById("btn-copy-room");
const btnLeave = document.getElementById("btn-leave");
const playerWrapper = document.querySelector(".player-wrapper");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSendMsg = document.getElementById("btn-send-msg");
const userListEl = document.getElementById("user-list");
const userListCountEl = document.getElementById("user-list-count");

// WebRTC Elementləri
const btnShareScreen = document.getElementById("btn-share-screen");
const btnStopShare = document.getElementById("btn-stop-share");
const videoPlayer = document.getElementById("main-video");

// --- YENİ: iPhone/iOS ÜÇÜN KRİTİK VİDEO AYARLARI ---
videoPlayer.autoplay = true;
videoPlayer.playsInline = true;
videoPlayer.setAttribute("playsinline", "true"); // Safari üçün məcburi

let currentRoom = null;
let currentUser = null;
let isRejoining = false;
let connectionBanner = null;

// WebRTC Dəyişənləri
let localStream = null;
let peerConnections = {};
let viewerConnection = null;

// --- YENİ: STUN Serverləri (Daha etibarlı P2P əlaqəsi üçün) ---
const config = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function getAvatarInitial(name) {
  return (name || "?").charAt(0).toUpperCase();
}

function getAvatarColor(name) {
  const colors = [
    "#6366f1",
    "#8b5cf6",
    "#ec4899",
    "#14b8a6",
    "#f59e0b",
    "#3b82f6",
    "#10b981",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// --- Sessiya (localStorage) ---
function saveSession({ username, roomCode, password }) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ username, roomCode, password }),
  );
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(WAS_BROADCASTER_KEY);
}

function restoreAuthFields() {
  const session = loadSession();
  if (!session) return;
  inputUsername.value = session.username || "";
  inputRoomCode.value = session.roomCode || "";
  inputRoomPass.value = session.password || "";
}

function showConnectionBanner(text) {
  if (!connectionBanner) {
    connectionBanner = document.createElement("div");
    connectionBanner.id = "connection-banner";
    connectionBanner.className = "connection-banner hidden";
    document.body.appendChild(connectionBanner);
  }
  if (!text) {
    connectionBanner.classList.add("hidden");
    return;
  }
  connectionBanner.innerText = text;
  connectionBanner.classList.remove("hidden");
}

function enterRoomUI({ roomCode, username }) {
  currentRoom = roomCode;
  currentUser = username;
  authScreen.classList.add("hidden");
  playerScreen.classList.remove("hidden");
  document.body.classList.add("in-room");
  displayRoomCode.innerText = roomCode;
  displayUsername.innerText = username;
  userAvatar.innerText = getAvatarInitial(username);
  userAvatar.style.backgroundColor = getAvatarColor(username);
  updateVideoPlaceholder();
}

function attemptRejoin() {
  const session = loadSession();
  if (!session || !socket.connected || isRejoining) return;

  isRejoining = true;
  showConnectionBanner("Yenidən qoşulur...");
  socket.emit("rejoin-room", session);
}

function onRoomJoined({ roomCode, username, reconnected }) {
  isRejoining = false;
  showConnectionBanner(null);

  const session = loadSession();
  if (session) {
    saveSession({
      username,
      roomCode,
      password: session.password,
    });
  }

  const wasInRoom = !!currentRoom;
  enterRoomUI({ roomCode, username });

  if (!wasInRoom && !reconnected) {
    resetChat();
  } else if (reconnected) {
    appendSystemMessage("Yenidən qoşuldunuz.");
    if (localStream) {
      socket.emit("register-broadcaster", currentRoom);
      sessionStorage.setItem(WAS_BROADCASTER_KEY, "1");
    }
  }

  restoreWebRTCAfterRejoin();
}

function restoreWebRTCAfterRejoin() {
  if (viewerConnection) {
    viewerConnection.close();
    viewerConnection = null;
  }
}

// --- GİRİŞ VƏ ÇAT ---
btnCreate.addEventListener("click", () => {
  const data = getAuthData();
  if (data) {
    isRejoining = false;
    saveSession(data);
    socket.emit("create-room", data);
  }
});

btnJoin.addEventListener("click", () => {
  const data = getAuthData();
  if (data) {
    isRejoining = false;
    saveSession(data);
    socket.emit("join-room", data);
  }
});

function getAuthData() {
  const username = inputUsername.value.trim();
  const roomCode = inputRoomCode.value.trim();
  const password = inputRoomPass.value;
  if (!username || !roomCode || !password) {
    alert("Bütün xanaları doldurun.");
    return null;
  }
  return { username, roomCode, password };
}

socket.on("error-msg", (msg) => {
  isRejoining = false;
  showConnectionBanner(null);
  alert(msg);
});

socket.on("session-expired", () => {
  isRejoining = false;
  clearSession();
  showConnectionBanner(null);
  currentRoom = null;
  currentUser = null;
  authScreen.classList.remove("hidden");
  playerScreen.classList.add("hidden");
  document.body.classList.remove("in-room");
  alert("Otaq artıq mövcud deyil. Yenidən qoşulun.");
});

socket.on("room-joined", onRoomJoined);

socket.on("connect", () => {
  if (loadSession()) attemptRejoin();
});

socket.on("disconnect", (reason) => {
  if (loadSession() && reason !== "io client disconnect") {
    showConnectionBanner("Əlaqə kəsildi. Yenidən qoşulur...");
  }
});

socket.on("reconnect", () => {
  attemptRejoin();
});

socket.on("reconnect_failed", () => {
  isRejoining = false;
  showConnectionBanner("Serverə qoşulmaq mümkün olmadı.");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && loadSession()) {
    if (!socket.connected) socket.connect();
    else attemptRejoin();
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted || loadSession()) {
    restoreAuthFields();
    if (socket.connected) attemptRejoin();
  }
});

restoreAuthFields();

btnCopyRoom.addEventListener("click", async () => {
  if (!currentRoom) return;
  try {
    await navigator.clipboard.writeText(currentRoom);
    btnCopyRoom.classList.add("copied");
    setTimeout(() => btnCopyRoom.classList.remove("copied"), 1500);
  } catch {
    alert("Kopyalama mümkün olmadı.");
  }
});

function updateVideoPlaceholder() {
  const hasStream =
    videoPlayer.srcObject &&
    videoPlayer.srcObject.getVideoTracks?.().length > 0;
  playerWrapper.classList.toggle("has-stream", !!hasStream);
}

btnSendMsg.addEventListener("click", sendMsg);
chatInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMsg();
});

function sendMsg() {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit("send-chat", {
      roomCode: currentRoom,
      username: currentUser,
      message: msg,
    });
    chatInput.value = "";
  }
}

// --- ÇAT MƏNTİQİ (Şar / Bubble Sistemi) ---
const MAX_CHAT_MESSAGES = 100;

function resetChat() {
  chatMessages.innerHTML = "";
  appendSystemMessage("Otağa xoş gəlmisiniz!");
}

function trimChatMessages() {
  while (chatMessages.children.length > MAX_CHAT_MESSAGES) {
    chatMessages.removeChild(chatMessages.firstChild);
  }
}

function appendToChat(node) {
  chatMessages.appendChild(node);
  trimChatMessages();
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMessage(message) {
  const div = document.createElement("div");
  div.className = "system-message";
  div.innerText = message;
  appendToChat(div);
}

const ADMIN_CROWN_SVG = `<svg class="admin-icon" viewBox="0 0 24 24" fill="currentColor" aria-label="Admin">
  <path d="M12 2l2.4 7.2H22l-6 4.6 2.3 7.2L12 16.8l-6.3 4.2 2.3-7.2-6-4.6h7.6L12 2z"/>
</svg>`;

function renderUserList({ users, count }) {
  userListEl.innerHTML = "";
  userListCountEl.innerText = count ?? users.length;

  if (!users.length) {
    const empty = document.createElement("li");
    empty.className = "user-list-empty";
    empty.innerText = "Hələ heç kim yoxdur";
    userListEl.appendChild(empty);
    return;
  }

  users.forEach(({ username, isAdmin }) => {
    const li = document.createElement("li");
    li.className = `user-list-item${username === currentUser ? " is-me" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = "user-list-avatar";
    avatar.innerText = getAvatarInitial(username);
    avatar.style.backgroundColor = getAvatarColor(username);

    const nameWrap = document.createElement("div");
    nameWrap.className = "user-list-name-wrap";

    const name = document.createElement("span");
    name.className = "user-list-name";
    name.innerText = username === currentUser ? `${username} (Siz)` : username;

    nameWrap.appendChild(name);

    if (isAdmin) {
      const badge = document.createElement("span");
      badge.className = "user-list-admin-badge";
      badge.title = "Otaq admini";
      badge.innerHTML = ADMIN_CROWN_SVG;
      nameWrap.appendChild(badge);
    }

    li.appendChild(avatar);
    li.appendChild(nameWrap);
    userListEl.appendChild(li);
  });
}

socket.on("updateUserList", renderUserList);

socket.on("receive-chat", ({ username, message }) => {
  const isMe = username === currentUser;
  appendBubbleToChat(username, message, isMe);
});

socket.on("sys-message", (message) => {
  appendSystemMessage(message);
});

function createChatAvatar(senderName) {
  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.innerText = getAvatarInitial(senderName);
  avatar.style.backgroundColor = getAvatarColor(senderName);
  avatar.title = senderName;
  return avatar;
}

function appendBubbleToChat(senderName, message, isMe) {
  const rowDiv = document.createElement("div");
  rowDiv.className = `chat-msg-row ${isMe ? "me" : "other"}`;

  const avatar = createChatAvatar(senderName);

  const bubbleContainer = document.createElement("div");
  bubbleContainer.className = "chat-bubble-container";

  const senderSpan = document.createElement("span");
  senderSpan.className = "chat-sender";
  senderSpan.innerText = isMe ? `${senderName} (Siz)` : senderName;
  bubbleContainer.appendChild(senderSpan);

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.innerText = message;
  bubbleContainer.appendChild(bubble);

  if (isMe) {
    rowDiv.appendChild(bubbleContainer);
    rowDiv.appendChild(avatar);
  } else {
    rowDiv.appendChild(avatar);
    rowDiv.appendChild(bubbleContainer);
  }

  appendToChat(rowDiv);
}

btnLeave.addEventListener("click", () => {
  clearSession();
  socket.disconnect();
  window.location.reload();
});

// --- WEBRTC EKRAN PAYLAŞIMI MƏNTİQİ ---

// 1. Host "Ekranı Paylaş" düyməsinə basır
btnShareScreen.addEventListener("click", async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    videoPlayer.srcObject = localStream;
    videoPlayer.muted = true;
    updateVideoPlaceholder();

    btnShareScreen.classList.add("hidden");
    btnStopShare.classList.remove("hidden");

    socket.emit("register-broadcaster", currentRoom);
    sessionStorage.setItem(WAS_BROADCASTER_KEY, "1");

    localStream.getVideoTracks()[0].onended = () => stopSharing();
  } catch (err) {
    console.error("Paylaşım xətası:", err);
    alert("Ekran paylaşımına icazə verilmədi və ya xəta baş verdi.");
  }
});

btnStopShare.addEventListener("click", stopSharing);

function stopSharing() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  videoPlayer.srcObject = null;
  updateVideoPlaceholder();
  btnShareScreen.classList.remove("hidden");
  btnStopShare.classList.add("hidden");

  socket.emit("broadcaster-disconnected", currentRoom);
  sessionStorage.removeItem(WAS_BROADCASTER_KEY);

  for (let id in peerConnections) {
    peerConnections[id].close();
    delete peerConnections[id];
  }
}

socket.on("broadcaster-active", (broadcasterId) => {
  socket.emit("watcher-request", { broadcasterId });
});

// 3. Yayımçıya izləyicidən sorğu gəlir
socket.on("watcher-request", async (watcherId) => {
  const pc = new RTCPeerConnection(config);
  peerConnections[watcherId] = pc;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-ice", {
        target: watcherId,
        candidate: event.candidate,
      });
    }
  };

  // Yayımçı tərəfində bağlantı qopmasını izləmək
  pc.oniceconnectionstatechange = () => {
    if (
      pc.iceConnectionState === "disconnected" ||
      pc.iceConnectionState === "failed"
    ) {
      console.log("İzləyici ilə əlaqə kəsildi (Bağlantı təmizlənir)");
      pc.close();
      delete peerConnections[watcherId];
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc-offer", { watcherId, sdp: pc.localDescription });
});

// 4. İzləyici yayımçıdan Offer (Təklif) alır
socket.on("webrtc-offer", async ({ broadcasterId, sdp }) => {
  viewerConnection = new RTCPeerConnection(config);

  viewerConnection.ontrack = (event) => {
    videoPlayer.srcObject = event.streams[0];
    videoPlayer.muted = false;
    updateVideoPlaceholder();
  };

  viewerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-ice", {
        target: broadcasterId,
        candidate: event.candidate,
      });
    }
  };

  // İzləyici (iPhone) tərəfində bağlantı qoparsa avtomatik yenidən qoşulma
  viewerConnection.oniceconnectionstatechange = () => {
    if (
      viewerConnection.iceConnectionState === "disconnected" ||
      viewerConnection.iceConnectionState === "failed"
    ) {
      console.log(
        "Yayımçı ilə əlaqə kəsildi. Yenidən qoşulmağa cəhd edilir...",
      );
      socket.emit("watcher-request", { broadcasterId });
    }
  };

  await viewerConnection.setRemoteDescription(sdp);
  const answer = await viewerConnection.createAnswer();
  await viewerConnection.setLocalDescription(answer);

  socket.emit("webrtc-answer", {
    broadcasterId,
    sdp: viewerConnection.localDescription,
  });
});

// 5. Yayımçı izləyicinin Answer-ini (Cavabını) alır
socket.on("webrtc-answer", async ({ watcherId, sdp }) => {
  if (peerConnections[watcherId]) {
    await peerConnections[watcherId].setRemoteDescription(sdp);
  }
});

// 6. ICE Candidate mübadiləsi (Əlaqənin stabilliyi üçün)
socket.on("webrtc-ice", async ({ sender, candidate }) => {
  const pc = peerConnections[sender] || viewerConnection;
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// Yayımçı ayrıldıqda və ya paylaşımı dayandırdıqda
socket.on("broadcaster-stopped", () => {
  videoPlayer.srcObject = null;
  updateVideoPlaceholder();
  if (viewerConnection) {
    viewerConnection.close();
    viewerConnection = null;
  }
  appendSystemMessage("Ekran paylaşımı dayandırıldı.");
});
