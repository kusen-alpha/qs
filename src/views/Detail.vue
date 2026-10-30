<template>
  <el-card class="bg-card" shadow="always" :style="{ border: '0' }" data-tauri-drag-region>
    <el-container class="detail-container">
      <el-aside width="120px" class="detail-aside">
        <div class="aside-title">自选</div>
        <el-menu class="el-menu-vertical-demo detail-menu" :default-active="selectedSecid" @select="onMenuSelect">
          <el-scrollbar height="440" :noresize="true">
            <el-menu-item
              v-for="item in symbols"
              :key="item.secid"
              :index="item.secid"
              @click="changeSymbol(item.secid)"
            >
              <StockMenuItem :name="item.name" :code="item.code" :range="item.range" />
            </el-menu-item>
          </el-scrollbar>
        </el-menu>
      </el-aside>
      <el-container class="detail-right-container">
        <el-tabs
          v-model="panel"
          type="border-card"
          class="detail-tabs"
          style="width: 100%"
          @tab-change="onTabChange"
        >
          <el-tab-pane label="行情图表" :name="DetailPanel.CHART">
            <HQKLineChart
              ref="chartRef"
              :symbol="current.secid"
              :name="current.name"
              :code="current.code"
            />
          </el-tab-pane>
          <el-tab-pane label="个股设置" :name="DetailPanel.SETTING" style="margin-left: 10px">
            <DetailSetting
              :name="current.name"
              :code="current.code"
              :secid="current.secid"
              :range="current.range"
              :price="current.price"
            />
          </el-tab-pane>
        </el-tabs>
      </el-container>
    </el-container>

    <div class="title-bar">
      <el-button class="close-button" type="info" id="titlebar-close" @click="closeDetail">
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
        @click="minimizeDetail"
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useMonitorStore } from '../stores/monitor';
import { DetailPanel, StoreEvent } from '../constants';
import { on } from '../utils/events';
import { applyDragRegion } from '../utils/layout';
import { isTauri } from '../utils/env';
import StockMenuItem from '../components/detail/StockMenuItem.vue';
import DetailSetting from '../components/detail/DetailSetting.vue';
import HQKLineChart from '../components/detail/HQKLineChart.vue';

const route = useRoute();
const monitor = useMonitorStore();

const symbols = ref([]);
const selectedSecid = ref('');
const panel = ref(DetailPanel.CHART);
const isMaximized = ref(false);
const chartRef = ref(null);

let unlistenRealtime = null;

const current = computed(() => {
  return (
    symbols.value.find((item) => item.secid === selectedSecid.value) || {
      name: '-',
      code: '-',
      secid: '-',
      price: '-',
      range: '-',
    }
  );
});

function initSymbols(secid, panelName) {
  const group = monitor.watchGroup[0];
  if (!group) return;
  symbols.value = group.symbols.map((s) => ({
    name: s.name,
    code: s.symbol,
    secid: s.secid,
    price: '-',
    range: '-',
  }));
  updateRealtime();
  const exists = symbols.value.find((s) => s.secid === secid);
  selectedSecid.value = exists ? secid : symbols.value[0] ? symbols.value[0].secid : '-';
  if (panelName && [DetailPanel.CHART, DetailPanel.SETTING].includes(panelName)) {
    panel.value = panelName;
  }
}

function onMenuSelect(index) {
  changeSymbol(index);
}

function changeSymbol(secid) {
  if (!symbols.value.find((s) => s.secid === secid)) return;
  selectedSecid.value = secid;
}

function onTabChange(name) {
  if (name === DetailPanel.CHART) {
    setTimeout(() => {
      if (chartRef.value && chartRef.value.resize) chartRef.value.resize();
    }, 200);
  }
}

function updateRealtime() {
  const list = realtimeList;
  if (!Array.isArray(list) || !list.length) return;
  for (const item of symbols.value) {
    const quote = list.find((q) => q.secid === item.secid);
    if (quote) {
      item.price = quote.price;
      item.range = quote.range;
    }
  }
}

let realtimeList = null;
function handleRealtime(event) {
  realtimeList = Array.isArray(event) ? event : event && event.payload;
  updateRealtime();
}

async function closeDetail() {
  if (!isTauri()) return;
  const { getCurrent } = await import('@tauri-apps/api/window');
  await getCurrent().close();
}

async function minimizeDetail() {
  if (!isTauri()) return;
  const { getCurrent } = await import('@tauri-apps/api/window');
  await getCurrent().minimize();
}

async function toggleFullscreen() {
  if (!isTauri()) return;
  const { getCurrent } = await import('@tauri-apps/api/window');
  const win = getCurrent();
  const maximized = await win.isMaximized();
  if (maximized) await win.unmaximize();
  else await win.maximize();
  isMaximized.value = !maximized;
}

onMounted(() => {
  applyDragRegion(['el-card__body', 'el-card', 'el-tabs__nav-scroll']);
  const query = route.query;
  initSymbols(query.secid, query.panel);
  on(StoreEvent.REALTIME_EAST, handleRealtime).then((fn) => {
    unlistenRealtime = fn;
  });
  if (isTauri()) {
    import('@tauri-apps/api/window')
      .then(({ getCurrent }) => getCurrent().isMaximized())
      .then((value) => {
        isMaximized.value = !!value;
      })
      .catch(() => {});
  }
});

onBeforeUnmount(() => {
  if (unlistenRealtime) unlistenRealtime();
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
.detail-container {
  height: 100%;
  min-width: 0;
}
.detail-aside {
  height: 100%;
  overflow: hidden;
  background-color: #ececec;
}
.detail-aside :deep(.el-select) {
  width: 100%;
  margin-top: 3px;
}
.detail-aside :deep(.el-input__wrapper) {
  width: 100% !important;
}
.detail-aside :deep(.el-input__inner) {
  width: 100% !important;
  margin-left: 0 !important;
  height: auto !important;
}
.detail-aside .aside-title {
  height: 26px;
  line-height: 26px;
  padding-left: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #606266;
}
.detail-menu {
  height: auto;
  margin-top: 1px;
}
.detail-menu :deep(.el-menu-item) {
  height: 56px !important;
  margin: 0 !important;
  padding: 0 2px 0 10px !important;
  border-left: 0 !important;
}
.detail-menu :deep(.el-menu-item.is-active) {
  background-color: #c6e2ff !important;
  border-left: 0 !important;
  padding-left: 10px !important;
}
.detail-right-container {
  min-width: 0;
  height: 100%;
}
.detail-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.detail-tabs :deep(.el-tabs__header) {
  height: 33px;
  flex: none;
  margin: 0;
}
.detail-tabs :deep(.el-tabs__item) {
  height: 35px;
  line-height: 35px;
}
.detail-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  padding: 0 !important;
  overflow: hidden;
}
.detail-tabs :deep(.el-tab-pane) {
  height: 100%;
}
.detail-tabs :deep(.el-tabs__nav-scroll) {
  display: flex;
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
