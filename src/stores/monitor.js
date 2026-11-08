import { defineStore } from 'pinia';
import { emit } from '../utils/events';
import { loadWatchlist, saveWatchGroup, buildWatchGroup } from '../utils/db';

const emptyWatchGroup = () => [{ name: '自选', id: 0, symbols: [] }];

/** 自选列表：只保留一个固定分组「自选」；数据库是唯一持久化来源 */
export const useMonitorStore = defineStore('monitor', {
  state: () => ({
    watchGroup: emptyWatchGroup(),
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
    /**
     * 从自选删除：同时从所有概念（含二级）移除同一只股票。
     * 用户语义是「删自选即彻底清除」，落库时才会连带删除股票、日K 与板块成分。
     */
    deleteWatchList(secid) {
      const prune = (groups) => {
        for (const group of groups) {
          if (group.symbols) {
            group.symbols = group.symbols.filter((s) => s.secid !== secid);
          }
          prune(group.children || []);
        }
      };
      prune(this.watchGroup);
    },
    existSymbolInGroup(secid) {
      return !!this.watchGroup[0].symbols.find((s) => s.secid == secid);
    },
    /** 从数据库回填；空库时清空为空自选组（数据库是唯一来源） */
    async loadFromDb() {
      const groups = buildWatchGroup(await loadWatchlist());
      this.watchGroup = groups.length ? groups : emptyWatchGroup();
      return true;
    },
    /** 广播变更并落库 */
    persist(event) {
      emit('stateChange', event);
      return saveWatchGroup(JSON.parse(JSON.stringify(this.watchGroup)));
    },
  },
});
