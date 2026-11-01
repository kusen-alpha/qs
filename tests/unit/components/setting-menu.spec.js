import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import SettingMenu from '@/components/setting/SettingMenu.vue';
import { useCacheStore } from '@/stores/cache';
import { freshPinia } from '../../helpers';

function mountMenu() {
  freshPinia();
  const cache = useCacheStore();
  const wrapper = mount(SettingMenu, { global: { plugins: [ElementPlus] } });
  return { wrapper, cache };
}

describe('SettingMenu · 左侧设置菜单', () => {
  it('按顺序渲染通用设置 / 显示设置 / 快捷键三项', () => {
    const { wrapper } = mountMenu();
    expect(wrapper.findAll('.el-menu-item').map((w) => w.text())).toEqual([
      '通用设置',
      '显示设置',
      '快捷键',
    ]);
  });

  it('默认激活通用设置（index=0）', () => {
    const { wrapper } = mountMenu();
    const items = wrapper.findAll('.el-menu-item');
    expect(items[0].classes()).toContain('is-active');
    expect(items[1].classes()).not.toContain('is-active');
    expect(items[2].classes()).not.toContain('is-active');
  });

  it('点击显示设置写入缓存并切换激活项', async () => {
    const { wrapper, cache } = mountMenu();
    expect(cache.curSetting).toBe('通用设置');
    await wrapper.findAll('.el-menu-item')[1].trigger('click');
    expect(cache.curSetting).toBe('显示设置');
    expect(wrapper.findAll('.el-menu-item')[1].classes()).toContain('is-active');
  });

  it('点击快捷键写入缓存', async () => {
    const { wrapper, cache } = mountMenu();
    await wrapper.findAll('.el-menu-item')[2].trigger('click');
    expect(cache.curSetting).toBe('快捷键');
  });

  it('未知 index 不改变当前设置项', async () => {
    const { wrapper, cache } = mountMenu();
    wrapper.findComponent({ name: 'ElMenu' }).vm.$emit('select', '99', ['99'], {});
    await nextTick();
    expect(cache.curSetting).toBe('通用设置');
  });

  it('底部占位高度按菜单项数量计算', () => {
    const { wrapper } = mountMenu();
    const spacer = wrapper.find('.top-menu + div');
    expect(spacer.attributes('style')).toContain('height: 303px');
  });
});
