import mitt from 'mitt';
import { listen } from '@tauri-apps/api/event';
import { emit as tauriEmit } from '@tauri-apps/api/event';
import { isTauri } from './env';

/** 兼容层的事件总线：Tauri 用原生事件，浏览器用 mitt */
const bus = mitt();

export async function emit(event, payload) {
  if (isTauri()) return tauriEmit(event, payload).catch(() => {});
  bus.emit(event, payload);
}

export async function on(event, handler) {
  if (isTauri()) {
    return listen(event, (e) => handler(e));
  }
  bus.on(event, handler);
  return Promise.resolve(() => bus.off(event, handler));
}
