import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriStore } from '@/utils/tauriStore';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => null),
}));

// 测试配置把 @tauri-apps/api/core 指向同一份 mock，这里直接 mock 该共享文件
vi.mock('../../mocks/tauri-api.js', () => ({ invoke: mocks.invoke }));

function newStore(name) {
  return new TauriStore(`tests/${name}.json`);
}

describe('tauriStore · 浏览器 localStorage 兼容层', () => {
  it('set / get / has', async () => {
    const store = newStore('set-get');
    expect(await store.has('a')).toBe(false);
    await store.set('a', 1);
    expect(await store.get('a')).toBe(1);
    expect(await store.has('a')).toBe(true);
  });

  it('delete 后键不存在', async () => {
    const store = newStore('delete');
    await store.set('a', 1);
    await store.delete('a');
    expect(await store.has('a')).toBe(false);
  });

  it('keys / values / entries / length', async () => {
    const store = newStore('list');
    await store.set('a', 1);
    await store.set('b', 2);
    expect(await store.keys()).toEqual(['a', 'b']);
    expect(await store.values()).toEqual([1, 2]);
    expect(await store.entries()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(await store.length()).toBe(2);
  });

  it('不同 path 互相隔离', async () => {
    const one = newStore('iso-1');
    const two = newStore('iso-2');
    await one.set('key', 'one');
    await two.set('key', 'two');
    expect(await one.get('key')).toBe('one');
    expect(await two.get('key')).toBe('two');
  });

  it('clear 清空全部键', async () => {
    const store = newStore('clear');
    await store.set('a', 1);
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });

  it('本地数据损坏时按空对象处理', async () => {
    const store = newStore('broken');
    localStorage.setItem('pdd-store:tests/broken.json', '{not-json');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.keys()).toEqual([]);
  });
});

describe('tauriStore 路 Tauri 资源式 API', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    mocks.invoke.mockReset();
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it('先 load 拿 rid，后续命令传 rid', async () => {
    mocks.invoke.mockResolvedValueOnce(42);
    const store = newStore('tauri-set');
    await store.set('a', 1);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'plugin:store|load', {
      path: 'tests/tauri-set.json',
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'plugin:store|set', {
      rid: 42,
      key: 'a',
      value: 1,
    });
  });

  it('get 解包 (value, exists) 元组', async () => {
    mocks.invoke.mockResolvedValueOnce(42).mockResolvedValueOnce([7, true]);
    const store = newStore('tauri-get');
    expect(await store.get('a')).toBe(7);
    expect(mocks.invoke).toHaveBeenLastCalledWith('plugin:store|get', {
      rid: 42,
      key: 'a',
    });
  });

  it('rid 只加载一次，跨命令复用', async () => {
    mocks.invoke.mockImplementation((cmd) => {
      if (cmd === 'plugin:store|load') return Promise.resolve(42);
      if (cmd === 'plugin:store|get') return Promise.resolve([1, true]);
      return Promise.resolve(null);
    });
    const store = newStore('tauri-once');
    await store.set('a', 1);
    await store.get('a');
    const loadCalls = mocks.invoke.mock.calls.filter(
      ([cmd]) => cmd === 'plugin:store|load',
    );
    expect(loadCalls).toHaveLength(1);
  });
});
