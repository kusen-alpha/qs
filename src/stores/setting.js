import { defineStore } from 'pinia';
import { isEqual } from 'lodash-es';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '../utils/events';
import { loadSettings, saveSettings } from '../utils/db';
import { isTauri } from '../utils/env';
import { SettingEvent, UpdownColor, defaultWatchFields } from '../constants';

async function setAutostart(enable) {
  if (!isTauri()) return;
  await invoke(enable ? 'plugin:autostart|enable' : 'plugin:autostart|disable').catch(
    () => {},
  );
}

/** 持久化设置：数据库是唯一来源 */
export const useSettingStore = defineStore('setting', {
  state: () => ({
    tableSize: 'small',
    updownColor: UpdownColor.redUpGreenDown,
    viewOpacity: 0,
    viewGray: 0,
    isFixWidth: true,
    fixedWidth: 380,
    watchFields: { ...defaultWatchFields },
    isEdgeFold: true,
    isOpenWithSystem: false,
    shortcutBoss: ['Ctrl', 'Q'],
  }),
  actions: {
    /** 从数据库回填；无记录时恢复默认值，并补齐新增字段的默认值 */
    async loadFromDb() {
      const data = await loadSettings();
      this.$reset();
      if (data && typeof data === 'object') {
        Object.assign(this.$state, data);
      }
      const fields = this.watchFields || {};
      for (const key in defaultWatchFields) {
        if (fields[key] === undefined) fields[key] = defaultWatchFields[key];
      }
      this.watchFields = fields;
      return true;
    },
    async updateSettings(next) {
      const changed = [];
      if (!isEqual(next.watchFields, this.watchFields)) {
        this.watchFields = next.watchFields;
        changed.push(SettingEvent.watchFieldsChange);
      }
      if (!isEqual(next.isEdgeFold, this.isEdgeFold)) {
        this.isEdgeFold = next.isEdgeFold;
        changed.push(SettingEvent.isEdgeFoldChange);
      }
      if (!isEqual(next.isOpenWithSystem, this.isOpenWithSystem)) {
        this.isOpenWithSystem = next.isOpenWithSystem;
        setAutostart(this.isOpenWithSystem);
      }
      if (!isEqual(next.isFixWidth, this.isFixWidth)) {
        this.isFixWidth = next.isFixWidth;
        changed.push(SettingEvent.isFixWidthChange);
      }
      if (!isEqual(next.fixedWidth, this.fixedWidth)) {
        this.fixedWidth = next.fixedWidth;
        changed.push(SettingEvent.fixedWidthChange);
      }
      if (!isEqual(next.tableSize, this.tableSize)) {
        this.tableSize = next.tableSize;
        changed.push(SettingEvent.tableSizeChange);
      }
      if (!isEqual(next.updownColor, this.updownColor)) {
        this.updownColor = next.updownColor;
        changed.push(SettingEvent.updownColorChange);
      }
      if (!isEqual(next.viewOpacity, this.viewOpacity)) {
        this.viewOpacity = next.viewOpacity;
        changed.push(SettingEvent.viewOpacityChange);
      }
      if (!isEqual(next.viewGray, this.viewGray)) {
        this.viewGray = next.viewGray;
        changed.push(SettingEvent.viewGrayChange);
      }
      if (!isEqual(next.shortcutBoss, this.shortcutBoss)) {
        this.shortcutBoss = next.shortcutBoss;
        changed.push(SettingEvent.shortcutBossChange);
      }
      if (changed.length > 0) {
        const saved = await saveSettings(JSON.parse(JSON.stringify(this.$state)));
        if (isTauri() && !saved) {
          throw new Error('设置保存失败');
        }
        emit('settingChange', changed);
      }
      return changed;
    },
  },
});
