import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import CheckButton from '@/components/monitor/CheckButton.vue';

const { openWindowMock } = vi.hoisted(() => ({ openWindowMock: vi.fn() }));

vi.mock('@/utils/windows', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openWindow: openWindowMock };
});

describe('CheckButton · 数据校验入口', () => {
  it('点击后打开独立的校验子窗口', async () => {
    const wrapper = mount(CheckButton, { global: { plugins: [ElementPlus] } });

    expect(wrapper.find('.check-trigger').attributes('title')).toBe('数据校验');

    await wrapper.find('.check-trigger').trigger('click');

    expect(openWindowMock).toHaveBeenCalledTimes(1);
    expect(openWindowMock.mock.calls[0][0]).toMatchObject({
      label: 'check',
      window: { title: '数据校验', url: '/#/check' },
    });
  });
});
