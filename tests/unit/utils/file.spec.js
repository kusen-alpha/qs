import { describe, expect, it } from 'vitest';
import { Files, ensureFile, readData, writeData } from '@/utils/file';

describe('file · 数据文件读写（浏览器模式）', () => {
  it('Files 清单与原产物一致', () => {
    expect(Files.SETTINGS).toEqual({ folder: '', file: 'settings.json', encrpt: false });
    expect(Files.MONITOR).toEqual({ folder: '', file: 'monitor.dat', encrpt: true });
    expect(Files.SYMBOL).toEqual({ folder: '', file: 'symbol.dat', encrpt: true });
  });

  it('ensureFile 首次创建返回 true，再次调用返回 false', async () => {
    expect(await ensureFile('', 'settings.json')).toBe(true);
    expect(await ensureFile('', 'settings.json')).toBe(false);
  });

  it('writeData / readData 明文往返', async () => {
    await writeData('', 'settings.json', { tableSize: 'default' });
    expect(await readData('', 'settings.json')).toEqual({ tableSize: 'default' });
  });

  it('writeData / readData 加密往返', async () => {
    const obj = { group: [{ name: '自选', symbols: [] }] };
    await writeData('', 'monitor.dat', obj, true);
    expect(await readData('', 'monitor.dat', true)).toEqual(obj);
    const raw = JSON.parse(localStorage.getItem('pdd-store:browser://appdata/monitor.dat'));
    expect(typeof raw.data).toBe('string');
    expect(raw.data).not.toContain('自选');
  });
});
