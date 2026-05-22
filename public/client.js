const socket = io();

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

// --- GİRİŞ VƏ ÇAT ---
btnCreate.addEventListener("click", () => {
  const data = getAuthData();
  if (data) socket.emit("create-room", data);
});

btnJoin.addEventListener("click", () => {
  const data = getAuthData();
  if (data) socket.emit("join-room", data);
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

socket.on("error-msg", (msg) => alert(msg));
socket.on("room-joined", ({ roomCode, username }) => {
  currentRoom = roomCode;
  currentUser = username;
  authScreen.classList.add("hidden");
  playerScreen.classList.remove("hidden");
  document.body.classList.add("in-room");
  displayRoomCode.innerText = roomCode;
  displayUsername.innerText = username;
  userAvatar.innerText = getAvatarInitial(username);
  userAvatar.style.backgroundColor = getAvatarColor(username);
  resetChat();
  updateVideoPlaceholder();
});

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

btnLeave.addEventListener("click", () => window.location.reload());

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
