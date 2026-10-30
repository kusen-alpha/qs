import { describe, expect, it } from 'vitest';
import { TauriStore } from '@/utils/tauriStore';

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
