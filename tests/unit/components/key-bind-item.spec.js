import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import KeyBindItem from '@/components/setting/KeyBindItem.vue';

function mountItem(props = {}) {
  return mount(KeyBindItem, {
    props: { title: '老板键', shotcut: ['Ctrl', 'Q'], ...props },
    global: { plugins: [ElementPlus] },
    attachTo: document.body,
  });
}

function keydown(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

function keyup(key) {
  document.dispatchEvent(new KeyboardEvent('keyup', { key }));
}

function message(wrapper) {
  return wrapper.findAll('.description')[1];
}

describe('KeyBindItem · 按键记录', () => {
  it('展示标题、描述与当前快捷键', () => {
    const wrapper = mountItem();
    expect(wrapper.find('.title').text()).toBe('老板键');
    expect(wrapper.findAll('.description')[0].text()).toBe('这是描述');
    expect(wrapper.find('.btn').text()).toBe('Ctrl + Q');
  });

  it('自定义描述与快捷键拼接方式', () => {
    const wrapper = mountItem({ desc: '显示/隐藏面板', shotcut: ['Alt', 'X'] });
    expect(wrapper.findAll('.description')[0].text()).toBe('显示/隐藏面板');
    expect(wrapper.find('.btn').text()).toBe('Alt + X');
  });

  it('disabled 时按钮禁用', () => {
    const wrapper = mountItem({ disabled: true });
    expect(wrapper.find('.btn').attributes('disabled')).toBeDefined();
  });

  it('点击后进入记录状态，再次按键恢复展示', async () => {
    const wrapper = mountItem();
    await wrapper.find('.btn').trigger('click');
    expect(wrapper.find('.btn').text()).toBe('记录按键中');
    keydown('Control');
    keydown('Q');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.btn').text()).toBe('Ctrl + Q');
  });

  it('捕获 Ctrl + Q 组合并 emit change', async () => {
    const wrapper = mountItem();
    await wrapper.find('.btn').trigger('click');
    keydown('Control');
    keydown('q');
    expect(wrapper.emitted('change')).toHaveLength(1);
    expect(wrapper.emitted('change')[0][0]).toEqual(['Control', 'q']);
  });

  it('只按一个键提示需要两个按键', async () => {
    const wrapper = mountItem();
    await wrapper.find('.btn').trigger('click');
    keydown('Control');
    keyup('Control');
    await wrapper.vm.$nextTick();
    expect(message(wrapper).text()).toBe('快捷键组合需要两个按键');
    expect(message(wrapper).isVisible()).toBe(true);
    expect(wrapper.find('.btn').text()).toBe('Ctrl + Q');
    expect(wrapper.emitted('change')).toBeUndefined();
  });

  it('第一个键不是修饰键时提示输入无效', async () => {
    const wrapper = mountItem();
    await wrapper.find('.btn').trigger('click');
    keydown('A');
    keydown('B');
    await wrapper.vm.$nextTick();
    expect(message(wrapper).text()).toBe('输入无效');
    expect(wrapper.emitted('change')).toBeUndefined();
  });

  it('修饰键 + 修饰键的组合提示输入无效', async () => {
    const wrapper = mountItem();
    await wrapper.find('.btn').trigger('click');
    keydown('Control');
    keydown('Shift');
    await wrapper.vm.$nextTick();
    expect(message(wrapper).text()).toBe('输入无效');
    expect(wrapper.emitted('change')).toBeUndefined();
  });

  it('未按任何键直接抬起提示未输入快捷键组合', async () => {
    const wrapper = mountItem();
    await wrapper.find('.btn').trigger('click');
    keyup('Control');
    await wrapper.vm.$nextTick();
    expect(message(wrapper).text()).toBe('未输入快捷键组合');
    expect(wrapper.emitted('change')).toBeUndefined();
  });

  it('错误提示 2 秒后自动清空', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountItem();
      await wrapper.find('.btn').trigger('click');
      keydown('A');
      keydown('B');
      await wrapper.vm.$nextTick();
      expect(message(wrapper).isVisible()).toBe(true);
      vi.advanceTimersByTime(2000);
      await wrapper.vm.$nextTick();
      expect(message(wrapper).isVisible()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('卸载后移除键盘监听，不再触发 emit', async () => {
    const wrapper = mountItem();
    await wrapper.find('.btn').trigger('click');
    wrapper.unmount();
    keydown('Control');
    keydown('Q');
    expect(wrapper.emitted('change')).toBeUndefined();
  });
});
