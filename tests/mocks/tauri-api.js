/**
 * @tauri-apps/api 的测试替身。
 * vitest.config.js 把 tauri / event / window / fs / path / http 六个子模块都指向这里，
 * 所以这里需要同时导出它们各自用到的命名导出。
 */

export const invoke = async () => null;

export const listen = async () => () => {};

export const emit = async () => {};

export const register = async () => {};

export const unregister = async () => {};

export const unregisterAll = async () => {};

export class LogicalSize {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
}

export class PhysicalPosition {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

export const getCurrent = () => ({
  label: 'main',
  close: async () => {},
  isMaximized: async () => false,
  maximize: async () => {},
  unmaximize: async () => {},
  minimize: async () => {},
  hide: async () => {},
  show: async () => {},
  isVisible: async () => true,
  setSize: async () => {},
  setPosition: async () => {},
  outerPosition: async () => ({ x: 0, y: 0 }),
  outerSize: async () => ({ width: 100, height: 100 }),
  setFocus: async () => {},
  onMoved: async () => () => {},
});

export const getCurrentWindow = getCurrent;

export const getAll = () => [];

export const getAllWindows = getAll;

export const availableMonitors = async () => [];

export class WebviewWindow {
  constructor(label, options) {
    this.label = label;
    this.options = options;
  }

  async close() {}
}

export const appDataDir = async () => 'browser://appdata/';

export const join = async (...parts) => parts.filter(Boolean).join('/');

export const exists = async () => false;

export const fetch = async () => ({ ok: false, status: 0, data: null });

export const ResponseType = { JSON: 1, Text: 2, Binary: 3 };
