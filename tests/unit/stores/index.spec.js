import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMonitorStore } from '@/stores/monitor';
import { useSettingStore } from '@/stores/setting';
import { useSymbolStore } from '@/stores/symbol';
import { initStores } from '@/stores/index';
import { freshPinia } from '../../helpers';

const mocks = vi.hoisted(() => ({
  isTauriValue: true,
  label: 'main',
  ensureFile: vi.fn(),
  readData: vi.fn(),
  writeData: vi.fn(),
  migrateWatchGroup: vi.fn(),
  loadWatchlist: vi.fn(),
  buildWatchGroup: vi.fn(),
  saveWatchGroup: vi.fn(),
  refreshBoardHistory: vi.fn(),
  syncWatchHistory: vi.fn(),
  ensureMarketWidthHistory: vi.fn(),
  invoke: vi.fn(),
  getCurrentWindow: vi.fn(),
}));

vi.mock('@/utils/env', () => ({
  isTauri: () => mocks.isTauriValue,
  inTauri: true,
}));

vi.mock('@/utils/file', () => ({
  ensureFile: mocks.ensureFile,
  readData: mocks.readData,
  writeData: mocks.writeData,
  Files: {
    SETTINGS: { folder: '', file: 'settings.json', encrpt: false },
    MONITOR: { folder: '', file: 'monitor.dat', encrpt: true },
    SYMBOL: { folder: '', file: 'symbol.dat', encrpt: true },
  },
}));

vi.mock('@/utils/db', () => ({
  migrateWatchGroup: mocks.migrateWatchGroup,
  loadWatchlist: mocks.loadWatchlist,
  buildWatchGroup: mocks.buildWatchGroup,
  saveWatchGroup: mocks.saveWatchGroup,
  refreshBoardHistory: mocks.refreshBoardHistory,
}));

vi.mock('@/utils/klineSync', () => ({ syncWatchHistory: mocks.syncWatchHistory }));

vi.mock('@/api/legulegu', () => ({
  ensureMarketWidthHistory: mocks.ensureMarketWidthHistory,
}));

vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

vi.mock('../../mocks/tauri-api.js', () => ({
  invoke: mocks.invoke,
  getCurrentWindow: mocks.getCurrentWindow,
}));

describe('stores/index · 主窗口数据初始化', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshPinia();
    // Pinia 插件在未挂载 app 时不会执行，手动补上 store 上的持久化方法
    useSettingStore().$persist = () => {};
    useMonitorStore().$persist = () => {};
    useSymbolStore().$persist = () => {};
    mocks.isTauriValue = true;
    mocks.label = 'main';
    mocks.getCurrentWindow.mockImplementation(() => ({ label: mocks.label }));
    mocks.ensureFile.mockResolvedValue(true);
    mocks.readData.mockResolvedValue(null);
    mocks.migrateWatchGroup.mockResolvedValue({ migrated: true });
    mocks.loadWatchlist.mockResolvedValue({ stocks: [], notions: [], members: [] });
    mocks.buildWatchGroup.mockReturnValue([]);
    mocks.syncWatchHistory.mockResolvedValue({});
    mocks.refreshBoardHistory.mockResolvedValue({ days: 5 });
    mocks.ensureMarketWidthHistory.mockResolvedValue({});
    mocks.invoke.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('非 Tauri 环境直接早退，不读写任何文件', async () => {
    mocks.isTauriValue = false;
    await initStores();
    expect(mocks.ensureFile).not.toHaveBeenCalled();
    expect(mocks.writeData).not.toHaveBeenCalled();
    expect(mocks.migrateWatchGroup).not.toHaveBeenCalled();
    expect(mocks.syncWatchHistory).not.toHaveBeenCalled();
    expect(mocks.refreshBoardHistory).not.toHaveBeenCalled();
    expect(mocks.ensureMarketWidthHistory).not.toHaveBeenCalled();
  });

  it('非 main 窗口同样早退，不触发迁移与补齐', async () => {
    mocks.label = 'market';
    await initStores();
    expect(mocks.ensureFile).not.toHaveBeenCalled();
    expect(mocks.migrateWatchGroup).not.toHaveBeenCalled();
    expect(mocks.syncWatchHistory).not.toHaveBeenCalled();
    expect(mocks.ensureMarketWidthHistory).not.toHaveBeenCalled();
  });

  it('首次创建文件时写入三个 store 的初始快照，并迁移旧自选结构', async () => {
    await initStores();

    expect(mocks.ensureFile).toHaveBeenCalledTimes(3);
    expect(mocks.writeData).toHaveBeenCalledTimes(3);

    const [settingsCall, monitorCall, symbolCall] = mocks.writeData.mock.calls;
    expect(settingsCall[1]).toBe('settings.json');
    expect(settingsCall[2]).toMatchObject({ tableSize: 'small', fixedWidth: 380 });
    expect(monitorCall[1]).toBe('monitor.dat');
    expect(monitorCall[2].watchGroup[0]).toMatchObject({ name: '自选', id: 0 });
    expect(symbolCall[1]).toBe('symbol.dat');
    expect(symbolCall[2].configs).toEqual({});

    expect(mocks.migrateWatchGroup).toHaveBeenCalledTimes(1);
    expect(mocks.migrateWatchGroup.mock.calls[0][0][0]).toMatchObject({ name: '自选', id: 0 });
    expect(mocks.buildWatchGroup).toHaveBeenCalledWith({
      stocks: [],
      notions: [],
      members: [],
    });
  });

  it('数据库为空时 loadFromDb 返回 false，保留本地默认自选', async () => {
    const monitor = useMonitorStore();
    const loaded = await monitor.loadFromDb();
    expect(loaded).toBe(false);
    expect(monitor.watchGroup).toHaveLength(1);
    expect(monitor.watchGroup[0].symbols.map((s) => s.secid)).toEqual(['1.600519']);
  });

  it('initStores 在数据库有数据时用其回填 monitor 并持久化快照', async () => {
    const monitor = useMonitorStore();
    const persistSpy = vi.spyOn(monitor, '$persist');
    mocks.buildWatchGroup.mockReturnValue([
      { name: '自选', id: 0, symbols: [] },
      { name: '白酒', id: 1, symbols: [] },
    ]);

    await initStores();

    expect(monitor.watchGroup.map((g) => g.name)).toEqual(['自选', '白酒']);
    expect(persistSpy).toHaveBeenCalled();
  });

  it('已有文件时读回数据并覆盖对应 store 状态，不写初始快照', async () => {
    mocks.ensureFile.mockResolvedValue(false);
    mocks.readData.mockImplementation(async (folder, file) => {
      if (file === 'settings.json') return { tableSize: 'default', isOpenWithSystem: true };
      if (file === 'symbol.dat') {
        return { configs: { '1.600519': { position: { num: 100 } } } };
      }
      return null;
    });

    const setting = useSettingStore();
    const symbol = useSymbolStore();
    await initStores();

    expect(mocks.writeData).not.toHaveBeenCalled();
    expect(setting.tableSize).toBe('default');
    expect(setting.fixedWidth).toBe(380); // 未回填的字段保留默认值
    expect(symbol.configs['1.600519']).toEqual({ position: { num: 100 } });
  });

  it('文件存在但内容为空时保留各 store 默认值', async () => {
    mocks.ensureFile.mockResolvedValue(false);
    await initStores();
    expect(useSettingStore().tableSize).toBe('small');
    expect(useMonitorStore().watchGroup[0].name).toBe('自选');
    expect(useSymbolStore().configs).toEqual({});
  });

  it('启动补齐日K 延后 5 秒执行，异常只记录日志不抛出', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.syncWatchHistory.mockRejectedValue(new Error('boom'));

    await initStores();
    expect(mocks.syncWatchHistory).not.toHaveBeenCalled();
    expect(mocks.refreshBoardHistory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.syncWatchHistory).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[kline] 启动补齐失败', expect.any(Error));
    // 日K补齐失败也要继续刷新板块历史
    expect(mocks.refreshBoardHistory).toHaveBeenCalledWith(5);
    errorSpy.mockRestore();
  });

  it('启动补齐日K 完成后按最近 5 个交易日幂等刷新板块历史', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.refreshBoardHistory.mockRejectedValue(new Error('board boom'));

    await initStores();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mocks.syncWatchHistory).toHaveBeenCalledTimes(1);
    expect(mocks.refreshBoardHistory).toHaveBeenCalledTimes(1);
    expect(mocks.refreshBoardHistory).toHaveBeenCalledWith(5);
    expect(errorSpy).toHaveBeenCalledWith('[board] 板块历史刷新失败', expect.any(Error));
    expect(errorSpy).not.toHaveBeenCalledWith('[kline] 启动补齐失败', expect.anything());
    errorSpy.mockRestore();
  });

  it('启动 5 秒后幂等补齐市场宽度历史，异常只记录日志', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ensureMarketWidthHistory.mockRejectedValue(new Error('width boom'));

    await initStores();
    expect(mocks.ensureMarketWidthHistory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.ensureMarketWidthHistory).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[marketWidth] 市场宽度历史补齐失败',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('开机自启状态与设置不一致时会调用对应插件命令', async () => {
    mocks.ensureFile.mockResolvedValue(false);
    mocks.readData.mockImplementation(async (folder, file) => {
      if (file === 'settings.json') return { isOpenWithSystem: true };
      return null;
    });
    mocks.invoke.mockImplementation(async (cmd) =>
      cmd === 'plugin:autostart|is_enabled' ? false : undefined,
    );

    await initStores();
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|is_enabled');
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|enable');
  });

  it('系统已开启自启但设置为关闭时调用 disable', async () => {
    mocks.ensureFile.mockResolvedValue(false);
    mocks.invoke.mockImplementation(async (cmd) =>
      cmd === 'plugin:autostart|is_enabled' ? true : undefined,
    );

    await initStores();
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|is_enabled');
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|disable');
  });

  it('自启插件不可用时异常被吞掉，initStores 正常完成', async () => {
    mocks.ensureFile.mockResolvedValue(false);
    mocks.invoke.mockRejectedValue(new Error('plugin missing'));

    await expect(initStores()).resolves.toBeUndefined();
    expect(mocks.migrateWatchGroup).toHaveBeenCalledTimes(1);
  });
});
