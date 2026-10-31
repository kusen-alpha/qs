import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../utils/env';
import { ensureFile, readData, writeData, Files } from '../utils/file';
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
