// Renomeia dist/server(.exe) pro formato que o Tauri espera pra sidecars:
// src-tauri/binaries/server-<target-triple>(.exe)
// Referência: https://v2.tauri.app/learn/sidecar-nodejs/
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ext = process.platform === 'win32' ? '.exe' : '';

const rustInfo = execSync('rustc -Vv').toString();
const targetTriple = /host: (\S+)/g.exec(rustInfo)?.[1];

if (!targetTriple) {
  console.error('Não consegui descobrir o target triple do Rust. O rustc está instalado?');
  process.exit(1);
}

const destDir = path.join('..', 'src-tauri', 'binaries');
fs.mkdirSync(destDir, { recursive: true });

const src = path.join('dist', `server${ext}`);
const dest = path.join(destDir, `server-${targetTriple}${ext}`);

fs.copyFileSync(src, dest);
console.log(`Sidecar copiado pra: ${dest}`);
