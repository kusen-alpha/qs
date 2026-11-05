import { defineStore } from 'pinia';
import { fetchKline, MIN_BEG } from '../utils/kline';
import { macdHistogram } from '../utils/macd';

/** MACD 取数与历史数据校验同口径：从 2024-01-01 起拉日 K，新自选股也能补全历史 */
const MACD_BEG = MIN_BEG;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

let retryTimer = null;

/**
 * 股票的 MACD 柱序列缓存（按天刷新）。
 * 表格渲染只读 series，真正的拉取由页面的 ensure 触发；
 * 拉取失败的股票 60 秒后自动重试。
 */
export const useMacdStore = defineStore('macd', {
  state: () => ({
    series: {},
    stamps: {},
  }),
  actions: {
    async ensure(secids) {
      const stamp = today();
      const list = [...new Set((secids || []).filter(Boolean))].filter(
        (secid) => this.stamps[secid] !== stamp,
      );
      if (!list.length) return;
      const beg = MACD_BEG;
      const failed = [];
      for (let i = 0; i < list.length; i += 4) {
        const chunk = list.slice(i, i + 4);
        await Promise.all(
          chunk.map(async (secid) => {
            // 单只股票请求失败不能中断同批其它股票，失败项留到 60 秒后统一重试
            try {
              const data = await fetchKline(secid, beg);
              if (data && data.candles.length) {
                this.series[secid] = macdHistogram(data.candles);
                this.stamps[secid] = stamp;
              } else {
                failed.push(secid);
                if (!this.series[secid]) this.series[secid] = [];
              }
            } catch (e) {
              failed.push(secid);
            }
          }),
        );
      }
      if (failed.length) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => this.ensure(failed), 60000);
      }
    },
  },
});
