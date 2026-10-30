import { fetch as tauriFetch, ResponseType } from '@tauri-apps/api/http';
import { isTauri } from './env';

/**
 * 与原产物一致的请求封装：
 * Tauri 下走 @tauri-apps/api/http（不受 CORS 限制）；浏览器下退回 fetch。
 * 统一返回 { ok, status, data }，其中 data 已解析为 JSON。
 * 注意：ResponseType.JSON = 1、Text = 2，默认必须用 JSON，否则拿到的是原始字符串。
 */
export async function request(url, options = {}) {
  if (isTauri()) {
    return tauriFetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      query: options.query,
      body: options.body,
      responseType: options.responseType || ResponseType.JSON,
    });
  }
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.headers,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (e) {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, data };
}
