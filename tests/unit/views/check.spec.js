import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import Check from '@/views/Check.vue';
import { useMonitorStore } from '@/stores/monitor';

const {
  loadMock,
  watchlistMock,
  industriesMock,
  saveQuotesMock,
  reloadMock,
  realtimeMock,
  refreshIndustryMock,
} = vi.hoisted(() => ({
  loadMock: vi.fn(),
  watchlistMock: vi.fn(),
  industriesMock: vi.fn(),
  saveQuotesMock: vi.fn(),
  reloadMock: vi.fn(),
  realtimeMock: vi.fn(),
  refreshIndustryMock: vi.fn(),
}));

vi.mock('@/utils/db', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadHistory: loadMock,
    loadWatchlist: watchlistMock,
    loadIndustries: industriesMock,
    saveQuotes: saveQuotesMock,
  };
});

vi.mock('@/utils/klineSync', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reloadHistories: reloadMock };
});

vi.mock('@/api/eastmoney', async (importOriginal) => {
  const actual = await importOriginal();
  class EastmoneyApi {
    async realtime(list) {
      return realtimeMock(list);
    }
  }
  return { ...actual, EastmoneyApi };
});

vi.mock('@/api/ths', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, refreshStockIndustries: refreshIndustryMock };
});

const STOCKS = [
  { secid: '1.600519', symbol: '600519', name: '贵州茅台' },
  { secid: '0.000001', symbol: '000001', name: '平安银行' },
];

const ROWS = [
  { secid: '1.600519', name: '贵州茅台', zx: true, price: 100, ratio: 1, turnover_ratio: 2 },
  { secid: '0.000001', name: '平安银行', zx: true, price: 10, ratio: 0.5, turnover_ratio: 1 },
];

const INDUSTRIES = [
  { code: '600519', l1: '食品饮料', l2: '白酒Ⅱ', ths: '白酒' },
  { code: '000001', l1: '银行', l2: '股份制银行', ths: '银行' },
];

const DATES = ['2024-01-02', '2024-01-03', '2026-11-02', '2026-11-03'];

const candles = (dates) => dates.map((date) => ({ date }));

const wrappers = [];

function mountCheck(stocks = STOCKS) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const monitor = useMonitorStore();
  monitor.watchGroup[0].symbols = stocks;

  const wrapper = mount(Check, { global: { plugins: [ElementPlus, pinia] } });
  wrappers.push(wrapper);
  return wrapper;
}

function findButton(root, text) {
  return root.findAll('button').find((btn) => btn.text() === text);
}

function itemButton(wrapper, index, text) {
  return findButton(wrapper.findAll('.check-item')[index], text);
}

function itemTags(wrapper) {
  return wrapper.findAll('.check-item .el-tag').map((tag) => tag.text());
}

/** 详情弹窗内容挂在 body 上，需从 document 查询 */
async function openDetail(wrapper, index) {
  await itemButton(wrapper, index, '详情').trigger('click');
  await flushPromises();
}

function detailIssues() {
  return Array.from(
    document.body.querySelectorAll('.check-detail-dialog .check-detail-issue'),
  ).map((node) => node.textContent);
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = '';
});

beforeEach(() => {
  loadMock.mockReset().mockImplementation(async () => candles(DATES));
  watchlistMock.mockReset().mockResolvedValue({ stocks: ROWS });
  industriesMock.mockReset().mockResolvedValue(INDUSTRIES);
  saveQuotesMock.mockReset().mockResolvedValue(null);
  reloadMock.mockReset().mockResolvedValue({ reloaded: 1, failed: 0, skipped: 0 });
  realtimeMock.mockReset().mockImplementation(async (list) =>
    list.map(({ secid }) => ({ secid, name: '修复', price: 10, range: 1, amount: 0, turn: 1 })),
  );
  refreshIndustryMock.mockReset().mockResolvedValue({
    '000001': { l1: '银行', l2: '股份制银行', ths: '银行' },
  });
});

describe('Check · 数据校验窗口', () => {
  it('展示一键校验与全部校验项', () => {
    const wrapper = mountCheck();

    expect(findButton(wrapper, '一键校验')).toBeTruthy();
    expect(wrapper.find('.check-footer').text()).toContain('一键校验');
    const names = wrapper.findAll('.check-item-name').map((item) => item.text());
    expect(names).toEqual(['校验 stocks 表股票数据', '校验 histories 表股票历史数据']);
    expect(itemTags(wrapper)).toEqual(['待校验', '待校验']);
    expect(wrapper.find('.check-summary').text()).toBe('尚未校验');
    const details = wrapper
      .findAll('.check-item-ops button')
      .filter((btn) => btn.text() === '详情');
    expect(details).toHaveLength(2);
    expect(details[0].attributes()).toHaveProperty('disabled');
    expect(document.body.querySelector('.check-detail-dialog')).toBeNull();
  });

  it('一键校验逐项执行并展示全部通过结果', async () => {
    const wrapper = mountCheck();

    await findButton(wrapper, '一键校验').trigger('click');
    await flushPromises();

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(watchlistMock).toHaveBeenCalledTimes(1);
    expect(industriesMock).toHaveBeenCalledTimes(1);
    expect(itemTags(wrapper)).toEqual(['通过', '通过']);
    const messages = wrapper.findAll('.check-item-message').map((item) => item.text());
    expect(messages[0]).toBe('共 2 只自选股，stocks 数据齐全');
    expect(messages[1]).toBe('共 2 只自选股，历史数据齐全');
    expect(wrapper.find('.check-summary').text()).toBe('已校验 2 项，通过 2 项，未通过 0 项');

    await openDetail(wrapper, 0);
    expect(document.body.querySelector('.check-detail-dialog .el-dialog__title').textContent).toContain(
      '校验 stocks 表股票数据',
    );
    expect(detailIssues()).toHaveLength(0);
    expect(document.body.querySelector('.check-detail-empty').textContent).toContain('未发现异常');
  });

  it('历史数据校验不通过时列出原因，修复后自动复查为通过', async () => {
    let repaired = false;
    loadMock.mockImplementation(async (secid) =>
      secid === '1.600519' || repaired ? candles(DATES) : [],
    );
    reloadMock.mockImplementation(async (secids) => {
      repaired = true;
      return { reloaded: secids.length, failed: 0, skipped: 0 };
    });
    const wrapper = mountCheck();

    await itemButton(wrapper, 1, '校验').trigger('click');
    await flushPromises();

    expect(itemTags(wrapper)[1]).toBe('未通过');
    expect(wrapper.findAll('.check-item-message')[1].text()).toBe(
      '共 2 只自选股，1 只历史完整，1 只存在问题',
    );

    await openDetail(wrapper, 1);
    const issues = detailIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('平安银行 000001');
    expect(issues[0]).toContain('无历史数据');
    expect(itemButton(wrapper, 1, '修复')).toBeTruthy();

    await itemButton(wrapper, 1, '修复').trigger('click');
    await flushPromises();

    expect(reloadMock).toHaveBeenCalledWith(['0.000001']);
    expect(itemTags(wrapper)[1]).toBe('通过');
    expect(itemButton(wrapper, 1, '校验')).toBeTruthy();
  });

  it('stocks 表校验不通过时列出缺数据原因，修复后自动复查为通过', async () => {
    watchlistMock
      .mockResolvedValueOnce({ stocks: [ROWS[0]] })
      .mockResolvedValue({ stocks: ROWS });
    const wrapper = mountCheck();

    await itemButton(wrapper, 0, '校验').trigger('click');
    await flushPromises();

    expect(itemTags(wrapper)[0]).toBe('未通过');

    await openDetail(wrapper, 0);
    const issues = detailIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('平安银行 000001');
    expect(issues[0]).toContain('stocks 表缺少记录');

    await itemButton(wrapper, 0, '修复').trigger('click');
    await flushPromises();

    expect(realtimeMock).toHaveBeenCalledWith([{ secid: '0.000001' }]);
    expect(saveQuotesMock).toHaveBeenCalledWith([
      { secid: '0.000001', name: '修复', price: 10, range: 1, amount: 0, turn: 1 },
    ]);
    expect(refreshIndustryMock).toHaveBeenCalledWith(['000001']);
    expect(itemTags(wrapper)[0]).toBe('通过');
  });

  it('行业字段缺失时修复后自动复查为通过', async () => {
    industriesMock
      .mockResolvedValueOnce([{ code: '600519', l1: '', l2: '', ths: '' }, INDUSTRIES[1]])
      .mockResolvedValue(INDUSTRIES);
    const wrapper = mountCheck();

    await itemButton(wrapper, 0, '校验').trigger('click');
    await flushPromises();

    expect(itemTags(wrapper)[0]).toBe('未通过');

    await itemButton(wrapper, 0, '修复').trigger('click');
    await flushPromises();

    expect(refreshIndustryMock).toHaveBeenCalledWith(['600519']);
    expect(itemTags(wrapper)[0]).toBe('通过');
  });

  it('读取历史全部异常时按无数据判定，不中断其他校验项', async () => {
    loadMock.mockRejectedValue(new Error('boom'));
    const wrapper = mountCheck();

    await findButton(wrapper, '一键校验').trigger('click');
    await flushPromises();

    expect(itemTags(wrapper)).toEqual(['通过', '未通过']);
    expect(wrapper.findAll('.check-item-message')[1].text()).toBe(
      '共 2 只自选股，0 只历史完整，2 只存在问题',
    );

    await openDetail(wrapper, 1);
    expect(detailIssues()).toHaveLength(2);
    expect(wrapper.find('.check-summary').text()).toBe('已校验 2 项，通过 1 项，未通过 1 项');
  });
});
