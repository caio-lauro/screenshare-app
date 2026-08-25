const statusEl = document.getElementById('status');
const choiceButtons = document.getElementById('choiceButtons');
const hostBtn = document.getElementById('hostBtn');
const viewBtn = document.getElementById('viewBtn');
const video = document.getElementById('video');
const stopBtn = document.getElementById('stopBtn');

// TURN roda no mesmo host que serve esta página (server.js), na porta 3478.
// Usamos location.hostname pra funcionar tanto em localhost quanto via IP da Radmin.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: `turn:${location.hostname}:3478`,
    username: 'screenshare',
    credential: 'radmin123',
  },
];

let ws;
let myId;
let localStream = null;
let role = null;

// host mantém uma RTCPeerConnection por viewer conectado
const peerConnections = new Map(); // viewerId -> RTCPeerConnection

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'welcome':
        myId = msg.id;
        break;

      case 'viewer-joined':
        if (role === 'host') await createOfferFor(msg.id);
        break;

      case 'offer':
        if (role === 'viewer') await handleOffer(msg);
        break;

      case 'answer':
        if (role === 'host') await handleAnswer(msg);
        break;

      case 'ice':
        await handleIce(msg);
        break;

      case 'host-left':
        statusEl.textContent = 'O host encerrou o compartilhamento.';
        video.style.display = 'none';
        choiceButtons.style.display = 'flex';
        break;
    }
  };
}

function send(obj) {
  ws.send(JSON.stringify(obj));
}

// ---------- HOST ----------
hostBtn.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true
    });
  } catch (err) {
    statusEl.textContent = 'Você precisa permitir o compartilhamento de tela.';
    return;
  }

  role = 'host';
  connectWS();
  ws.onopen = () => send({ type: 'hello', role: 'host' });

  choiceButtons.style.display = 'none';
  video.srcObject = localStream;
  video.style.display = 'block';
  video.muted = true; // evita eco no próprio host
  stopBtn.style.display = 'block';
  statusEl.textContent = 'Compartilhando sua tela. Passe seu IP + porta pros seus amigos.';

  localStream.getVideoTracks()[0].onended = () => stopSharing();
};

async function createOfferFor(viewerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(viewerId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: viewerId, candidate: e.candidate });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', to: viewerId, sdp: offer });
}

async function handleAnswer(msg) {
  const pc = peerConnections.get(msg.from);
  if (pc) await pc.setRemoteDescription(msg.sdp);
}

// ---------- VIEWER ----------
viewBtn.onclick = () => {
  role = 'viewer';
  connectWS();
  ws.onopen = () => send({ type: 'hello', role: 'viewer' });

  choiceButtons.style.display = 'none';
  statusEl.textContent = 'Aguardando o host começar a compartilhar...';
};

let viewerPc = null;

async function handleOffer(msg) {
  viewerPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  viewerPc.ontrack = (e) => {
    video.srcObject = e.streams[0];
    video.style.display = 'block';
    statusEl.textContent = 'Conectado!';
  };

  viewerPc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: msg.from, candidate: e.candidate });
  };

  await viewerPc.setRemoteDescription(msg.sdp);
  const answer = await viewerPc.createAnswer();
  await viewerPc.setLocalDescription(answer);
  send({ type: 'answer', to: msg.from, sdp: answer });
}

// ---------- ICE comum aos dois papéis ----------
async function handleIce(msg) {
  const pc = role === 'host' ? peerConnections.get(msg.from) : viewerPc;
  if (pc) {
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (err) {
      console.error('Erro ao adicionar ICE candidate', err);
    }
  }
}

// ---------- Encerrar ----------
function stopSharing() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  for (const [, pc] of peerConnections) pc.close();
  peerConnections.clear();
  if (ws) ws.close();
  video.style.display = 'none';
  stopBtn.style.display = 'none';
  choiceButtons.style.display = 'flex';
  statusEl.textContent = 'Compartilhamento encerrado.';
}

stopBtn.onclick = stopSharing;
