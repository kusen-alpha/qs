import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  remove: vi.fn(),
  readStore: vi.fn(),
}));

vi.mock('@/utils/env', () => ({ isTauri: () => true }));
vi.mock('../../mocks/tauri-api.js', () => ({
  appDataDir: async () => 'C:\\Users\\u\\AppData\\Roaming\\com.daic.qushi',
  join: async (...parts) => parts.join('\\'),
  exists: mocks.exists,
  remove: mocks.remove,
}));
vi.mock('@/utils/tauriStore', () => ({
  TauriStore: class {
    constructor(path) {
      this.path = path;
    }

    async get(key) {
      return mocks.readStore(this.path, key);
    }
  },
}));

import { legacyExists, readLegacyData, removeLegacyFiles, setProfileId } from '@/utils/file';

const BASE = 'C:\\Users\\u\\AppData\\Roaming\\com.daic.qushi';
const PROFILE = 'sqlite-abc';
const PROFILE_DIR = `${BASE}\\profiles\\${PROFILE}`;

beforeEach(() => {
  mocks.exists.mockReset();
  mocks.exists.mockResolvedValue(false);
  mocks.remove.mockReset();
  mocks.remove.mockResolvedValue(undefined);
  mocks.readStore.mockReset();
  mocks.readStore.mockResolvedValue(undefined);
});

afterEach(() => {
  setProfileId('');
});

describe('file · 旧版数据文件读取（桌面端）', () => {
  it('以解析后的字符串路径探测分库目录与公共目录', async () => {
    setProfileId(PROFILE);
    mocks.exists.mockResolvedValue(false);

    await expect(legacyExists('monitor.dat')).resolves.toBe(false);

    const paths = mocks.exists.mock.calls.map(([path]) => path);
    expect(paths).toEqual([`${PROFILE_DIR}\\monitor.dat`, `${BASE}\\monitor.dat`]);
    expect(paths.every((path) => typeof path === 'string')).toBe(true);
  });

  it('分库目录先命中时不再探测公共目录', async () => {
    setProfileId(PROFILE);
    mocks.exists.mockImplementation(async (path) => path === `${PROFILE_DIR}\\monitor.dat`);

    await expect(legacyExists('monitor.dat')).resolves.toBe(true);
    expect(mocks.exists).toHaveBeenCalledTimes(1);
  });

  it('两处目录都没有旧文件时返回 false', async () => {
    setProfileId(PROFILE);
    await expect(legacyExists('settings.json')).resolves.toBe(false);
    expect(mocks.exists).toHaveBeenCalledTimes(2);
  });

  it('未设置分库标识时只探测公共目录', async () => {
    mocks.exists.mockImplementation(async (path) => path === `${BASE}\\settings.json`);

    await expect(legacyExists('settings.json')).resolves.toBe(true);
    expect(mocks.exists.mock.calls.map(([path]) => path)).toEqual([`${BASE}\\settings.json`]);
  });

  it('读取第一个存在的旧文件数据', async () => {
    setProfileId(PROFILE);
    mocks.exists.mockImplementation(async (path) => path === `${BASE}\\settings.json`);
    mocks.readStore.mockResolvedValue({ tableSize: 'default' });

    await expect(readLegacyData('settings.json')).resolves.toEqual({ tableSize: 'default' });
    expect(mocks.readStore).toHaveBeenCalledWith(`${BASE}\\settings.json`, 'data');
  });

  it('删除分库目录中的旧版数据文件', async () => {
    setProfileId(PROFILE);
    mocks.exists.mockImplementation(async (path) => path.startsWith(`${PROFILE_DIR}\\`));

    await removeLegacyFiles();

    expect(mocks.remove.mock.calls.map(([path]) => path)).toEqual([
      `${PROFILE_DIR}\\settings.json`,
      `${PROFILE_DIR}\\monitor.dat`,
      `${PROFILE_DIR}\\symbol.dat`,
    ]);
    expect(mocks.remove.mock.calls.every(([path]) => typeof path === 'string')).toBe(true);
  });
});
