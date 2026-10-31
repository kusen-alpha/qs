'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const versionFile = path.join(root, 'version.json');
const tauriConf = path.join(root, 'src-tauri', 'tauri.conf.json');

const version = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
if (!version || typeof version !== 'string') {
  console.error('[prepare-version] version.json 缺少 version 字段');
  process.exit(1);
}

const conf = JSON.parse(fs.readFileSync(tauriConf, 'utf8'));
conf.version = version;
fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + '\n', 'utf8');
console.log(`[prepare-version] tauri.conf.json version -> ${version}`);
