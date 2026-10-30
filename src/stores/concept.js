import { defineStore } from 'pinia';

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

/** 概念：最多两级，一级下挂二级，二级下挂自选股票 */
export const useConceptStore = defineStore('concept', {
  state: () => ({
    concepts: [],
  }),
  actions: {
    persist() {
      this.$persist();
    },
    addConcept(name) {
      const item = { id: nextId('c'), name: (name || '').trim() || '新概念', children: [] };
      this.concepts.push(item);
      this.persist();
      return item.id;
    },
    renameConcept(conceptId, name) {
      const item = this.concepts.find((c) => c.id === conceptId);
      if (!item) return;
      item.name = (name || '').trim() || item.name;
      this.persist();
    },
    removeConcept(conceptId) {
      this.concepts = this.concepts.filter((c) => c.id !== conceptId);
      this.persist();
    },
    moveConcept(conceptId, offset) {
      const idx = this.concepts.findIndex((c) => c.id === conceptId);
      const target = idx + offset;
      if (idx < 0 || target < 0 || target >= this.concepts.length) return;
      const list = this.concepts;
      [list[idx], list[target]] = [list[target], list[idx]];
      this.persist();
    },
    addSubConcept(conceptId) {
      const item = this.concepts.find((c) => c.id === conceptId);
      if (!item) return null;
      const sub = { id: nextId('s'), name: '新二级概念', symbols: [] };
      item.children.push(sub);
      this.persist();
      return sub.id;
    },
    renameSubConcept(conceptId, subId, name) {
      const sub = this.findSub(conceptId, subId);
      if (!sub) return;
      sub.name = (name || '').trim() || sub.name;
      this.persist();
    },
    removeSubConcept(conceptId, subId) {
      const item = this.concepts.find((c) => c.id === conceptId);
      if (!item) return;
      item.children = item.children.filter((s) => s.id !== subId);
      this.persist();
    },
    moveSubConcept(conceptId, subId, offset) {
      const item = this.concepts.find((c) => c.id === conceptId);
      if (!item) return;
      const idx = item.children.findIndex((s) => s.id === subId);
      const target = idx + offset;
      if (idx < 0 || target < 0 || target >= item.children.length) return;
      const list = item.children;
      [list[idx], list[target]] = [list[target], list[idx]];
      this.persist();
    },
    addSymbols(conceptId, subId, symbols) {
      const sub = this.findSub(conceptId, subId);
      if (!sub) return;
      for (const item of symbols) {
        if (!sub.symbols.find((s) => s.secid === item.secid)) {
          sub.symbols.push({ secid: item.secid, symbol: item.symbol, name: item.name });
        }
      }
      this.persist();
    },
    removeSymbol(conceptId, subId, secid) {
      const sub = this.findSub(conceptId, subId);
      if (!sub) return;
      sub.symbols = sub.symbols.filter((s) => s.secid !== secid);
      this.persist();
    },
    findSub(conceptId, subId) {
      const item = this.concepts.find((c) => c.id === conceptId);
      if (!item) return null;
      return item.children.find((s) => s.id === subId) || null;
    },
  },
  persist: {
    storage: localStorage,
  },
});
