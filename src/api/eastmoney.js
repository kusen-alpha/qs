import { request } from '../utils/http';
import { saveQuotes } from '../utils/db';

const HEADERS = {
  Host: 'push2.eastmoney.com',
  Referer: 'http://quote.eastmoney.com/',
  Connection: 'keep-alive',
  Accept: '*/*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 Edg/108.0.1462.54',
};

function createEmpty(name, secid) {
  return {
    name,
    secid,
    price: '-',
    range: '-',
    price_diff: '-',
    turn: '-',
    high: '-',
    low: '-',
    position_num: '-',
    position_price: '-',
    position_value: '-',
    position_profit: '-',
    position_profit_rate: '-',
  };
}

/** 东方财富实时行情（原产物 ut 类） */
export class EastmoneyApi {
  constructor() {
    this.headers = HEADERS;
  }

  processRealtimeData(list) {
    if (!list) return [];
    return list.map((a) => ({
      name: a.f14,
      secid: a.f13 + '.' + a.f12,
      price: a.f2,
      range: a.f3,
      price_diff: a.f4,
      turn: a.f8,
      high: a.f15,
      low: a.f16,
      position_num: '-',
      position_price: '-',
      position_value: '-',
      position_profit: '-',
      position_profit_rate: '-',
      amount: a.f6,
      open: a.f17,
      pre_close: a.f18,
    }));
  }

  async realtime(list) {
    if (!list.length) return [];
    const params = {
      pn: '1',
      pz: '500',
      po: '1',
      np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2',
      invt: '2',
      fid: 'f3',
      fs: 'm:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048',
      fields:
        'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f22,f11,f62,f115,f152',
      secids: list.map((s) => s.secid).join(','),
      _: '1623833739532',
    };
    const qs = new URLSearchParams(params).toString();
    const res = await request(
      'https://push2.eastmoney.com/api/qt/ulist.np/get?' + qs,
      { method: 'GET', headers: this.headers },
    );
    if (res.ok && res.data && res.data.data) {
      const list = this.processRealtimeData(res.data.data.diff);
      // 每轮刷新都写库；失败不影响行情展示
      saveQuotes(list);
      return list;
    }
    return [];
  }
}

/** 从全部分组中取指定来源的标的 */
export function pickBySource(watchGroup, source) {
  const out = [];
  for (const group of watchGroup) {
    for (const symbol of group.symbols) {
      if (symbol.source === source) out.push(symbol);
    }
  }
  return out;
}

/** 用实时行情填充自选列表，并计算持仓收益 */
export function mergeRealtime(quotes, symbols, configs = []) {
  const out = [];
  for (const symbol of symbols) {
    const quote = quotes.find((q) => q.secid === symbol.secid);
    const cfg = configs.find((c) => c.secid === symbol.secid);
    if (quote) {
      if (cfg && cfg.position) {
        const pos = calcPosition(quote, cfg);
        quote.position_num = pos.num;
        quote.position_price = pos.buy_price;
        quote.position_value = pos.value;
        quote.position_profit = pos.profit;
        quote.position_profit_rate = pos.profit_rate;
      }
      out.push(quote);
    } else {
      out.push(createEmpty(symbol.name, symbol.secid));
    }
  }
  return out;
}

export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloat(value);
  return NaN;
}

export function calcPosition(quote, config) {
  const pos = { num: 0, buy_price: 0, value: 0, profit: 0, profit_rate: 0 };
  pos.buy_price = toNumber(config.position.buyPrice);
  pos.num = toNumber(config.position.buyAmount);
  pos.value = toNumber(quote.price) * pos.num;
  pos.profit = pos.value - pos.buy_price * pos.num;
  pos.profit_rate = pos.buy_price ? pos.profit / (pos.buy_price * pos.num) : 0;
  return pos;
}

/** 总盈亏 / 今盈亏 */
export function summarizeProfit(quotes, configs) {
  const held = configs.filter((c) => c.position);
  const sum = {
    total_profit: 0,
    total_profit_rate: 0,
    today_profit: 0,
    today_profit_rate: 0,
    total_cost: 0,
    today_cost: 0,
  };
  for (const cfg of held) {
    const quote = quotes.find((q) => q.secid === cfg.secid);
    if (!quote) continue;
    const price = toNumber(quote.price);
    const diff = toNumber(quote.price_diff);
    const buyPrice = toNumber(cfg.position.buyPrice);
    const amount = toNumber(cfg.position.buyAmount);
    if (price && diff && buyPrice && amount) {
      sum.total_profit += (price - buyPrice) * amount;
      sum.total_cost += buyPrice * amount;
      sum.today_profit += diff * amount;
      sum.today_cost += (price - diff) * amount;
    }
  }
  sum.total_profit_rate = sum.total_cost ? sum.total_profit / sum.total_cost : 0;
  sum.today_profit_rate = sum.today_cost ? sum.today_profit / sum.today_cost : 0;
  return sum;
}

/** 金额缩写（原产物 J） */
export function formatAmount(value) {
  const abs = Math.abs(value);
  if (abs < 10000) return value.toFixed(0).toString();
  if (abs < 100000) return (value / 10000).toFixed(1) + '万';
  if (abs < 100000000) return (value / 10000).toFixed(0) + '万';
  return (value / 100000000).toFixed(2) + '亿';
}

/** 收益率格式（原产物 _e） */
export function formatRate(value) {
  if (value < 10) return (value * 100).toFixed(2) + '%';
  if (value < 1000) return value.toFixed(2) + '倍';
  if (value < 100000) return value.toFixed(0) + '倍';
  return '>10万倍';
}
