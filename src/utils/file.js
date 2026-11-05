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

let profileId = '';

/** 切换当前数据库对应的配置目录；空值表示旧版公共目录 */
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

/** 旧版公共目录下的同名文件，用于首次切到分库目录时迁移设置 */
async function legacyFilePath(folder, file) {
  return join(await appDataDir(), folder, file);
}

async function copyStore(from, to) {
  const source = new TauriStore(from);
  const target = new TauriStore(to);
  for (const key of await source.keys()) {
    await target.set(key, await source.get(key));
  }
  await target.save();
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
    // 分库目录首次创建时，沿用旧版公共文件里的设置与缓存
    if (profileId) {
      const legacy = await legacyFilePath(folder, file);
      if (await exists(legacy)) {
        await copyStore(legacy, path);
        return false;
      }
    }
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
