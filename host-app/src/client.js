const statusEl = document.getElementById('status');
const shareUrlRow = document.getElementById('shareUrlRow');
const shareUrlEl = document.getElementById('shareUrl');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const otherIpsDetails = document.getElementById('otherIpsDetails');
const otherIpsList = document.getElementById('otherIpsList');
const hostBtn = document.getElementById('hostBtn');
const liveBadge = document.getElementById('liveBadge');
const stopBtn = document.getElementById('stopBtn');
const chatPanel = document.getElementById('chatPanel');
const chatLog = document.getElementById('chatLog');
const chatName = document.getElementById('chatName');
const chatText = document.getElementById('chatText');
const chatSendBtn = document.getElementById('chatSendBtn');

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
// Viewers que entraram na sala ANTES de você clicar em "Compartilhar" ficam
// aqui em espera — sem isso, o "viewer-joined" deles chegaria com
// localStream ainda null, a oferta falharia silenciosamente, e ninguém
// tentaria de novo depois que você começasse a compartilhar.
const pendingViewers = new Set();

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connectToSidecar(attempt = 1) {
  ws = new WebSocket(`ws://${SIGNALING_HOST}:3000`);

  ws.onopen = () => {
    statusEl.textContent = 'Servidor pronto. Peça pros seus amigos acessarem o endereço abaixo (na mesma rede Radmin):';
    shareUrlEl.textContent = `http://<SEU-IP-RADMIN>:3000`; // placeholder até o local-ips chegar
    shareUrlRow.style.display = 'flex';
    hostBtn.style.display = 'inline-block';
    chatPanel.style.display = 'flex';
    send({ type: 'hello', role: 'host' });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'local-ips':
        renderShareUrl(msg.ips);
        break;
      case 'viewer-joined':
        if (localStream) {
          await createOfferFor(msg.id);
        } else {
          pendingViewers.add(msg.id); // ainda não começamos a compartilhar
        }
        break;
      case 'viewer-left':
        pendingViewers.delete(msg.id);
        closeConnectionFor(msg.id);
        break;
      case 'chat':
        appendChatMessage(msg);
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

// Escolhe o endereço mais provável de ser o da Radmin (ranges 25.x.x.x e
// 26.x.x.x, que é o que ela costuma usar) e mostra os outros como opção
// caso o palpite esteja errado — sem esconder informação, só priorizar.
function renderShareUrl(ips) {
  if (!ips || ips.length === 0) return; // mantém o placeholder manual

  const radminLike = ips.find((ip) => /^2[56]\./.test(ip.address));
  const primary = radminLike || ips[0];
  const url = `http://${primary.address}:3000`;

  shareUrlEl.textContent = url;
  copyUrlBtn.onclick = () => {
    navigator.clipboard.writeText(url);
    copyUrlBtn.textContent = 'Copiado!';
    setTimeout(() => (copyUrlBtn.textContent = 'Copiar'), 1500);
  };

  const others = ips.filter((ip) => ip.address !== primary.address);
  otherIpsList.innerHTML = '';
  if (others.length === 0) {
    otherIpsDetails.style.display = 'none';
  } else {
    otherIpsDetails.style.display = 'block';
    others.forEach((ip) => {
      const otherUrl = `http://${ip.address}:3000`;
      const row = document.createElement('div');
      row.className = 'ipRow';
      const label = document.createElement('span');
      label.textContent = `${otherUrl} (${ip.name})`;
      const btn = document.createElement('button');
      btn.textContent = 'Copiar';
      btn.onclick = () => navigator.clipboard.writeText(otherUrl);
      row.appendChild(label);
      row.appendChild(btn);
      otherIpsList.appendChild(row);
    });
  }
}

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

  // Cria a oferta agora pra qualquer viewer que já estava esperando na sala
  // antes de você clicar em compartilhar.
  for (const viewerId of pendingViewers) {
    await createOfferFor(viewerId);
  }
  pendingViewers.clear();
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
  localStream = null;
  liveBadge.style.display = 'none';
  stopBtn.style.display = 'none';
  hostBtn.style.display = 'inline-block';
  statusEl.textContent = 'Compartilhamento encerrado.';
}

stopBtn.onclick = stopSharing;

// ---------- Chat ----------
// O nome fica salvo no localStorage do app, então não precisa digitar de
// novo toda vez que abrir (armazenamento local do próprio WebView do Tauri,
// separado do localStorage usado pelos amigos no navegador).
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
