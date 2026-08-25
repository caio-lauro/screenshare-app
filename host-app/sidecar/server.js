const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const Turn = require('node-turn');

const PORT = process.env.PORT || 3000;

// Lista os IPv4 locais da máquina (exceto loopback). Usado pra sugerir
// automaticamente o endereço que os amigos devem usar pra entrar — a
// própria máquina do host sempre sabe seus IPs melhor do que qualquer
// heurística de rede feita a partir do navegador.
function getLocalIPv4s() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({ name, address: net.address });
      }
    }
  }
  return results;
}

// --- Servidor TURN (relay de mídia quando a conexão P2P direta falha) ---
// Usa as mesmas credenciais fixas configuradas no client.js (public/client.js).
// Por rodar dentro da própria VPN Radmin, credenciais fixas são aceitáveis aqui.
const TURN_PORT = 3478;
const turnServer = new Turn({
  authMech: 'long-term',
  credentials: {
    screenshare: 'radmin123',
  },
  listeningPort: TURN_PORT,
  minPort: 49152,
  maxPort: 49252, // faixa reduzida (100 portas) pra facilitar liberar no firewall
});
turnServer.start();
console.log(`Servidor TURN escutando na porta UDP ${TURN_PORT}`);

// --- Servidor HTTP simples (serve a pasta public/) ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Não encontrado');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- Sinalização WebRTC via WebSocket ---
// Regras do protocolo (mensagens JSON):
//   Cliente -> Servidor:
//     { type: 'hello', role: 'host' | 'viewer' }
//     { type: 'offer'|'answer'|'ice', to: <id>, ...payload }
//     { type: 'chat', name: <string>, text: <string> }
//   Servidor -> Cliente:
//     { type: 'welcome', id: <seuId> }
//     { type: 'viewer-joined', id: <idDoViewer> }   (só o host recebe)
//     { type: 'viewer-left', id: <idDoViewer> }      (só o host recebe)
//     { type: 'local-ips', ips: [{name, address}] }  (só o host recebe, junto do viewer-joined)
//     { type: 'host-left' }                          (viewers recebem)
//     { type: 'offer'|'answer'|'ice', from: <id>, ...payload }  (repassado)
//     { type: 'chat', name, text, ts }                (todo mundo recebe)

const wss = new WebSocketServer({ server });

let nextId = 1;
const clients = new Map(); // id -> { ws, role }
let hostId = null;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  const id = nextId++;
  clients.set(id, { ws, role: null });
  send(ws, { type: 'welcome', id });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'hello') {
      clients.get(id).role = msg.role;
      if (msg.role === 'host') {
        hostId = id;
        send(ws, { type: 'local-ips', ips: getLocalIPv4s() });
      } else if (msg.role === 'viewer' && hostId !== null) {
        // avisa o host que um novo viewer chegou, pra ele criar a offer
        const host = clients.get(hostId);
        if (host) send(host.ws, { type: 'viewer-joined', id });
      }
      return;
    }

    // Repassa offer/answer/ice pro destinatário certo
    if (['offer', 'answer', 'ice'].includes(msg.type) && msg.to != null) {
      const target = clients.get(msg.to);
      if (target) send(target.ws, { ...msg, from: id });
      return;
    }

    // Chat: transmite pra todo mundo conectado (host + todos os viewers),
    // incluindo quem mandou — assim não precisa de lógica separada de "eco".
    if (msg.type === 'chat') {
      const chatMsg = {
        type: 'chat',
        name: String(msg.name || 'Anônimo').slice(0, 24),
        text: String(msg.text || '').slice(0, 300),
        ts: Date.now(),
      };
      if (!chatMsg.text.trim()) return;
      for (const [, c] of clients) send(c.ws, chatMsg);
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    if (id === hostId) {
      hostId = null;
      // avisa todo mundo que o host saiu
      for (const [, c] of clients) send(c.ws, { type: 'host-left' });
    } else if (hostId !== null) {
      // avisa o host que esse viewer caiu, pra ele fechar a RTCPeerConnection
      // correspondente — sem isso, a conexão fica órfã e continua consumindo
      // CPU tentando codificar/enviar vídeo pra ninguém.
      const host = clients.get(hostId);
      if (host) send(host.ws, { type: 'viewer-left', id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando! Acesse http://localhost:${PORT} (ou pelo IP da VPN na mesma porta)`);
});
