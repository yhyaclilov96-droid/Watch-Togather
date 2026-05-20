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
const btnLeave = document.getElementById("btn-leave");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSendMsg = document.getElementById("btn-send-msg");

// WebRTC Elementləri
const btnShareScreen = document.getElementById("btn-share-screen");
const btnStopShare = document.getElementById("btn-stop-share");
const videoPlayer = document.getElementById("main-video");

let currentRoom = null;
let currentUser = null;

// WebRTC Dəyişənləri
let localStream = null;
let peerConnections = {}; // Yayımçının birdən çox izləyicisi olacağı üçün obyekt
let viewerConnection = null; // İzləyicinin yalnız bir yayımçı ilə əlaqəsi olacaq
const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// --- GİRİŞ VƏ ÇAT (Əvvəlki kimidir) ---
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
  displayRoomCode.innerText = roomCode;
  displayUsername.innerText = username;
});

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
socket.on("receive-chat", ({ username, message }) =>
  addMessageToChat(`<strong>${username}:</strong> ${message}`),
);
socket.on("sys-message", (message) =>
  addMessageToChat(`<span class="system-message">${message}</span>`),
);
function addMessageToChat(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
btnLeave.addEventListener("click", () => window.location.reload());

// --- WEBRTC EKRAN PAYLAŞIMI MƏNTİQİ ---

// 1. Host "Ekranı Paylaş" düyməsinə basır
btnShareScreen.addEventListener("click", async () => {
  try {
    // Brauzerdən ekranı və *SƏSİ* istəyirik
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true, // MÜTLƏQ: Səs paylaşımını aktivləşdirmək üçün
    });

    // Özümüz də görək deyə pleyerə veririk, amma səs əks-səda (echo) verməsin deyə özümüzdə səssiz edirik
    videoPlayer.srcObject = localStream;
    videoPlayer.muted = true;

    btnShareScreen.classList.add("hidden");
    btnStopShare.classList.remove("hidden");

    // Serverə xəbər veririk ki, biz artıq otaqda yayımcıyıq
    socket.emit("register-broadcaster", currentRoom);

    // Əgər istifadəçi brauzerin özünün yuxarıdakı "Stop sharing" düyməsinə basarsa
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
  btnShareScreen.classList.remove("hidden");
  btnStopShare.classList.add("hidden");

  // Serverə yayımın bitdiyini xəbər veririk
  socket.emit("broadcaster-disconnected", currentRoom);

  // Bütün P2P əlaqələrini kəsirik
  for (let id in peerConnections) {
    peerConnections[id].close();
    delete peerConnections[id];
  }
}

// 2. İzləyici otağa girəndə (və ya otaqdaykən) yayımcının olduğunu öyrənir
socket.on("broadcaster-active", (broadcasterId) => {
  // Yayımcıdan videonu istəyirik
  socket.emit("watcher-request", { broadcasterId });
});

// 3. Yayımçıya izləyicidən sorğu gəlir
socket.on("watcher-request", async (watcherId) => {
  const pc = new RTCPeerConnection(config);
  peerConnections[watcherId] = pc;

  // Yayımçı öz video və səs treklərini bağlantıya əlavə edir
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-ice", {
        target: watcherId,
        candidate: event.candidate,
      });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc-offer", { watcherId, sdp: pc.localDescription });
});

// 4. İzləyici yayımçıdan Offer (Təklif) alır
socket.on("webrtc-offer", async ({ broadcasterId, sdp }) => {
  viewerConnection = new RTCPeerConnection(config);

  // Video axını gələndə pleyerdə açır
  viewerConnection.ontrack = (event) => {
    videoPlayer.srcObject = event.streams[0];
    videoPlayer.muted = false; // İzləyici filmin səsini eşitməlidir
  };

  viewerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-ice", {
        target: broadcasterId,
        candidate: event.candidate,
      });
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
  if (viewerConnection) {
    viewerConnection.close();
    viewerConnection = null;
  }
  addMessageToChat(
    '<span class="system-message">Ekran paylaşımı dayandırıldı.</span>',
  );
});
