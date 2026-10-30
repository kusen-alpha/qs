import { defineStore } from 'pinia';
import { fetchKline } from '../utils/kline';
import { macdHistogram } from '../utils/macd';

/** 取 N 天前的 yyyymmdd，MACD 只需近期日 K（含 EMA 预热） */
function begDate(days = 400) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${d.getFullYear()}${m}${day}`);
}

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
      const beg = begDate();
      const failed = [];
      for (let i = 0; i < list.length; i += 4) {
        const chunk = list.slice(i, i + 4);
        await Promise.all(
          chunk.map(async (secid) => {
            const data = await fetchKline(secid, beg);
            if (data && data.candles.length) {
              this.series[secid] = macdHistogram(data.candles);
              this.stamps[secid] = stamp;
            } else {
              failed.push(secid);
              if (!this.series[secid]) this.series[secid] = [];
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
