import { describe, expect, it } from 'vitest';
import { Exchange, MonitorEvent, SettingEvent, UpdownColor, defaultWatchFields } from '@/constants';

describe('constants · 常量契约', () => {
  it('交易所编号固定（持久化数据依赖）', () => {
    expect(Exchange.STOCK_CN).toBe(0);
    expect(Exchange.STOCK_US).toBe(1);
    expect(Exchange.STOCK_HK).toBe(2);
    expect(Exchange.INDEX).toBe(7);
  });

  it('自选列表事件', () => {
    expect(MonitorEvent).toEqual({
      addWatchList: 'addWatchList',
      deleteWatchList: 'deleteWatchList',
    });
  });

  it('设置事件名与 key 一致', () => {
    for (const [key, value] of Object.entries(SettingEvent)) {
      expect(value).toBe(key);
    }
  });

  it('涨跌配色方案', () => {
    expect(UpdownColor).toEqual({
      redUpGreenDown: 'redUpGreenDown',
      redDownGreenUp: 'redDownGreenUp',
    });
  });

  it('默认关注字段：只默认展示价格/涨幅/涨跌/换手', () => {
    expect(defaultWatchFields).toMatchObject({
      price: true,
      range: true,
      price_diff: true,
      high: false,
      low: false,
      turn: true,
      concept_l1: false,
      concept_l2: false,
      concept_ths: false,
      position_num: false,
      position_profit: false,
    });
  });
});
