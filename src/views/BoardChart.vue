<template>
  <el-card class="bg-card" shadow="always" :style="{ border: '0' }" data-tauri-drag-region>
    <el-container class="chart-container">
      <el-aside width="140px" class="chart-aside">
        <div class="aside-title">
          <span class="aside-title-text">{{ isSector ? '板块' : '概念' }}</span>
          <el-select
            v-if="isSector"
            v-model="scope"
            size="small"
            class="aside-scope"
            @change="onScopeChange"
          >
            <el-option label="同花顺板块" value="ths" />
            <el-option label="申万板块" value="sw" />
          </el-select>
        </div>
        <div class="menu-list">
          <div
            v-for="row in rows"
            :key="row.key"
            class="menu-item"
            :class="{ 'is-active': row.key === selected.key, 'is-child': row.isChild }"
            @click="select(row)"
          >
            <span
              v-if="row.hasChildren"
              class="menu-arrow"
              :class="{ expanded: expandedKey === row.key }"
              @click.stop="toggle(row)"
            />
            <span v-else class="menu-arrow-placeholder" />
            <span class="menu-name">{{ row.name }}</span>
          </div>
          <div v-if="!rows.length" class="menu-empty">暂无数据</div>
        </div>
      </el-aside>
      <el-container class="chart-right-container">
        <HQKLineChart :board-key="selected.key" :name="selected.name" />
      </el-container>
    </el-container>

    <div class="title-bar">
      <el-button class="close-button" type="info" id="titlebar-close" @click="closeWindowBtn">
        <el-icon>
          <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </el-icon>
      </el-button>
      <el-button
        class="fullscreen-button close-button"
        type="info"
        id="titlebar-fullscreen"
        @click="toggleFullscreen"
      >
        <el-icon>
          <svg v-if="isMaximized" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
          </svg>
        </el-icon>
      </el-button>
      <el-button
        class="fullscreen-button close-button"
        type="info"
        id="titlebar-minimize"
        @click="minimizeBtn"
      >
        <el-icon>
          <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
            <path d="M19 12.998H5v-2h14z" />
          </svg>
        </el-icon>
      </el-button>
    </div>
  </el-card>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useMonitorStore } from '../stores/monitor';
import { on } from '../utils/events';
import { applyDragRegion } from '../utils/layout';
import { isTauri } from '../utils/env';
import { loadBoardList } from '../utils/db';
import HQKLineChart from '../components/detail/HQKLineChart.vue';

const route = useRoute();
const monitor = useMonitorStore();

/* kind=concept 展示概念页的左侧列表，kind=sector 展示板块列表 */
const isSector = computed(() => route.query.kind !== 'concept');

const scope = ref('ths');
const boards = ref([]);
/* 同时只展开一个一级板块/概念 */
const expandedKey = ref(null);
const selected = ref({ key: '', name: '' });
const isMaximized = ref(false);

let offs = [];

/* 概念：一级默认展示，二级手动展开（与概念页一致） */
const conceptRows = computed(() => {
  const out = [];
  for (const group of monitor.watchGroup) {
    if (Number(group.id) === 0) continue;
    const children = group.children || [];
    const key = `self:${group.id}`;
    out.push({ key, name: group.name, isChild: false, hasChildren: children.length > 0 });
    if (expandedKey.value === key) {
      for (const child of children) {
        out.push({
          key: `self:${child.id}`,
          name: child.name,
          isChild: true,
          hasChildren: false,
        });
      }
    }
  }
  return out;
});

/* 板块：同花顺平铺；申万按 parent_key 挂二级 */
const sectorRows = computed(() => {
  const list = boards.value;
  if (scope.value !== 'sw') {
    return list.map((board) => ({
      key: board.board_key,
      name: board.name,
      isChild: false,
      hasChildren: false,
    }));
  }
  const out = [];
  for (const top of list.filter((board) => Number(board.level) === 1)) {
    const children = list.filter(
      (board) => Number(board.level) === 2 && board.parent_key === top.board_key,
    );
    out.push({
      key: top.board_key,
      name: top.name,
      isChild: false,
      hasChildren: children.length > 0,
    });
    if (expandedKey.value === top.board_key) {
      for (const child of children) {
        out.push({ key: child.board_key, name: child.name, isChild: true, hasChildren: false });
      }
    }
  }
  return out;
});

const rows = computed(() => (isSector.value ? sectorRows.value : conceptRows.value));

/** 当前选中项不存在时回落到第一个一级项 */
function resetSelection() {
  if (selected.value.key && rows.value.find((row) => row.key === selected.value.key)) return;
  const first = rows.value.find((row) => !row.isChild) || rows.value[0];
  selected.value = first
    ? { key: first.key, name: first.name }
    : { key: '', name: '' };
}

async function loadSector() {
  boards.value = (await loadBoardList(scope.value)) || [];
  if (expandedKey.value && !boards.value.find((b) => b.board_key === expandedKey.value)) {
    expandedKey.value = null;
  }
  resetSelection();
}

async function onScopeChange() {
  expandedKey.value = null;
  await loadSector();
}

function select(row) {
  selected.value = { key: row.key, name: row.name };
}

function toggle(row) {
  if (!row.hasChildren) return;
  expandedKey.value = expandedKey.value === row.key ? null : row.key;
}

async function closeWindowBtn() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

async function minimizeBtn() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().minimize();
}

async function toggleFullscreen() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const maximized = await win.isMaximized();
  if (maximized) await win.unmaximize();
  else await win.maximize();
  isMaximized.value = !maximized;
}

onMounted(async () => {
  applyDragRegion(['el-card__body', 'el-card', 'title-bar']);
  if (isSector.value) await loadSector();
  else resetSelection();

  offs.push(
    await on('stateChange', async () => {
      await monitor.loadFromDb();
      if (isSector.value) loadSector();
    }),
  );

  if (isTauri()) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().isMaximized())
      .then((value) => {
        isMaximized.value = !!value;
      })
      .catch(() => {});
  }
});
</script>

<style scoped>
.bg-card {
  height: 100%;
  width: 100%;
  position: relative;
}
.bg-card :deep(.el-card__body) {
  height: 100%;
  padding: 0;
}
.chart-container {
  height: 100%;
  min-width: 0;
}
.chart-aside {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: #ececec;
}
.aside-title {
  flex: none;
  height: 26px;
  display: flex;
  align-items: center;
  padding: 0 2px 0 8px;
}
.aside-title-text {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: #606266;
}
.aside-title :deep(.aside-scope) {
  flex: 1;
  min-width: 0;
  margin-left: 4px;
}
.aside-title :deep(.el-select__wrapper) {
  min-height: 20px;
  padding: 0 4px;
  font-size: 12px;
}
.menu-list {
  flex: 1;
  min-height: 0;
  margin-top: 1px;
  overflow-x: hidden;
  overflow-y: auto;
}
.menu-item {
  display: flex;
  align-items: center;
  height: 30px;
  margin: 0 0 1px 0;
  padding: 0 4px 0 8px;
  background-color: #fff;
  font-size: 12px;
  color: #303133;
  cursor: pointer;
}
.menu-item:hover {
  color: #409eff;
}
.menu-item.is-active {
  background-color: #c6e2ff;
}
.menu-item.is-child {
  padding-left: 22px;
}
.menu-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-arrow {
  flex: none;
  width: 0;
  height: 0;
  margin-right: 4px;
  border-left: 4px solid #909399;
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
  transition: transform 0.2s;
}
.menu-arrow.expanded {
  transform: rotate(90deg);
}
.menu-arrow-placeholder {
  flex: none;
  width: 4px;
  margin-right: 4px;
}
.menu-empty {
  padding: 12px 8px;
  font-size: 12px;
  color: #b9b8b8;
}
.chart-right-container {
  min-width: 0;
  height: 100%;
}
.title-bar {
  z-index: 10;
  height: 30px;
  align-items: center;
}
.title-bar :deep(.close-button) {
  position: static !important;
  width: 30px !important;
  height: 30px !important;
  margin: 0 !important;
  padding: 0;
  border: 0 !important;
  background-color: transparent !important;
  color: #b9b8b8;
}
.title-bar :deep(.close-button .el-icon) {
  font-size: 22px;
  color: #b9b8b8;
}
</style>
