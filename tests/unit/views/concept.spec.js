import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Concept from '@/views/Concept.vue';

const { closeWindow, WindowConfigs, applyDragRegion } = vi.hoisted(() => ({
  closeWindow: vi.fn(),
  applyDragRegion: vi.fn(),
  WindowConfigs: {
    search: { label: 'search' },
    concept: { label: 'concept' },
  },
}));

vi.mock('@/utils/windows', () => ({ closeWindow, WindowConfigs }));
vi.mock('@/utils/layout', () => ({ applyDragRegion }));

const stubs = {
  ConceptManager: { name: 'ConceptManager', template: '<div class="concept-manager-stub" />' },
};

function mountConcept() {
  return mount(Concept, { global: { plugins: [ElementPlus], stubs } });
}

describe('Concept 页面 · 概念管理窗口', () => {
  it('渲染概念管理组件与关闭按钮', () => {
    const wrapper = mountConcept();
    expect(wrapper.find('.concept-manager-stub').exists()).toBe(true);
    expect(wrapper.find('.concept-close').exists()).toBe(true);
  });

  it('点击关闭按钮关闭概念管理子窗口', async () => {
    const wrapper = mountConcept();
    await wrapper.find('.concept-close').trigger('click');
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(closeWindow).toHaveBeenCalledWith(WindowConfigs.concept);
  });

  it('挂载时给卡片与头部加拖动标记', () => {
    mountConcept();
    expect(applyDragRegion).toHaveBeenCalledWith([
      'el-card__body',
      'el-card',
      'concept-header',
      'header-row',
    ]);
  });

  it('关闭按钮内包含图标', () => {
    const wrapper = mountConcept();
    expect(wrapper.find('.concept-close').find('.el-icon').exists()).toBe(true);
  });

  it('页面使用概念卡片布局而非通用背景卡片', () => {
    const wrapper = mountConcept();
    expect(wrapper.find('.concept-card').exists()).toBe(true);
    expect(wrapper.find('.concept-layout').exists()).toBe(true);
  });
});
