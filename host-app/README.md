# ScreenShare Host (app Tauri)

App nativo que substitui o "abrir navegador + mexer em flag". Ao abrir, ele já
sobe o servidor de sinalização + TURN sozinho (como sidecar) e mostra a tela
de "Compartilhar minha tela" — clique único, sem hacks de navegador.

Seus amigos continuam entrando pelo navegador normal, sem instalar nada — isso
não muda.

## Pré-requisitos (na sua máquina Windows)

- Node.js (você já tem)
- Rust + Cargo — se não tiver: https://rustup.rs
- Tauri CLI: `cargo install tauri-cli --version "^2"`

## Passo 1 — Build do sidecar (o server.js virando .exe)

```powershell
cd sidecar
npm install
npm run build      # gera sidecar/dist/server.exe via @yao-pkg/pkg
npm run rename      # copia e renomeia pra ../src-tauri/binaries/server-<target-triple>.exe
```

Confira que apareceu um arquivo tipo
`src-tauri/binaries/server-x86_64-pc-windows-msvc.exe`.

## Passo 2 — Gerar os ícones do app

Qualquer imagem PNG quadrada (ideal ≥1024×1024) serve de fonte:

```powershell
cd ../src-tauri
cargo tauri icon caminho\para\alguma-imagem.png
```

Isso preenche a pasta `icons/` com os formatos que o `tauri.conf.json` espera.

## Passo 3 — Testar em modo dev (rápido, recomendado primeiro)

```powershell
cd ..
cargo tauri dev
```

Isso abre a janela do app sem precisar rebuildar o sidecar toda hora.
**É aqui que vale confirmar se o prompt de seleção de tela aparece
automaticamente** ao clicar em "Compartilhar minha tela" — ele deveria, já
que o WebView2 é baseado em Chromium, mas essa é a parte mais nova/menos
testada da configuração. Se não aparecer, me chama que a gente investiga o
hook de permissão do WebView2 antes de partir pro build final.

## Passo 4 — Build final (o .exe/instalador de verdade)

```powershell
cargo tauri build
```

O instalador `.exe` (NSIS) sai em
`src-tauri/target/release/bundle/nsis/`. Esse é o arquivo que você abre
(ou compartilha, se um amigo quiser ser host também no futuro).

## Firewall

As mesmas portas do servidor original continuam valendo — veja o README na
raiz do projeto (`../README.md`) pra os comandos de firewall.

## Mudanças recentes (v2)

- **`node-turn` sem vulnerabilidades**: `sidecar/package.json` ganhou um
  campo `overrides` forçando `js-yaml`, `flatted` e `log4js` pras versões
  corrigidas, sem trocar de biblioteca. Depois de puxar essa versão, rode
  `npm install` de novo dentro de `sidecar/` pra aplicar.
- **Áudio isolado por janela**: ao compartilhar, escolha **"Janela"** (não
  "Tela inteira") no seletor — assim só o áudio daquele app específico é
  capturado, sem pegar o Discord/chamadas de voz junto.
- **Volume ajustável**: um slider aparece durante a transmissão (se a fonte
  tiver áudio), controlando o volume que é *enviado* pros seus amigos,
  independente do volume local da sua máquina.
- **Bandeja do sistema**: fechar a janela (X) agora só esconde ela — a
  transmissão continua. Use o ícone na bandeja pra reabrir a janela ou
  encerrar de vez (opção "Sair").

## Limitação conhecida: apps em tela cheia exclusiva

Jogos em fullscreen exclusivo (às vezes até "borderless" que na prática ainda
usa modo exclusivo) podem travar ou aparecer pretos pra quem assiste — isso é
uma limitação da API de captura do Windows (Windows Graphics Capture), não
algo que dá pra corrigir no código. Tente: desativar "otimizações de tela
cheia" nas propriedades do .exe do jogo, desligar G-Sync/FreeSync durante a
transmissão, ou desativar "Agendamento de GPU com aceleração de hardware" em
Configurações > Sistema > Tela > Gráficos.

## Se algo der errado

- **"failed to create sidecar command"**: o nome em `tauri.conf.json` >
  `bundle.externalBin`, em `capabilities/default.json` e na chamada
  `shell.sidecar("binaries/server")` no `main.rs` precisam bater
  exatamente. Já vêm sincronizados aqui, mas se renomear algo, ajuste nos
  três lugares.
- **App abre mas não conecta**: confirme que `server-<target-triple>.exe`
  existe em `src-tauri/binaries/` com o nome certo (rode
  `rustc -Vv` pra conferir o target triple da sua máquina).
- **getDisplayMedia não mostra prompt**: essa é a parte experimental —
  veja o aviso no Passo 3.
