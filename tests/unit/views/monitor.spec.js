import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Monitor from '@/views/Monitor.vue';
import { useMonitorStore } from '@/stores/monitor';
import { useSettingStore } from '@/stores/setting';
import { freshPinia } from '../../helpers';

function mountMonitor() {
  freshPinia();
  const monitor = useMonitorStore();
  const setting = useSettingStore();
  setting.$persist = () => {};
  monitor.watchGroup = [
    { id: 0, id_str: '0', name: '自选', symbols: [{ symbol: '600519' }] },
    { id: 1, id_str: '1', name: '行业', symbols: [] },
  ];
  const wrapper = mount(Monitor, {
    global: {
      plugins: [ElementPlus],
      stubs: {
        QuoteTable: { template: '<div class="quote-table-stub" />' },
        ConceptTable: { template: '<div class="concept-table-stub" />' },
        SectorTable: { template: '<div class="sector-table-stub" />' },
        CalendarTable: { template: '<div class="calendar-table-stub" />' },
        Iconbar: { template: '<div class="iconbar-stub" />' },
      },
    },
  });
  return { wrapper, monitor, setting };
}

describe('Monitor 视图 · 顶部 tab', () => {
  it('默认显示自选行情表格', () => {
    const { wrapper } = mountMonitor();
    expect(wrapper.find('.quote-table-stub').exists()).toBe(true);
    expect(wrapper.find('.monitor-tab.active').text()).toBe('自选');
  });

  it('切换概念 tab 展示概念表格', async () => {
    const { wrapper } = mountMonitor();
    await wrapper.findAll('.monitor-tab')[1].trigger('click');
    expect(wrapper.find('.concept-table-stub').exists()).toBe(true);
    expect(wrapper.find('.quote-table-stub').exists()).toBe(false);
  });

  it('板块 tab 展示板块表格，行情与日历 tab 分别展示按钮面板与日历列表', async () => {
    const { wrapper } = mountMonitor();
    const tabs = wrapper.findAll('.monitor-tab');
    await tabs[2].trigger('click');
    expect(wrapper.find('.sector-table-stub').exists()).toBe(true);
    expect(wrapper.find('.monitor-placeholder').exists()).toBe(false);
    await tabs[3].trigger('click');
    expect(wrapper.find('.monitor-placeholder').exists()).toBe(false);
    expect(wrapper.find('.market-tool').text()).toBe('市场宽度');
    await tabs[4].trigger('click');
    expect(wrapper.find('.calendar-table-stub').exists()).toBe(true);
    expect(wrapper.find('.monitor-placeholder').exists()).toBe(false);
  });

  it('透明度与灰度写入卡片样式', async () => {
    const { wrapper, setting } = mountMonitor();
    setting.viewOpacity = 20;
    setting.viewGray = 30;
    await wrapper.vm.$nextTick();
    const style = wrapper.find('#monitorCard').attributes('style');
    expect(style).toContain('opacity: 0.8');
    expect(style).toContain('grayscale(30%)');
  });
});
