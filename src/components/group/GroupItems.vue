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
    <el-table-column prop="exchange" label="类别" width="100" />
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
  cache.deleteSymbols(selected.value, currentGroup.value.name);
  clearSelection();
  dialogVisible.value = false;
}

function deleteOne(row) {
  cache.deleteSymbols([row], currentGroup.value.name);
  clearSelection();
}

/* 自选页添加：打开自选的搜索窗口（保留当前概念页，便于添加后继续编辑） */
async function openSearchWindow() {
  if (!isTauri()) {
    location.hash = '#/edit';
    return;
  }
  const { WebviewWindow, getAll } = await import('@tauri-apps/api/window');
  const exists = getAll().find((w) => w.label === WindowConfigs.search.label);
  if (exists) {
    await exists.setFocus().catch(() => {});
    return;
  }
  const cfg = JSON.parse(JSON.stringify(WindowConfigs.search));
  new WebviewWindow(cfg.label, cfg.window);
}

/* 搜索窗口添加股票后，把自选的新股票同步到当前概念页（保留页面上未保存的编辑） */
async function syncWatchSymbols() {
  monitor.$hydrate({ runHooks: false });
  const watch = cache.group.find((group) => group.id === 0);
  const latest = monitor.watchGroup.find((group) => group.id === 0);
  if (!watch || !latest) return;
  const exists = new Set((watch.symbols || []).map((s) => s.secid));
  for (const s of latest.symbols || []) {
    if (exists.has(s.secid)) continue;
    watch.symbols.push({ ...s });
    exists.add(s.secid);
  }
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
