const statusEl = document.getElementById('status');
const shareUrlEl = document.getElementById('shareUrl');
const hostBtn = document.getElementById('hostBtn');
const liveBadge = document.getElementById('liveBadge');
const stopBtn = document.getElementById('stopBtn');

// O sidecar (server.js empacotado) sempre roda na própria máquina do host,
// então aqui a conexão é sempre local — diferente do public/client.js original,
// que usa location.hostname pra funcionar também quando acessado via IP da Radmin.
const SIGNALING_HOST = 'localhost';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: `turn:${SIGNALING_HOST}:3478`,
    username: 'screenshare',
    credential: 'radmin123',
  },
];

let ws;
let localStream = null; // stream original do getDisplayMedia (vídeo + áudio cru)
const peerConnections = new Map(); // viewerId -> RTCPeerConnection

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connectToSidecar(attempt = 1) {
  ws = new WebSocket(`ws://${SIGNALING_HOST}:3000`);

  ws.onopen = () => {
    statusEl.textContent = 'Servidor pronto. Peça pros seus amigos acessarem o endereço abaixo (na mesma rede Radmin):';
    shareUrlEl.textContent = `http://<SEU-IP-RADMIN>:3000`;
    shareUrlEl.style.display = 'block';
    hostBtn.style.display = 'inline-block';
    send({ type: 'hello', role: 'host' });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'viewer-joined':
        await createOfferFor(msg.id);
        break;
      case 'viewer-left':
        closeConnectionFor(msg.id);
        break;
      case 'answer':
        await handleAnswer(msg);
        break;
      case 'ice':
        await handleIce(msg);
        break;
    }
  };

  ws.onclose = () => {
    // O sidecar pode ainda estar subindo — tenta de novo por alguns segundos
    if (attempt <= 10) {
      setTimeout(() => connectToSidecar(attempt + 1), 500);
    } else {
      statusEl.textContent = 'Não consegui conectar ao servidor local. Tente reabrir o app.';
    }
  };
}

connectToSidecar();

// ---------- Compartilhar tela ----------
hostBtn.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
      // Pede pro Chromium/WebView2 oferecer só o áudio da janela escolhida,
      // em vez do sistema inteiro — assim o Discord fica de fora quando você
      // compartilha uma janela específica (ex: um jogo) em vez de "Tela inteira".
      // Navegadores mais antigos ignoram essa opção sem erro (fallback seguro).
      windowAudio: 'window',
    });
  } catch (err) {
    statusEl.textContent = 'Você precisa permitir o compartilhamento de tela.';
    return;
  }

  hostBtn.style.display = 'none';
  // Sem preview local: além de economizar GPU/CPU renderizando um vídeo que
  // ninguém precisa ver, evita o "efeito espelho infinito" — se você
  // compartilhar a tela inteira com essa janela visível, um preview ao vivo
  // aqui dentro criaria um loop recursivo (a tela mostrando o app mostrando
  // a tela...), que fica cada vez mais pesado de codificar com o tempo.
  liveBadge.style.display = 'flex';
  stopBtn.style.display = 'block';
  statusEl.textContent = 'Compartilhando! Seus amigos já podem entrar pelo link acima. Dica: escolha "Janela" (não "Tela inteira") no seletor pra deixar o Discord fora do áudio, e minimize esta janela pela bandeja pra economizar recursos.';

  localStream.getVideoTracks()[0].onended = () => stopSharing();
};

async function createOfferFor(viewerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(viewerId, pc);

  // Vídeo e áudio precisam estar associados ao MESMO MediaStream ao serem
  // adicionados, senão o navegador de quem assiste recebe dois eventos
  // "ontrack" separados e o segundo sobrescreve o primeiro (tela preta).
  // O áudio vai "cru" (sem processamento) — o volume é ajustado por quem assiste.
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Prefere H.264 antes de VP8/VP9 quando disponível: em máquinas com GPU
  // compatível, o Chromium/WebView2 consegue codificar H.264 por hardware,
  // o que reduz bastante o uso de CPU comparado à codificação por software
  // (que é o padrão pro VP8). Se não houver suporte, isso não tem efeito —
  // o navegador simplesmente ignora a preferência e segue com o codec normal.
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

async function handleIce(msg) {
  const pc = peerConnections.get(msg.from);
  if (pc) {
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (err) {
      console.error('Erro ao adicionar ICE candidate', err);
    }
  }
}

function stopSharing() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  for (const [, pc] of peerConnections) pc.close();
  peerConnections.clear();
  liveBadge.style.display = 'none';
  stopBtn.style.display = 'none';
  hostBtn.style.display = 'inline-block';
  statusEl.textContent = 'Compartilhamento encerrado.';
}

stopBtn.onclick = stopSharing;
