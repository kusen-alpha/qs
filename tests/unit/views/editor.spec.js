import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Editor from '@/views/Editor.vue';
import WindowMaxButton from '@/components/WindowMaxButton.vue';

const { closeWindow, WindowConfigs, applyDragRegion } = vi.hoisted(() => ({
  closeWindow: vi.fn(),
  applyDragRegion: vi.fn(),
  WindowConfigs: { search: { label: 'search' } },
}));

vi.mock('@/utils/windows', () => ({ closeWindow, WindowConfigs }));
vi.mock('@/utils/layout', () => ({ applyDragRegion }));

const stubs = {
  Search: { name: 'Search', template: '<div class="search-stub" />' },
};

function mountEditor() {
  return mount(Editor, { global: { plugins: [ElementPlus], stubs } });
}

describe('Editor 页面 · 编辑列表窗口', () => {
  it('渲染搜索表单、最大化和关闭按钮', () => {
    const wrapper = mountEditor();
    expect(wrapper.find('.search-stub').exists()).toBe(true);
    expect(wrapper.findComponent(WindowMaxButton).exists()).toBe(true);
    expect(wrapper.find('#titlebar-close').exists()).toBe(true);
  });

  it('最大化按钮接收窗口尺寸与定位参数', () => {
    const wrapper = mountEditor();
    expect(wrapper.findComponent(WindowMaxButton).props()).toMatchObject({
      size: 30,
      right: 36,
      background: '#f2f2f2',
    });
  });

  it('点击关闭按钮关闭编辑列表子窗口', async () => {
    const wrapper = mountEditor();
    await wrapper.find('#titlebar-close').trigger('click');
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(closeWindow).toHaveBeenCalledWith(WindowConfigs.search);
  });

  it('挂载时给卡片区域加拖动标记', () => {
    mountEditor();
    expect(applyDragRegion).toHaveBeenCalledWith(['el-card__body', 'el-card']);
  });

  it('关闭按钮带图标且使用标题栏关闭 id', () => {
    const wrapper = mountEditor();
    expect(wrapper.find('#titlebar-close').find('.el-icon').exists()).toBe(true);
  });
});
