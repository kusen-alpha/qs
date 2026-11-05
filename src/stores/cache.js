import { defineStore } from 'pinia';
import { isEqual } from 'lodash-es';
import { UpdownColor, defaultWatchFields } from '../constants';

/** 同一提醒的静默窗口：20 分钟内不重复提醒 */
const ALERT_WINDOW_MS = 1200000;

/** 主窗口运行时状态（设置草稿、提醒去重队列、盈亏汇总） */
export const useCacheStore = defineStore('cache', {
  state: () => ({
    curSetting: '通用设置',
    group: [],
    selectGroup: 0,
    tableSize: 'small',
    updownColor: UpdownColor.redUpGreenDown,
    viewOpacity: 0,
    viewGray: 0,
    isFixWidth: true,
    fixedWidth: 380,
    watchFields: { ...defaultWatchFields },
    isEdgeFold: true,
    isOpenWithSystem: false,
    shortcutBoss: ['Ctrl', 'Q'],
    alertQueue: [],
    totoal_profit: 0,
    totoal_profit_rate: 0,
    today_profit: 0,
    today_profit_rate: 0,
  }),
  actions: {
    /** 扁平化所有概念（一级 + 二级） */
    allConcepts() {
      const list = [];
      for (const group of this.group) {
        list.push(group);
        for (const child of group.children || []) list.push(child);
      }
      return list;
    },
    findConceptById(id) {
      return this.allConcepts().find((group) => group.id == id) || null;
    },
    findConceptByName(name) {
      return this.allConcepts().find((group) => group.name === name) || null;
    },
    /** 二级概念所属的一级概念；一级概念或未知 id 返回 null */
    parentConceptOf(id) {
      return (
        this.group.find((group) => (group.children || []).some((child) => child.id == id)) ||
        null
      );
    },
    nextConceptId() {
      let maxId = 0;
      for (const group of this.allConcepts()) {
        if (group.id > maxId) maxId = group.id;
      }
      return maxId + 1;
    },
    /** 新增一级概念 */
    addConcept(name) {
      if (this.findConceptByName(name)) return false;
      const id = this.nextConceptId();
      this.group.push({
        name,
        id,
        id_str: String(id),
        symbols: [],
        children: [],
      });
      return true;
    },
    /** 在指定一级概念下新增二级概念（自选 id=0 不是概念，不挂二级） */
    addSubConcept(parentId, name) {
      const parent = this.group.find((group) => group.id == parentId);
      if (!parent || parent.id == 0) return false;
      // 二级概念只在同一一级概念下保持唯一，不同一级概念之间允许重名
      if ((parent.children || []).some((child) => child.name === name)) return false;
      if (!parent.children) parent.children = [];
      const id = this.nextConceptId();
      parent.children.push({
        name,
        id,
        id_str: String(id),
        symbols: [],
      });
      return true;
    },
    /** 上移/下移一级概念：自选固定在最前，不参与排序；返回是否发生移动 */
    moveConcept(id, offset) {
      const idx = this.group.findIndex((group) => group.id == id);
      const target = idx + offset;
      if (idx < 1 || target < 1 || target >= this.group.length) return false;
      const list = this.group;
      [list[idx], list[target]] = [list[target], list[idx]];
      return true;
    },
    /** 上移/下移某个一级概念下的二级概念；返回是否发生移动 */
    moveSubConcept(parentId, subId, offset) {
      const parent = this.group.find((group) => group.id == parentId);
      if (!parent || !parent.children) return false;
      const idx = parent.children.findIndex((child) => child.id == subId);
      const target = idx + offset;
      if (idx < 0 || target < 0 || target >= parent.children.length) return false;
      const list = parent.children;
      [list[idx], list[target]] = [list[target], list[idx]];
      return true;
    },
    /** 把二级概念移动到另一个一级概念下（追加到末尾）；目标已有同名二级概念时失败 */
    moveSubConceptToParent(subId, parentId) {
      const source = this.parentConceptOf(subId);
      const target = this.group.find((group) => group.id == parentId);
      if (!source || !target || target.id == 0 || source.id == target.id) return false;
      const child = source.children.find((item) => item.id == subId);
      if (!child) return false;
      if ((target.children || []).some((item) => item.name === child.name)) return false;
      source.children = source.children.filter((item) => item.id != subId);
      if (!target.children) target.children = [];
      target.children.push(child);
      return true;
    },
    /** 重命名概念：一级概念全局唯一，二级概念只与同一一级概念下的兄弟重名冲突 */
    changeGroupName(id, name) {
      const parent = this.parentConceptOf(id);
      const duplicated = parent
        ? (parent.children || []).some(
            (child) => child.id != id && child.name === name,
          )
        : this.allConcepts().some((concept) => concept.id != id && concept.name === name);
      if (duplicated) return;
      const group = this.findConceptById(id);
      if (group) group.name = name;
    },
    addSymbol(symbol, groupName) {
      const group = this.findConceptByName(groupName);
      if (group) {
        group.symbols.push(symbol);
        group.symbols = [...new Set(group.symbols)];
      }
    },
    delSymbol(symbol, groupId) {
      const group = this.findConceptById(groupId);
      if (group) {
        group.symbols = group.symbols.filter((s) => s.symbol !== symbol.symbol);
      }
    },
    copySymbols(symbols, to) {
      symbols.forEach((s) => this.addSymbol(s, to));
    },
    /** 批量添加股票到指定概念（按 secid 去重），返回实际新增数量 */
    addSymbols(symbols, toId) {
      const group = this.findConceptById(toId);
      if (!group) return 0;
      if (!group.symbols) group.symbols = [];
      const exists = new Set(group.symbols.map((s) => s.secid));
      let added = 0;
      for (const s of symbols) {
        if (exists.has(s.secid)) continue;
        group.symbols.push({ ...s });
        exists.add(s.secid);
        added += 1;
      }
      return added;
    },
    deleteSymbols(symbols, groupId) {
      symbols.forEach((s) => this.delSymbol(s, groupId));
    },
    deleteGroup(id) {
      const remove = (nodes) => {
        const i = nodes.findIndex((n) => n.id == id);
        if (i !== -1) {
          nodes.splice(i, 1);
          return true;
        }
        for (const n of nodes) {
          if (n.children && remove(n.children)) return true;
        }
        return false;
      };
      remove(this.group);
      if (!this.findConceptById(this.selectGroup)) {
        this.selectGroup = this.group.length ? this.group[0].id : 0;
      }
    },
    initSettings(s) {
      this.tableSize = s.tableSize;
      this.updownColor = s.updownColor;
      this.viewOpacity = s.viewOpacity;
      this.viewGray = s.viewGray;
      this.watchFields = s.watchFields;
      this.isFixWidth = s.isFixWidth;
      this.fixedWidth = s.fixedWidth;
      this.isEdgeFold = s.isEdgeFold;
      this.isOpenWithSystem = s.isOpenWithSystem;
      this.shortcutBoss = s.shortcutBoss;
    },
    _alertState(e) {
      for (let i = this.alertQueue.length - 1; i >= 0; i--) {
        const t = this.alertQueue[i].data;
        if (isEqual(t.secid + t.trigger + t.state, e.secid + e.trigger + e.state)) {
          return e.dt - t.dt < ALERT_WINDOW_MS ? 1 : 2;
        }
      }
      return -1;
    },
    /** 返回本次需要弹窗提醒的项（20 分钟内重复触发不再提醒） */
    updateAlertQueue(list) {
      const out = [];
      // 队列只服务于静默窗口内的去重判断：过期记录及时清理，
      // 否则长期运行会无限增长并随 store 持久化累积
      const now = Date.now();
      this.alertQueue = this.alertQueue.filter((a) => now - a.data.dt < ALERT_WINDOW_MS);
      for (const r of list) {
        const state = this._alertState(r);
        if (state === -1) {
          this.alertQueue.push({ data: r });
          out.push(r);
        } else if (state === 2) {
          this.alertQueue = this.alertQueue.filter(
            (a) =>
              !isEqual(
                a.data.secid + a.data.trigger + a.data.state,
                r.secid + r.trigger + r.state,
              ),
          );
          this.alertQueue.push({ data: r });
          out.push(r);
        }
      }
      return out;
    },
    updateProfit(p) {
      this.totoal_profit = p.total_profit;
      this.totoal_profit_rate = p.total_profit_rate;
      this.today_profit = p.today_profit;
      this.today_profit_rate = p.today_profit_rate;
    },
  },
});
