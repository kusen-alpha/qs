import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Detail from '@/views/Detail.vue';
import { useMonitorStore } from '@/stores/monitor';
import { freshPinia } from '../../helpers';
import { emit } from '@/utils/events';

const { query, win } = vi.hoisted(() => ({
  query: { value: {} },
  win: {
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(),
  },
}));

vi.mock('vue-router', () => ({ useRoute: () => ({ query: query.value }) }));
vi.mock('@tauri-apps/api/window', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentWindow: () => win,
}));
vi.mock('@/utils/layout', () => ({ applyDragRegion: vi.fn() }));
vi.mock('@/components/detail/HQKLineChart.vue', () => ({
  default: {
    name: 'HQKLineChart',
    props: ['symbol', 'name', 'code'],
    template: '<div class="chart-stub">{{ symbol }}</div>',
  },
}));

const stubs = {
  StockMenuItem: {
    name: 'StockMenuItem',
    props: ['name', 'code', 'range'],
    template: '<div class="stock-item-stub">{{ name }}|{{ range }}</div>',
  },
  DetailSetting: {
    name: 'DetailSetting',
    props: ['name', 'code', 'secid', 'range', 'price'],
    template: '<div class="detail-setting-stub">{{ secid }}|{{ price }}</div>',
  },
};

const defaultSymbols = [
  { symbol: '600519', name: '贵州茅台', secid: '1.600519' },
  { symbol: '000858', name: '五粮液', secid: '0.000858' },
];

async function mountDetail(symbols = defaultSymbols) {
  freshPinia();
  const monitor = useMonitorStore();
  monitor.watchGroup = symbols.length ? [{ name: '自选', id: 0, symbols }] : [];
  const wrapper = mount(Detail, { global: { plugins: [ElementPlus], stubs } });
  await nextTick();
  return { wrapper, monitor };
}

beforeEach(() => {
  query.value = {};
  win.isMaximized.mockReset();
  win.isMaximized.mockResolvedValue(false);
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('Detail 页面 · 个股看盘窗口', () => {
  it('初始加载自选列表并默认选中第一只股票', async () => {
    const { wrapper } = await mountDetail();
    expect(wrapper.findAll('.el-menu-item')).toHaveLength(2);
    expect(wrapper.findAll('.stock-item-stub')[0].text()).toContain('贵州茅台');
    expect(wrapper.find('.chart-stub').text()).toBe('1.600519');
    expect(wrapper.find('.detail-setting-stub').text()).toContain('1.600519');
  });

  it('query 指定的 secid 存在时优先选中', async () => {
    query.value = { secid: '0.000858' };
    const { wrapper } = await mountDetail();
    expect(wrapper.find('.chart-stub').text()).toBe('0.000858');
    expect(wrapper.findAll('.el-menu-item')[1].classes()).toContain('is-active');
  });

  it('query 指定的 secid 不存在时回落到第一只股票', async () => {
    query.value = { secid: '9.999999' };
    const { wrapper } = await mountDetail();
    expect(wrapper.find('.chart-stub').text()).toBe('1.600519');
  });

  it('query 指定 panel=SETTING 时切到个股设置页签', async () => {
    query.value = { panel: 'SETTING', secid: '0.000858' };
    const { wrapper } = await mountDetail();
    expect(wrapper.find('.detail-setting-stub').text()).toContain('0.000858');
  });

  it('点击左侧列表切换当前股票', async () => {
    const { wrapper } = await mountDetail();
    await wrapper.findAll('.el-menu-item')[1].trigger('click');
    expect(wrapper.find('.chart-stub').text()).toBe('0.000858');
    expect(wrapper.find('.detail-setting-stub').text()).toContain('0.000858');
  });

  it('自选列表为空时展示占位数据', async () => {
    const { wrapper } = await mountDetail([]);
    expect(wrapper.findAll('.el-menu-item')).toHaveLength(0);
    expect(wrapper.find('.chart-stub').text()).toBe('-');
    expect(wrapper.find('.detail-setting-stub').text()).toContain('-');
  });

  it('实时行情事件更新列表中股票的现价与涨跌幅', async () => {
    const { wrapper } = await mountDetail();
    await flushPromises();
    await emit('REALTIME_EAST', [
      { secid: '1.600519', price: 1700, range: 1.2 },
      { secid: '0.000858', price: 120, range: -0.5 },
    ]);
    await nextTick();
    const items = wrapper.findAllComponents({ name: 'StockMenuItem' });
    expect(items[0].props()).toMatchObject({ name: '贵州茅台', range: 1.2 });
    expect(items[1].props()).toMatchObject({ name: '五粮液', range: -0.5 });
  });

  it('Tauri 环境下关闭按钮关闭当前窗口', async () => {
    window.__TAURI_INTERNALS__ = {};
    const { wrapper } = await mountDetail();
    await flushPromises();
    await wrapper.find('#titlebar-close').trigger('click');
    await flushPromises();
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('最大化按钮根据当前状态最大化或还原窗口', async () => {
    window.__TAURI_INTERNALS__ = {};
    const { wrapper } = await mountDetail();
    await flushPromises();
    await wrapper.find('#titlebar-fullscreen').trigger('click');
    await flushPromises();
    expect(win.isMaximized).toHaveBeenCalled();
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.unmaximize).not.toHaveBeenCalled();

    win.isMaximized.mockResolvedValue(true);
    await wrapper.find('#titlebar-fullscreen').trigger('click');
    await flushPromises();
    expect(win.unmaximize).toHaveBeenCalledTimes(1);
  });

  it('最小化按钮调用窗口最小化', async () => {
    window.__TAURI_INTERNALS__ = {};
    const { wrapper } = await mountDetail();
    await flushPromises();
    await wrapper.find('#titlebar-minimize').trigger('click');
    await flushPromises();
    expect(win.minimize).toHaveBeenCalledTimes(1);
  });

  it('浏览器环境不调用窗口 API，关闭按钮无副作用', async () => {
    const { wrapper } = await mountDetail();
    await flushPromises();
    await wrapper.find('#titlebar-close').trigger('click');
    await flushPromises();
    expect(win.close).not.toHaveBeenCalled();
  });
});
