import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { ensureMarketWidthHistory } from '../api/legulegu';
import { isTauri } from '../utils/env';
import { ensureFile, readData, writeData, Files } from '../utils/file';
import { migrateWatchGroup, refreshBoardHistory } from '../utils/db';
import { syncWatchHistory } from '../utils/klineSync';
import { useSettingStore } from './setting';
import { useMonitorStore } from './monitor';
import { useSymbolStore } from './symbol';

export const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

/** 首次创建数据文件，否则读取并回填 store */
async function hydrateStore(initialState, folder, file, store, encrypt) {
  const created = await ensureFile(folder, file);
  if (created) {
    await writeData(folder, file, initialState, encrypt);
    return;
  }
  const data = await readData(folder, file, encrypt);
  if (!data) return;
  for (const key in data) {
    store.$state[key] = data[key];
  }
  store.$persist();
}

/** 仅主窗口负责磁盘数据初始化 */
export async function initStores() {
  if (!isTauri()) return;
  const current = getCurrentWindow();
  if (current.label !== 'main') return;

  const setting = useSettingStore();
  const monitor = useMonitorStore();
  const symbol = useSymbolStore();

  await hydrateStore(
    JSON.parse(JSON.stringify(setting.$state)),
    Files.SETTINGS.folder,
    Files.SETTINGS.file,
    setting,
    Files.SETTINGS.encrpt,
  );
  await hydrateStore(
    JSON.parse(JSON.stringify(monitor.$state)),
    Files.MONITOR.folder,
    Files.MONITOR.file,
    monitor,
    Files.MONITOR.encrpt,
  );
  await hydrateStore(
    JSON.parse(JSON.stringify(symbol.$state)),
    Files.SYMBOL.folder,
    Files.SYMBOL.file,
    symbol,
    Files.SYMBOL.encrpt,
  );

  // 旧版自选/概念一次性入库；Rust 侧用 meta.migrated_v1 保证只执行一次
  await migrateWatchGroup(JSON.parse(JSON.stringify(monitor.watchGroup)));
  // 之后以数据库为准回填自选与概念
  await monitor.loadFromDb();

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
