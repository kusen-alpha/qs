import { defineStore } from 'pinia';
import { isEqual, isNull } from 'lodash-es';
import { emit } from '../utils/events';
import { readData, writeData, Files } from '../utils/file';

/** 原产物 SymbolStore(uO)：每只股票的持仓 / 提醒配置 */
export const useSymbolStore = defineStore('symbol', {
  state: () => ({
    configs: {},
  }),
  getters: {
    showAlert: (state) => (secid) => !!state.configs[secid] && !!state.configs[secid].crossAlertConfig,
    showPosition: (state) => (secid) => !!state.configs[secid] && !!state.configs[secid].position,
    positionNum: (state) => () => {
      let n = 0;
      for (const k in state.configs) if (state.configs[k].position) n += 1;
      return n;
    },
    alertNum: (state) => () => {
      let n = 0;
      for (const k in state.configs) if (state.configs[k].crossAlertConfig) n += 1;
      return n;
    },
  },
  actions: {
    deleteSymbolConfig(secid) {
      if (this.configs[secid]) {
        delete this.configs[secid];
        this.$persist();
        writeData(Files.SYMBOL.folder, Files.SYMBOL.file, JSON.parse(JSON.stringify(this.$state)), true);
      }
    },
    async addConfig(config) {
      if (isNull(config)) return;
      if (!config.position && !config.crossAlertConfig && !config.taAlertConfig) {
        if (this.configs[config.secid]) {
          delete this.configs[config.secid];
        } else {
          return;
        }
      } else {
        if (isEqual(this.configs[config.secid], config)) return;
        this.configs[config.secid] = config;
      }
      this.$persist();
      await writeData(Files.SYMBOL.folder, Files.SYMBOL.file, JSON.parse(JSON.stringify(this.$state)), true);
      emit('symbolConfigChange', {});
    },
    readConfig() {
      readData(Files.SYMBOL.folder, Files.SYMBOL.file, true).then((data) => {
        if (data) this.configs = data.configs;
      });
    },
  },
  persist: {
    storage: localStorage,
  },
});
