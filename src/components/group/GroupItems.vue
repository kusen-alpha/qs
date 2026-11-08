<template>
  <el-row v-if="showToolbar" class="icon_row">
    <el-col :span="24">
      <el-button type="primary" class="button" plain size="small" @click="openAdd">添加</el-button>
      <el-button type="danger" class="button" plain size="small" @click="openDelete">删除</el-button>
    </el-col>
  </el-row>

  <el-table
    ref="tableRef"
    :data="rows"
    row-key="secid"
    height="317"
    size="default"
    style="width: 100%"
    @selection-change="onSelectionChange"
  >
    <el-table-column v-if="showToolbar" type="selection" width="55" />
    <el-table-column prop="name" label="名称" width="180" />
    <el-table-column prop="symbol" label="代码" width="100" />
    <el-table-column v-if="showToolbar" label="操作" width="100">
      <template #default="{ row }">
        <el-button link type="primary" size="small" @click="deleteOne(row)">删除</el-button>
      </template>
    </el-table-column>
  </el-table>

  <el-dialog
    v-model="dialogVisible"
    title="删除"
    class="item-change-dialog"
    width="60%"
  >
    <GroupItemChangeDialog action="delete" :symbols="selected" />
    <template #footer>
      <span class="dialog-footer">
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmDelete">确认</el-button>
      </span>
    </template>
  </el-dialog>

  <el-dialog
    v-model="pickerVisible"
    :title="`从自选添加到「${currentGroup.name}」`"
    class="item-change-dialog picker-dialog"
    width="60%"
    top="6vh"
  >
    <el-input
      v-model="pickerKeyword"
      size="default"
      class="picker-search"
      placeholder="搜索股票名称或代码"
      clearable
    />
    <div class="picker-all">
      <el-checkbox v-model="allChecked" :indeterminate="indeterminate">全选</el-checkbox>
      <span class="picker-summary">已选 {{ picked.length }} / {{ selectableOptions.length }}</span>
    </div>
    <div class="picker-list">
      <el-checkbox-group v-model="picked">
        <el-checkbox
          v-for="stock in filteredOptions"
          :key="stock.secid"
          :label="stock.secid"
          :disabled="isAdded(stock)"
          class="picker-item"
        >
          <span class="picker-name">{{ stock.name }}</span>
          <span class="picker-code">{{ stock.symbol }}</span>
          <el-tag v-if="isAdded(stock)" size="small" type="info" effect="plain" class="picker-added">
            已添加
          </el-tag>
        </el-checkbox>
      </el-checkbox-group>
      <p v-if="!filteredOptions.length" class="picker-empty">未找到匹配的自选股票</p>
    </div>
    <template #footer>
      <span class="dialog-footer">
        <el-button type="primary" @click="confirmPick">确认</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useCacheStore } from '../../stores/cache';
import { useMonitorStore } from '../../stores/monitor';
import GroupItemChangeDialog from './GroupItemChangeDialog.vue';
import { WindowConfigs } from '../../utils/windows';
import { on } from '../../utils/events';
import { isTauri } from '../../utils/env';
import { MonitorEvent } from '../../constants';

const cache = useCacheStore();
const monitor = useMonitorStore();

const tableRef = ref();
const selected = ref([]);
const dialogVisible = ref(false);

const currentGroup = computed(
  () => cache.findConceptById(cache.selectGroup) || { name: '', symbols: [] },
);
/* 一级概念自身不存股票：选中时展示其下所有二级概念股票的并集（按 secid 去重） */
const rows = computed(() => {
  const group = currentGroup.value;
  const children = group.children || [];
  if (!children.length) return group.symbols || [];
  const seen = new Set();
  const list = [];
  for (const child of children) {
    for (const s of child.symbols || []) {
      const key = s.secid || s.symbol;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(s);
    }
  }
  return list;
});

/* 股票只与二级概念绑定：自选与二级概念可添加/删除，一级概念不提供这些操作 */
const parentConcept = computed(() =>
  cache.group.find((group) => (group.children || []).some((child) => child.id == cache.selectGroup)),
);
const isWatchGroup = computed(() => currentGroup.value.id == 0);
const isSubConcept = computed(() => !!parentConcept.value);
const showToolbar = computed(() => isWatchGroup.value || isSubConcept.value);

/* 记录本次从自选移除的股票：保存成功后由分组页统一清理提醒/持仓配置 */
function markWatchRemoved(symbols) {
  if (!isWatchGroup.value) return;
  for (const s of symbols) {
    if (s.secid && !cache.removedWatchSecids.includes(s.secid)) {
      cache.removedWatchSecids.push(s.secid);
    }
  }
}

function onSelectionChange(list) {
  selected.value = list;
}

function warn(message) {
  ElMessage.warning({
    message,
    type: 'warning',
    duration: 1200,
  });
}

function openAdd() {
  if (isWatchGroup.value) {
    openSearchWindow();
    return;
  }
  pickerKeyword.value = '';
  picked.value = [];
  pickerVisible.value = true;
}

function openDelete() {
  if (selected.value.length == 0) {
    warn('未选择任何项！');
    return;
  }
  dialogVisible.value = true;
}

function clearSelection() {
  if (tableRef.value) tableRef.value.clearSelection();
}

function confirmDelete() {
  markWatchRemoved(selected.value);
  cache.deleteSymbols(selected.value, currentGroup.value.id);
  clearSelection();
  dialogVisible.value = false;
}

function deleteOne(row) {
  markWatchRemoved([row]);
  cache.deleteSymbols([row], currentGroup.value.id);
  clearSelection();
}

/* 自选页添加：打开自选的搜索窗口（保留当前概念页，便于添加后继续编辑） */
async function openSearchWindow() {
  if (!isTauri()) {
    location.hash = '#/edit';
    return;
  }
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const { getAllWindows } = await import('@tauri-apps/api/window');
  const all = await getAllWindows();
  const exists = all.find((w) => w.label === WindowConfigs.search.label);
  if (exists) {
    await exists.setFocus().catch(() => {});
    return;
  }
  const cfg = JSON.parse(JSON.stringify(WindowConfigs.search));
  new WebviewWindow(cfg.label, cfg.window);
}

/* 其他窗口删除自选时被同步剪掉的概念归属：记录原概念与原位置，
   落库失败回滚后按原样恢复；真正删除则在后续列表变更时丢弃 */
const prunedBackup = new Map();

/** 跨窗口事件载荷：Tauri 传事件对象，浏览器传载荷本身 */
function payloadOf(event) {
  if (event && typeof event === 'object' && 'payload' in event) return event.payload;
  return event;
}

/** 从各概念移除股票，并记录被剪掉的归属（自选分组本身由同步逻辑自行恢复） */
function backupAndPrune(removed) {
  const prune = (groups) => {
    for (const group of groups) {
      if (Number(group.id) === 0) {
        // 自选本身无需备份，回滚时会由自选快照重新合并回来
        group.symbols = (group.symbols || []).filter((s) => !removed.has(s.secid));
      } else {
        const kept = [];
        (group.symbols || []).forEach((s, index) => {
          if (!removed.has(s.secid)) {
            kept.push(s);
            return;
          }
          const records = prunedBackup.get(s.secid) || [];
          records.push({ groupId: group.id, index, symbol: s });
          prunedBackup.set(s.secid, records);
        });
        group.symbols = kept;
      }
      prune(group.children || []);
    }
  };
  prune(cache.group);
}

/** 回滚：把重新出现在自选里的股票放回原概念的原位置 */
function restorePruned(latestIds) {
  for (const [secid, records] of prunedBackup) {
    if (!latestIds.has(secid)) continue;
    records.sort((a, b) => a.index - b.index);
    for (const record of records) {
      const group = cache.findConceptById(record.groupId);
      if (!group) continue;
      if (!group.symbols) group.symbols = [];
      if (group.symbols.some((s) => s.secid === secid)) continue;
      group.symbols.splice(Math.min(record.index, group.symbols.length), 0, record.symbol);
    }
  }
  prunedBackup.clear();
}

/** 自选里重新出现的股票属于合法重新添加：丢弃旧概念归属，不回填 */
function dropPrunedBackup(latestIds) {
  for (const secid of [...prunedBackup.keys()]) {
    if (latestIds.has(secid)) prunedBackup.delete(secid);
  }
}

/* 搜索窗口添加股票后，把自选的新股票同步到当前概念页（保留页面上未保存的编辑） */
async function syncWatchSymbols(event) {
  await monitor.loadFromDb();
  const watch = cache.group.find((group) => group.id === 0);
  const latest = monitor.watchGroup.find((group) => group.id === 0);
  if (!watch || !latest) return;
  const pendingRemoved = new Set(cache.removedWatchSecids);
  const localIds = new Set((watch.symbols || []).map((s) => s.secid));
  const latestIds = new Set((latest.symbols || []).map((s) => s.secid));
  // 删除落库失败的回滚：先按快照把概念归属放回；其它事件里重新出现的自选视为重新添加
  if (payloadOf(event) === MonitorEvent.rollbackWatchList) restorePruned(latestIds);
  else dropPrunedBackup(latestIds);
  // 其他窗口新增的自选：合并进来（本窗口刚删除、尚未保存的不回填）
  for (const s of latest.symbols || []) {
    if (localIds.has(s.secid) || pendingRemoved.has(s.secid)) continue;
    watch.symbols.push({ ...s });
    localIds.add(s.secid);
  }
  // 其他窗口删除的自选：删自选即彻底清除，同步从自选和所有概念移除
  const removed = new Set([...localIds].filter((secid) => !latestIds.has(secid)));
  if (!removed.size) return;
  backupAndPrune(removed);
}

let offStateChange = null;

onMounted(async () => {
  offStateChange = await on('stateChange', syncWatchSymbols);
});

onBeforeUnmount(() => {
  if (offStateChange) offStateChange();
});

/* 二级概念添加：从自选中搜索并勾选股票 */
const pickerVisible = ref(false);
const pickerKeyword = ref('');
const picked = ref([]);

const watchSymbols = computed(() => {
  const watch = cache.group.find((group) => group.id === 0);
  return (watch && watch.symbols) || [];
});

const filteredOptions = computed(() => {
  const keyword = pickerKeyword.value.trim().toLowerCase();
  if (!keyword) return watchSymbols.value;
  return watchSymbols.value.filter(
    (s) =>
      (s.name || '').toLowerCase().includes(keyword) ||
      (s.symbol || '').toLowerCase().includes(keyword),
  );
});

const addedSecids = computed(
  () => new Set((currentGroup.value.symbols || []).map((s) => s.secid)),
);

function isAdded(stock) {
  return addedSecids.value.has(stock.secid);
}

const selectableOptions = computed(() => filteredOptions.value.filter((s) => !isAdded(s)));

const allChecked = computed({
  get: () =>
    selectableOptions.value.length > 0 &&
    selectableOptions.value.every((s) => picked.value.includes(s.secid)),
  set: (checked) => {
    picked.value = checked ? selectableOptions.value.map((s) => s.secid) : [];
  },
});

const indeterminate = computed(() => {
  const count = selectableOptions.value.filter((s) => picked.value.includes(s.secid)).length;
  return count > 0 && count < selectableOptions.value.length;
});

function confirmPick() {
  const symbols = watchSymbols.value.filter((s) => picked.value.includes(s.secid));
  const added = cache.addSymbols(symbols, currentGroup.value.id);
  if (added > 0) {
    ElMessage.success({
      message: `已添加 ${added} 只股票`,
      type: 'success',
      duration: 1200,
    });
  }
  picked.value = [];
  pickerVisible.value = false;
}
</script>

<style>
/* el-dialog 会被 teleport 到 body，样式需写在全局 */
.picker-search {
  margin-bottom: 4px;
}
.picker-all {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  padding-right: 20px;
}
.picker-summary {
  font-size: 12px;
  color: #909399;
}
.picker-list {
  display: flex;
  flex-direction: column;
  max-height: 148px;
  overflow-y: auto;
}
.picker-item {
  height: 26px;
}
/* 名称、代码各占固定列宽，保证多行之间每一列左边缘竖向对齐 */
.picker-item .el-checkbox__label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.picker-name {
  flex: none;
  width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.picker-code {
  flex: none;
  width: 70px;
  color: #909399;
}
.picker-added {
  flex: none;
  margin-left: 8px;
}
.picker-empty {
  margin: 0;
  padding: 30px 0;
  text-align: center;
  font-size: 12px;
  color: #b9b8b8;
}
</style>
