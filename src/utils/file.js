import { appDataDir, join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { isTauri } from './env';
import { TauriStore } from './tauriStore';
import { Ix } from './crypto';

/** 数据文件清单，与原产物 `Ct` 常量完全一致 */
export const Files = {
  SETTINGS: { folder: '', file: 'settings.json', encrpt: false },
  MONITOR: { folder: '', file: 'monitor.dat', encrpt: true },
  SYMBOL: { folder: '', file: 'symbol.dat', encrpt: true },
};

async function baseDir() {
  if (isTauri()) return appDataDir();
  return 'browser://appdata';
}

async function filePath(folder, file) {
  const base = await baseDir();
  if (!isTauri()) return [base, folder, file].filter(Boolean).join('/');
  return join(base, folder, file);
}

/** 首次创建数据文件，写入 create 时间戳 */
export async function ensureFile(folder, file) {
  const path = await filePath(folder, file);
  if (isTauri()) {
    if (await exists(path)) return false;
  } else {
    const store = new TauriStore(path);
    if (await store.has('create')) return false;
  }
  const store = new TauriStore(path);
  await store.set('create', Date.now());
  await store.save();
  return true;
}

/** 写数据文件；encrypt=true 时经 Ix 加密 */
export async function writeData(folder, file, obj, encrypt = false) {
  const path = await filePath(folder, file);
  const store = new TauriStore(path);
  if (encrypt) {
    await store.set('data', new Ix().encrypt(JSON.stringify(obj)));
  } else {
    await store.set('data', obj);
  }
  await store.save();
}

/** 读数据文件；encrypt=true 时解密并 JSON.parse */
export async function readData(folder, file, encrypt = false) {
  const path = await filePath(folder, file);
  const store = new TauriStore(path);
  const data = await store.get('data');
  if (encrypt) {
    const plain = new Ix().decrypt(data);
    return JSON.parse(plain);
  }
  return data;
}
