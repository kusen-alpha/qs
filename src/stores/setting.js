import { defineStore } from 'pinia';
import { isEqual } from 'lodash-es';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '../utils/events';
import { writeData, Files } from '../utils/file';
import { isTauri } from '../utils/env';
import { SettingEvent, UpdownColor, defaultWatchFields } from '../constants';

async function setAutostart(enable) {
  if (!isTauri()) return;
  await invoke(enable ? 'plugin:autostart|enable' : 'plugin:autostart|disable').catch(
    () => {},
  );
}

/** 持久化设置 */
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
    updateSettings(next) {
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
        this.$persist();
        writeData(Files.SETTINGS.folder, Files.SETTINGS.file, JSON.parse(JSON.stringify(this.$state)));
        emit('settingChange', changed);
      }
    },
  },
  persist: {
    storage: localStorage,
    /* 老配置里没有新增字段时补上默认值，例如 MACD 列默认开启 */
    afterRestore: (ctx) => {
      const fields = ctx.store.watchFields || {};
      for (const key in defaultWatchFields) {
        if (fields[key] === undefined) fields[key] = defaultWatchFields[key];
      }
    },
  },
});
