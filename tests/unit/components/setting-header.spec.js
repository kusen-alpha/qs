import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import SettingHeader from '@/components/setting/SettingHeader.vue';
import { useCacheStore } from '@/stores/cache';
import { freshPinia } from '../../helpers';

function mountHeader(curSetting) {
  freshPinia();
  const cache = useCacheStore();
  if (curSetting) cache.curSetting = curSetting;
  const wrapper = mount(SettingHeader, { global: { plugins: [ElementPlus] } });
  return { wrapper, cache };
}

describe('SettingHeader · 设置窗口标题', () => {
  it('默认显示通用设置', () => {
    const { wrapper } = mountHeader();
    expect(wrapper.find('.title-text').text()).toBe('通用设置');
  });

  it('显示显示设置', () => {
    const { wrapper } = mountHeader('显示设置');
    expect(wrapper.find('.title-text').text()).toBe('显示设置');
  });

  it('显示快捷键', () => {
    const { wrapper } = mountHeader('快捷键');
    expect(wrapper.find('.title-text').text()).toBe('快捷键');
  });

  it('缓存切换后标题同步更新', async () => {
    const { wrapper, cache } = mountHeader('通用设置');
    cache.curSetting = '快捷键';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.title-text').text()).toBe('快捷键');
  });

  it('标题带窗口拖动区域标记', () => {
    const { wrapper } = mountHeader();
    expect(wrapper.find('.title').attributes('data-tauri-drag-region')).toBeDefined();
  });
});
