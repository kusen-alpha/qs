import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import GeneralSetting from '@/components/setting/GeneralSetting.vue';
import SettingItem from '@/components/setting/SettingItem.vue';
import { useCacheStore } from '@/stores/cache';
import { freshPinia } from '../../helpers';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function mountGeneral() {
  freshPinia();
  const cache = useCacheStore();
  const wrapper = mount(GeneralSetting, { global: { plugins: [ElementPlus] } });
  return { wrapper, cache };
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('GeneralSetting · 通用设置', () => {
  it('渲染三个设置项，未拿到版本信息时不显示版本', () => {
    const { wrapper } = mountGeneral();
    expect(wrapper.findAllComponents(SettingItem).map((w) => w.props('title'))).toEqual([
      '自定义监控列',
      '边缘折叠',
      '开机自启动',
    ]);
    expect(wrapper.find('.version-text').exists()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('监控列按钮数量与默认勾选字段一致', () => {
    const { wrapper, cache } = mountGeneral();
    const buttons = wrapper.findAll('.monitor-checkbox');
    expect(buttons).toHaveLength(15);
    const checked = wrapper
      .findAll('.monitor-checkbox')
      .filter((b) => b.classes().includes('is-checked'))
      .map((b) => b.text());
    const expected = [];
    for (const key in cache.watchFields) {
      if (cache.watchFields[key]) expected.push(key);
    }
    expect(expected).toEqual(['price', 'range', 'price_diff', 'turn', 'macd']);
    expect(checked).toHaveLength(5);
    expect(checked.join('')).toContain('当前价');
  });

  it('勾选监控列写回缓存，未勾选字段全部关闭', async () => {
    const { wrapper, cache } = mountGeneral();
    const groups = wrapper.findAllComponents({ name: 'ElCheckboxGroup' });
    groups[0].vm.$emit('update:modelValue', ['price', 'macd', 'position_num']);
    await wrapper.vm.$nextTick();
    expect(cache.watchFields.price).toBe(true);
    expect(cache.watchFields.macd).toBe(true);
    expect(cache.watchFields.position_num).toBe(true);
    expect(cache.watchFields.range).toBe(false);
    expect(cache.watchFields.turn).toBe(false);
  });

  it('边缘折叠开关写入缓存', async () => {
    const { wrapper, cache } = mountGeneral();
    expect(cache.isEdgeFold).toBe(true);
    const switches = wrapper.findAllComponents({ name: 'ElSwitch' });
    switches[0].vm.$emit('update:modelValue', false);
    await wrapper.vm.$nextTick();
    expect(cache.isEdgeFold).toBe(false);
  });

  it('开机自启动开关写入缓存', async () => {
    const { wrapper, cache } = mountGeneral();
    expect(cache.isOpenWithSystem).toBe(false);
    const switches = wrapper.findAllComponents({ name: 'ElSwitch' });
    switches[1].vm.$emit('update:modelValue', true);
    await wrapper.vm.$nextTick();
    expect(cache.isOpenWithSystem).toBe(true);
  });

  it('Tauri 环境读取版本信息并展示', async () => {
    window.__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue({ version: '1.2.3', buildDate: '2024-01-01' });
    const { wrapper } = mountGeneral();
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith('app_info');
    expect(wrapper.findAllComponents(SettingItem).map((w) => w.props('title'))).toContain('版本');
    expect(wrapper.find('.version-text').text()).toBe('v1.2.3（2024-01-01 构建）');
  });
});
