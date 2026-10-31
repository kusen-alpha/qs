/**
 * 运行环境判定：Tauri 1 会注入 __TAURI_IPC__。
 * 浏览器下走 localStorage 兼容层，便于纯前端调试与截图比对。
 */
export function isTauri() {
  return (
    typeof window !== 'undefined' &&
    (!!window.__TAURI_INTERNALS__ || !!window.__TAURI_IPC__ || !!window.__TAURI__)
  );
}

export const inTauri = isTauri();
