<template>
  <el-card
    class="bg-card"
    data-tauri-drag-region
    style="--el-card-padding: 0px; background-color: #f2f2f2; animation: none"
  >
    <div class="mw-header" data-tauri-drag-region>
      <span class="mw-title">市场宽度 · 申万一级</span>
      <span class="mw-note">站上 MA20 股票占比（%），最右侧为最新交易日</span>
    </div>
    <div v-loading="loading" class="mw-body">
      <template v-if="rows.length">
        <!-- 日期在表格外，与各列中心对齐 -->
        <div class="mw-dates-row">
          <div class="mw-name-head">行业</div>
          <div class="mw-dates-clip">
            <div class="mw-dates-track" :style="{ transform: `translateX(${-scrollLeft}px)` }">
              <span v-for="col in columns" :key="col.date" class="mw-date">
                <i>{{ col.date }}</i>
              </span>
            </div>
          </div>
        </div>
        <div ref="tableRef" class="mw-table" @scroll="onScroll">
          <div class="mw-track">
            <div v-for="row in rows" :key="row.code" class="mw-row">
              <div class="mw-name">{{ row.name }}</div>
              <div v-if="viewStart > 0" class="mw-gap" :style="{ width: `${viewStart * CELL_W}px` }"></div>
              <div
                v-for="col in visibleColumns"
                :key="col.date"
                class="mw-cell"
                :style="
                  row.values[col.index] === null
                    ? emptyStyle
                    : cellStyle(row.values[col.index])
                "
              >
                {{ row.values[col.index] === null ? '-' : row.values[col.index] }}
              </div>
              <div
                v-if="viewEnd < columns.length"
                class="mw-gap"
                :style="{ width: `${(columns.length - viewEnd) * CELL_W}px` }"
              ></div>
            </div>
          </div>
        </div>
      </template>
      <p v-else-if="!loading" class="mw-empty">{{ error || '暂无数据' }}</p>
    </div>
    <WindowMaxButton />
    <el-button class="mw-close" type="info" size="small" id="titlebar-close" @click="close">
      <el-icon class="el-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" class="el-icon">
          <path
            fill="currentColor"
            d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"
          />
        </svg>
      </el-icon>
    </el-button>
  </el-card>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  loadMarketWidth,
  loadMarketWidthFromDb,
  refreshMarketWidth,
} from '../api/legulegu';
import WindowMaxButton from '../components/WindowMaxButton.vue';
import { isTauri } from '../utils/env';

/* 单列宽度与行业列宽度，需与样式保持一致，列虚拟化依赖这两个常量 */
const CELL_W = 24;
const NAME_W = 92;
/* 可视区域左右各多渲染几列，滚动时不出现空白 */
const OVERSCAN = 6;
/* 默认开窗按 30 个交易日估算，与 fitWindowSize 中的 VISIBLE_DAYS 保持一致 */
const VISIBLE_DAYS = 30;

const loading = ref(false);
const rows = ref([]);
const columns = ref([]);
const error = ref('');
const tableRef = ref(null);
const scrollLeft = ref(0);
/* 当前实际渲染的列区间 [viewStart, viewEnd)，避免一次性创建 32×688 个单元格 */
const viewStart = ref(0);
const viewEnd = ref(0);
const visibleColumns = computed(() =>
  columns.value.slice(viewStart.value, viewEnd.value),
);

/* 背景色渐变：0-50 深绿→浅绿，50-100 浅红→深红 */
const GREEN_DEEP = [6, 86, 42];
const GREEN_LIGHT = [206, 240, 214];
const RED_LIGHT = [255, 214, 214];
const RED_DEEP = [154, 20, 20];
const emptyStyle = { backgroundColor: '#f2f2f2', color: '#c0c4cc' };

function mix(from, to, t) {
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function cellStyle(value) {
  let background;
  if (value <= 50) background = mix(GREEN_DEEP, GREEN_LIGHT, value / 50);
  else background = mix(RED_LIGHT, RED_DEEP, (value - 50) / 50);
  const rgb = background.match(/\d+/g).map(Number);
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return { backgroundColor: background, color: luminance > 0.62 ? '#303133' : '#ffffff' };
}

/* 可视列区间随横向滚动更新，只渲染窗口附近的列 */
function syncVisible() {
  const total = columns.value.length;
  if (!total) {
    viewStart.value = 0;
    viewEnd.value = 0;
    return;
  }
  const el = tableRef.value;
  /* jsdom 等环境拿不到布局宽度时按窗口宽度估算 */
  const containerWidth = (el && el.clientWidth) || window.innerWidth - NAME_W;
  const viewWidth = Math.max(CELL_W, containerWidth - NAME_W);
  const scroll = (el && el.scrollLeft) || 0;
  const start = Math.max(0, Math.floor(scroll / CELL_W) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scroll + viewWidth) / CELL_W) + OVERSCAN);
  viewStart.value = start;
  viewEnd.value = Math.max(start + 1, end);
}

/* 表体外日期行跟随横向滚动，保证日期始终对准所在列 */
function onScroll() {
  const el = tableRef.value;
  if (!el) return;
  scrollLeft.value = el.scrollLeft;
  syncVisible();
}

let retryTimer = null;

/* 内容超宽时滚到最右，保证最新日期可见 */
async function scrollToLatest(retry = 6) {
  retryTimer = null;
  await nextTick();
  const el = tableRef.value;
  if (!el) {
    if (retry > 0) retryTimer = setTimeout(() => scrollToLatest(retry - 1), 60);
    return;
  }
  if (el.scrollWidth <= el.clientWidth) {
    syncVisible();
    return;
  }
  el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
  scrollLeft.value = el.scrollLeft;
  syncVisible();
}

/* 按行业行数与列宽动态调整窗口尺寸：高度容纳全部行业，宽度贴近表格右缘 */
async function fitWindowSize() {
  if (!isTauri()) return;
  await nextTick();
  const body = document.querySelector('.mw-body');
  const dates = document.querySelector('.mw-dates-row');
  const table = tableRef.value;
  if (!body || !dates || !table) return;
  const bottomPadding = 6;
  /* 窗口变窄出现横向滚动条时会占去 8px，预先留出，避免最后一行被裁掉 */
  const scrollbarHeight = 8;
  const height = Math.ceil(
    body.getBoundingClientRect().top +
      dates.getBoundingClientRect().height +
      rows.value.length * 24 +
      bottomPadding +
      scrollbarHeight +
      2,
  );
  const rect = table.getBoundingClientRect();
  /* 默认宽度按 VISIBLE_DAYS 个交易日开窗，历史列更多时由横向滚动条查看，避免窗口过宽 */
  const visibleDays = Math.min(columns.value.length, VISIBLE_DAYS);
  const gridWidth = 92 + visibleDays * 24;
  const rightInset = window.innerWidth - rect.right;
  const desiredWidth = Math.ceil(rect.left + gridWidth + rightInset);
  const maxWidth = Math.max(320, window.screen.availWidth - 20);
  const maxHeight = Math.max(240, window.screen.availHeight - 20);
  const width = Math.min(desiredWidth, maxWidth);
  const finalHeight = Math.min(height, maxHeight);
  const { getCurrentWindow, LogicalSize, LogicalPosition } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const pos = await win.outerPosition();
  await win.setSize(new LogicalSize(width, finalHeight));
  /* 放大后若右侧/底部超出屏幕，把窗口移回可见范围 */
  const x = Math.min(Math.max(0, pos.x / scale), Math.max(0, window.screen.availWidth - width));
  const y = Math.min(Math.max(0, pos.y / scale), Math.max(0, window.screen.availHeight - finalHeight));
  await win.setPosition(new LogicalPosition(x, y));
}

onUnmounted(() => {
  if (retryTimer) clearTimeout(retryTimer);
  window.removeEventListener('resize', syncVisible);
});

/* 应用一份完整数据：行业平均固定到第一行，日期按升序成列 */
function applyData(data) {
  const average = data.rows.filter((row) => row.name === '行业平均');
  rows.value = [...average, ...data.rows.filter((row) => row.name !== '行业平均')];
  columns.value = data.dates.map((date, index) => ({ date, index }));
  if (!tableRef.value) {
    /* 首次渲染直接从最右侧（最新交易日）开始铺列，其余历史列在拖入视窗时按需渲染 */
    const initial = Math.min(columns.value.length, VISIBLE_DAYS + OVERSCAN);
    viewEnd.value = columns.value.length;
    viewStart.value = columns.value.length - initial;
  } else {
    viewEnd.value = Math.min(viewEnd.value, columns.value.length);
    viewStart.value = Math.min(viewStart.value, Math.max(0, columns.value.length - 1));
  }
}

/* 库内数据已渲染时，后台按库内最大交易日补数并落库，成功后再合并回表格 */
async function refreshInBackground() {
  try {
    const fresh = await refreshMarketWidth();
    if (!fresh) return;
    const el = tableRef.value;
    /* 用户正停在最新交易日时才跟随滚到最右，否则保持当前横向位置 */
    const atLatest = !el || el.scrollWidth - el.clientWidth - el.scrollLeft <= 4;
    applyData(fresh);
    await nextTick();
    syncVisible();
    if (atLatest) await scrollToLatest();
  } catch (e) {
    /* 后台刷新失败静默，保留已渲染的库内数据 */
  }
}

async function load() {
  loading.value = true;
  error.value = '';

  /* 先读库立即渲染，窗口不必等接口 */
  let painted = false;
  try {
    const stored = await loadMarketWidthFromDb();
    if (stored) {
      applyData(stored);
      painted = true;
      loading.value = false;
      await nextTick();
      /* 初次渲染范围已在最右侧，先把视口定位到最新交易日，再调整窗口尺寸并校正 */
      await scrollToLatest();
      await fitWindowSize();
      await scrollToLatest();
      refreshInBackground();
    }
  } catch (e) {
    /* 读库失败时退回阻塞加载 */
  }
  if (painted) return;

  try {
    applyData(await loadMarketWidth());
  } catch (e) {
    rows.value = [];
    error.value = e.message || '市场宽度数据获取失败';
  } finally {
    loading.value = false;
    await nextTick();
    /* 同样先从最新交易日开始展示，窗口尺寸调整后再校正一次 */
    if (rows.value.length) await scrollToLatest();
    await fitWindowSize();
    if (rows.value.length) await scrollToLatest();
  }
}

onMounted(() => {
  window.addEventListener('resize', syncVisible);
  load();
});

async function close() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().close();
}
</script>

<style scoped>
.mw-header {
  height: 34px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 36px 0 10px;
  box-sizing: border-box;
}
.mw-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}
.mw-note {
  font-size: 12px;
  color: #909399;
}
.mw-body {
  height: calc(100vh - 36px);
  padding: 0 6px 6px;
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
/* 表格外日期行：与列中心对齐，倾斜且互不遮挡 */
.mw-dates-row {
  display: flex;
  height: 64px;
  flex: 0 0 64px;
}
.mw-name-head {
  width: 92px;
  flex: 0 0 92px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #606266;
}
.mw-dates-clip {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.mw-dates-track {
  display: flex;
  height: 100%;
}
.mw-date {
  width: 24px;
  flex: 0 0 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mw-date i {
  font-style: normal;
  font-size: 9px;
  line-height: 1;
  white-space: nowrap;
  color: #606266;
  transform: rotate(-90deg);
}
/* 数字格紧贴：单元格即色块，横纵均无间距；纵向铺满全部行业，不出现滚动条 */
.mw-table {
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  background-color: #f2f2f2;
}
/* 纵向不滚动，保留横向滚动条：窗口宽度不足以放下全部交易日时可拖动查看 */
.mw-table::-webkit-scrollbar {
  width: 0;
  height: 8px;
}
.mw-table::-webkit-scrollbar-track {
  background: transparent;
}
.mw-table::-webkit-scrollbar-thumb {
  background-color: #c8c9cc;
  border-radius: 4px;
}
.mw-table::-webkit-scrollbar-thumb:hover {
  background-color: #a8abb2;
}
.mw-track {
  display: inline-block;
  min-width: 100%;
}
.mw-row {
  display: flex;
  height: 24px;
}
.mw-name {
  position: sticky;
  left: 0;
  z-index: 2;
  width: 92px;
  flex: 0 0 92px;
  display: flex;
  align-items: center;
  padding-left: 8px;
  box-sizing: border-box;
  font-size: 12px;
  color: #303133;
  white-space: nowrap;
  background-color: #f2f2f2;
}
.mw-cell {
  width: 24px;
  flex: 0 0 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  user-select: none;
}
/* 虚拟化占位：未渲染的列用空白撑开宽度，保证滚动条长度与日期对齐 */
.mw-gap {
  flex: 0 0 auto;
  height: 24px;
}
.mw-empty {
  margin: 0;
  padding: 80px 0;
  text-align: center;
  font-size: 12px;
  color: #b9b8b8;
}
.mw-close {
  position: absolute;
  top: 0;
  right: 0;
  margin: 3px;
  z-index: 10;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background-color: #fff;
}
.mw-close :deep(.el-icon) {
  font-size: 22px;
  color: #b9b8b8;
}
.mw-close:hover {
  background-color: #e38e8e;
}
.mw-close:hover :deep(.el-icon) {
  color: #f3f3f3;
}
</style>
