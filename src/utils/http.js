import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauri } from './env';

/**
 * 与原始产物一致的请求封装：
 * Tauri 下走 @tauri-apps/plugin-http（不受 CORS 限制）；浏览器下退回 fetch。
 * 统一返回 { ok, status, data }，其中 data 已尽量解析为 JSON。
 */
export async function request(url, options = {}) {
  let res;
  if (isTauri()) {
    res = await tauriFetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
    });
  } else {
    res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
    });
  }
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (e) {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, data };
}

/** 以字节形式请求，便于 GBK 等非 UTF-8 页面自行解码 */
export async function requestBytes(url, options = {}) {
  let res;
  if (isTauri()) {
    res = await tauriFetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
    });
  } else {
    res = await fetch(url, { method: options.method || 'GET', headers: options.headers });
  }
  return { ok: res.ok, status: res.status, data: new Uint8Array(await res.arrayBuffer()) };
}
