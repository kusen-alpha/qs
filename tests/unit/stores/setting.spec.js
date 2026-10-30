import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingStore } from '@/stores/setting';
import { SettingEvent } from '@/constants';
import { freshPinia } from '../../helpers';

vi.mock('@/utils/file', () => ({
  writeData: vi.fn(),
  readData: vi.fn(async () => null),
  Files: {
    SETTINGS: { folder: '', file: 'settings.json', encrpt: false },
    MONITOR: { folder: '', file: 'monitor.dat', encrpt: true },
    SYMBOL: { folder: '', file: 'symbol.dat', encrpt: true },
  },
}));

vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

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
    setting.$persist = () => {};
  });

  it('默认设置', () => {
    expect(setting.tableSize).toBe('small');
    expect(setting.fixedWidth).toBe(380);
    expect(setting.shortcutBoss).toEqual(['Ctrl', 'Q']);
    expect(setting.watchFields.price).toBe(true);
    expect(setting.watchFields.high).toBe(false);
  });

  it('updateSettings 未变化时不写文件、不发事件', async () => {
    const { writeData } = await import('@/utils/file');
    const { emit } = await import('@/utils/events');
    setting.updateSettings(snapshot(setting));
    expect(writeData).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('updateSettings 变化时更新状态、写文件并发出对应事件', async () => {
    const { writeData } = await import('@/utils/file');
    const { emit } = await import('@/utils/events');
    setting.updateSettings({
      ...snapshot(setting),
      tableSize: 'default',
      fixedWidth: 420,
      updownColor: 'redDownGreenUp',
    });
    expect(setting.tableSize).toBe('default');
    expect(setting.fixedWidth).toBe(420);
    expect(writeData).toHaveBeenCalledTimes(1);
    expect(writeData.mock.calls[0][1]).toBe('settings.json');
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
