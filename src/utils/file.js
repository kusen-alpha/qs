import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, remove } from '@tauri-apps/plugin-fs';
import { isTauri } from './env';
import { TauriStore } from './tauriStore';
import { Ix } from './crypto';

/** 旧版数据文件清单，仅用于一次性迁移，迁移完成后删除 */
export const Files = {
  SETTINGS: { folder: '', file: 'settings.json', encrpt: false },
  MONITOR: { folder: '', file: 'monitor.dat', encrpt: true },
  SYMBOL: { folder: '', file: 'symbol.dat', encrpt: true },
};

let profileId = '';

/** 当前数据库对应的旧版配置目录；空值表示旧版公共目录 */
export function setProfileId(id) {
  profileId = String(id || '').trim();
}

export function getProfileId() {
  return profileId;
}

async function baseDir() {
  if (!isTauri()) {
    return profileId ? `browser://appdata/profiles/${profileId}` : 'browser://appdata';
  }
  const base = await appDataDir();
  return profileId ? join(base, 'profiles', profileId) : base;
}

async function filePath(folder, file) {
  const base = await baseDir();
  if (!isTauri()) return [base, folder, file].filter(Boolean).join('/');
  return join(base, folder, file);
}

/**
 * 旧版文件可能落在两个位置：分库目录 profiles/<id>/ 与旧版公共根目录。
 * 迁移时两处都检查，避免切换数据库后只读到其中一份。
 */
async function legacyPaths(file) {
  if (!isTauri()) return [];
  const base = await appDataDir();
  const paths = [];
  if (profileId) paths.push(await join(base, 'profiles', profileId, file));
  paths.push(await join(base, file));
  return paths;
}

/** 旧版文件是否仍存在（任一处存在即 true） */
export async function legacyExists(file) {
  if (!isTauri()) return false;
  for (const path of await legacyPaths(file)) {
    if (await exists(path)) return true;
  }
  return false;
}

/** 依次读取分库目录与旧版公共目录，返回第一个有效数据 */
export async function readLegacyData(file, encrypt = false) {
  for (const path of await legacyPaths(file)) {
    if (!(await exists(path))) continue;
    const store = new TauriStore(path);
    const data = await store.get('data');
    if (data === undefined || data === null) continue;
    if (encrypt) {
      const plain = new Ix().decrypt(data);
      return JSON.parse(plain);
    }
    return data;
  }
  return null;
}

/** 删除两处目录下的全部旧版数据文件；单文件失败不阻断其它文件 */
export async function removeLegacyFiles() {
  if (!isTauri()) return;
  for (const item of Object.values(Files)) {
    for (const path of await legacyPaths(item.file)) {
      try {
        if (await exists(path)) await remove(path);
      } catch (e) {
        console.error('[file] 删除旧版数据文件失败', path, e);
      }
    }
  }
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
