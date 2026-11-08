import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import QuoteTable from '@/components/monitor/Table.vue';
import { useCacheStore } from '@/stores/cache';
import { useMacdStore } from '@/stores/macd';
import { useMonitorStore } from '@/stores/monitor';
import { useSettingStore } from '@/stores/setting';
import { useSymbolStore } from '@/stores/symbol';
import { defaultWatchFields } from '@/constants';
import { freshPinia, stock } from '../../helpers';

const { realtimeMock, openWindowMock, loadStockConceptsMock, isTauriMock, tauriEmitMock, quoteSourceMock } = vi.hoisted(() => ({
  realtimeMock: vi.fn(),
  openWindowMock: vi.fn(),
  loadStockConceptsMock: vi.fn(),
  isTauriMock: vi.fn(() => false),
  tauriEmitMock: vi.fn(() => Promise.resolve()),
  quoteSourceMock: {
    env: { live: true, todayTrading: true, useDb: false },
    rows: vi.fn(),
    idle: vi.fn(() => 60000),
    envCalls: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ emit: tauriEmitMock, listen: vi.fn() }));

vi.mock('@/utils/quoteSource', () => ({
  isLiveQuoteWindow: () => quoteSourceMock.env.live,
  idleDelayMs: () => quoteSourceMock.idle(),
  loadQuoteEnvironment: (...args) => {
    quoteSourceMock.envCalls(...args);
    return Promise.resolve(quoteSourceMock.env);
  },
  loadQuoteRows: (...args) => quoteSourceMock.rows(...args),
  fetchQuotes: async (api, symbols) => {
    const secids = symbols.map((item) => item.secid);
    quoteSourceMock.envCalls(secids);
    const env = quoteSourceMock.env;
    if (env.useDb) {
      const rows = await quoteSourceMock.rows(secids);
      if (rows.length) return { quotes: rows, delay: quoteSourceMock.idle(), source: 'db' };
    }
    const quotes = await api.realtime(symbols);
    const base = env.live && env.todayTrading ? 4000 : 60000;
    return { quotes, delay: quotes.length ? base : Math.min(base, 20000), source: 'api' };
  },
}));

vi.mock('@/utils/env', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isTauri: () => isTauriMock() };
});

vi.mock('@/api/eastmoney', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    EastmoneyApi: class {
      constructor() {
        this.realtime = realtimeMock;
      }
    },
  };
});

vi.mock('@/api/ths', () => ({ loadStockConcepts: loadStockConceptsMock }));

vi.mock('@/utils/windows', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openWindow: openWindowMock };
});
import { WindowConfigs } from '@/utils/windows';

function quote(secid, name, extra = {}) {
  return {
    name,
    secid,
    price: 10,
    range: 0,
    price_diff: 0,
    turn: 1,
    high: 10,
    low: 9,
    position_num: '-',
    position_price: '-',
    position_value: '-',
    position_profit: '-',
    position_profit_rate: '-',
    ...extra,
  };
}

const wrappers = [];

function mountTable({
  symbols = [
    stock('600519', '贵州茅台', '1.600519'),
    stock('000858', '五粮液', '0.000858'),
  ],
  fields = {},
  configs = {},
  series = {},
  quotes = [],
  responses = null,
  conceptMap = {},
  env,
  quoteRows,
} = {}) {
  freshPinia();
  const setting = useSettingStore();
  const monitor = useMonitorStore();
  const symbol = useSymbolStore();
  const macd = useMacdStore();
  const cache = useCacheStore();
  // stateChange 处理会从数据库重读；用例中直接用当前 watchGroup 验证刷新逻辑
  monitor.loadFromDb = vi.fn(async () => true);
  setting.watchFields = { ...defaultWatchFields, ...fields };
  monitor.watchGroup[0].symbols = symbols;
  symbol.configs = configs;
  macd.series = series;
  macd.ensure = vi.fn(async () => {});

  realtimeMock.mockReset();
  if (responses) {
    responses.forEach((item) => realtimeMock.mockResolvedValueOnce(item));
    realtimeMock.mockResolvedValue(responses[responses.length - 1]);
  } else {
    realtimeMock.mockResolvedValue(quotes);
  }
  quoteSourceMock.env = env || { live: true, todayTrading: true, useDb: false };
  quoteSourceMock.rows.mockReset();
  quoteSourceMock.rows.mockResolvedValue(quoteRows || []);
  quoteSourceMock.idle.mockClear();
  quoteSourceMock.envCalls.mockClear();
  loadStockConceptsMock.mockReset();
  loadStockConceptsMock.mockResolvedValue(conceptMap);

  const wrapper = mount(QuoteTable, { global: { plugins: [ElementPlus] } });
  wrappers.push(wrapper);
  return { wrapper, monitor, setting, symbol, macd, cache };
}

async function settle(wrapper) {
  await flushPromises();
  await nextTick();
  await nextTick();
  return wrapper;
}

function bodyRows(wrapper) {
  return wrapper.findAll('.el-table__body-wrapper tbody tr.el-table__row');
}

function names(wrapper) {
  return wrapper.findAll('.row-symbol-name').map((node) => node.text());
}

function headerCell(wrapper, label) {
  return wrapper
    .findAll('.el-table__header-wrapper th')
    .find((th) => th.text().includes(label));
}

function cellsOfRow(wrapper, index) {
  return bodyRows(wrapper)[index].findAll('td').map((td) => td.text());
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

describe('QuoteTable · 自选行情表格', () => {
  it('空自选显示 Element Plus 空文案，不渲染数据行', async () => {
    const { wrapper } = mountTable({ symbols: [], quotes: [] });
    await settle(wrapper);
    expect(bodyRows(wrapper)).toHaveLength(0);
    const empty = wrapper.find('.el-table__empty-text');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toBe('请点击右下角 ➕ 号添加');
  });

  it('有行情时按自选顺序渲染名称、价格、涨跌幅、涨跌额、换手率', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
    ];
    const quotes = [
      quote('1.600519', '贵州茅台', { price: 1500, range: 1.5, price_diff: 22, turn: 0.3 }),
      quote('0.000858', '五粮液', { price: 120, range: -2.5, price_diff: -3, turn: 1.1 }),
    ];
    const { wrapper } = mountTable({ symbols, quotes });
    await settle(wrapper);

    expect(bodyRows(wrapper)).toHaveLength(2);
    expect(names(wrapper)).toEqual(['贵州茅台', '五粮液']);
    expect(cellsOfRow(wrapper, 0)).toEqual(['贵州茅台', '1500', '1.5%', '22', '0.3%', '-']);
    expect(cellsOfRow(wrapper, 1)).toEqual(['五粮液', '120', '-2.5%', '-3', '1.1%', '-']);
  });

  it('点击表头排序：升序 → 降序 → 取消排序', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
      stock('600036', '招商银行', '1.600036'),
    ];
    const quotes = [
      quote('1.600519', '贵州茅台', { range: 1.5 }),
      quote('0.000858', '五粮液', { range: -2.5 }),
      quote('1.600036', '招商银行', { range: 0.8 }),
    ];
    const { wrapper } = mountTable({ symbols, quotes });
    await settle(wrapper);
    expect(names(wrapper)).toEqual(['贵州茅台', '五粮液', '招商银行']);

    const rangeTh = headerCell(wrapper, '涨跌幅');
    await rangeTh.find('.sort-caret.ascending').trigger('click');
    await nextTick();
    expect(names(wrapper)).toEqual(['五粮液', '招商银行', '贵州茅台']);

    await rangeTh.find('.sort-caret.descending').trigger('click');
    await nextTick();
    expect(names(wrapper)).toEqual(['贵州茅台', '招商银行', '五粮液']);

    await rangeTh.find('.sort-caret.descending').trigger('click');
    await nextTick();
    expect(names(wrapper)).toEqual(['贵州茅台', '五粮液', '招商银行']);
  });

  it('持仓与提醒配置在名称列显示自选标记', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
    ];
    const configs = {
      '1.600519': { secid: '1.600519', position: { buyPrice: 1500, buyAmount: 100 } },
      '0.000858': { secid: '0.000858', crossAlertConfig: { crossUpPrice: 150 } },
    };
    const quotes = [
      quote('1.600519', '贵州茅台'),
      quote('0.000858', '五粮液'),
    ];
    const { wrapper } = mountTable({ symbols, configs, quotes });
    await settle(wrapper);

    const rows = bodyRows(wrapper);
    expect(rows[0].find('.alert-icon-top').exists()).toBe(true);
    expect(rows[0].find('.alert-icon-down').exists()).toBe(false);
    expect(rows[1].find('.alert-icon-top').exists()).toBe(false);
    expect(rows[1].find('.alert-icon-down').exists()).toBe(true);
  });

  it('双击行打开详情窗口的图表页，行单击关闭右键菜单', async () => {
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const quotes = [quote('1.600519', '贵州茅台')];
    const { wrapper } = mountTable({ symbols, quotes });
    await settle(wrapper);

    const row = bodyRows(wrapper)[0];
    await row.trigger('dblclick');
    expect(openWindowMock).toHaveBeenLastCalledWith(WindowConfigs.detail, {
      secid: '1.600519',
      panel: 'CHART',
    });

    await row.trigger('contextmenu', { clientX: 10, clientY: 20 });
    expect(wrapper.find('.raw-context-menu').exists()).toBe(true);
    expect(wrapper.find('.raw-context-menu').attributes('style')).toContain('left: 10px');
    expect(wrapper.find('.raw-context-menu').attributes('style')).toContain('top: 20px');

    await row.trigger('click');
    expect(wrapper.find('.raw-context-menu').exists()).toBe(false);
  });

  it('右键菜单「编辑」打开个股设置，删除会移除自选与配置', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
    ];
    const quotes = [
      quote('1.600519', '贵州茅台'),
      quote('0.000858', '五粮液'),
    ];
    const configs = {
      '1.600519': { secid: '1.600519', position: { buyPrice: 1500, buyAmount: 100 } },
    };
    const { wrapper, monitor, symbol } = mountTable({ symbols, configs, quotes });
    await settle(wrapper);
    const removeConfig = vi.spyOn(symbol, 'deleteSymbolConfig');
    const persist = vi.spyOn(monitor, 'persist').mockImplementation(() => {});

    await bodyRows(wrapper)[0].trigger('contextmenu', { clientX: 10, clientY: 20 });
    await wrapper.find('.raw-context-menu li').trigger('click');
    expect(openWindowMock).toHaveBeenLastCalledWith(WindowConfigs.detail, {
      secid: '1.600519',
      panel: 'SETTING',
    });

    await bodyRows(wrapper)[0].trigger('contextmenu', { clientX: 10, clientY: 20 });
    await wrapper.find('.raw-context-menu li.danger').trigger('click');
    await settle(wrapper);
    expect(monitor.watchGroup[0].symbols.map((s) => s.secid)).toEqual(['0.000858']);
    expect(names(wrapper)).toEqual(['五粮液']);
    expect(persist).toHaveBeenCalledWith('deleteWatchList');
    expect(removeConfig).toHaveBeenCalledWith('1.600519');
  });

  it('删除落库失败时提示错误、恢复行、广播回滚且不清理配置', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
    ];
    const quotes = [
      quote('1.600519', '贵州茅台'),
      quote('0.000858', '五粮液'),
    ];
    const { wrapper, monitor, symbol } = mountTable({ symbols, quotes });
    await settle(wrapper);
    const removeConfig = vi.spyOn(symbol, 'deleteSymbolConfig');
    vi.spyOn(monitor, 'persist').mockResolvedValue(null);
    isTauriMock.mockReturnValue(true);
    tauriEmitMock.mockClear();

    await bodyRows(wrapper)[0].trigger('contextmenu', { clientX: 10, clientY: 20 });
    await wrapper.find('.raw-context-menu li.danger').trigger('click');
    await settle(wrapper);

    isTauriMock.mockReturnValue(false);
    expect(removeConfig).not.toHaveBeenCalled();
    // persist 被替身后不会广播，这条事件只能来自失败后的回滚广播
    expect(tauriEmitMock).toHaveBeenCalledWith('stateChange', 'rollbackWatchList');
    expect(monitor.watchGroup[0].symbols.map((s) => s.secid)).toEqual([
      '1.600519',
      '0.000858',
    ]);
    expect(names(wrapper)).toEqual(['贵州茅台', '五粮液']);
  });

  it('挂载后立即请求实时行情，并按 4 秒间隔轮询刷新', async () => {
    vi.useFakeTimers();
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const { wrapper } = mountTable({
      symbols,
      responses: [
        [quote('1.600519', '贵州茅台', { price: 1500 })],
        [quote('1.600519', '贵州茅台', { price: 1510 })],
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(realtimeMock).toHaveBeenCalledTimes(1);
    expect(realtimeMock).toHaveBeenLastCalledWith([symbols[0]]);
    expect(names(wrapper)).toEqual(['贵州茅台']);
    expect(cellsOfRow(wrapper, 0)[1]).toBe('1500');

    await vi.advanceTimersByTimeAsync(4000);
    expect(realtimeMock).toHaveBeenCalledTimes(2);
    expect(cellsOfRow(wrapper, 0)[1]).toBe('1510');
  });

  it('请求未返回时卸载组件，返回后不再继续轮询', async () => {
    vi.useFakeTimers();
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    let release;
    const pending = new Promise((resolve) => {
      release = () => resolve([quote('1.600519', '贵州茅台')]);
    });
    const { wrapper } = mountTable({ symbols, responses: [pending] });
    await vi.advanceTimersByTimeAsync(0);
    expect(realtimeMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    wrappers.splice(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20000);
    expect(realtimeMock).toHaveBeenCalledTimes(1);
  });

  it('非盘中且库已覆盖交易日时直接读库渲染，不再请求行情接口', async () => {
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const { wrapper } = mountTable({
      symbols,
      quotes: [],
      env: { live: false, todayTrading: true, useDb: true },
      quoteRows: [
        quote('1.600519', '贵州茅台', { price: 1500, range: 1.5, price_diff: 22, turn: 0.3 }),
      ],
    });
    await settle(wrapper);

    expect(realtimeMock).not.toHaveBeenCalled();
    expect(quoteSourceMock.envCalls).toHaveBeenCalledWith(['1.600519']);
    expect(quoteSourceMock.rows).toHaveBeenCalledWith(['1.600519']);
    expect(quoteSourceMock.idle).toHaveBeenCalled();
    expect(names(wrapper)).toEqual(['贵州茅台']);
    expect(cellsOfRow(wrapper, 0)).toEqual(['贵州茅台', '1500', '1.5%', '22', '0.3%', '-']);
  });

  it('盘中库落后时仍走接口，并放慢到 60 秒重试', async () => {
    vi.useFakeTimers();
    quoteSourceMock.env = { live: true, todayTrading: true, useDb: false };
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const { wrapper } = mountTable({
      symbols,
      responses: [[quote('1.600519', '贵州茅台', { price: 1500 })]],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(realtimeMock).toHaveBeenCalledTimes(1);

    quoteSourceMock.env = { live: false, todayTrading: true, useDb: false };
    await vi.advanceTimersByTimeAsync(4000);
    expect(realtimeMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60000);
    expect(realtimeMock).toHaveBeenCalledTimes(3);
  });

  it('收到 stateChange 后重新从自选列表刷新表格', async () => {
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const quotes = [quote('1.600519', '贵州茅台')];
    const { wrapper, monitor } = mountTable({ symbols, quotes });
    await settle(wrapper);
    expect(names(wrapper)).toEqual(['贵州茅台']);

    monitor.watchGroup[0].symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
    ];
    const { emit } = await import('@/utils/events');
    await emit('stateChange', {});
    await settle(wrapper);

    expect(names(wrapper)).toEqual(['贵州茅台', '五粮液']);
    expect(cellsOfRow(wrapper, 1)).toEqual(['五粮液', '-', '-%', '-', '-%', '-']);
  });

  it('缺少行情数据时用占位「-」兜底', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
    ];
    const { wrapper } = mountTable({
      symbols,
      quotes: [quote('1.600519', '贵州茅台', { price: 1500 })],
    });
    await settle(wrapper);
    expect(bodyRows(wrapper)).toHaveLength(2);
    expect(cellsOfRow(wrapper, 1)).toEqual(['五粮液', '-', '-%', '-', '-%', '-']);
  });

  it('涨跌颜色随设置切换红涨绿跌 / 绿涨红跌', async () => {
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const quotes = [quote('1.600519', '贵州茅台', { range: 1.5, price_diff: 22 })];
    const { wrapper, setting } = mountTable({ symbols, quotes });
    await settle(wrapper);
    const rangeSpan = bodyRows(wrapper)[0].findAll('td')[2].find('span');
    expect(rangeSpan.classes()).toContain('red');

    setting.updownColor = 'redDownGreenUp';
    await nextTick();
    expect(bodyRows(wrapper)[0].findAll('td')[2].find('span').classes()).toContain('green');
  });

  it('价格超过十万取整显示，涨跌幅与换手率带百分号', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
    ];
    const quotes = [
      quote('1.600519', '贵州茅台', { price: 120000.6, range: 2.25, turn: 3.5 }),
      quote('0.000858', '五粮液', { price: 88.8, range: -0.5, turn: 0 }),
    ];
    const { wrapper } = mountTable({ symbols, quotes });
    await settle(wrapper);
    expect(cellsOfRow(wrapper, 0)[1]).toBe('120001');
    expect(cellsOfRow(wrapper, 0)[2]).toBe('2.25%');
    expect(cellsOfRow(wrapper, 0)[4]).toBe('3.5%');
    expect(cellsOfRow(wrapper, 1)[1]).toBe('88.8');
    expect(cellsOfRow(wrapper, 1)[4]).toBe('0%');
  });

  it('持仓列按金额缩写与收益率格式展示', async () => {
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const quotes = [quote('1.600519', '贵州茅台', { price: 1600, range: 6.67, price_diff: 10 })];
    const configs = {
      '1.600519': {
        secid: '1.600519',
        position: { buyPrice: 1500, buyAmount: 100 },
      },
    };
    const fields = {
      position_num: true,
      position_price: true,
      position_value: true,
      position_profit: true,
      position_profit_rate: true,
    };
    const { wrapper } = mountTable({ symbols, quotes, configs, fields });
    await settle(wrapper);
    const cells = cellsOfRow(wrapper, 0);
    expect(cells).toContain('100');
    expect(cells).toContain('1500');
    expect(cells).toContain('16万');
    expect(cells).toContain('1.0万');
    expect(cells).toContain('6.67%');
  });

  it('MACD 列展示连续同号天数，缺日 K 显示 -', async () => {
    const symbols = [
      stock('600519', '贵州茅台', '1.600519'),
      stock('000858', '五粮液', '0.000858'),
      stock('600036', '招商银行', '1.600036'),
    ];
    const series = {
      '1.600519': [
        { date: '2026-10-29', value: 1 },
        { date: '2026-10-30', value: 2 },
      ],
      '0.000858': [
        { date: '2026-10-29', value: -1 },
        { date: '2026-10-30', value: -2 },
      ],
    };
    const quotes = [
      quote('1.600519', '贵州茅台'),
      quote('0.000858', '五粮液'),
      quote('1.600036', '招商银行'),
    ];
    const { wrapper } = mountTable({ symbols, series, quotes });
    await settle(wrapper);
    const macdCells = bodyRows(wrapper).map((row) => row.findAll('td')[5].text());
    expect(macdCells).toEqual(['2', '-2', '-']);
    expect(bodyRows(wrapper)[0].findAll('td')[5].find('span').classes()).toContain('red');
    expect(bodyRows(wrapper)[1].findAll('td')[5].find('span').classes()).toContain('green');
  });

  it('概念列关闭时不请求接口，打开后展示申万与同花顺概念', async () => {
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const quotes = [quote('1.600519', '贵州茅台')];
    const off = mountTable({ symbols, quotes });
    await settle(off.wrapper);
    expect(loadStockConceptsMock).not.toHaveBeenCalled();

    const on = mountTable({
      symbols,
      quotes,
      fields: { concept_l1: true, concept_l2: true, concept_ths: true },
      conceptMap: {
        600519: { l1: '食品饮料', l2: '白酒', ths: '酿酒' },
      },
    });
    await settle(on.wrapper);
    expect(loadStockConceptsMock).toHaveBeenCalledWith(['600519']);
    const cells = cellsOfRow(on.wrapper, 0);
    expect(cells).toContain('食品饮料');
    expect(cells).toContain('白酒');
    expect(cells).toContain('酿酒');
  });

  it('MACD 列关闭时不触发日 K 拉取', async () => {
    const symbols = [stock('600519', '贵州茅台', '1.600519')];
    const { wrapper, macd } = mountTable({ symbols, quotes: [], fields: { macd: false } });
    await settle(wrapper);
    expect(macd.ensure).not.toHaveBeenCalled();
  });
});
