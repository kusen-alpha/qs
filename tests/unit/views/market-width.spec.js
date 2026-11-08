import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import MarketWidth from '@/views/MarketWidth.vue';

/* db 为库内已渲染的数据；refresh 为后台补数结果（默认已立即就绪） */
const api = vi.hoisted(() => ({
  db: null,
  refresh: null,
  refreshCalls: 0,
}));

vi.mock('@/api/legulegu', () => ({
  loadMarketWidthFromDb: vi.fn(async () => api.db),
  loadMarketWidth: vi.fn(async () => api.refresh),
  refreshMarketWidth: vi.fn(async () => {
    api.refreshCalls += 1;
    return api.refresh;
  }),
}));

const sample = {
  dates: ['2026-10-27', '2026-10-28'],
  rows: [
    { name: '美容护理', code: '801980.SI', values: [10, 17] },
    { name: '环保', code: '801970.SI', values: [52, null] },
    { name: '行业平均', code: 'SWL1', values: [30, 40] },
  ],
};

beforeEach(() => {
  api.db = null;
  api.refresh = sample;
  api.refreshCalls = 0;
});

function mountView() {
  return mount(MarketWidth, {
    global: { plugins: [ElementPlus] },
    attachTo: document.body,
  });
}

describe('MarketWidth 独立窗口', () => {
  it('交易日日期在表格外、数字格紧贴，最右侧为最新日期', async () => {
    const wrapper = mountView();
    await flushPromises();

    /* 日期位于表格之外，按列从左到右升序排列 */
    const dates = wrapper.findAll('.mw-date').map((d) => d.text());
    expect(dates).toEqual(['2026-10-27', '2026-10-28']);
    expect(wrapper.find('.mw-table').exists()).toBe(true);

    const rows = wrapper.findAll('.mw-row');
    expect(rows).toHaveLength(3);
    /* 行业平均固定在第一位 */
    expect(rows[0].find('.mw-name').text()).toBe('行业平均');
    expect(rows[0].findAll('.mw-cell').map((c) => c.text())).toEqual(['30', '40']);
    expect(rows[1].find('.mw-name').text()).toBe('美容护理');
    expect(rows[1].findAll('.mw-cell').map((c) => c.text())).toEqual(['10', '17']);
    expect(rows[2].findAll('.mw-cell').map((c) => c.text())).toEqual(['52', '-']);

    wrapper.unmount();
  });

  it('先渲染库内数据，再合并后台补数结果', async () => {
    api.db = {
      dates: ['2026-10-27'],
      rows: [
        { name: '行业平均', code: 'SWL1', values: [30] },
        { name: '美容护理', code: '801980.SI', values: [10] },
      ],
    };
    /* 让后台补数保持挂起，验证库内数据先出现 */
    let resolveRefresh;
    api.refresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    const wrapper = mountView();
    await flushPromises();

    expect(api.refreshCalls).toBe(1);
    const rows = wrapper.findAll('.mw-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].findAll('.mw-cell').map((c) => c.text())).toEqual(['30']);

    resolveRefresh(sample);
    await flushPromises();

    /* 补数后日期增加一列，表格合并为新数据 */
    expect(wrapper.findAll('.mw-date')).toHaveLength(2);
    expect(wrapper.findAll('.mw-row')).toHaveLength(3);
    expect(wrapper.findAll('.mw-row')[1].findAll('.mw-cell').map((c) => c.text())).toEqual([
      '10',
      '17',
    ]);

    wrapper.unmount();
  });

  it('首次从最新交易日开始渲染，拖动后只渲染进入视窗的列', async () => {
    const dates = Array.from({ length: 120 }, (_, i) => `2026-01-01#${i}`);
    const totalWidth = 92 + dates.length * 24;
    api.db = {
      dates,
      rows: [
        { name: '美容护理', code: '801980.SI', values: dates.map((_, i) => i) },
        { name: '环保', code: '801970.SI', values: dates.map((_, i) => i) },
      ],
    };
    api.refresh = null;

    /* jsdom 无布局，注入表格尺寸模拟真实窗口：可视 828px，全部列宽 92 + 120×24 */
    const origin = {
      clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
      scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
    };
    const define = (name, getter) =>
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: getter });
    const restore = (name) => {
      if (origin[name]) Object.defineProperty(HTMLElement.prototype, name, origin[name]);
      else delete HTMLElement.prototype[name];
    };
    define('clientWidth', function () {
      return this.classList && this.classList.contains('mw-table') ? 828 : 0;
    });
    define('scrollWidth', function () {
      return this.classList && this.classList.contains('mw-table') ? totalWidth : 0;
    });

    const wrapper = mountView();
    try {
      await flushPromises();

      /* 首次渲染落在最右侧（最新交易日），左侧未渲染的列由占位块撑开 */
      let row = wrapper.findAll('.mw-row')[0];
      let cells = row.findAll('.mw-cell');
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.length).toBeLessThan(dates.length);
      expect(cells[0].text()).not.toBe('0');
      expect(cells[cells.length - 1].text()).toBe(String(dates.length - 1));
      expect(row.findAll('.mw-gap')).toHaveLength(1);

      /* 拖动到最左侧后，只渲染左侧进入视窗的列 */
      wrapper.find('.mw-table').element.scrollLeft = 0;
      await wrapper.find('.mw-table').trigger('scroll');
      await flushPromises();

      row = wrapper.findAll('.mw-row')[0];
      cells = row.findAll('.mw-cell');
      expect(cells.length).toBeLessThan(dates.length);
      expect(cells[0].text()).toBe('0');

      /* 日期行仍完整渲染，与滚动位置对齐 */
      expect(wrapper.findAll('.mw-date')).toHaveLength(dates.length);
    } finally {
      wrapper.unmount();
      restore('clientWidth');
      restore('scrollWidth');
    }
  });
});
