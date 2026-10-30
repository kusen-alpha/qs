import { defineStore } from 'pinia';
import { emit } from '../utils/events';
import { writeData, Files } from '../utils/file';
import { Exchange } from '../constants';

/** 自选列表：只保留一个固定分组「自选」 */
export const useMonitorStore = defineStore('monitor', {
  state: () => ({
    watchGroup: [
      {
        name: '自选',
        id: 0,
        editable: false,
        symbols: [
          { symbol: '600519', name: '贵州茅台', exchange: Exchange.STOCK_CN, secid: '1.600519', source: '1' },
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
        exchange: item.SecurityType,
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
    persist(event) {
      emit('stateChange', event);
      this.$persist();
      writeData(Files.MONITOR.folder, Files.MONITOR.file, JSON.parse(JSON.stringify(this.$state)), true);
    },
  },
  persist: {
    storage: localStorage,
  },
});
