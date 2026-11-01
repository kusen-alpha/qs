import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import SettingMain from '@/components/setting/SettingMain.vue';
import { useCacheStore } from '@/stores/cache';
import { freshPinia } from '../../helpers';

const stubs = {
  GeneralSetting: { name: 'GeneralSetting', template: '<div class="general-setting-stub" />' },
  ViewSetting: { name: 'ViewSetting', template: '<div class="view-setting-stub" />' },
  ShortcutSetting: { name: 'ShortcutSetting', template: '<div class="shortcut-setting-stub" />' },
};

function mountMain(curSetting) {
  freshPinia();
  const cache = useCacheStore();
  cache.curSetting = curSetting;
  const wrapper = mount(SettingMain, {
    global: { plugins: [ElementPlus], stubs },
  });
  return { wrapper, cache };
}

describe('SettingMain · 右侧设置内容', () => {
  it('通用设置渲染 GeneralSetting', () => {
    const { wrapper } = mountMain('通用设置');
    expect(wrapper.find('.general-setting-stub').exists()).toBe(true);
    expect(wrapper.find('.view-setting-stub').exists()).toBe(false);
    expect(wrapper.find('.shortcut-setting-stub').exists()).toBe(false);
  });

  it('显示设置渲染 ViewSetting', () => {
    const { wrapper } = mountMain('显示设置');
    expect(wrapper.find('.view-setting-stub').exists()).toBe(true);
    expect(wrapper.find('.general-setting-stub').exists()).toBe(false);
    expect(wrapper.find('.shortcut-setting-stub').exists()).toBe(false);
  });

  it('快捷键渲染 ShortcutSetting', () => {
    const { wrapper } = mountMain('快捷键');
    expect(wrapper.find('.shortcut-setting-stub').exists()).toBe(true);
    expect(wrapper.find('.general-setting-stub').exists()).toBe(false);
    expect(wrapper.find('.view-setting-stub').exists()).toBe(false);
  });

  it('未知设置项时主区域为空', () => {
    const { wrapper } = mountMain('不存在');
    expect(wrapper.find('.general-setting-stub').exists()).toBe(false);
    expect(wrapper.find('.view-setting-stub').exists()).toBe(false);
    expect(wrapper.find('.shortcut-setting-stub').exists()).toBe(false);
  });

  it('缓存中的设置项变化后重新渲染对应内容', async () => {
    const { wrapper, cache } = mountMain('通用设置');
    cache.curSetting = '快捷键';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.shortcut-setting-stub').exists()).toBe(true);
    expect(wrapper.find('.general-setting-stub').exists()).toBe(false);
  });
});
