import { describe, expect, it } from 'vitest';
import { matchShortcut } from '@/utils/shortcut';

describe('shortcut · 快捷键匹配', () => {
  it('Ctrl + 键', () => {
    expect(matchShortcut(['Ctrl', 'Q'], { ctrlKey: true, key: 'q' })).toBe(true);
    expect(matchShortcut(['Ctrl', 'Q'], { ctrlKey: true, key: 'Q' })).toBe(true);
    expect(matchShortcut(['Ctrl', 'Q'], { ctrlKey: true, key: 'W' })).toBe(false);
    expect(matchShortcut(['Ctrl', 'Q'], { key: 'q' })).toBe(false);
  });

  it('Shift / Alt', () => {
    expect(matchShortcut(['Shift', 'A'], { shiftKey: true, key: 'a' })).toBe(true);
    expect(matchShortcut(['Alt', 'B'], { altKey: true, key: 'B' })).toBe(true);
    expect(matchShortcut(['Alt', 'B'], { ctrlKey: true, key: 'B' })).toBe(false);
  });

  it('快捷键不完整时始终不匹配', () => {
    expect(matchShortcut(['Ctrl'], { ctrlKey: true, key: 'Q' })).toBe(false);
    expect(matchShortcut([], { ctrlKey: true, key: 'Q' })).toBe(false);
    expect(matchShortcut(null, { ctrlKey: true, key: 'Q' })).toBe(false);
  });
});
