import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ElementPlus from 'element-plus';
import Search from '@/components/editor/Search.vue';
import { useMonitorStore } from '@/stores/monitor';
import { emit } from '@/utils/events';
import { freshPinia } from '../../helpers';

const { requestMock, loadStockConceptsMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  loadStockConceptsMock: vi.fn(),
}));

vi.mock('@/utils/http', () => ({
  request: requestMock,
  requestBytes: vi.fn(),
}));

vi.mock('@/api/ths', () => ({
  loadStockConcepts: loadStockConceptsMock,
}));

const ROWS = [
  { Code: '600519', Name: '贵州茅台', SecurityTypeName: '沪A', QuoteID: '1.600519' },
  { Code: '000001', Name: '平安银行', SecurityTypeName: '深A', QuoteID: '0.000001' },
  { Code: '300750', Name: '宁德时代', SecurityTypeName: '创业板', QuoteID: '0.300750' },
];

const CONCEPTS = {
  600519: { l1: '食品饮料', l2: '白酒', ths: '白酒概念' },
};

const wrappers = [];

async function mountSearch(options = {}) {
  const { rows = ROWS, concepts = CONCEPTS, symbols = [] } = options;
  freshPinia();
  const monitor = useMonitorStore();
  monitor.loadFromDb = vi.fn(async () => true);
  monitor.watchGroup = [{ name: '自选', id: 0, symbols }];

  requestMock.mockReset();
  requestMock.mockResolvedValue({
    data: { QuotationCodeTable: { Data: rows } },
  });
  loadStockConceptsMock.mockReset();
  loadStockConceptsMock.mockImplementation(async () => concepts);

  const wrapper = mount(Search, {
    global: { plugins: [ElementPlus] },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, monitor };
}

function searchInput(wrapper) {
  return wrapper.find('.input-with-select input');
}

async function typeKeyword(wrapper, value) {
  await searchInput(wrapper).setValue(value);
  await vi.advanceTimersByTimeAsync(600);
  await flushPromises();
  await nextTick();
}

function bodyRows(wrapper) {
  return wrapper.findAll('.el-table__body-wrapper .el-table__row');
}

beforeEach(() => {
  /* 只接管防抖定时器，保留 setImmediate 供 flushPromises 使用 */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

describe('Search · 股票搜索面板', () => {
  it('初始状态只渲染搜索框，不展示结果表格', async () => {
    const { wrapper } = await mountSearch();
    expect(searchInput(wrapper).attributes('placeholder')).toBe(
      '输入 A 股代码、名称、简拼或关键词',
    );
    expect(wrapper.find('.table-search').exists()).toBe(false);
    expect(wrapper.findAll('.el-table__body-wrapper .el-table__row')).toHaveLength(0);
  });

  it('输入后防抖 600ms 才发起一次搜索并渲染结果', async () => {
    const { wrapper } = await mountSearch();
    await searchInput(wrapper).setValue('茅台');
    expect(requestMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(599);
    expect(requestMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    await nextTick();

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [url, options] = requestMock.mock.calls[0];
    expect(url.startsWith('https://searchadapter.eastmoney.com/api/suggest/get?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('input')).toBe('茅台');
    expect(params.get('count')).toBe('15');
    expect(options).toMatchObject({ method: 'GET' });

    const rows = bodyRows(wrapper);
    expect(rows).toHaveLength(3);
    expect(rows[0].text()).toContain('600519');
    expect(rows[0].text()).toContain('贵州茅台');
    expect(rows[1].text()).toContain('000001');
    expect(rows[1].text()).toContain('平安银行');
  });

  it('结果行补充一级/二级/同花顺概念，缺失时显示 -', async () => {
    const { wrapper } = await mountSearch();
    await typeKeyword(wrapper, '6');

    const rows = bodyRows(wrapper);
    expect(rows[0].text()).toContain('食品饮料');
    expect(rows[0].text()).toContain('白酒概念');
    expect(rows[1].text()).toContain('平安银行');

    const cells = rows[1].findAll('td');
    expect(cells[3].text()).toBe('-');
    expect(cells[4].text()).toBe('-');
    expect(cells[5].text()).toBe('-');

    expect(loadStockConceptsMock).toHaveBeenCalledTimes(1);
    expect(loadStockConceptsMock).toHaveBeenCalledWith(['600519', '000001', '300750']);
  });

  it('按交易所类型给标签着色', async () => {
    const { wrapper } = await mountSearch();
    await typeKeyword(wrapper, '6');

    const tags = wrapper.findAll('.type-tag');
    expect(tags).toHaveLength(3);
    expect(tags[0].classes()).toContain('bg2');
    expect(tags[1].classes()).toContain('bg1');
    expect(tags[2].classes()).toContain('bg-other');
    expect(tags[0].text()).toBe('沪A');
  });

  it('键盘上下键循环切换选中行并同步表格当前行', async () => {
    const { wrapper } = await mountSearch();
    await typeKeyword(wrapper, '6');

    const table = wrapper.findComponent({ name: 'ElTable' });
    const setCurrentRow = vi.spyOn(table.vm, 'setCurrentRow');
    const input = searchInput(wrapper);

    await input.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(wrapper.vm.activeIndex).toBe(0);
    expect(setCurrentRow).toHaveBeenLastCalledWith(wrapper.vm.list[0]);

    await input.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(wrapper.vm.activeIndex).toBe(1);
    expect(setCurrentRow).toHaveBeenLastCalledWith(wrapper.vm.list[1]);

    await input.trigger('keydown', { key: 'ArrowUp' });
    await nextTick();
    expect(wrapper.vm.activeIndex).toBe(0);

    await input.trigger('keydown', { key: 'ArrowUp' });
    await nextTick();
    expect(wrapper.vm.activeIndex).toBe(2);
  });

  it('回车在未选中时添加第一行到自选', async () => {
    const { wrapper, monitor } = await mountSearch();
    await typeKeyword(wrapper, '6');

    await searchInput(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await nextTick();

    expect(monitor.watchGroup[0].symbols).toEqual([
      { symbol: '600519', name: '贵州茅台', secid: '1.600519', source: '1' },
    ]);
    expect(wrapper.vm.list[0].IsAddCurGroup).toBe(true);
    expect(wrapper.findAll('.action-btn')[0].attributes('disabled')).toBeDefined();
  });

  it('上下键选中后回车添加当前选中行', async () => {
    const { wrapper, monitor } = await mountSearch();
    await typeKeyword(wrapper, '6');

    await searchInput(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    await searchInput(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    await searchInput(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(monitor.watchGroup[0].symbols).toEqual([
      { symbol: '000001', name: '平安银行', secid: '0.000001', source: '1' },
    ]);
    expect(wrapper.vm.list[1].IsAddCurGroup).toBe(true);
    expect(wrapper.vm.list[0].IsAddCurGroup).toBe(false);
  });

  it('结果为空时上下键与回车不报错也不添加', async () => {
    const { wrapper, monitor } = await mountSearch();
    const input = searchInput(wrapper);

    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowUp' });
    await input.trigger('keydown', { key: 'Enter' });

    expect(wrapper.vm.activeIndex).toBe(-1);
    expect(monitor.watchGroup[0].symbols).toHaveLength(0);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('接口返回空列表时隐藏结果表格', async () => {
    const { wrapper } = await mountSearch({ rows: [] });
    await typeKeyword(wrapper, '不存在的股票');

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(wrapper.vm.list).toEqual([]);
    expect(wrapper.find('.table-search').exists()).toBe(false);
  });

  it('搜索异常时清空列表且不抛出', async () => {
    const { wrapper } = await mountSearch();
    requestMock.mockRejectedValueOnce(new Error('network down'));

    await typeKeyword(wrapper, '茅台');

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(wrapper.vm.list).toEqual([]);
    expect(wrapper.find('.table-search').exists()).toBe(false);
  });

  it('清空输入框直接清空结果且不再请求', async () => {
    const { wrapper } = await mountSearch();
    await typeKeyword(wrapper, '6');
    expect(bodyRows(wrapper)).toHaveLength(3);
    expect(requestMock).toHaveBeenCalledTimes(1);

    await typeKeyword(wrapper, '');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(wrapper.vm.list).toEqual([]);
    expect(wrapper.find('.table-search').exists()).toBe(false);
  });

  it('点击添加按钮写入自选并禁用该行按钮', async () => {
    const { wrapper, monitor } = await mountSearch();
    await typeKeyword(wrapper, '6');

    const button = wrapper.findAll('.action-btn')[1];
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    await nextTick();

    expect(monitor.watchGroup[0].symbols).toEqual([
      { symbol: '000001', name: '平安银行', secid: '0.000001', source: '1' },
    ]);
    expect(wrapper.vm.list[1].IsAddCurGroup).toBe(true);
    expect(wrapper.findAll('.action-btn')[1].attributes('disabled')).toBeDefined();
  });

  it('已在自选中的股票搜索结果直接标记为已添加', async () => {
    const { wrapper } = await mountSearch({
      symbols: [{ symbol: '600519', name: '贵州茅台', secid: '1.600519', source: '1' }],
    });
    await typeKeyword(wrapper, '6');

    expect(wrapper.vm.list[0].IsAddCurGroup).toBe(true);
    expect(wrapper.vm.list[1].IsAddCurGroup).toBe(false);
    expect(wrapper.findAll('.action-btn')[0].attributes('disabled')).toBeDefined();
  });

  it('收到 stateChange 事件后重新标记自选状态', async () => {
    const { wrapper, monitor } = await mountSearch();
    await typeKeyword(wrapper, '6');
    expect(wrapper.vm.list[0].IsAddCurGroup).toBe(false);

    monitor.watchGroup[0].symbols.push({
      symbol: '600519',
      name: '贵州茅台',
      secid: '1.600519',
      source: '1',
    });
    await emit('stateChange', {});
    await flushPromises();
    await nextTick();

    expect(wrapper.vm.list[0].IsAddCurGroup).toBe(true);
    expect(wrapper.findAll('.action-btn')[0].attributes('disabled')).toBeDefined();
  });

  it('卸载时取消尚未触发的防抖请求', async () => {
    const { wrapper } = await mountSearch();
    await searchInput(wrapper).setValue('茅台');

    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);

    await vi.advanceTimersByTimeAsync(600);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
