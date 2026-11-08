import { defineStore } from 'pinia';
import { isEqual, isNull } from 'lodash-es';
import { emit } from '../utils/events';
import { loadSymbolConfigs, saveSymbolConfigs } from '../utils/db';

/** 每只股票的持仓 / 提醒配置：数据库是唯一来源 */
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
    /** 从数据库回填；空库即空配置 */
    async loadFromDb() {
      this.configs = await loadSymbolConfigs();
      return true;
    },
    async deleteSymbolConfig(secid) {
      if (this.configs[secid]) {
        delete this.configs[secid];
        await saveSymbolConfigs(JSON.parse(JSON.stringify(this.configs)));
        emit('symbolConfigChange', {});
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
      await saveSymbolConfigs(JSON.parse(JSON.stringify(this.configs)));
      emit('symbolConfigChange', {});
    },
  },
});
