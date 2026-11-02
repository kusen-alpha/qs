import { getDbSetupState } from './db';
import { isTauri } from './env';

let cached = null;

/**
 * 数据库初始化状态缓存。
 * 首次判断、路由守卫、启动初始化共用一次查询，避免重复 invoke。
 */
export function readSetupState(force = false) {
  if (!isTauri()) {
    return Promise.resolve({ configured: true, saved: true, error: null });
  }
  if (!cached || force) {
    cached = getDbSetupState();
  }
  return cached;
}

/** 配置成功后标记为已就绪，后续路由直接放行 */
export function markConfigured() {
  cached = Promise.resolve({ configured: true, saved: true, error: null });
}
