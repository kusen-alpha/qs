<template>
  <div class="sector-panel">
    <div class="sector-tabs">
      <span
        v-for="tab in TABS"
        :key="tab.key"
        class="sector-tab"
        :class="{ active: scope === tab.key }"
        @click="setScope(tab.key)"
        >{{ tab.label }}</span
      >
    </div>
    <el-table
      :data="rows"
      max-height="250"
      :cell-style="{ padding: '3px 0px' }"
      :header-cell-style="{ padding: '3px 0px' }"
      empty-text="暂无可展示的板块"
      :size="setting.tableSize"
      @row-click="onRowClick"
      @sort-change="onSortChange"
    >
      <el-table-column prop="name" label="名称" width="100">
        <template #default="{ row }">
          <span class="sector-name" :class="{ 'sector-child': row.isChild }">
            <span
              v-if="row.hasChildren"
              class="sector-arrow"
              :class="{ expanded: expandedKey === row.key }"
            />
            <span v-else class="sector-arrow-placeholder" />
            <span class="sector-text">{{ row.name }}</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="range" label="涨跌幅" width="96" sortable="custom" align="center">
        <template #default="{ row }">
          <span :class="row.range > 0 ? upColor : downColor">{{ row.rangeText }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="turn" label="换手率" width="96" sortable="custom" align="center">
        <template #default="{ row }">
          <span>{{ row.turnText }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="macd" label="MACD" width="76" sortable="custom" align="center">
        <template #default="{ row }">
          <span :class="row.macd > 0 ? upColor : downColor">{{ row.macdText }}</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSettingStore } from '../../stores/setting';
import { useMonitorStore } from '../../stores/monitor';
import { on } from '../../utils/events';
import { applyDragRegion } from '../../utils/layout';
import { EastmoneyApi, toNumber } from '../../api/eastmoney';
import { loadBoardList } from '../../utils/db';

/* 列名上方的两个小 tab：申万有一二级层级，同花顺行业为平铺列表 */
const TABS = [
  { key: 'sw', label: '申万板块' },
  { key: 'ths', label: '同花顺板块' },
];

const setting = useSettingStore();
const monitor = useMonitorStore();

const api = new EastmoneyApi();
const scope = ref('sw');
const boards = ref([]);
const quotes = ref([]);
/* 申万板块同时只展开一个一级板块 */
const expandedKey = ref(null);
/* 表头排序：prop 为 range / turn / macd，order 为 ascending / descending / null */
const sortKey = ref(null);
const sortOrder = ref(null);

let timer = null;
let offs = [];

const upColor = computed(() =>
  setting.updownColor === 'redUpGreenDown' ? 'red' : 'green',
);
const downColor = computed(() =>
  setting.updownColor === 'redUpGreenDown' ? 'green' : 'red',
);

const quoteIndex = computed(() => {
  const map = {};
  for (const quote of quotes.value) map[quote.secid] = quote;
  return map;
});

/** 板块成分股的实时行情平均值（无行情时显示 -） */
function averageOf(members) {
  let rangeSum = 0;
  let rangeCount = 0;
  let turnSum = 0;
  let turnCount = 0;
  for (const secid of members) {
    const quote = quoteIndex.value[secid];
    if (!quote) continue;
    const range = toNumber(quote.range);
    if (!Number.isNaN(range)) {
      rangeSum += range;
      rangeCount += 1;
    }
    const turn = toNumber(quote.turn);
    if (!Number.isNaN(turn)) {
      turnSum += turn;
      turnCount += 1;
    }
  }
  return {
    range: rangeCount ? rangeSum / rangeCount : NaN,
    turn: turnCount ? turnSum / turnCount : NaN,
  };
}

function makeRow(board, hasChildren) {
  const avg = averageOf(board.members || []);
  const macd = Number.isFinite(board.macd) ? board.macd : NaN;
  return {
    key: board.board_key,
    name: board.name,
    isChild: Number(board.level) === 2,
    hasChildren,
    range: avg.range,
    rangeText: Number.isNaN(avg.range) ? '-' : avg.range.toFixed(2) + '%',
    turn: avg.turn,
    turnText: Number.isNaN(avg.turn) ? '-' : avg.turn.toFixed(2) + '%',
    macd,
    macdText: Number.isNaN(macd) ? '-' : String(macd),
  };
}

/* 申万：一级板块下按 parent_key 挂二级；同花顺：平铺列表 */
const rows = computed(() => {
  if (scope.value !== 'sw') {
    const flat = [...boards.value];
    if (sortKey.value) flat.sort(compareBoards);
    return flat.map((board) => makeRow(board, false));
  }

  const tops = boards.value.filter((board) => Number(board.level) === 1);
  if (sortKey.value) tops.sort(compareBoards);
  const out = [];
  for (const top of tops) {
    const children = boards.value.filter(
      (board) => Number(board.level) === 2 && board.parent_key === top.board_key,
    );
    out.push(makeRow(top, children.length > 0));
    if (expandedKey.value === top.board_key) {
      for (const child of children) out.push(makeRow(child, false));
    }
  }
  return out;
});

/* 排序：缺数据的板块始终排在最后，其余按所选列数值升降序 */
function compareBoards(a, b) {
  const av = boardValue(a);
  const bv = boardValue(b);
  const aMissing = Number.isNaN(av);
  const bMissing = Number.isNaN(bv);
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1;
  }
  const diff = av - bv;
  return sortOrder.value === 'descending' ? -diff : diff;
}

function boardValue(board) {
  if (sortKey.value === 'macd') {
    return Number.isFinite(board.macd) ? board.macd : NaN;
  }
  return averageOf(board.members || [])[sortKey.value];
}

function onSortChange({ prop, order }) {
  sortKey.value = order ? prop : null;
  sortOrder.value = order;
}

/* 实时行情只取当前 tab 下所有板块的成分股 */
const realtimeSymbols = computed(() => {
  const secids = [];
  for (const board of boards.value) {
    for (const secid of board.members || []) secids.push(secid);
  }
  return [...new Set(secids)].map((secid) => ({ secid }));
});

async function loadBoards() {
  const list = (await loadBoardList(scope.value)) || [];
  boards.value = list;
  // 默认展开的一级板块可能在新数据里已不存在
  if (expandedKey.value && !list.find((board) => board.board_key === expandedKey.value)) {
    expandedKey.value = null;
  }
}

function setScope(key) {
  if (scope.value === key) return;
  scope.value = key;
  expandedKey.value = null;
  loadBoards();
}

/** 点击一级板块展开其二级板块，同时只保留一个展开项 */
function onRowClick(row) {
  if (row.isChild || !row.hasChildren) return;
  expandedKey.value = expandedKey.value === row.key ? null : row.key;
}

async function loopRealtime() {
  let delay = 4000;
  try {
    quotes.value = await api.realtime(realtimeSymbols.value);
  } catch (e) {
    console.error(e);
    delay = 20000;
  }
  timer = setTimeout(loopRealtime, delay);
}

onMounted(async () => {
  await loadBoards();
  loopRealtime();
  applyDragRegion(['el-table__cell', 'cell', 'el-table__empty-block', 'el-table__empty-text']);
  offs.push(
    await on('stateChange', () => {
      monitor.$hydrate({ runHooks: false });
      loadBoards();
    }),
  );
  offs.push(
    await on('settingChange', () => {
      setting.$hydrate({ runHooks: false });
    }),
  );
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  offs.forEach((off) => off && off());
});
</script>

<style scoped>
.sector-panel {
  display: flex;
  flex-direction: column;
}
.sector-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 18px;
  padding: 0 2px;
}
.sector-tab {
  height: 18px;
  line-height: 18px;
  font-size: 11px;
  color: #909399;
  cursor: pointer;
  user-select: none;
}
.sector-tab.active {
  color: #409eff;
  font-weight: 600;
  box-shadow: inset 0 -2px 0 #409eff;
}
.sector-name {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
}
.sector-name.sector-child {
  padding-left: 14px;
}
.sector-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sector-arrow {
  flex: none;
  width: 0;
  height: 0;
  margin-right: 4px;
  border-left: 4px solid #909399;
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
  transition: transform 0.2s;
}
.sector-arrow.expanded {
  transform: rotate(90deg);
}
.sector-arrow-placeholder {
  flex: none;
  width: 4px;
  margin-right: 4px;
}
</style>
