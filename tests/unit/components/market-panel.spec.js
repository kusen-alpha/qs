import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import MarketPanel from '@/components/market/MarketPanel.vue';

const { openWindow, configs } = vi.hoisted(() => ({
  openWindow: vi.fn(),
  configs: { marketWidth: { label: 'marketWidth' } },
}));
vi.mock('@/utils/windows', () => ({ WindowConfigs: configs, openWindow }));

describe('MarketPanel · 行情 tab', () => {
  it('按钮三列网格排列，含市场宽度', () => {
    const wrapper = mount(MarketPanel, { global: { plugins: [ElementPlus] } });
    expect(wrapper.findAll('.market-panel .market-tool').map((b) => b.text())).toEqual(['市场宽度']);
  });

  it('点击市场宽度打开独立子窗口', async () => {
    const wrapper = mount(MarketPanel, { global: { plugins: [ElementPlus] } });
    await wrapper.find('.market-tool').trigger('click');
    expect(openWindow).toHaveBeenCalledWith(configs.marketWidth);
  });
});
