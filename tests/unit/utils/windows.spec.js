import { describe, expect, it } from 'vitest';
import { WindowConfigs } from '@/utils/windows';

describe('windows · 子窗口配置', () => {
  it('包含五个子窗口，label 唯一', () => {
    const labels = Object.values(WindowConfigs).map((c) => c.label);
    expect(labels).toEqual(['search', 'detail', 'group', 'setting', 'marketWidth']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('常规子窗口都是 750×450、无边框、透明、不可缩放', () => {
    for (const config of Object.values(WindowConfigs)) {
      if (config.label === 'marketWidth') continue;
      expect(config.window).toMatchObject({
        width: 750,
        height: 450,
        resizable: false,
        decorations: false,
        transparent: true,
      });
    }
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
      fileDropEnabled: false,
    });
  });

  it('窗口 url 与路由一一对应', () => {
    expect(WindowConfigs.search.window.url).toBe('/#/edit');
    expect(WindowConfigs.detail.window.url).toBe('/#/detail');
    expect(WindowConfigs.setting.window.url).toBe('/#/setting');
  });
});
