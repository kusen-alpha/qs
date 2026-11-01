import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import ShortcutSetting from '@/components/setting/ShortcutSetting.vue';
import KeyBindItem from '@/components/setting/KeyBindItem.vue';
import { useCacheStore } from '@/stores/cache';
import { freshPinia } from '../../helpers';

vi.mock('@/utils/shortcut', () => ({ matchShortcut: vi.fn(() => true) }));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: vi.fn(),
  unregister: vi.fn(),
  unregisterAll: vi.fn(),
}));

function mountShortcut() {
  freshPinia();
  const cache = useCacheStore();
  const wrapper = mount(ShortcutSetting, { global: { plugins: [ElementPlus] } });
  return { wrapper, cache };
}

function pressKeys(wrapper, keys) {
  return wrapper
    .findComponent(KeyBindItem)
    .vm.$emit('change', keys);
}

describe('ShortcutSetting · 快捷键设置', () => {
  it('渲染老板键项及当前快捷键', () => {
    const { wrapper, cache } = mountShortcut();
    const item = wrapper.findComponent(KeyBindItem);
    expect(item.props()).toMatchObject({
      title: '老板键',
      desc: '显示/隐藏面板',
      shotcut: ['Ctrl', 'Q'],
    });
    expect(item.find('.btn').text()).toBe('Ctrl + Q');
    expect(cache.shortcutBoss).toEqual(['Ctrl', 'Q']);
  });

  it('显示组合键开头的说明文案', () => {
    const { wrapper } = mountShortcut();
    expect(wrapper.find('.remark-text').text()).toContain('Ctrl');
    expect(wrapper.find('.remark-text').text()).toContain('Alt');
    expect(wrapper.find('.remark-text').text()).toContain('Shift');
  });

  it('Control 归一化为 Ctrl，小写字母转大写', async () => {
    const { wrapper, cache } = mountShortcut();
    pressKeys(wrapper, ['Control', 'q']);
    await wrapper.vm.$nextTick();
    expect(cache.shortcutBoss).toEqual(['Ctrl', 'Q']);
  });

  it('Shift / Alt 开头保持不变，字母规范为大写', async () => {
    const { wrapper, cache } = mountShortcut();
    pressKeys(wrapper, ['Shift', 'a']);
    await wrapper.vm.$nextTick();
    expect(cache.shortcutBoss).toEqual(['Shift', 'A']);
    pressKeys(wrapper, ['Alt', 'b']);
    await wrapper.vm.$nextTick();
    expect(cache.shortcutBoss).toEqual(['Alt', 'B']);
  });

  it('功能键等非字母按键原样保留', async () => {
    const { wrapper, cache } = mountShortcut();
    pressKeys(wrapper, ['Control', 'F1']);
    await wrapper.vm.$nextTick();
    expect(cache.shortcutBoss).toEqual(['Ctrl', 'F1']);
  });

  it('缓存变化后子组件展示新快捷键', async () => {
    const { wrapper, cache } = mountShortcut();
    cache.shortcutBoss = ['Alt', 'X'];
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(KeyBindItem).props('shotcut')).toEqual(['Alt', 'X']);
    expect(wrapper.findComponent(KeyBindItem).find('.btn').text()).toBe('Alt + X');
  });
});
