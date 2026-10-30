import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import MarketWidth from '@/views/MarketWidth.vue';

vi.mock('@/api/legulegu', () => ({
  loadMarketWidth: vi.fn(() =>
    Promise.resolve({
      dates: ['2026-10-27', '2026-10-28'],
      rows: [
        { name: '美容护理', code: '801980.SI', values: [10, 17] },
        { name: '环保', code: '801970.SI', values: [52, null] },
        { name: '行业平均', code: 'SWL1', values: [30, 40] },
      ],
    }),
  ),
}));

describe('MarketWidth 独立窗口', () => {
  it('交易日日期在表格外、数字格紧贴，最右侧为最新日期', async () => {
    const wrapper = mount(MarketWidth, {
      global: { plugins: [ElementPlus] },
      attachTo: document.body,
    });
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
});
