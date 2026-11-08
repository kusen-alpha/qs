import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Iconbar from '@/components/monitor/Iconbar.vue';
import { useCacheStore } from '@/stores/cache';
import { useSettingStore } from '@/stores/setting';
import { freshPinia } from '../../helpers';

vi.mock('@/utils/windows', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openWindow: vi.fn() };
});

import { openWindow, WindowConfigs } from '@/utils/windows';

function mountBar(tab = 'watch') {
  freshPinia();
  const cache = useCacheStore();
  const setting = useSettingStore();
  cache.totoal_profit = 12345;
  cache.totoal_profit_rate = 0.1234;
  cache.today_profit = -100;
  cache.today_profit_rate = -0.01;
  const wrapper = mount(Iconbar, {
    props: { tab },
    global: {
      plugins: [ElementPlus],
      stubs: {
        'el-tooltip': { template: '<div><slot /></div>' },
      },
    },
  });
  return { wrapper, cache, setting };
}

describe('Iconbar · 底部图标栏', () => {
  it('自选 tab：设置 / 添加 / 图表 三个按钮 + 盈亏区', () => {
    const { wrapper } = mountBar('watch');
    expect(wrapper.findAll('.buttons')).toHaveLength(3);
    expect(wrapper.find('.profit').exists()).toBe(true);
  });

  it('概念 tab：设置 / 添加 / 图表 三个按钮，没有盈亏区', () => {
    const { wrapper } = mountBar('concept');
    expect(wrapper.findAll('.buttons')).toHaveLength(3);
    expect(wrapper.find('.profit').exists()).toBe(false);
  });

  it('板块 tab：设置 / 图表 两个按钮，没有添加与盈亏区', () => {
    const { wrapper } = mountBar('sector');
    expect(wrapper.findAll('.buttons')).toHaveLength(2);
    expect(wrapper.find('.profit').exists()).toBe(false);
  });

  it('日历 tab：设置 / 添加 两个按钮，添加按钮打开独立事件窗口', async () => {
    const { wrapper } = mountBar('calendar');
    expect(wrapper.findAll('.buttons')).toHaveLength(2);
    expect(wrapper.find('.profit').exists()).toBe(false);

    await wrapper.findAll('.buttons')[1].trigger('click');
    expect(openWindow).toHaveBeenLastCalledWith(WindowConfigs.calendar);
  });

  it('点击盈亏在总盈亏与今盈亏之间切换', async () => {
    const { wrapper } = mountBar('watch');
    expect(wrapper.find('.profit-text').text()).toBe('总盈亏');
    expect(wrapper.text()).toContain('1.2万');
    await wrapper.find('.profit').trigger('click');
    expect(wrapper.find('.profit-text').text()).toBe('今盈亏');
    expect(wrapper.text()).toContain('-100');
    await wrapper.find('.profit').trigger('click');
    expect(wrapper.find('.profit-text').text()).toBe('总盈亏');
  });

  it('红涨绿跌与绿涨红跌的颜色类', async () => {
    const { wrapper, cache, setting } = mountBar('watch');
    expect(wrapper.find('.profit-value').classes()).toContain('red');
    cache.totoal_profit = -1;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.profit-value')[0].classes()).toContain('green');
    setting.updownColor = 'redDownGreenUp';
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.profit-value')[0].classes()).toContain('red');
  });

  it('按钮打开对应窗口：设置 / 添加 / 图表', async () => {
    const { wrapper } = mountBar('watch');
    const buttons = wrapper.findAll('.buttons');
    await buttons[0].trigger('click');
    expect(openWindow).toHaveBeenLastCalledWith(WindowConfigs.setting);
    await buttons[1].trigger('click');
    expect(openWindow).toHaveBeenLastCalledWith(WindowConfigs.search);
    await buttons[2].trigger('click');
    expect(openWindow).toHaveBeenLastCalledWith(WindowConfigs.detail);
  });

  it('概念 tab 的添加按钮打开分组编辑窗口', async () => {
    const { wrapper } = mountBar('concept');
    await wrapper.findAll('.buttons')[1].trigger('click');
    expect(openWindow).toHaveBeenLastCalledWith(WindowConfigs.group);
  });

  it('概念/板块 tab 的图表按钮打开对应类型的板块图表窗口', async () => {
    const concept = mountBar('concept');
    await concept.wrapper.findAll('.buttons')[2].trigger('click');
    expect(openWindow).toHaveBeenLastCalledWith(WindowConfigs.boardChart, { kind: 'concept' });

    const sector = mountBar('sector');
    await sector.wrapper.findAll('.buttons')[1].trigger('click');
    expect(openWindow).toHaveBeenLastCalledWith(WindowConfigs.boardChart, { kind: 'sector' });
  });
});
