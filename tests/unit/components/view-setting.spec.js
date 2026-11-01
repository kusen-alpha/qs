import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import ViewSetting from '@/components/setting/ViewSetting.vue';
import SettingItem from '@/components/setting/SettingItem.vue';
import { useCacheStore } from '@/stores/cache';
import { freshPinia } from '../../helpers';

function mountView() {
  freshPinia();
  const cache = useCacheStore();
  const wrapper = mount(ViewSetting, { global: { plugins: [ElementPlus] } });
  return { wrapper, cache };
}

describe('ViewSetting · 显示设置', () => {
  it('渲染五个设置项标题', () => {
    const { wrapper } = mountView();
    expect(wrapper.findAllComponents(SettingItem).map((w) => w.props('title'))).toEqual([
      '面板字体大小',
      '固定宽度',
      '涨跌颜色',
      '界面透明度',
      '界面灰度',
    ]);
  });

  it('按缓存默认值初始化各控件', () => {
    const { wrapper, cache } = mountView();
    const radios = wrapper.findAllComponents({ name: 'ElRadioGroup' });
    expect(radios[0].props('modelValue')).toBe('small');
    expect(radios[1].props('modelValue')).toBe('redUpGreenDown');
    expect(wrapper.findComponent({ name: 'ElSwitch' }).props('modelValue')).toBe(true);
    const number = wrapper.findComponent({ name: 'ElInputNumber' });
    expect(number.props()).toMatchObject({ modelValue: 380, min: 300, max: 800, step: 20 });
    const sliders = wrapper.findAllComponents({ name: 'ElSlider' });
    expect(sliders[0].props('modelValue')).toBe(0);
    expect(sliders[1].props('modelValue')).toBe(0);
    expect(cache.fixedWidth).toBe(380);
  });

  it('切换字体大小写入缓存', async () => {
    const { wrapper, cache } = mountView();
    const radios = wrapper.findAllComponents({ name: 'ElRadioGroup' });
    radios[0].vm.$emit('update:modelValue', 'large');
    await wrapper.vm.$nextTick();
    expect(cache.tableSize).toBe('large');
  });

  it('切换固定宽度开关写入缓存', async () => {
    const { wrapper, cache } = mountView();
    wrapper.findComponent({ name: 'ElSwitch' }).vm.$emit('update:modelValue', false);
    await wrapper.vm.$nextTick();
    expect(cache.isFixWidth).toBe(false);
  });

  it('修改固定宽度数值写入缓存', async () => {
    const { wrapper, cache } = mountView();
    wrapper.findComponent({ name: 'ElInputNumber' }).vm.$emit('update:modelValue', 420);
    await wrapper.vm.$nextTick();
    expect(cache.fixedWidth).toBe(420);
  });

  it('切换涨跌颜色写入缓存', async () => {
    const { wrapper, cache } = mountView();
    const radios = wrapper.findAllComponents({ name: 'ElRadioGroup' });
    radios[1].vm.$emit('update:modelValue', 'redDownGreenUp');
    await wrapper.vm.$nextTick();
    expect(cache.updownColor).toBe('redDownGreenUp');
  });

  it('拖动透明度与灰度滑杆写入缓存', async () => {
    const { wrapper, cache } = mountView();
    const sliders = wrapper.findAllComponents({ name: 'ElSlider' });
    sliders[0].vm.$emit('update:modelValue', 20);
    sliders[1].vm.$emit('update:modelValue', 30);
    await wrapper.vm.$nextTick();
    expect(cache.viewOpacity).toBe(20);
    expect(cache.viewGray).toBe(30);
  });
});
