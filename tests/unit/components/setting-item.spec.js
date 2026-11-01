import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import SettingItem from '@/components/setting/SettingItem.vue';

function mountItem(props = {}, slots = {}) {
  return mount(SettingItem, {
    props: { title: '示例设置', ...props },
    slots,
    global: { plugins: [ElementPlus] },
  });
}

describe('SettingItem · 设置项外壳', () => {
  it('渲染标题文案', () => {
    const wrapper = mountItem();
    expect(wrapper.find('.title').text()).toBe('示例设置');
  });

  it('main 插槽内容渲染在主容器', () => {
    const wrapper = mountItem({}, { main: '<span class="main-slot">内容</span>' });
    expect(wrapper.find('.main-container .main-slot').text()).toBe('内容');
    expect(wrapper.find('.main-container').attributes('style')).toContain('height: 100%');
  });

  it('提供 desc 插槽时渲染说明并压缩主区域高度', () => {
    const wrapper = mountItem({}, { desc: '<span class="desc-slot">说明</span>' });
    expect(wrapper.find('.desc-container .desc-slot').text()).toBe('说明');
    expect(wrapper.find('.main-container').attributes('style')).toContain('height: 70%');
  });

  it('未提供 desc 插槽时不渲染说明区域', () => {
    const wrapper = mountItem();
    expect(wrapper.find('.desc-container').exists()).toBe(false);
    expect(wrapper.find('.main-container').attributes('style')).toContain('height: 100%');
  });

  it('divider 默认显示', () => {
    const wrapper = mountItem();
    expect(wrapper.find('.divider').exists()).toBe(true);
  });

  it('divider=false 时不渲染分隔线', () => {
    const wrapper = mountItem({ divider: false });
    expect(wrapper.find('.divider').exists()).toBe(false);
  });

  it('标题带窗口拖动区域标记', () => {
    const wrapper = mountItem();
    expect(wrapper.find('.title').attributes('data-tauri-drag-region')).toBeDefined();
  });
});
