<template>
  <el-table
    :data="rows"
    max-height="250"
    :cell-style="{ padding: '3px 0px' }"
    :header-cell-style="{ padding: '3px 0px' }"
    empty-text="暂无概念，点击右下角 ➕ 添加"
    :size="setting.tableSize"
    @row-click="onRowClick"
    @sort-change="onSortChange"
  >
    <el-table-column prop="name" label="名称" width="100">
      <template #default="{ row }">
        <span class="concept-name" :class="{ 'concept-child': row.isChild }">
          <span
            v-if="row.hasChildren"
            class="concept-arrow"
            :class="{ expanded: expandedId === row.id }"
          />
          <span v-else class="concept-arrow-placeholder" />
          <span class="concept-text">{{ row.name }}</span>
        </span>
      </template>
    </el-table-column>
    <el-table-column
      prop="range"
      label="涨跌幅"
      width="96"
      sortable="custom"
      align="center"
    >
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
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSettingStore } from '../../stores/setting';
import { useMonitorStore } from '../../stores/monitor';
import { useMacdStore } from '../../stores/macd';
import { on } from '../../utils/events';
import { applyDragRegion } from '../../utils/layout';
import { aggregateSignDays } from '../../utils/macd';
import { EastmoneyApi, toNumber } from '../../api/eastmoney';

const setting = useSettingStore();
const monitor = useMonitorStore();
const macd = useMacdStore();

const api = new EastmoneyApi();
const quotes = ref([]);
const expandedId = ref(null);
/* 表头排序：prop 为 range / turn / macd，order 为 ascending / descending / null */
const sortKey = ref(null);
const sortOrder = ref(null);

let timer = null;
/* 组件卸载标记：请求返回后不再续排定时器，避免切换标签页后残留轮询 */
let disposed = false;
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

/** 概念下股票的行情平均值（无行情时显示 -） */
function averageOf(symbols) {
  let rangeSum = 0;
  let rangeCount = 0;
  let turnSum = 0;
  let turnCount = 0;
  for (const s of symbols) {
    const quote = quoteIndex.value[s.secid];
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

/** 概念包含的股票：一级概念取所有二级概念并集，二级概念取自身 */
function conceptSymbols(concept) {
  const children = concept.children || [];
  return children.length
    ? children.flatMap((child) => child.symbols || [])
    : concept.symbols || [];
}

/** 概念 MACD 连续天数：先按日平均成分股 MACD 柱，再数连续同号天数 */
function conceptMacd(symbols) {
  const seriesList = symbols
    .map((s) => macd.series[s.secid])
    .filter((series) => series && series.length);
  if (!seriesList.length) return NaN;
  return aggregateSignDays(seriesList);
}

function makeRow(concept, symbols, isChild, hasChildren) {
  const avg = averageOf(symbols);
  const macdDays = conceptMacd(symbols);
  return {
    id: concept.id,
    name: concept.name,
    isChild,
    hasChildren,
    range: avg.range,
    rangeText: Number.isNaN(avg.range) ? '-' : avg.range.toFixed(2) + '%',
    turn: avg.turn,
    turnText: Number.isNaN(avg.turn) ? '-' : avg.turn.toFixed(2) + '%',
    macd: macdDays,
    macdText: Number.isNaN(macdDays) ? '-' : String(macdDays),
  };
}

/* 一级概念默认收缩：只展开当前 expandedId 对应的二级概念；
   自选（id 0）不在概念列表展示，其余一级概念按表头排序 */
const rows = computed(() => {
  const list = monitor.watchGroup.filter((group) => Number(group.id) !== 0);
  if (sortKey.value) list.sort(compareConcepts);

  const out = [];
  for (const group of list) {
    const children = group.children || [];
    const symbols = children.length
      ? children.flatMap((child) => child.symbols || [])
      : group.symbols || [];
    out.push(makeRow(group, symbols, false, children.length > 0));
    if (expandedId.value === group.id) {
      for (const child of children) {
        out.push(makeRow(child, child.symbols || [], true, false));
      }
    }
  }
  return out;
});

/* 排序：缺行情（NaN）的概念始终排在最后，其余按所选列数值升降序 */
function compareConcepts(a, b) {
  const av = conceptValue(a);
  const bv = conceptValue(b);
  const aMissing = Number.isNaN(av);
  const bMissing = Number.isNaN(bv);
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1;
  }
  const diff = av - bv;
  return sortOrder.value === 'descending' ? -diff : diff;
}

function conceptValue(concept) {
  const symbols = conceptSymbols(concept);
  if (sortKey.value === 'macd') return conceptMacd(symbols);
  return averageOf(symbols)[sortKey.value];
}

function onSortChange({ prop, order }) {
  sortKey.value = order ? prop : null;
  sortOrder.value = order;
}

/* 概念列表不展示自选，行情与 MACD 也只取概念下的股票 */
const conceptGroups = computed(() =>
  monitor.watchGroup.filter((group) => Number(group.id) !== 0),
);

const realtimeSymbols = computed(() => {
  const out = [];
  for (const group of conceptGroups.value) {
    for (const s of group.symbols || []) out.push(s);
    for (const child of group.children || []) {
      for (const s of child.symbols || []) out.push(s);
    }
  }
  return out.filter((s) => s.source === '1');
});

/* MACD 用日 K，不区分行情数据源 */
const macdSymbols = computed(() => {
  const out = [];
  for (const group of conceptGroups.value) {
    for (const s of group.symbols || []) out.push(s.secid);
    for (const child of group.children || []) {
      for (const s of child.symbols || []) out.push(s.secid);
    }
  }
  return out;
});

async function ensureMacd() {
  await macd.ensure(macdSymbols.value);
}

/** 点击一级概念展开其二级概念，同时只保留一个展开项 */
function onRowClick(row) {
  if (row.isChild || !row.hasChildren) return;
  expandedId.value = expandedId.value === row.id ? null : row.id;
}

async function loopRealtime() {
  if (disposed) return;
  let delay = 4000;
  try {
    const data = await api.realtime(realtimeSymbols.value);
    if (disposed) return;
    quotes.value = data;
  } catch (e) {
    console.error(e);
    delay = 20000;
  }
  if (disposed) return;
  timer = setTimeout(loopRealtime, delay);
}

onMounted(async () => {
  loopRealtime();
  ensureMacd();
  applyDragRegion(['el-table__cell', 'cell', 'el-table__empty-block', 'el-table__empty-text']);
  offs.push(
    await on('stateChange', () => {
      monitor.$hydrate({ runHooks: false });
      ensureMacd();
    }),
  );
  offs.push(
    await on('settingChange', () => {
      setting.$hydrate({ runHooks: false });
    }),
  );
});

onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  offs.forEach((off) => off && off());
});
</script>

<style scoped>
.concept-name {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
}
.concept-name.concept-child {
  padding-left: 14px;
}
.concept-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.concept-arrow {
  flex: none;
  width: 0;
  height: 0;
  margin-right: 4px;
  border-left: 4px solid #909399;
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
  transition: transform 0.2s;
}
.concept-arrow.expanded {
  transform: rotate(90deg);
}
.concept-arrow-placeholder {
  flex: none;
  width: 4px;
  margin-right: 4px;
}
</style>
