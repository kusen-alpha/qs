/**
 * @tauri-apps/api 的测试替身。
 * vitest.config.js 把 tauri / event / window / fs / path / http 六个子模块都指向这里，
 * 所以这里需要同时导出它们各自用到的命名导出。
 */

export const invoke = async () => null;

export const listen = async () => () => {};

export const emit = async () => {};

export const getCurrent = () => ({
  label: 'main',
  close: async () => {},
  isMaximized: async () => false,
  onMoved: async () => () => {},
});

export const getAll = () => [];

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
