import { invoke } from '@tauri-apps/api/tauri';
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
  }

  async set(key, value) {
    if (isTauri()) return invoke('plugin:store|set', { path: this.path, key, value });
    const data = readLocal(this.path);
    data[key] = value;
    writeLocal(this.path, data);
    return value;
  }

  async get(key) {
    if (isTauri()) return invoke('plugin:store|get', { path: this.path, key });
    return readLocal(this.path)[key];
  }

  async has(key) {
    if (isTauri()) return invoke('plugin:store|has', { path: this.path, key });
    return key in readLocal(this.path);
  }

  async delete(key) {
    if (isTauri()) return invoke('plugin:store|delete', { path: this.path, key });
    const data = readLocal(this.path);
    delete data[key];
    writeLocal(this.path, data);
  }

  async clear() {
    if (isTauri()) return invoke('plugin:store|clear', { path: this.path });
    writeLocal(this.path, {});
  }

  async reset() {
    if (isTauri()) return invoke('plugin:store|reset', { path: this.path });
    writeLocal(this.path, {});
  }

  async keys() {
    if (isTauri()) return invoke('plugin:store|keys', { path: this.path });
    return Object.keys(readLocal(this.path));
  }

  async values() {
    if (isTauri()) return invoke('plugin:store|values', { path: this.path });
    return Object.values(readLocal(this.path));
  }

  async entries() {
    if (isTauri()) return invoke('plugin:store|entries', { path: this.path });
    return Object.entries(readLocal(this.path));
  }

  async length() {
    if (isTauri()) return invoke('plugin:store|length', { path: this.path });
    return Object.keys(readLocal(this.path)).length;
  }

  async load() {
    if (isTauri()) return invoke('plugin:store|load', { path: this.path });
  }

  async save() {
    if (isTauri()) return invoke('plugin:store|save', { path: this.path });
  }
}
