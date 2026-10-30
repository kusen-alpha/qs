import { describe, expect, it } from 'vitest';
import { Ix } from '@/utils/crypto';

describe('crypto · Ix AES 加解密', () => {
  const ix = new Ix();

  it('加密结果是全大写 hex', () => {
    const hex = ix.encrypt('{"a":1}');
    expect(hex).toMatch(/^[0-9A-F]+$/);
    expect(hex).not.toBe(ix.encrypt('{"a":2}'));
  });

  it('解密可以还原明文（含中文）', () => {
    const plain = JSON.stringify({ name: '自选', symbols: [{ name: '贵州茅台' }] });
    expect(ix.decrypt(ix.encrypt(plain))).toBe(plain);
  });

  it('同一明文每次加密结果一致（固定 key/iv）', () => {
    expect(ix.encrypt('pdd')).toBe(ix.encrypt('pdd'));
  });
});
