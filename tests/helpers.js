import { createPinia, setActivePinia } from 'pinia';

/** 每个用例一个全新的 pinia，避免状态互相污染 */
export function freshPinia() {
  const pinia = createPinia();
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
