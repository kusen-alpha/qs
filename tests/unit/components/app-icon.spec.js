import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppIcon from '@/components/AppIcon.vue';

function mountIcon(name) {
  return mount(AppIcon, { props: { name } });
}

describe('AppIcon · 内置图标', () => {
  it('plus 图标', () => {
    const wrapper = mountIcon('plus');
    expect(wrapper.findAll('svg')).toHaveLength(1);
    expect(wrapper.find('svg').attributes('viewBox')).toBe('0 0 1024 1024');
    expect(wrapper.find('path').attributes('d')).toMatch(/^M480 480V128/);
  });

  it('chart 图标使用 256 画布', () => {
    const wrapper = mountIcon('chart');
    expect(wrapper.findAll('svg')).toHaveLength(1);
    expect(wrapper.find('svg').attributes('viewBox')).toBe('0 0 256 256');
  });

  it('setting 图标', () => {
    const wrapper = mountIcon('setting');
    expect(wrapper.findAll('svg')).toHaveLength(1);
    expect(wrapper.find('path').attributes('d')).toContain('M600.704 64');
  });

  it('edit 图标包含两条路径', () => {
    const wrapper = mountIcon('edit');
    expect(wrapper.findAll('svg')).toHaveLength(1);
    expect(wrapper.findAll('path')).toHaveLength(2);
  });

  it('star 图标', () => {
    const wrapper = mountIcon('star');
    expect(wrapper.findAll('svg')).toHaveLength(1);
    expect(wrapper.find('path').attributes('d')).toContain('M283.84 867.84');
  });

  it('bell 图标', () => {
    const wrapper = mountIcon('bell');
    expect(wrapper.findAll('svg')).toHaveLength(1);
    expect(wrapper.find('path').attributes('d')).toContain('M512 64a64 64');
  });

  it('delete 图标', () => {
    const wrapper = mountIcon('delete');
    expect(wrapper.findAll('svg')).toHaveLength(1);
    expect(wrapper.find('path').attributes('d')).toContain('M160 256H96');
  });

  it('未知图标名不渲染任何内容', () => {
    const wrapper = mountIcon('unknown');
    expect(wrapper.findAll('svg')).toHaveLength(0);
  });
});
