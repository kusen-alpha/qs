import { afterEach, describe, expect, it } from 'vitest';
import { Files, ensureFile, readData, setProfileId, writeData } from '@/utils/file';

afterEach(() => {
  setProfileId('');
});

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

  it('切换 profileId 后数据写入独立目录，互不串台', async () => {
    await writeData('', 'settings.json', { tableSize: 'default' });

    setProfileId('sqlite-abc');
    expect(await ensureFile('', 'settings.json')).toBe(true);
    await writeData('', 'settings.json', { tableSize: 'large' });
    expect(
      localStorage.getItem('pdd-store:browser://appdata/profiles/sqlite-abc/settings.json'),
    ).toBeTruthy();
    expect(await readData('', 'settings.json')).toEqual({ tableSize: 'large' });

    setProfileId('');
    expect(await readData('', 'settings.json')).toEqual({ tableSize: 'default' });
  });
});
