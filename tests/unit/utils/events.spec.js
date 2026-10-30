import { describe, expect, it, vi } from 'vitest';
import { emit, on } from '@/utils/events';

describe('events · 浏览器事件总线', () => {
  it('emit 触发 on 注册的处理函数并透传 payload', async () => {
    const handler = vi.fn();
    await on('test:event', handler);
    await emit('test:event', { a: 1 });
    expect(handler).toHaveBeenCalledWith({ a: 1 });
  });

  it('返回的取消函数能注销监听', async () => {
    const handler = vi.fn();
    const off = await on('test:off', handler);
    off();
    await emit('test:off', 1);
    expect(handler).not.toHaveBeenCalled();
  });
});
