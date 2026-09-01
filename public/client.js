const statusEl = document.getElementById('status');
const choiceButtons = document.getElementById('choiceButtons');
const hostFallback = document.getElementById('hostFallback');
const hostFallbackLink = document.getElementById('hostFallbackLink');
const hostBtn = document.getElementById('hostBtn');
const viewBtn = document.getElementById('viewBtn');
const video = document.getElementById('video');
const stopBtn = document.getElementById('stopBtn');
const volumeRow = document.getElementById('volumeRow');
const volumeSlider = document.getElementById('volumeSlider');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const chatPanel = document.getElementById('chatPanel');
const chatLog = document.getElementById('chatLog');
const chatName = document.getElementById('chatName');
const chatText = document.getElementById('chatText');
const chatSendBtn = document.getElementById('chatSendBtn');

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
// Todos os viewers atualmente conectados, independente de já terem oferta
// ou não — cobre tanto "entrou antes do host compartilhar" quanto "ficou
// conectado depois que o host parou e está retomando".
const connectedViewers = new Set();

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
        if (role === 'host') {
          connectedViewers.add(msg.id);
          if (localStream) await createOfferFor(msg.id);
        }
        break;

      case 'viewer-left':
        if (role === 'host') {
          connectedViewers.delete(msg.id);
          closeConnectionFor(msg.id);
        }
        break;

      case 'chat':
        appendChatMessage(msg);
        break;

      case 'stream-ended':
        if (role === 'viewer') {
          if (viewerPc) {
            viewerPc.close();
            viewerPc = null;
          }
          video.srcObject = null;
          video.style.display = 'none';
          volumeRow.style.display = 'none';
          fullscreenBtn.style.display = 'none';
          statusEl.textContent = 'O host parou de compartilhar. Aguardando...';
        }
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
      audio: true,
      // Pede pro navegador oferecer só o áudio da janela escolhida (não o
      // sistema inteiro) quando você compartilhar uma janela específica.
      windowAudio: 'window',
    });
  } catch (err) {
    statusEl.textContent = 'Você precisa permitir o compartilhamento de tela.';
    return;
  }

  role = 'host';
  connectWS();
  ws.onopen = () => {
    send({ type: 'hello', role: 'host' });
    chatPanel.style.display = 'flex';
  };

  choiceButtons.style.display = 'none';
  video.srcObject = localStream;
  video.style.display = 'block';
  video.muted = true; // evita eco no próprio host
  stopBtn.style.display = 'block';
  statusEl.textContent = 'Compartilhando sua tela. Passe seu IP + porta pros seus amigos.';

  localStream.getVideoTracks()[0].onended = () => stopSharing();

  // Cria a oferta agora pra todo mundo que já está conectado — cobre tanto
  // quem entrou antes de você compartilhar quanto quem ficou na sala depois
  // que você parou e agora está começando de novo.
  for (const viewerId of connectedViewers) {
    await createOfferFor(viewerId);
  }
};

async function createOfferFor(viewerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(viewerId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Prefere H.264 (costuma ter aceleração por hardware) antes de VP8/VP9
  // quando disponível, pra reduzir uso de CPU. Sem efeito se não suportado.
  const videoTransceiver = pc
    .getTransceivers()
    .find((t) => t.sender && t.sender.track && t.sender.track.kind === 'video');
  if (videoTransceiver && videoTransceiver.setCodecPreferences) {
    const { codecs } = RTCRtpSender.getCapabilities('video');
    const h264 = codecs.filter((c) => c.mimeType === 'video/H264');
    const others = codecs.filter((c) => c.mimeType !== 'video/H264');
    if (h264.length > 0) {
      videoTransceiver.setCodecPreferences([...h264, ...others]);
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: viewerId, candidate: e.candidate });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', to: viewerId, sdp: offer });
}

function closeConnectionFor(viewerId) {
  const pc = peerConnections.get(viewerId);
  if (pc) {
    pc.close();
    peerConnections.delete(viewerId);
  }
}

async function handleAnswer(msg) {
  const pc = peerConnections.get(msg.from);
  if (pc) await pc.setRemoteDescription(msg.sdp);
}

// ---------- VIEWER ----------
function startViewing() {
  role = 'viewer';
  connectWS();
  ws.onopen = () => {
    send({ type: 'hello', role: 'viewer' });
    chatPanel.style.display = 'flex';
  };

  choiceButtons.style.display = 'none';
  statusEl.textContent = 'Aguardando o host começar a compartilhar...';
}

viewBtn.onclick = startViewing;

// A grande maioria de quem abre esse link é amigo entrando pra assistir (o
// host já roda pelo app, não pelo navegador) — então já entra direto nessa
// tela, sem precisar clicar em nada. Quem realmente quiser hospedar pelo
// navegador ainda pode, pelo link discreto abaixo.
startViewing();

hostFallbackLink.onclick = (e) => {
  e.preventDefault();
  if (ws) ws.close();
  choiceButtons.style.display = 'flex';
  hostFallback.style.display = 'none';
  statusEl.textContent = 'Escolha uma opção abaixo';
};

let viewerPc = null;

async function handleOffer(msg) {
  viewerPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  viewerPc.ontrack = (e) => {
    video.srcObject = e.streams[0];
    video.style.display = 'block';
    video.volume = parseFloat(volumeSlider.value);
    volumeRow.style.display = 'flex';
    fullscreenBtn.style.display = 'inline-block';
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

// ---------- Tela cheia ----------
fullscreenBtn.onclick = () => {
  if (video.requestFullscreen) video.requestFullscreen();
  else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen(); // Safari
};

// ---------- Chat ----------
// O nome fica salvo no localStorage do navegador, então não precisa digitar
// de novo toda vez que entrar numa sala.
const STORAGE_KEY = 'screenshare_username';
chatName.value = localStorage.getItem(STORAGE_KEY) || '';
chatName.onchange = () => localStorage.setItem(STORAGE_KEY, chatName.value.trim());

function appendChatMessage(msg) {
  const line = document.createElement('div');
  line.className = 'msg';
  const time = new Date(msg.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  line.innerHTML = `<span style="color:#666">[${time}]</span> <b></b>: <span></span>`;
  line.querySelector('b').textContent = msg.name;
  line.querySelector('span:last-child').textContent = msg.text;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat() {
  const text = chatText.value.trim();
  if (!text) return;
  const name = chatName.value.trim() || 'Anônimo';
  localStorage.setItem(STORAGE_KEY, name);
  send({ type: 'chat', name, text });
  chatText.value = '';
}

chatSendBtn.onclick = sendChat;
chatText.onkeydown = (e) => {
  if (e.key === 'Enter') sendChat();
};

// Volume é só local: ajusta a reprodução no elemento <video>, sem afetar
// o que o host está enviando (o áudio "cru" continua o mesmo pra todo mundo).
volumeSlider.oninput = () => {
  video.volume = parseFloat(volumeSlider.value);
};

// ---------- Encerrar ----------
function stopSharing() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  for (const [, pc] of peerConnections) pc.close();
  peerConnections.clear();
  if (ws) ws.close();
  video.style.display = 'none';
  stopBtn.style.display = 'none';
  volumeRow.style.display = 'none';
  choiceButtons.style.display = 'flex';
  statusEl.textContent = 'Compartilhamento encerrado.';
}

stopBtn.onclick = stopSharing;
