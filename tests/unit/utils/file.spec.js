import { afterEach, describe, expect, it } from 'vitest';
import {
  Files,
  getProfileId,
  legacyExists,
  readData,
  readLegacyData,
  removeLegacyFiles,
  setProfileId,
} from '@/utils/file';

afterEach(() => {
  setProfileId('');
});

describe('file · 旧版数据文件读取（浏览器模式）', () => {
  it('Files 清单与原产物一致', () => {
    expect(Files.SETTINGS).toEqual({ folder: '', file: 'settings.json', encrpt: false });
    expect(Files.MONITOR).toEqual({ folder: '', file: 'monitor.dat', encrpt: true });
    expect(Files.SYMBOL).toEqual({ folder: '', file: 'symbol.dat', encrpt: true });
  });

  it('readData 明文读取当前目录数据', async () => {
    localStorage.setItem(
      'pdd-store:browser://appdata/settings.json',
      JSON.stringify({ data: { tableSize: 'default' } }),
    );
    expect(await readData('', 'settings.json')).toEqual({ tableSize: 'default' });
  });

  it('切换 profileId 后读取独立目录，互不串台', async () => {
    localStorage.setItem(
      'pdd-store:browser://appdata/settings.json',
      JSON.stringify({ data: { tableSize: 'default' } }),
    );
    localStorage.setItem(
      'pdd-store:browser://appdata/profiles/sqlite-abc/settings.json',
      JSON.stringify({ data: { tableSize: 'large' } }),
    );

    expect(await readData('', 'settings.json')).toEqual({ tableSize: 'default' });
    setProfileId('sqlite-abc');
    expect(getProfileId()).toBe('sqlite-abc');
    expect(await readData('', 'settings.json')).toEqual({ tableSize: 'large' });
  });

  it('非 Tauri 环境不探测旧文件，直接返回空', async () => {
    expect(await legacyExists('settings.json')).toBe(false);
    expect(await readLegacyData('monitor.dat', true)).toBeNull();
    await expect(removeLegacyFiles()).resolves.toBeUndefined();
  });
});
