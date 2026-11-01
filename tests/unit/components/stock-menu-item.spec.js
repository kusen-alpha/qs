import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import StockMenuItem from '@/components/detail/StockMenuItem.vue';

function mountItem(props = {}) {
  return mount(StockMenuItem, {
    props: { name: '贵州茅台', code: '600519', range: '2.5', ...props },
    global: { plugins: [ElementPlus] },
  });
}

describe('StockMenuItem · 自选菜单项', () => {
  it('渲染名称、代码与涨跌幅', () => {
    const wrapper = mountItem();
    expect(wrapper.find('.stock-item-name').text()).toBe('贵州茅台');
    expect(wrapper.find('.stock-item-code .stock-item-col').text()).toBe('600519');
    expect(wrapper.find('.stock-item-range').text()).toBe('2.5%');
  });

  it('正涨幅使用红色，负涨幅使用绿色', () => {
    const up = mountItem({ range: 1.2 });
    expect(up.find('.stock-item-range').classes()).toContain('red');

    const down = mountItem({ range: -4.5 });
    expect(down.find('.stock-item-range').classes()).toContain('green');
  });

  it('涨幅为 0 按红色涨处理', () => {
    const wrapper = mountItem({ range: 0 });
    expect(wrapper.find('.stock-item-range').text()).toBe('0%');
    expect(wrapper.find('.stock-item-range').classes()).toContain('red');
  });

  it('数字类型的涨跌幅正常展示并带百分号', () => {
    const wrapper = mountItem({ range: 3.45 });
    expect(wrapper.find('.stock-item-range').text()).toBe('3.45%');
    expect(wrapper.find('.stock-item-range').classes()).toContain('red');
  });

  it('字符串涨跌幅带正号或空格时按数值判断颜色', () => {
    const up = mountItem({ range: '+1.5' });
    expect(up.find('.stock-item-range').text()).toBe('+1.5%');
    expect(up.find('.stock-item-range').classes()).toContain('red');

    const down = mountItem({ range: ' -2 ' });
    expect(down.find('.stock-item-range').text()).toBe('-2 %');
    expect(down.find('.stock-item-range').classes()).toContain('green');
  });

  it('默认属性与缺省涨跌幅兜底', () => {
    const wrapper = mount(StockMenuItem, {
      global: { plugins: [ElementPlus] },
    });
    expect(wrapper.find('.stock-item-name').text()).toBe('');
    expect(wrapper.findAll('.stock-item-code .stock-item-col')[0].text()).toBe('');
    expect(wrapper.find('.stock-item-range').text()).toBe('-%');
    expect(wrapper.find('.stock-item-range').classes()).toContain('green');
  });
});
