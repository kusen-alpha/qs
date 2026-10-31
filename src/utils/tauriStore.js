import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './env';

/**
 * tauri-plugin-store 的前端封装，命令与原始产物保持一致：
 * plugin:store|set / get / has / delete / clear / reset / keys / values / entries / length / load / save
 * 浏览器环境用 localStorage 模拟同样的 path+key 结构。
 */
function lsKey(path) {
  return `pdd-store:${path}`;
}

function readLocal(path) {
  try {
    return JSON.parse(localStorage.getItem(lsKey(path)) || '{}');
  } catch (e) {
    return {};
  }
}

function writeLocal(path, obj) {
  localStorage.setItem(lsKey(path), JSON.stringify(obj));
}

export class TauriStore {
  constructor(path) {
    this.path = path;
    // tauri-plugin-store 2.x 是资源式 API：load(path) 拿到 rid 后，
    // 后续命令都传 rid，不再传 path。
    this.rid = null;
  }

  async ensureRid() {
    if (this.rid == null) {
      this.rid = await invoke('plugin:store|load', { path: this.path });
    }
    return this.rid;
  }

  async set(key, value) {
    if (isTauri()) {
      return invoke('plugin:store|set', { rid: await this.ensureRid(), key, value });
    }
    const data = readLocal(this.path);
    data[key] = value;
    writeLocal(this.path, data);
    return value;
  }

  async get(key) {
    if (isTauri()) {
      const [value] = await invoke('plugin:store|get', {
        rid: await this.ensureRid(),
        key,
      });
      return value;
    }
    return readLocal(this.path)[key];
  }

  async has(key) {
    if (isTauri()) {
      return invoke('plugin:store|has', { rid: await this.ensureRid(), key });
    }
    return key in readLocal(this.path);
  }

  async delete(key) {
    if (isTauri()) {
      return invoke('plugin:store|delete', { rid: await this.ensureRid(), key });
    }
    const data = readLocal(this.path);
    delete data[key];
    writeLocal(this.path, data);
  }

  async clear() {
    if (isTauri()) return invoke('plugin:store|clear', { rid: await this.ensureRid() });
    writeLocal(this.path, {});
  }

  async reset() {
    if (isTauri()) return invoke('plugin:store|reset', { rid: await this.ensureRid() });
    writeLocal(this.path, {});
  }

  async keys() {
    if (isTauri()) return invoke('plugin:store|keys', { rid: await this.ensureRid() });
    return Object.keys(readLocal(this.path));
  }

  async values() {
    if (isTauri()) return invoke('plugin:store|values', { rid: await this.ensureRid() });
    return Object.values(readLocal(this.path));
  }

  async entries() {
    if (isTauri()) return invoke('plugin:store|entries', { rid: await this.ensureRid() });
    return Object.entries(readLocal(this.path));
  }

  async length() {
    if (isTauri()) return invoke('plugin:store|length', { rid: await this.ensureRid() });
    return Object.keys(readLocal(this.path)).length;
  }

  async load() {
    if (isTauri()) {
      this.rid = await invoke('plugin:store|load', { path: this.path });
      return this.rid;
    }
  }

  async save() {
    if (isTauri()) return invoke('plugin:store|save', { rid: await this.ensureRid() });
  }
}
