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
              <div
                v-for="col in columns"
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
            </div>
          </div>
        </div>
      </template>
      <p v-else-if="!loading" class="mw-empty">{{ error || '暂无数据' }}</p>
    </div>
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
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { loadMarketWidth } from '../api/legulegu';
import { isTauri } from '../utils/env';

const loading = ref(false);
const rows = ref([]);
const columns = ref([]);
const error = ref('');
const tableRef = ref(null);
const scrollLeft = ref(0);

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

/* 表体外日期行跟随横向滚动，保证日期始终对准所在列 */
function onScroll() {
  const el = tableRef.value;
  if (el) scrollLeft.value = el.scrollLeft;
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
  if (el.scrollWidth <= el.clientWidth) return;
  el.scrollLeft = el.scrollWidth;
  scrollLeft.value = el.scrollLeft;
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
  const height = Math.ceil(
    body.getBoundingClientRect().top +
      dates.getBoundingClientRect().height +
      rows.value.length * 24 +
      bottomPadding +
      2,
  );
  const rect = table.getBoundingClientRect();
  const gridWidth = 92 + columns.value.length * 24;
  const rightInset = window.innerWidth - rect.right;
  const width = Math.ceil(rect.left + gridWidth + rightInset);
  const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setSize(new LogicalSize(width, height));
}

onUnmounted(() => {
  if (retryTimer) clearTimeout(retryTimer);
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await loadMarketWidth();
    /* 行业平均固定到第一行，其余保持接口顺序 */
    const average = data.rows.filter((row) => row.name === '行业平均');
    rows.value = [...average, ...data.rows.filter((row) => row.name !== '行业平均')];
    /* 接口按日期升序返回，最右侧为最新交易日 */
    columns.value = data.dates.map((date, index) => ({ date, index }));
    await scrollToLatest();
  } catch (e) {
    rows.value = [];
    error.value = e.message || '市场宽度数据获取失败';
  } finally {
    loading.value = false;
    await fitWindowSize();
  }
}

onMounted(load);

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
.mw-table::-webkit-scrollbar {
  width: 0;
  height: 0;
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
