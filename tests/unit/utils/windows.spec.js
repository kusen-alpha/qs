import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowConfigs } from '@/utils/windows';

const tauriMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(async () => []),
  created: [],
}));

// 测试配置把 @tauri-apps/api/window 与 webviewWindow 都指向同一份 mock，
// 所以这里直接 mock 该共享文件，两个动态 import 都会命中。
vi.mock('../../mocks/tauri-api.js', () => ({
  getAllWindows: tauriMocks.getAllWindows,
  getAll: tauriMocks.getAllWindows,
  getCurrentWindow: () => ({ label: 'main', close: async () => {} }),
  WebviewWindow: class {
    constructor(label, options) {
      tauriMocks.created.push({ label, options });
    }
  },
}));

describe('windows · 子窗口配置', () => {
  it('包含七个子窗口，label 唯一', () => {
    const labels = Object.values(WindowConfigs).map((c) => c.label);
    expect(labels).toEqual([
      'search',
      'detail',
      'group',
      'setting',
      'boardChart',
      'marketWidth',
      'calendar',
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('常规子窗口都是 750×450、无边框、透明、不可缩放', () => {
    for (const config of Object.values(WindowConfigs)) {
      if (['marketWidth', 'boardChart', 'calendar'].includes(config.label)) continue;
      expect(config.window).toMatchObject({
        width: 750,
        height: 450,
        resizable: false,
        decorations: false,
        transparent: true,
      });
    }
  });

  it('板块图表窗口更大且可缩放，指向 /#/boardchart', () => {
    expect(WindowConfigs.boardChart.window).toMatchObject({
      title: '板块图表',
      url: '/#/boardchart',
      width: 900,
      height: 560,
      resizable: true,
    });
  });

  it('市场宽度窗口更大且可缩放，指向 /#/market', () => {
    expect(WindowConfigs.marketWidth.window).toMatchObject({
      title: '市场宽度',
      url: '/#/market',
      width: 826,
      height: 875,
      resizable: true,
    });
  });

  it('分组窗口指向 /#/group，并禁止文件拖放', () => {
    expect(WindowConfigs.group.window).toMatchObject({
      title: '分组编辑',
      url: '/#/group',
      dragDropEnabled: false,
    });
  });

  it('日历事件窗口独立且可缩放，指向 /#/calendar', () => {
    expect(WindowConfigs.calendar.window).toMatchObject({
      title: '日历事件',
      url: '/#/calendar',
      width: 540,
      height: 560,
      resizable: true,
      decorations: false,
      transparent: true,
    });
  });

  it('窗口 url 与路由一一对应', () => {
    expect(WindowConfigs.search.window.url).toBe('/#/edit');
    expect(WindowConfigs.detail.window.url).toBe('/#/detail');
    expect(WindowConfigs.setting.window.url).toBe('/#/setting');
    expect(WindowConfigs.calendar.window.url).toBe('/#/calendar');
  });
});

describe('windows 路 openWindow', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    tauriMocks.getAllWindows.mockResolvedValue([]);
    tauriMocks.created.length = 0;
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it('无同名窗口时创建 WebviewWindow', async () => {
    const { openWindow } = await import('@/utils/windows');
    await openWindow(WindowConfigs.setting);
    expect(tauriMocks.created).toHaveLength(1);
    expect(tauriMocks.created[0].label).toBe('setting');
    expect(tauriMocks.created[0].options.url).toBe('/#/setting');
  });

  it('已有同名窗口时复用，不重复创建', async () => {
    tauriMocks.getAllWindows.mockResolvedValue([
      { label: 'setting', close: async () => {} },
    ]);
    const { openWindow } = await import('@/utils/windows');
    await openWindow(WindowConfigs.setting);
    expect(tauriMocks.created).toHaveLength(0);
  });

  it('打开新窗口前先关闭其它子窗口', async () => {
    const closed = [];
    tauriMocks.getAllWindows.mockResolvedValue([
      { label: 'search', close: async () => closed.push('search') },
      { label: 'detail', close: async () => closed.push('detail') },
    ]);
    const { openWindow } = await import('@/utils/windows');
    await openWindow(WindowConfigs.setting);
    expect(closed.sort()).toEqual(['detail', 'search']);
    expect(tauriMocks.created).toHaveLength(1);
  });
});
