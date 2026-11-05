'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const outDir = path.join(root, 'release');

if (!fs.existsSync(bundleDir)) {
  console.error(`[copy-release] 未找到安装包目录：${bundleDir}，请先执行 tauri build`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

// 清掉上一次的安装包，避免 release 目录里堆着旧版本
for (const file of fs.readdirSync(outDir)) {
  if (file.endsWith('.exe')) {
    fs.rmSync(path.join(outDir, file));
  }
}

let copied = 0;
for (const file of fs.readdirSync(bundleDir)) {
  if (!file.endsWith('.exe')) continue;
  fs.copyFileSync(path.join(bundleDir, file), path.join(outDir, file));
  console.log(`[copy-release] ${file} -> release/`);
  copied += 1;
}

if (!copied) {
  console.error('[copy-release] 安装包目录中没有 exe');
  process.exit(1);
}
