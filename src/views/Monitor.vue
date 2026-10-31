<template>
  <el-card
    id="monitorCard"
    class="monitor-bg-card"
    shadow="hover"
    data-tauri-drag-region
    :style="cardStyle"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <div class="monitor-header" data-tauri-drag-region>
      <span
        v-for="tab in TABS"
        :key="tab.key"
        class="monitor-tab"
        :class="{ active: activeTab === tab.key }"
        @click="switchTab(tab.key)"
        >{{ tab.label }}</span
      >
      <el-button class="monitor-close" type="info" text title="关闭" @click="closeApp">
        <el-icon>
          <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </el-icon>
      </el-button>
    </div>
    <QuoteTable v-if="activeTab === 'watch'" />
    <ConceptTable v-else-if="activeTab === 'concept'" />
    <MarketPanel v-else-if="activeTab === 'market'" />
    <div v-else class="monitor-placeholder">{{ activeTabLabel }} · 内容开发中</div>
    <Iconbar :tab="activeTab" />
  </el-card>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  availableMonitors,
} from '@tauri-apps/api/window';
import QuoteTable from '../components/monitor/Table.vue';
import ConceptTable from '../components/monitor/ConceptTable.vue';
import MarketPanel from '../components/market/MarketPanel.vue';
import Iconbar from '../components/monitor/Iconbar.vue';
import { useSettingStore } from '../stores/setting';
import { isTauri } from '../utils/env';
import { applyDragRegion, calcTableWidth } from '../utils/layout';
import { emit, on } from '../utils/events';
import { matchShortcut } from '../utils/shortcut';

const setting = useSettingStore();
let offs = [];
let resizeTimer = null;

/* 顶部 tab：自选与概念为现有实现，其余三个先占位，内容后续开发 */
const TABS = [
  { key: 'watch', label: '自选' },
  { key: 'concept', label: '概念' },
  { key: 'sector', label: '板块' },
  { key: 'market', label: '行情' },
  { key: 'calendar', label: '日历' },
];
const activeTab = ref('watch');
const activeTabLabel = computed(
  () => (TABS.find((tab) => tab.key === activeTab.value) || TABS[0]).label,
);

function switchTab(key) {
  if (activeTab.value === key) return;
  activeTab.value = key;
  nextTick(scheduleResize);
}

/* 右上角关闭：桌面端关闭主窗口退出应用 */
function closeApp() {
  if (isTauri()) {
    getCurrentWindow().close();
    return;
  }
  location.hash = '#/';
}

const cardStyle = computed(
  () => `opacity: ${1 - setting.viewOpacity / 100}; filter: grayscale(${setting.viewGray}%)`,
);

function applyCardBody() {
  const bodies = document.getElementsByClassName('el-card__body');
  for (let i = 0; i < bodies.length; i++) {
    bodies[i].setAttribute('data-tauri-drag-region', 'true');
    bodies[i].setAttribute(
      'style',
      'padding-top: 5px;padding-right: 5px;padding-bottom: 5px;padding-left: 5px;',
    );
  }
  applyDragRegion([
    'el-table__cell',
    'cell',
    'el-table__empty-block',
    'el-table__empty-text',
    'monitor-header',
    'monitor-placeholder',
    'el-col',
  ]);
}

function cardEl() {
  return document.getElementById('monitorCard');
}

function resizeWindow() {
  if (!isTauri()) return;
  const el = cardEl();
  if (!el) return;
  const width = setting.isFixWidth
    ? setting.fixedWidth
    : calcTableWidth(el.offsetWidth, el.offsetHeight, setting.watchFields, setting.tableSize);
  getCurrentWindow().setSize(new LogicalSize(width, el.offsetHeight)).catch(() => {});
}

function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeWindow, 150);
}

async function onLeave(event) {
  if (!setting.isEdgeFold) return;
  const el = cardEl();
  if (!el) return;
  const nearEdge =
    !event.relatedTarget &&
    (event.offsetX <= 0 ||
      event.offsetY <= 0 ||
      event.offsetX >= el.offsetWidth - 2 ||
      event.offsetY >= el.offsetHeight - 2);
  if (!nearEdge) return;
  const win = getCurrentWindow();
  const [pos, size, monitors] = await Promise.all([
    win.outerPosition(),
    win.outerSize(),
    availableMonitors().catch(() => []),
  ]);
  let minX = 0;
  let maxX = 0;
  for (const m of monitors) {
    if (m.position.x < minX) minX = m.position.x;
    if (m.position.x + m.size.width > maxX) maxX = m.position.x + m.size.width;
  }
  const fold = 6;
  const x = pos.x < minX + 5 ? minX - size.width + fold : pos.x + size.width > maxX - 5 ? maxX - fold : null;
  if (x !== null) win.setPosition(new PhysicalPosition(x, pos.y));
  emit('hideContextmenu', 'hide');
}

async function onEnter() {
  if (!setting.isEdgeFold || !isTauri()) return;
  const win = getCurrentWindow();
  const [pos, size, monitors] = await Promise.all([
    win.outerPosition(),
    win.outerSize(),
    availableMonitors().catch(() => []),
  ]);
  let minX = 0;
  let maxX = 0;
  for (const m of monitors) {
    if (m.position.x < minX) minX = m.position.x;
    if (m.position.x + m.size.width > maxX) maxX = m.position.x + m.size.width;
  }
  if (pos.x < minX) win.setPosition(new PhysicalPosition(minX, pos.y));
  else if (pos.x + size.width > maxX) win.setPosition(new PhysicalPosition(maxX - size.width, pos.y));
}

onMounted(async () => {
  applyCardBody();
  scheduleResize();
  setTimeout(resizeWindow, 300);

  offs.push(
    await on('settingChange', (e) => {
      const keys = [
        'watchFieldsChange',
        'tableSizeChange',
        'viewGrayChange',
        'viewOpacityChange',
        'isFixWidthChange',
        'fixedWidthChange',
        'shortcutBossChange',
        'isEdgeFoldChange',
      ];
      if (e.payload.some((k) => keys.includes(k))) {
        setting.$hydrate({ runHooks: false });
        if (
          e.payload.includes('isFixWidthChange') ||
          e.payload.includes('fixedWidthChange') ||
          e.payload.includes('tableSizeChange') ||
          e.payload.includes('watchFieldsChange')
        ) {
          scheduleResize();
        }
        if (e.payload.includes('shortcutBossChange')) {
          registerBossKey();
        }
      }
    }),
  );
  offs.push(await on('stateChange', scheduleResize));
  offs.push(
    await on('hide_or_show_window', async () => {
      if (!isTauri()) return;
      const win = getCurrentWindow();
      if (await win.isVisible()) await win.hide();
      else await win.show();
    }),
  );

  document.addEventListener('keydown', bossKeyHandler);
  registerBossKey();
});

let registeredBossKey = null;

async function registerBossKey() {
  if (!isTauri()) return;
  const { register, unregister } = await import('@tauri-apps/plugin-global-shortcut');
  if (registeredBossKey) {
    await unregister(registeredBossKey).catch(() => {});
    registeredBossKey = null;
  }
  const shortcut = setting.shortcutBoss.join('+');
  try {
    await register(shortcut, () => emit('hide_or_show_window'));
    registeredBossKey = shortcut;
  } catch (e) {
    console.error('global shortcut register failed', e);
  }
}

function bossKeyHandler(e) {
  if (matchShortcut(setting.shortcutBoss, e)) emit('hide_or_show_window');
}

onBeforeUnmount(() => {
  clearTimeout(resizeTimer);
  if (registeredBossKey && isTauri()) {
    import('@tauri-apps/plugin-global-shortcut')
      .then(({ unregister }) => unregister(registeredBossKey))
      .catch(() => {});
  }
  document.removeEventListener('keydown', bossKeyHandler);
  offs.forEach((off) => off && off());
});
</script>

<style scoped>
.monitor-header {
  height: 22px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px;
}
.monitor-close {
  margin-left: auto;
  width: 20px;
  height: 20px;
  min-height: 20px;
  padding: 0;
  border: none;
  color: #909399;
}
.monitor-close:hover {
  color: #f56c6c;
}
.monitor-tab {
  height: 22px;
  line-height: 22px;
  font-size: 12px;
  color: #909399;
  cursor: pointer;
  user-select: none;
}
.monitor-tab.active {
  color: #409eff;
  font-weight: 600;
  box-shadow: inset 0 -2px 0 #409eff;
}
.monitor-placeholder {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #c0c4cc;
}
</style>
