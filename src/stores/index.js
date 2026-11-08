import { createPinia } from 'pinia';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { ensureMarketWidthHistory } from '../api/legulegu';
import { isTauri } from '../utils/env';
import { legacyExists, readLegacyData, removeLegacyFiles, Files } from '../utils/file';
import { importLegacy, refreshBoardHistory } from '../utils/db';
import { syncWatchHistory } from '../utils/klineSync';
import { startNonTradingCalendar } from '../utils/nonTrading';
import { useSettingStore } from './setting';
import { useMonitorStore } from './monitor';
import { useSymbolStore } from './symbol';

export const pinia = createPinia();

/**
 * 旧版 profile 文件一次性迁入数据库：仅主窗口执行。
 * 命令成功后才删除旧文件；失败保留文件，下次启动重试。
 */
async function migrateLegacyFiles() {
  try {
    const existsList = await Promise.all([
      legacyExists(Files.SETTINGS.file),
      legacyExists(Files.SYMBOL.file),
      legacyExists(Files.MONITOR.file),
    ]);
    if (!existsList.some(Boolean)) return;
    const [settings, symbolState, monitorState] = await Promise.all([
      readLegacyData(Files.SETTINGS.file, false),
      readLegacyData(Files.SYMBOL.file, true),
      readLegacyData(Files.MONITOR.file, true),
    ]);
    const result = await importLegacy({
      settings,
      symbolConfigs: symbolState ? symbolState.configs : null,
      groups: monitorState ? monitorState.watchGroup : null,
    });
    // 返回 null 表示导入失败（或非 Tauri 环境），此时不删除旧文件
    if (!result) return;
    await removeLegacyFiles();
  } catch (e) {
    console.error('[legacy] 旧版数据迁移失败', e);
  }
}

/** 所有窗口都从数据库回填；主窗口额外负责磁盘数据初始化与启动任务 */
export async function initStores() {
  if (!isTauri()) return;
  const current = getCurrentWindow();
  const isMain = current.label === 'main';

  const setting = useSettingStore();
  const monitor = useMonitorStore();
  const symbol = useSymbolStore();

  if (isMain) await migrateLegacyFiles();
  await Promise.all([setting.loadFromDb(), symbol.loadFromDb(), monitor.loadFromDb()]);

  if (!isMain) return;

  // 启动时补齐自选日K，延后执行避免抢占首次行情刷新；
  // 补齐完成后再幂等刷新板块日线（已有数据增量补最近 5 个交易日）
  setTimeout(() => {
    syncWatchHistory()
      .catch((e) => console.error('[kline] 启动补齐失败', e))
      .then(() => refreshBoardHistory(5))
      .catch((e) => console.error('[board] 板块历史刷新失败', e));
  }, 5000);

  // 市场宽度历史幂等补齐：库内未覆盖 2024 年初时整段拉取，已覆盖则跳过
  setTimeout(() => {
    ensureMarketWidthHistory().catch((e) =>
      console.error('[marketWidth] 市场宽度历史补齐失败', e),
    );
  }, 5000);

  // 非交易日日历：后台回填历史非交易日并监听盘中探测信号，不阻塞首屏
  startNonTradingCalendar().catch((e) =>
    console.error('[probe] 非交易日任务启动失败', e),
  );

  // 开机自启状态与设置对齐
  try {
    const enabled = await invoke('plugin:autostart|is_enabled');
    if (enabled && !setting.isOpenWithSystem) {
      await invoke('plugin:autostart|disable');
    } else if (!enabled && setting.isOpenWithSystem) {
      await invoke('plugin:autostart|enable');
    }
  } catch (e) {
    /* plugin 未安装时忽略 */
  }
}
