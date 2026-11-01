import { defineStore } from 'pinia';
import { emit } from '../utils/events';
import { loadWatchlist, saveWatchGroup, buildWatchGroup } from '../utils/db';

/** 自选列表：只保留一个固定分组「自选」 */
export const useMonitorStore = defineStore('monitor', {
  state: () => ({
    watchGroup: [
      {
        name: '自选',
        id: 0,
        symbols: [
          { symbol: '600519', name: '贵州茅台', secid: '1.600519', source: '1' },
        ],
      },
    ],
  }),
  actions: {
    addWatchList(item) {
      const symbol = {
        symbol: item.Code,
        name: item.Name,
        secid: item.QuoteID,
        source: '1',
      };
      if (!this.watchGroup[0].symbols.find((s) => s.secid == symbol.secid)) {
        this.watchGroup[0].symbols.push(symbol);
      }
    },
    deleteWatchList(secid) {
      this.watchGroup[0].symbols = this.watchGroup[0].symbols.filter((s) => s.secid !== secid);
    },
    existSymbolInGroup(secid) {
      return !!this.watchGroup[0].symbols.find((s) => s.secid == secid);
    },
    /** 从数据库回填（数据库为空时保留现有数据），供主窗口启动时调用 */
    async loadFromDb() {
      const groups = buildWatchGroup(await loadWatchlist());
      if (!groups.length) return false;
      this.watchGroup = groups;
      this.$persist();
      return true;
    },
    /** 写 localStorage 快照（供子窗口同步）并落库 */
    persist(event) {
      this.$persist();
      emit('stateChange', event);
      return saveWatchGroup(JSON.parse(JSON.stringify(this.watchGroup)));
    },
  },
  persist: {
    storage: localStorage,
  },
});
