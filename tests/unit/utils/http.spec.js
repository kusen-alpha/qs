import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, requestBytes } from '@/utils/http';

const mocks = vi.hoisted(() => ({
  tauriFetch: vi.fn(),
}));

// @tauri-apps/plugin-http 在测试配置里指向同一份 mock 文件，这里只提供 fetch
vi.mock('../../mocks/tauri-api.js', () => ({ fetch: mocks.tauriFetch }));

function textResponse(text, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function byteResponse(bytes, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => '',
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

describe('http · 浏览器 fetch 分支', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => textResponse(JSON.stringify({ a: 1 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__TAURI_INTERNALS__;
  });

  it('默认 GET，返回 ok/status 并自动解析 JSON', async () => {
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ code: 0, data: [1] })));

    const res = await request('https://example.com/api');
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', {
      method: 'GET',
      headers: undefined,
    });
    expect(res).toEqual({ ok: true, status: 200, data: { code: 0, data: [1] } });
  });

  it('POST 与自定义 headers 原样透传（源码不透传 body）', async () => {
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ ok: true })));

    await request('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"x":1}',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('非 JSON 响应保留原始文本', async () => {
    fetchMock.mockResolvedValue(textResponse('<html>blocked</html>'));

    const res = await request('https://example.com/page');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toBe('<html>blocked</html>');
  });

  it('空响应体解析失败时返回空字符串', async () => {
    fetchMock.mockResolvedValue(textResponse(''));

    const res = await request('https://example.com/empty');
    expect(res.data).toBe('');
  });

  it('非 2xx 响应仍返回状态与已解析数据', async () => {
    fetchMock.mockResolvedValue(
      textResponse(JSON.stringify({ error: 'not found' }), { ok: false, status: 404 }),
    );

    const res = await request('https://example.com/missing');
    expect(res).toEqual({ ok: false, status: 404, data: { error: 'not found' } });
  });

  it('fetch 抛错直接冒泡（源码无超时/重试）', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(request('https://example.com/api')).rejects.toThrow('offline');
  });

  it('requestBytes 返回 Uint8Array 字节', async () => {
    fetchMock.mockResolvedValue(byteResponse([1, 2, 3]));

    const res = await requestBytes('https://example.com/bytes');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(res.data)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/bytes', {
      method: 'GET',
      headers: undefined,
    });
  });

  it('requestBytes 非 2xx 也返回字节与失败状态', async () => {
    fetchMock.mockResolvedValue(byteResponse([9], { ok: false, status: 500 }));

    const res = await requestBytes('https://example.com/bytes');
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(Array.from(res.data)).toEqual([9]);
  });
});

describe('http · Tauri 插件分支', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    mocks.tauriFetch.mockResolvedValue(textResponse(JSON.stringify({ tauri: true })));
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it('Tauri 下走 plugin-http 而非全局 fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await request('https://example.com/api', {
      method: 'POST',
      headers: { 'X-Test': '1' },
    });
    vi.unstubAllGlobals();

    expect(mocks.tauriFetch).toHaveBeenCalledWith('https://example.com/api', {
      method: 'POST',
      headers: { 'X-Test': '1' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, status: 200, data: { tauri: true } });
  });

  it('Tauri 下 requestBytes 使用插件响应解出字节', async () => {
    mocks.tauriFetch.mockResolvedValue(byteResponse([7, 8]));

    const res = await requestBytes('https://example.com/bytes', { method: 'GET' });
    expect(mocks.tauriFetch).toHaveBeenCalledTimes(1);
    expect(res.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(res.data)).toEqual([7, 8]);
  });
});
