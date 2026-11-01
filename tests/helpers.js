import { createPinia, setActivePinia } from 'pinia';

/**
 * 测试用持久化插件替身：只提供 $persist / $hydrate 两个方法，不读写存储。
 * 真实持久化由 pinia-plugin-persistedstate 负责，与本套件关注的业务逻辑无关。
 */
const persistShim = ({ store }) => {
  store.$persist = () => {};
  store.$hydrate = () => {};
};

/** 每个用例一个全新的 pinia，避免状态互相污染 */
export function freshPinia() {
  const pinia = createPinia();
  pinia.use(persistShim);
  setActivePinia(pinia);
  return pinia;
}

/** 造一只股票 */
export function stock(symbol, name = '股票' + symbol, secid = '1.' + symbol) {
  return { symbol, name, secid, source: '1' };
}

/** 造一个一级概念 */
export function concept(id, name, symbols = [], children = []) {
  return {
    id,
    id_str: String(id),
    name,
    symbols,
    children,
  };
}
