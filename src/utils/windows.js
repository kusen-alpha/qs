import { isTauri } from './env';

/** 路由到 window label 的映射与原始 config chunk 一致 */
export const WindowConfigs = {
  search: {
    label: 'search',
    window: {
      title: '编辑列表',
      url: '/#/edit',
      width: 750,
      height: 450,
      minWidth: null,
      minHeight: null,
      x: null,
      y: null,
      center: true,
      resizable: false,
      maximized: false,
      decorations: false,
      alwaysOnTop: false,
      transparent: true,
    },
  },
  detail: {
    label: 'detail',
    window: {
      title: '看盘',
      url: '/#/detail',
      width: 750,
      height: 450,
      minWidth: null,
      minHeight: null,
      x: null,
      y: null,
      center: true,
      resizable: false,
      maximized: false,
      decorations: false,
      alwaysOnTop: false,
      transparent: true,
    },
  },
  group: {
    label: 'group',
    window: {
      title: '分组编辑',
      url: '/#/group',
      width: 750,
      height: 450,
      minWidth: null,
      minHeight: null,
      x: null,
      y: null,
      center: true,
      resizable: false,
      maximized: false,
      decorations: false,
      alwaysOnTop: false,
      transparent: true,
      dragDropEnabled: false,
    },
  },
  setting: {
    label: 'setting',
    window: {
      title: '设置',
      url: '/#/setting',
      width: 750,
      height: 450,
      minWidth: null,
      minHeight: null,
      x: null,
      y: null,
      center: true,
      resizable: false,
      maximized: false,
      decorations: false,
      alwaysOnTop: false,
      transparent: true,
    },
  },
  boardChart: {
    label: 'boardChart',
    window: {
      title: '板块图表',
      url: '/#/boardchart',
      width: 900,
      height: 560,
      minWidth: null,
      minHeight: null,
      x: null,
      y: null,
      center: true,
      resizable: true,
      maximized: false,
      decorations: false,
      alwaysOnTop: false,
      transparent: true,
      dragDropEnabled: false,
    },
  },
  marketWidth: {
    label: 'marketWidth',
    window: {
      title: '市场宽度',
      url: '/#/market',
      width: 826,
      height: 875,
      minWidth: null,
      minHeight: null,
      x: null,
      y: null,
      center: true,
      resizable: true,
      maximized: false,
      decorations: false,
      alwaysOnTop: false,
      transparent: true,
      dragDropEnabled: false,
    },
  },
};

/**
 * 打开子窗口：已存在则复用，否则以传入 query 重新拉取。
 * 浏览器环境下用 hash 路由跳转模拟。
 */
export async function openWindow(config, query = null) {
  if (!isTauri()) {
    const url = config.window.url.replace('/#/', '/');
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    location.hash = '#' + url + qs;
    return;
  }
  // Tauri 1.4 的 getAll 是命名导出（WebviewWindow 上没有静态 getAll），与原产物一致
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const { getAllWindows } = await import('@tauri-apps/api/window');
  const all = await getAllWindows();
  for (const w of all) {
    if (w.label !== config.label && w.label !== 'main') {
      // 同一时间只保留一个子窗口
      await w.close().catch(() => {});
    }
  }
  if (all.find((w) => w.label === config.label)) return null;
  const cfg = JSON.parse(JSON.stringify(config));
  if (query) {
    cfg.window.url = cfg.window.url + '?' + new URLSearchParams(query).toString();
  }
  const win = new WebviewWindow(cfg.label, cfg.window);
  // 创建失败时 Tauri 只发 tauri://error 事件，不抛异常，这里记录下来便于排查
  win.once?.('tauri://error', (e) => {
    console.error(`[window] ${cfg.label} create failed`, e);
  });
  return win;
}

export async function closeWindow(config) {
  if (!isTauri()) return;
  const { getAllWindows } = await import('@tauri-apps/api/window');
  const all = await getAllWindows();
  const win = all.find((w) => w.label === config.label);
  if (win) await win.close();
}
