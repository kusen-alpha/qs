import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import WindowMaxButton from '@/components/WindowMaxButton.vue';

const { win } = vi.hoisted(() => ({
  win: {
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

beforeEach(() => {
  win.maximize.mockReset();
  win.unmaximize.mockReset();
  win.isMaximized.mockReset();
  win.isMaximized.mockResolvedValue(false);
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('WindowMaxButton · 窗口最大化按钮', () => {
  it('浏览器环境显示最大化提示且点击不调用窗口 API', async () => {
    const wrapper = mount(WindowMaxButton, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(wrapper.find('.window-max-button').attributes('title')).toBe('最大化');
    await wrapper.find('.window-max-button').trigger('click');
    await flushPromises();
    expect(win.maximize).not.toHaveBeenCalled();
    expect(win.isMaximized).not.toHaveBeenCalled();
  });

  it('Tauri 环境下根据窗口状态显示还原提示', async () => {
    window.__TAURI_INTERNALS__ = {};
    win.isMaximized.mockResolvedValue(true);
    const wrapper = mount(WindowMaxButton, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(win.isMaximized).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.window-max-button').attributes('title')).toBe('还原');
  });

  it('未最大化时点击按钮调用 maximize 并切换为还原', async () => {
    window.__TAURI_INTERNALS__ = {};
    const wrapper = mount(WindowMaxButton, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(wrapper.find('.window-max-button').attributes('title')).toBe('最大化');
    await wrapper.find('.window-max-button').trigger('click');
    await flushPromises();
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.unmaximize).not.toHaveBeenCalled();
    expect(wrapper.find('.window-max-button').attributes('title')).toBe('还原');
  });

  it('已最大化时点击按钮调用 unmaximize 并切换为最大化', async () => {
    window.__TAURI_INTERNALS__ = {};
    win.isMaximized.mockResolvedValue(true);
    const wrapper = mount(WindowMaxButton, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.find('.window-max-button').trigger('click');
    await flushPromises();
    expect(win.unmaximize).toHaveBeenCalledTimes(1);
    expect(win.maximize).not.toHaveBeenCalled();
    expect(wrapper.find('.window-max-button').attributes('title')).toBe('最大化');
  });

  it('默认样式为绝对定位、28px 尺寸、距右 34px', () => {
    const wrapper = mount(WindowMaxButton, { global: { plugins: [ElementPlus] } });
    const style = wrapper.find('.window-max-button').attributes('style');
    expect(style).toContain('position: absolute');
    expect(style).toContain('top: 3px');
    expect(style).toContain('right: 34px');
    expect(style).toContain('width: 28px');
    expect(style).toContain('height: 28px');
    expect(style).toContain('--max-btn-bg: #fff');
  });

  it('自定义尺寸、位置和背景色写入按钮样式', () => {
    const wrapper = mount(WindowMaxButton, {
      props: { size: 30, right: 36, top: 10, background: '#f2f2f2', position: 'static' },
      global: { plugins: [ElementPlus] },
    });
    const style = wrapper.find('.window-max-button').attributes('style');
    expect(style).toContain('position: static');
    expect(style).toContain('top: 10px');
    expect(style).toContain('right: 36px');
    expect(style).toContain('width: 30px');
    expect(style).toContain('height: 30px');
    expect(style).toContain('--max-btn-bg: #f2f2f2');
  });
});
