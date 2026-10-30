import { afterEach, describe, expect, it } from 'vitest';
import { isTauri } from '@/utils/env';

describe('env · 运行环境判定', () => {
  afterEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_IPC__;
  });

  it('浏览器环境返回 false', () => {
    expect(isTauri()).toBe(false);
  });

  it('存在 Tauri 注入对象时返回 true', () => {
    window.__TAURI__ = {};
    expect(isTauri()).toBe(true);
    delete window.__TAURI__;
    window.__TAURI_IPC__ = () => {};
    expect(isTauri()).toBe(true);
  });
});
