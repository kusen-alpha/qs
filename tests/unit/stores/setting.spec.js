import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingStore } from '@/stores/setting';
import { SettingEvent, defaultWatchFields } from '@/constants';
import { freshPinia } from '../../helpers';

vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

vi.mock('@/utils/db', () => ({
  loadSettings: vi.fn(async () => null),
  saveSettings: vi.fn(async () => ({ saved: true })),
}));

function snapshot(store) {
  return {
    tableSize: store.tableSize,
    updownColor: store.updownColor,
    viewOpacity: store.viewOpacity,
    viewGray: store.viewGray,
    isFixWidth: store.isFixWidth,
    fixedWidth: store.fixedWidth,
    watchFields: store.watchFields,
    isEdgeFold: store.isEdgeFold,
    isOpenWithSystem: store.isOpenWithSystem,
    shortcutBoss: store.shortcutBoss,
  };
}

describe('setting store', () => {
  let setting;

  beforeEach(() => {
    freshPinia();
    setting = useSettingStore();
  });

  it('默认设置', () => {
    expect(setting.tableSize).toBe('small');
    expect(setting.fixedWidth).toBe(380);
    expect(setting.shortcutBoss).toEqual(['Ctrl', 'Q']);
    expect(setting.watchFields.price).toBe(true);
    expect(setting.watchFields.high).toBe(false);
  });

  it('loadFromDb 从数据库回填并补齐新增字段默认值', async () => {
    const { loadSettings } = await import('@/utils/db');
    loadSettings.mockResolvedValueOnce({
      tableSize: 'default',
      fixedWidth: 420,
      watchFields: { price: false },
    });
    await setting.loadFromDb();
    expect(setting.tableSize).toBe('default');
    expect(setting.fixedWidth).toBe(420);
    expect(setting.watchFields.price).toBe(false);
    expect(setting.watchFields.high).toBe(defaultWatchFields.high);
  });

  it('loadFromDb 无记录时恢复默认值', async () => {
    setting.tableSize = 'default';
    const { loadSettings } = await import('@/utils/db');
    loadSettings.mockResolvedValueOnce(null);
    await setting.loadFromDb();
    expect(setting.tableSize).toBe('small');
    expect(setting.watchFields.price).toBe(true);
  });

  it('updateSettings 未变化时不写数据库、不发事件', async () => {
    const { saveSettings } = await import('@/utils/db');
    const { emit } = await import('@/utils/events');
    await setting.updateSettings(snapshot(setting));
    expect(saveSettings).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('updateSettings 变化时更新状态、写数据库并发出对应事件', async () => {
    const { saveSettings } = await import('@/utils/db');
    const { emit } = await import('@/utils/events');
    await setting.updateSettings({
      ...snapshot(setting),
      tableSize: 'default',
      fixedWidth: 420,
      updownColor: 'redDownGreenUp',
    });
    expect(setting.tableSize).toBe('default');
    expect(setting.fixedWidth).toBe(420);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0][0]).toMatchObject({
      tableSize: 'default',
      fixedWidth: 420,
    });
    const [event, changed] = emit.mock.calls[0];
    expect(event).toBe('settingChange');
    expect(changed).toEqual(
      expect.arrayContaining([
        SettingEvent.fixedWidthChange,
        SettingEvent.tableSizeChange,
        SettingEvent.updownColorChange,
      ]),
    );
  });
});
