const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Turn = require('node-turn');

const PORT = process.env.PORT || 3000;

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
//   Servidor -> Cliente:
//     { type: 'welcome', id: <seuId> }
//     { type: 'viewer-joined', id: <idDoViewer> }   (só o host recebe)
//     { type: 'viewer-left', id: <idDoViewer> }      (só o host recebe)
//     { type: 'host-left' }                          (viewers recebem)
//     { type: 'offer'|'answer'|'ice', from: <id>, ...payload }  (repassado)

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
