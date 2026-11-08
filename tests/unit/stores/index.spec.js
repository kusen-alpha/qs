import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMonitorStore } from '@/stores/monitor';
import { useSettingStore } from '@/stores/setting';
import { useSymbolStore } from '@/stores/symbol';
import { initStores } from '@/stores/index';
import { freshPinia } from '../../helpers';

const mocks = vi.hoisted(() => ({
  isTauriValue: true,
  label: 'main',
  legacyExists: vi.fn(),
  readLegacyData: vi.fn(),
  removeLegacyFiles: vi.fn(),
  importLegacy: vi.fn(),
  loadWatchlist: vi.fn(),
  buildWatchGroup: vi.fn(),
  saveWatchGroup: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  loadSymbolConfigs: vi.fn(),
  saveSymbolConfigs: vi.fn(),
  refreshBoardHistory: vi.fn(),
  syncWatchHistory: vi.fn(),
  ensureMarketWidthHistory: vi.fn(),
  startNonTradingCalendar: vi.fn(),
  invoke: vi.fn(),
  getCurrentWindow: vi.fn(),
}));

vi.mock('@/utils/env', () => ({
  isTauri: () => mocks.isTauriValue,
  inTauri: true,
}));

vi.mock('@/utils/file', () => ({
  legacyExists: mocks.legacyExists,
  readLegacyData: mocks.readLegacyData,
  removeLegacyFiles: mocks.removeLegacyFiles,
  Files: {
    SETTINGS: { folder: '', file: 'settings.json', encrpt: false },
    MONITOR: { folder: '', file: 'monitor.dat', encrpt: true },
    SYMBOL: { folder: '', file: 'symbol.dat', encrpt: true },
  },
}));

vi.mock('@/utils/db', () => ({
  importLegacy: mocks.importLegacy,
  loadWatchlist: mocks.loadWatchlist,
  buildWatchGroup: mocks.buildWatchGroup,
  saveWatchGroup: mocks.saveWatchGroup,
  loadSettings: mocks.loadSettings,
  saveSettings: mocks.saveSettings,
  loadSymbolConfigs: mocks.loadSymbolConfigs,
  saveSymbolConfigs: mocks.saveSymbolConfigs,
  refreshBoardHistory: mocks.refreshBoardHistory,
}));

vi.mock('@/utils/klineSync', () => ({ syncWatchHistory: mocks.syncWatchHistory }));

vi.mock('@/utils/nonTrading', () => ({
  startNonTradingCalendar: mocks.startNonTradingCalendar,
}));

vi.mock('@/api/legulegu', () => ({
  ensureMarketWidthHistory: mocks.ensureMarketWidthHistory,
}));

vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

vi.mock('../../mocks/tauri-api.js', () => ({
  invoke: mocks.invoke,
  getCurrentWindow: mocks.getCurrentWindow,
}));

describe('stores/index · 数据库唯一来源初始化', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshPinia();
    mocks.isTauriValue = true;
    mocks.label = 'main';
    mocks.getCurrentWindow.mockImplementation(() => ({ label: mocks.label }));
    mocks.legacyExists.mockResolvedValue(false);
    mocks.readLegacyData.mockResolvedValue(null);
    mocks.removeLegacyFiles.mockResolvedValue(undefined);
    mocks.importLegacy.mockResolvedValue({ imported: true });
    mocks.loadWatchlist.mockResolvedValue({ stocks: [], notions: [], members: [] });
    mocks.buildWatchGroup.mockReturnValue([]);
    mocks.loadSettings.mockResolvedValue(null);
    mocks.loadSymbolConfigs.mockResolvedValue({});
    mocks.syncWatchHistory.mockResolvedValue({});
    mocks.refreshBoardHistory.mockResolvedValue({ days: 5 });
    mocks.ensureMarketWidthHistory.mockResolvedValue({});
    mocks.startNonTradingCalendar.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('非 Tauri 环境直接早退，不读库也不启动任务', async () => {
    mocks.isTauriValue = false;
    await initStores();
    expect(mocks.loadWatchlist).not.toHaveBeenCalled();
    expect(mocks.loadSettings).not.toHaveBeenCalled();
    expect(mocks.syncWatchHistory).not.toHaveBeenCalled();
    expect(mocks.ensureMarketWidthHistory).not.toHaveBeenCalled();
    expect(mocks.startNonTradingCalendar).not.toHaveBeenCalled();
  });

  it('子窗口只从数据库回填，不迁移旧文件、不启动补齐任务', async () => {
    mocks.label = 'group';
    await initStores();
    expect(mocks.legacyExists).not.toHaveBeenCalled();
    expect(mocks.importLegacy).not.toHaveBeenCalled();
    expect(mocks.loadWatchlist).toHaveBeenCalledTimes(1);
    expect(mocks.loadSettings).toHaveBeenCalledTimes(1);
    expect(mocks.loadSymbolConfigs).toHaveBeenCalledTimes(1);
    expect(mocks.syncWatchHistory).not.toHaveBeenCalled();
    expect(mocks.ensureMarketWidthHistory).not.toHaveBeenCalled();
    expect(mocks.startNonTradingCalendar).not.toHaveBeenCalled();
  });

  it('主窗口无旧文件时跳过迁移，只从数据库回填', async () => {
    await initStores();
    expect(mocks.legacyExists).toHaveBeenCalledTimes(3);
    expect(mocks.importLegacy).not.toHaveBeenCalled();
    expect(mocks.removeLegacyFiles).not.toHaveBeenCalled();

    const monitor = useMonitorStore();
    expect(monitor.watchGroup).toEqual([{ name: '自选', id: 0, symbols: [] }]);
    expect(useSymbolStore().configs).toEqual({});
  });

  it('旧文件迁移成功后才删除文件', async () => {
    mocks.legacyExists.mockResolvedValue(true);
    mocks.readLegacyData.mockImplementation(async (file) => {
      if (file === 'settings.json') return { tableSize: 'default' };
      if (file === 'symbol.dat') return { configs: { '1.600519': { position: { num: 100 } } } };
      if (file === 'monitor.dat') {
        return { watchGroup: [{ name: '自选', id: 0, symbols: [{ secid: '1.600519' }] }] };
      }
      return null;
    });

    await initStores();
    expect(mocks.importLegacy).toHaveBeenCalledTimes(1);
    expect(mocks.importLegacy).toHaveBeenCalledWith({
      settings: { tableSize: 'default' },
      symbolConfigs: { '1.600519': { position: { num: 100 } } },
      groups: [{ name: '自选', id: 0, symbols: [{ secid: '1.600519' }] }],
    });
    expect(mocks.removeLegacyFiles).toHaveBeenCalledTimes(1);
  });

  it('迁移失败时保留旧文件，下次启动可重试', async () => {
    mocks.legacyExists.mockResolvedValue(true);
    mocks.importLegacy.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await initStores();
    expect(mocks.removeLegacyFiles).not.toHaveBeenCalled();

    mocks.importLegacy.mockRejectedValueOnce(new Error('boom'));
    await initStores();
    expect(mocks.removeLegacyFiles).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[legacy] 旧版数据迁移失败', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('旧文件探测异常时保住主流程，仍从数据库回填', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.legacyExists.mockRejectedValue(new Error('旧文件探测失败'));

    await expect(initStores()).resolves.toBeUndefined();
    expect(mocks.importLegacy).not.toHaveBeenCalled();
    expect(mocks.removeLegacyFiles).not.toHaveBeenCalled();
    expect(mocks.loadWatchlist).toHaveBeenCalledTimes(1);
    expect(mocks.loadSettings).toHaveBeenCalledTimes(1);
    expect(mocks.loadSymbolConfigs).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[legacy] 旧版数据迁移失败', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('数据库有数据时用其回填 monitor', async () => {
    const monitor = useMonitorStore();
    mocks.buildWatchGroup.mockReturnValue([
      { name: '自选', id: 0, symbols: [] },
      { name: '白酒', id: 1, symbols: [] },
    ]);

    await initStores();
    expect(monitor.watchGroup.map((g) => g.name)).toEqual(['自选', '白酒']);
  });

  it('数据库为空时 monitor 仍保留一个空的自选组', async () => {
    const monitor = useMonitorStore();
    await initStores();
    expect(monitor.watchGroup).toHaveLength(1);
    expect(monitor.watchGroup[0].symbols).toEqual([]);
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

  it('主窗口启动非交易日回填与探测任务，失败只记录日志不阻塞初始化', async () => {
    await initStores();
    expect(mocks.startNonTradingCalendar).toHaveBeenCalledTimes(1);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.startNonTradingCalendar.mockRejectedValue(new Error('probe boom'));
    await expect(initStores()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[probe] 非交易日任务启动失败', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('开机自启状态与设置不一致时会调用对应插件命令', async () => {
    mocks.loadSettings.mockResolvedValue({ isOpenWithSystem: true });
    mocks.invoke.mockImplementation(async (cmd) =>
      cmd === 'plugin:autostart|is_enabled' ? false : undefined,
    );

    await initStores();
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|is_enabled');
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|enable');
  });

  it('系统已开启自启但设置为关闭时调用 disable', async () => {
    mocks.invoke.mockImplementation(async (cmd) =>
      cmd === 'plugin:autostart|is_enabled' ? true : undefined,
    );

    await initStores();
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|is_enabled');
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:autostart|disable');
  });

  it('自启插件不可用时异常被吞掉，initStores 正常完成', async () => {
    mocks.invoke.mockRejectedValue(new Error('plugin missing'));

    await expect(initStores()).resolves.toBeUndefined();
  });
});
