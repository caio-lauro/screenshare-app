# Compartilhamento de Tela (protótipo)

## Como rodar (você, o host)

1. Instale as dependências (só uma vez):
   ```
   npm install
   ```
2. Suba o servidor:
   ```
   node server.js
   ```
3. Abra `http://localhost:3000` no seu navegador e clique em **"Hospedar minha tela"**.
4. Passe seu **IP da Radmin VPN + porta 3000** pros seus amigos, ex:
   ```
   http://25.x.x.x:3000
   ```

## Como seus amigos entram (zero instalação)

1. Certifique-se de que estão conectados na mesma rede Radmin.
2. Abrem o link que você passou (`http://<seu-ip-radmin>:3000`) em qualquer navegador.
3. Clicam em **"Entrar em uma sala"**.
4. Pronto — a tela aparece automaticamente.

## Limitações do protótipo (de propósito, pra manter simples)

- Só o host transmite (sem áudio de microfone, sem "trocar de apresentador" ainda).
- Sem senha/autenticação — quem tiver o link entra. Como é só na VPN entre vocês, tende a ser ok.
- Se o host fechar a aba, todo mundo é desconectado (dá pra host recarregar e recomeçar).
- Testado pensando em Chrome/Firefox recentes. `getDisplayMedia` funciona bem nesses.

## Próximos passos possíveis

- Empacotar com Tauri pra virar um `.exe`/binário que os amigos só clicam duas vezes (sem precisar rodar `node`).
- Adicionar campo de senha simples na sala.
- Permitir trocar quem está compartilhando sem reiniciar o servidor.
