import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { useConceptStore } from '@/stores/concept';
import { freshPinia, stock } from '../../helpers';

/** 未挂载 Vue app 时 Pinia 会排队插件，这里沿用现有 spec 的手动持久化桩 */
function stubPersist(store) {
  store.$persist = () => {};
  return store;
}

describe('concept store · 一级/二级概念维护', () => {
  let store;

  beforeEach(() => {
    freshPinia();
    store = stubPersist(useConceptStore());
  });

  it('addConcept 生成带 c 前缀的 id，字段齐全并追加到末尾', () => {
    expect(store.concepts).toEqual([]);
    const id = store.addConcept('白酒');
    expect(id).toMatch(/^c/);
    expect(store.concepts).toHaveLength(1);
    expect(store.concepts[0]).toMatchObject({
      id,
      name: '白酒',
      children: [],
    });
    expect(store.concepts[0].symbols).toBeUndefined();
  });

  it('addConcept 会 trim 名称，空名称回退为「新概念」', () => {
    store.addConcept('  银行  ');
    store.addConcept('');
    store.addConcept(null);
    expect(store.concepts.map((c) => c.name)).toEqual(['银行', '新概念', '新概念']);
  });

  it('addConcept 不做重名校验，同名概念可创建且 id 不重复（记录现状）', () => {
    const first = store.addConcept('同名');
    const second = store.addConcept('同名');
    expect(first).not.toBe(second);
    expect(store.concepts.map((c) => c.name)).toEqual(['同名', '同名']);
  });

  it('renameConcept 更新名称，空白保留原值，未知 id 无副作用', () => {
    const id = store.addConcept('白酒');
    store.renameConcept(id, '  黄酒  ');
    expect(store.concepts[0].name).toBe('黄酒');
    store.renameConcept(id, '   ');
    expect(store.concepts[0].name).toBe('黄酒');
    store.renameConcept('missing', 'X');
    expect(store.concepts).toHaveLength(1);
    expect(store.concepts[0].name).toBe('黄酒');
  });

  it('removeConcept 删除一级概念时子概念随之级联消失', () => {
    const id = store.addConcept('行业');
    const subId = store.addSubConcept(id);
    store.addConcept('保留');
    store.removeConcept(id);
    expect(store.concepts).toHaveLength(1);
    expect(store.concepts[0].name).toBe('保留');
    expect(store.findSub(id, subId)).toBeNull();
  });

  it('moveConcept 交换相邻顺序，越界与未知 id 不改变数据', () => {
    const a = store.addConcept('A');
    const b = store.addConcept('B');
    const c = store.addConcept('C');

    store.moveConcept(a, 1);
    expect(store.concepts.map((item) => item.id)).toEqual([b, a, c]);

    store.moveConcept(a, -1);
    expect(store.concepts.map((item) => item.id)).toEqual([a, b, c]);

    store.moveConcept(a, -1); // 首位再上移
    store.moveConcept(c, 1); // 末位再下移
    store.moveConcept('missing', 1);
    expect(store.concepts.map((item) => item.id)).toEqual([a, b, c]);
  });

  it('addSubConcept 生成 s 前缀子概念；只支持两级，拿子概念 id 再挂子级无效', () => {
    const parent = store.addConcept('行业');
    const subId = store.addSubConcept(parent);
    expect(subId).toMatch(/^s/);
    expect(store.findSub(parent, subId)).toEqual({
      id: subId,
      name: '新二级概念',
      symbols: [],
    });
    expect(store.addSubConcept('missing')).toBeNull();
    expect(store.addSubConcept(subId)).toBeNull();
    expect(store.findSub(parent, subId).symbols).toEqual([]);
  });

  it('moveSubConcept 在所属一级概念内交换，边界与未知父级不变', () => {
    const parent = store.addConcept('行业');
    const s1 = store.addSubConcept(parent);
    const s2 = store.addSubConcept(parent);

    store.moveSubConcept(parent, s1, 1);
    expect(store.findSub(parent, s2).id).toBe(s2);
    expect(store.findSub(parent, s1).id).toBe(s1);
    expect(store.concepts[0].children.map((s) => s.id)).toEqual([s2, s1]);

    store.moveSubConcept(parent, s1, 1); // 末位下移
    store.moveSubConcept(parent, s2, -1); // 首位上移
    store.moveSubConcept('missing', s1, 1);
    expect(store.concepts[0].children.map((s) => s.id)).toEqual([s2, s1]);
  });

  it('renameSubConcept 与 removeSubConcept 只作用于指定子概念', () => {
    const parent = store.addConcept('行业');
    const s1 = store.addSubConcept(parent);
    const s2 = store.addSubConcept(parent);

    store.renameSubConcept(parent, s1, ' 白酒 ');
    expect(store.findSub(parent, s1).name).toBe('白酒');
    store.renameSubConcept(parent, s1, '');
    expect(store.findSub(parent, s1).name).toBe('白酒');

    store.removeSubConcept(parent, s1);
    expect(store.concepts[0].children.map((s) => s.id)).toEqual([s2]);
    store.removeSubConcept('missing', s2);
    expect(store.concepts[0].children).toHaveLength(1);
  });

  it('addSymbols 按 secid 去重，只保留 secid/symbol/name 三个字段', () => {
    const parent = store.addConcept('行业');
    const subId = store.addSubConcept(parent);

    store.addSymbols(parent, subId, [
      stock('600519', '贵州茅台'),
      stock('600519', '贵州茅台'),
      stock('000858', '五粮液'),
    ]);
    expect(store.findSub(parent, subId).symbols).toEqual([
      { secid: '1.600519', symbol: '600519', name: '贵州茅台' },
      { secid: '1.000858', symbol: '000858', name: '五粮液' },
    ]);

    store.addSymbols(parent, subId, [stock('600519', '贵州茅台')]);
    expect(store.findSub(parent, subId).symbols).toHaveLength(2);
    store.addSymbols('missing', subId, [stock('600036')]);
    expect(store.findSub(parent, subId).symbols).toHaveLength(2);
  });

  it('removeSymbol 按 secid 删除，findSub 对未知父级/子级返回 null', () => {
    const parent = store.addConcept('行业');
    const subId = store.addSubConcept(parent);
    store.addSymbols(parent, subId, [stock('600519'), stock('000858')]);

    store.removeSymbol(parent, subId, '1.600519');
    expect(store.findSub(parent, subId).symbols.map((s) => s.symbol)).toEqual(['000858']);
    store.removeSymbol(parent, subId, '1.600999');

    expect(store.findSub('missing', subId)).toBeNull();
    expect(store.findSub(parent, 'missing')).toBeNull();
  });

  it('nextId 使用 Date.now(36 进制) + 自增序号，前缀区分一级/二级', () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = store.addConcept('A');
    const second = store.addConcept('B');
    const sub = store.addSubConcept(first);
    spy.mockRestore();

    const base = `c${now.toString(36)}`;
    expect(first.startsWith(base)).toBe(true);
    expect(second.startsWith(base)).toBe(true);
    expect(Number(second.slice(base.length))).toBe(Number(first.slice(base.length)) + 1);
    expect(sub.startsWith(`s${now.toString(36)}`)).toBe(true);
  });
});

describe('concept store · 持久化', () => {
  function realPinia() {
    const pinia = createPinia();
    pinia.use(piniaPluginPersistedstate);
    // 插件只有在 pinia 安装到 app 上才会真正生效
    createApp({}).use(pinia);
    setActivePinia(pinia);
    return pinia;
  }

  it('无存储时使用默认空状态', () => {
    realPinia();
    expect(useConceptStore().concepts).toEqual([]);
  });

  it('addConcept 写入 localStorage，新建 pinia 后可从存储恢复', () => {
    realPinia();
    const first = useConceptStore();
    const id = first.addConcept('白酒');

    const raw = JSON.parse(localStorage.getItem('concept'));
    expect(raw.concepts).toHaveLength(1);
    expect(raw.concepts[0]).toMatchObject({ id, name: '白酒', children: [] });

    realPinia();
    const restored = useConceptStore();
    expect(restored.concepts.map((c) => c.name)).toEqual(['白酒']);
  });

  it('旧结构缺少 children 时原样回填（源码无迁移逻辑）', () => {
    localStorage.setItem(
      'concept',
      JSON.stringify({ concepts: [{ id: 'c_old', name: '旧概念' }] }),
    );
    realPinia();
    const store = useConceptStore();
    expect(store.concepts).toHaveLength(1);
    expect(store.concepts[0].name).toBe('旧概念');
    expect(store.concepts[0].children).toBeUndefined();
  });
});
