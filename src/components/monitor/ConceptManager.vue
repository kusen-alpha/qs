<template>
  <div class="concept-panel">
    <!-- 左侧一级概念：对应 pdd 分组的左侧分组菜单 -->
    <div class="concept-aside">
      <div class="menu-list">
        <div
          v-for="item in store.concepts"
          :key="item.id"
          class="menu-item"
          :class="{ 'is-active': item.id === activeId }"
          @click="activeId = item.id"
        >
          <span class="menu-name">{{ item.name }}</span>
          <el-tag type="info" size="small" effect="light" round class="menu-count-tag">
            {{ totalSymbols(item) }}
          </el-tag>
          <span class="menu-add" title="添加二级概念" @click.stop="addSub(item)">+</span>
        </div>
        <div v-if="!store.concepts.length" class="menu-empty">暂无概念</div>
      </div>

      <el-input
        v-if="adding"
        ref="addInputRef"
        v-model="newName"
        size="default"
        class="input-new-tag"
        maxlength="18"
        placeholder="概念名称"
        @keyup.enter="confirmAdd"
        @blur="confirmAdd"
      >
        <template #append>
          <el-button :icon="Check" @click="confirmAdd" />
        </template>
      </el-input>
      <el-button v-else class="button-new-tag" size="default" type="primary" @click="startAdd">
        + 新概念
      </el-button>
    </div>

    <!-- 右侧：当前一级概念下的二级概念 -->
    <div class="concept-content">
      <div class="concept-header">
        <div class="header-name">
          <el-input
            v-if="renaming"
            ref="renameInputRef"
            v-model="conceptName"
            size="default"
            class="input-new-tag"
            maxlength="18"
            show-word-limit
            @keyup.enter="confirmRename"
          >
            <template #append>
              <el-button :icon="Check" @click="confirmRename" />
            </template>
          </el-input>
          <h6 v-else class="head-border group-name">{{ activeConcept ? activeConcept.name : '' }}</h6>
        </div>
        <div class="header-ops">
          <el-tooltip content="上移" placement="bottom" :show-after="200" :offset="-3">
            <el-button
              type="primary"
              size="default"
              :icon="ArrowUp"
              circle
              :disabled="!canMove(-1)"
              @click="moveConcept(-1)"
            />
          </el-tooltip>
          <el-tooltip content="下移" placement="bottom" :show-after="200" :offset="-3">
            <el-button
              type="primary"
              size="default"
              :icon="ArrowDown"
              circle
              :disabled="!canMove(1)"
              @click="moveConcept(1)"
            />
          </el-tooltip>
          <el-tooltip content="重命名" placement="bottom" :show-after="200" :offset="-3">
            <el-button
              type="primary"
              :disabled="!activeConcept"
              size="default"
              :icon="Edit"
              circle
              @click="startRename"
            />
          </el-tooltip>
          <el-tooltip content="删除概念" placement="bottom" :show-after="200" :offset="-3">
            <el-button
              type="danger"
              :disabled="!activeConcept"
              size="default"
              :icon="Delete"
              circle
              @click="removeConcept"
            />
          </el-tooltip>
        </div>
      </div>

      <div class="concept-main">
        <div class="icon_row">
          <el-button
            type="primary"
            class="button"
            plain
            size="small"
            :disabled="!activeConcept"
            @click="addSub(activeConcept)"
          >
            + 二级概念
          </el-button>
        </div>

        <el-table
          ref="tableRef"
          :data="subRows"
          row-key="id"
          height="400"
          size="default"
          empty-text="暂无二级概念"
          style="width: 100%"
        >
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="sub-stock-list">
                <div v-for="stock in row.symbols" :key="stock.secid" class="sub-stock-row">
                  <span class="sub-stock-name">{{ stock.name }}</span>
                  <span class="sub-stock-code">{{ stock.symbol }}</span>
                  <el-button link type="danger" size="small" @click="removeSymbol(row, stock)">移除</el-button>
                </div>
                <div v-if="!row.symbols.length" class="sub-stock-empty">
                  暂无股票，点击右侧 + 从自选添加
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="二级概念">
            <template #default="{ row }">
              <el-input
                v-if="editingSub === row.id"
                :ref="bindSubInput"
                v-model="subName"
                size="small"
                @keyup.enter="confirmSubName(row)"
                @blur="confirmSubName(row)"
              />
              <span v-else class="sub-name" title="双击重命名" @dblclick="startSubEdit(row)">
                {{ row.name }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="80" align="center">
            <template #default="{ row }">
              <el-tag type="info" size="small" effect="light" round>{{ row.symbols.length }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="moveSub(row, -1)">↑</el-button>
              <el-button link type="primary" size="small" @click="moveSub(row, 1)">↓</el-button>
              <el-button link type="primary" size="small" @click="openPicker(row)">+</el-button>
              <el-button link type="danger" size="small" @click="removeSub(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="concept-footer">
        <p class="tips-text">*可点击二级概念右侧 + 从自选添加股票；支持上下移动排序</p>
      </div>
    </div>

    <!-- 从自选中多选股票 -->
    <el-dialog v-model="pickerVisible" :title="pickerTitle" class="item-change-dialog" width="60%">
      <el-checkbox-group v-model="picked" class="picker-list">
        <el-checkbox v-for="stock in stockOptions" :key="stock.secid" :label="stock.secid" class="picker-item">
          {{ stock.name }} {{ stock.symbol }}
        </el-checkbox>
      </el-checkbox-group>
      <div v-if="!stockOptions.length" class="sub-stock-empty">自选列表为空，或全部已添加到该二级概念</div>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="pickerVisible = false">取消</el-button>
          <el-button type="primary" @click="confirmPick">确认</el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { ArrowDown, ArrowUp, Check, Delete, Edit } from '@element-plus/icons-vue';
import { useConceptStore } from '../../stores/concept';
import { useMonitorStore } from '../../stores/monitor';

const store = useConceptStore();
const monitor = useMonitorStore();

const activeId = ref('');
const activeConcept = computed(
  () => store.concepts.find((c) => c.id === activeId.value) || store.concepts[0] || null,
);
const subRows = computed(() => (activeConcept.value ? activeConcept.value.children : []));

watch(
  () => store.concepts.length,
  () => {
    if (!store.concepts.find((c) => c.id === activeId.value)) {
      activeId.value = store.concepts[0] ? store.concepts[0].id : '';
    }
  },
  { immediate: true },
);

function totalSymbols(item) {
  return item.children.reduce((n, sub) => n + sub.symbols.length, 0);
}

/* ---------------- 一级概念 ---------------- */
const adding = ref(false);
const newName = ref('');
const addInputRef = ref();

function startAdd() {
  adding.value = true;
  nextTick(() => addInputRef.value?.focus());
}

function confirmAdd() {
  if (!adding.value) return;
  const name = newName.value.trim();
  if (name) activeId.value = store.addConcept(name);
  adding.value = false;
  newName.value = '';
}

const renaming = ref(false);
const conceptName = ref('');
const renameInputRef = ref();

function startRename() {
  if (!activeConcept.value) return;
  renaming.value = true;
  conceptName.value = activeConcept.value.name;
  nextTick(() => renameInputRef.value?.focus());
}

function confirmRename() {
  if (!renaming.value) return;
  if (activeConcept.value && conceptName.value.trim()) {
    store.renameConcept(activeConcept.value.id, conceptName.value);
  }
  renaming.value = false;
}

function canMove(offset) {
  if (!activeConcept.value) return false;
  const idx = store.concepts.findIndex((c) => c.id === activeConcept.value.id);
  const target = idx + offset;
  return idx >= 0 && target >= 0 && target < store.concepts.length;
}

function moveConcept(offset) {
  if (!activeConcept.value) return;
  store.moveConcept(activeConcept.value.id, offset);
}

function removeConcept() {
  if (!activeConcept.value) return;
  ElMessageBox.confirm(`确认删除概念「${activeConcept.value.name}」？`, '确认删除', {
    type: 'warning',
  })
    .then(() => store.removeConcept(activeConcept.value.id))
    .catch(() => {});
}

/* ---------------- 二级概念 ---------------- */
const tableRef = ref();
const editingSub = ref('');
const subName = ref('');
const subInputRef = ref(null);

function bindSubInput(el) {
  subInputRef.value = el;
}

function addSub(concept) {
  if (!concept) return;
  const id = store.addSubConcept(concept.id);
  if (!id) return;
  startSubEdit({ id, name: '新二级概念' });
}

function startSubEdit(row) {
  editingSub.value = row.id;
  subName.value = row.name;
  nextTick(() => subInputRef.value?.focus());
}

function confirmSubName(row) {
  if (editingSub.value !== row.id) return;
  if (subName.value.trim()) store.renameSubConcept(activeConcept.value.id, row.id, subName.value);
  editingSub.value = '';
}

function moveSub(row, offset) {
  store.moveSubConcept(activeConcept.value.id, row.id, offset);
}

function removeSub(row) {
  store.removeSubConcept(activeConcept.value.id, row.id);
}

/* ---------------- 股票多选 ---------------- */
const pickerVisible = ref(false);
const picked = ref([]);
const pickerSub = ref(null);

const pickerTitle = computed(() => `选择自选股票 · ${pickerSub.value ? pickerSub.value.name : ''}`);

const stockOptions = computed(() => {
  const exists = new Set(((pickerSub.value && pickerSub.value.symbols) || []).map((s) => s.secid));
  return monitor.watchGroup[0].symbols.filter((s) => !exists.has(s.secid));
});

function openPicker(row) {
  pickerSub.value = row;
  picked.value = [];
  pickerVisible.value = true;
}

function confirmPick() {
  if (picked.value.length && pickerSub.value) {
    const exists = new Set(pickerSub.value.symbols.map((s) => s.secid));
    const symbols = monitor.watchGroup[0].symbols.filter(
      (s) => picked.value.includes(s.secid) && !exists.has(s.secid),
    );
    store.addSymbols(activeConcept.value.id, pickerSub.value.id, symbols);
    if (tableRef.value) tableRef.value.toggleRowExpansion(pickerSub.value, true);
  }
  pickerVisible.value = false;
}

function removeSymbol(row, stock) {
  store.removeSymbol(activeConcept.value.id, row.id, stock.secid);
}
</script>

<style scoped>
.concept-panel {
  height: 100vh;
  display: flex;
  background-color: #f2f2f2;
}

/* 左侧一级概念：pdd 分组菜单 */
.concept-aside {
  flex: none;
  width: 180px;
  display: flex;
  flex-direction: column;
  background-color: #ececec;
}
.menu-list {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.menu-item {
  display: flex;
  align-items: center;
  height: 40px;
  margin: 1px 0;
  padding: 0 2px 0 10px;
  background-color: #fff;
  font-size: 14px;
  color: #303133;
  cursor: pointer;
}
.menu-item:hover {
  color: #409eff;
}
.menu-item.is-active {
  background-color: #c6e2ff;
}
.menu-item.is-active .menu-count-tag {
  color: #409eff;
  background-color: #fff;
}
.menu-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-count-tag {
  flex: none;
  margin-left: auto;
}
.menu-add {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 0 6px 0 4px;
  border-radius: 50%;
  line-height: 16px;
  text-align: center;
  font-size: 14px;
  color: #409eff;
  visibility: hidden;
}
.menu-item:hover .menu-add {
  visibility: visible;
}
.menu-add:hover {
  background-color: #409eff;
  color: #fff;
}
.menu-empty {
  padding: 12px 10px;
  font-size: 12px;
  color: #b9b8b8;
}
.button-new-tag,
.input-new-tag {
  flex: none;
  width: 179px;
  height: 35px;
  margin: 2px 0 2px 1px;
}
.input-new-tag :deep(.el-input__inner) {
  height: 35px;
}

/* 右侧内容区 */
.concept-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background-color: #fff;
}
.concept-header {
  flex: none;
  height: 58px;
  display: flex;
  align-items: center;
  padding: 0 36px 0 10px;
  background-color: #fff;
  border-bottom: 1px solid #e8e8e8;
}
.header-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding-right: 10px;
}
.group-name {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-ops {
  flex: none;
  display: flex;
  align-items: center;
}
.header-ops .el-button + .el-button {
  margin-left: 6px;
}

.concept-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 1px;
  overflow: hidden;
}
.icon_row {
  flex: none;
  padding: 5px 0 2px 10px;
  background-color: #fff;
}
.icon_row .button {
  margin-left: 0;
}

/* 二级概念下的股票 */
.sub-stock-list {
  padding: 4px 10px 4px 48px;
}
.sub-stock-row {
  display: flex;
  align-items: center;
  height: 28px;
  font-size: 12px;
  color: #606266;
}
.sub-stock-name {
  flex: none;
}
.sub-stock-code {
  flex: 1;
  margin-left: 8px;
  color: #909399;
}
.sub-stock-empty {
  padding: 4px 0;
  font-size: 12px;
  color: #b9b8b8;
}
.sub-name {
  cursor: default;
}
.sub-name:hover {
  color: #409eff;
}

.concept-footer {
  flex: none;
  height: 40px;
  display: flex;
  align-items: center;
  background-color: #fff;
}
.tips-text {
  margin: 0 0 0 10px;
  font-size: 12px;
  color: #b9b8b8;
}

.picker-list {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  overflow-y: auto;
}
.picker-item {
  height: 28px;
}
</style>

<style>
/* 股票多选弹窗：沿用 pdd 的 item-change-dialog 样式（弹窗被 teleport 到 body，不能写在 scoped 里） */
.item-change-dialog .el-dialog__header {
  padding-top: 14px;
  text-align: center;
  font-weight: 700;
}
.item-change-dialog .el-dialog__body {
  padding-top: 5px;
  padding-left: 25px;
  padding-bottom: 5px;
}
</style>
