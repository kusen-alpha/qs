<template>
  <el-menu
    class="el-menu-vertical-demo"
    :default-active="String(cache.selectGroup)"
    @select="onSelect"
  >
    <el-scrollbar height="410" noresize>
      <div class="scrollbar-flex-content">
        <template v-for="group in cache.group" :key="group.id">
          <el-menu-item
            :index="group.id_str"
            data-draggable="true"
            class="concept-item"
          >
            <span class="expand-arrow" :class="{ expanded: expandedId === group.id }">
              <ExpandIcon v-if="group.children && group.children.length" />
            </span>
            <span class="concept-name">{{ group.name }}</span>
            <span v-if="group.id !== 0" class="move-buttons">
              <el-button
                link
                class="move-btn"
                :disabled="!canMoveGroup(group, -1)"
                @click.stop="moveGroup(group, -1)"
              >↑</el-button>
              <el-button
                link
                class="move-btn"
                :disabled="!canMoveGroup(group, 1)"
                @click.stop="moveGroup(group, 1)"
              >↓</el-button>
            </span>
            <el-tag type="info" size="small" class="menu-count-tag" effect="light" round>
              {{ group.symbols.length }}
            </el-tag>
            <el-button
              v-if="group.id !== 0"
              class="add-sub-button"
              link
              :icon="PlusIcon"
              @click.stop="startAddSub(group)"
            />
          </el-menu-item>
          <template v-if="expandedId === group.id">
            <el-input
              v-if="addingSubParent === group.id"
              ref="subInputRef"
              v-model="newSubName"
              size="default"
              class="input-new-tag sub-input-new-tag"
              maxlength="18"
              @keyup.enter="confirmAddSub(group)"
            >
              <template #append>
                <el-button :icon="CheckIcon" @click="confirmAddSub(group)" />
              </template>
            </el-input>
            <el-menu-item
              v-for="child in group.children"
              :key="child.id"
              :index="child.id_str"
              class="sub-item"
              data-draggable="true"
            >
              <span class="concept-name">{{ child.name }}</span>
              <span class="move-buttons">
                <el-button
                  link
                  class="move-btn"
                  :disabled="!canMoveSub(group, child, -1)"
                  @click.stop="moveSub(group, child, -1)"
                >↑</el-button>
                <el-button
                  link
                  class="move-btn"
                  :disabled="!canMoveSub(group, child, 1)"
                  @click.stop="moveSub(group, child, 1)"
                >↓</el-button>
              </span>
              <el-tag type="info" size="small" class="menu-count-tag" effect="light" round>
                {{ child.symbols.length }}
              </el-tag>
            </el-menu-item>
          </template>
        </template>
      </div>
    </el-scrollbar>
  </el-menu>
  <el-input
    v-if="adding"
    ref="inputRef"
    v-model="newName"
    size="default"
    class="input-new-tag"
    maxlength="18"
    @keyup.enter="confirmAdd"
  >
    <template #append>
      <el-button :icon="CheckIcon" @click="confirmAdd" />
    </template>
  </el-input>
  <el-button
    v-else
    class="button-new-tag"
    size="default"
    type="primary"
    @click="startAdd"
  >
    + 新概念
  </el-button>
</template>

<style scoped>
/* app.css 合并后丢失了原组件作用域，其它页面同名的 .el-menu-item 规则会串入本页；
   这里恢复 group-menu 原有的左侧内边距与无左边框。 */
.el-menu {
  height: auto;
  display: block;
}
.el-menu-item {
  padding-left: 10px !important;
  border-left: none;
  font-weight: 400;
}
.el-menu-item.is-active {
  padding-left: 10px !important;
  border-left: none;
}
.button-new-tag,
.input-new-tag {
  height: 35px;
}
.concept-name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.add-sub-button {
  margin-left: 4px;
  padding: 0;
  height: auto;
  color: var(--el-color-primary);
  font-size: 15px;
}
/* 排序按钮：平时隐藏，悬停菜单项时出现，避免挤占名称宽度 */
.move-buttons {
  flex: none;
  display: inline-flex;
  align-items: center;
  visibility: hidden;
}
.concept-item:hover .move-buttons,
.sub-item:hover .move-buttons,
.move-buttons:focus-within {
  visibility: visible;
}
.move-btn {
  min-width: 0;
  height: auto;
  padding: 0 2px;
  font-size: 15px;
  line-height: 1;
  color: #909399;
}
.move-btn + .move-btn {
  margin-left: 0;
}
.sub-item,
.sub-item.is-active {
  /* 一级名称左侧多了 16px 展开箭头，二级同步右移，保持 16px 缩进 */
  padding-left: 42px !important;
  font-size: 12px;
}
.expand-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 12px;
  height: 12px;
  margin-right: 4px;
  color: #909399;
  transition: transform 0.2s;
}
.expand-arrow.expanded {
  transform: rotate(90deg);
}
.expand-arrow svg {
  width: 12px;
  height: 12px;
}
.sub-input-new-tag {
  padding: 0 10px;
  box-sizing: border-box;
}
</style>

<script setup>
import { h, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useCacheStore } from '../../stores/cache';

const cache = useCacheStore();
const adding = ref(false);
const newName = ref('');
const inputRef = ref();

const addingSubParent = ref(null);
const newSubName = ref('');
const subInputRef = ref();

/* 一级概念默认全部收缩，同一时间只展开一个 */
const expandedId = ref(null);

const ExpandIcon = () =>
  h(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 1024 1024' },
    [
      h('path', {
        fill: 'currentColor',
        d: 'M384 208 768 512 384 816z',
      }),
    ],
  );

const CheckIcon = () =>
  h(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 1024 1024' },
    [
      h('path', {
        fill: 'currentColor',
        d: 'M406.656 832.768 156.8 582.912l90.368-90.368 159.488 159.488 397.056-397.056 90.368 90.368z',
      }),
    ],
  );

const PlusIcon = () =>
  h(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 1024 1024' },
    [
      h('path', {
        fill: 'currentColor',
        d: 'M480 256h64v224h224v64H544v224h-64V544H256v-64h224V256z',
      }),
    ],
  );

function parentOfConcept(id) {
  return (
    cache.group.find((group) => (group.children || []).some((child) => child.id == id)) ||
    null
  );
}

/* 一级概念排序：自选固定在最前，只在其后的一级概念间移动 */
function canMoveGroup(group, offset) {
  const idx = cache.group.findIndex((item) => item.id == group.id);
  const target = idx + offset;
  return idx > 0 && target > 0 && target < cache.group.length;
}

function moveGroup(group, offset) {
  cache.moveConcept(group.id, offset);
}

/* 二级概念排序：仅在所属一级概念内部移动 */
function canMoveSub(group, child, offset) {
  const list = group.children || [];
  const idx = list.findIndex((item) => item.id == child.id);
  const target = idx + offset;
  return idx >= 0 && target >= 0 && target < list.length;
}

function moveSub(group, child, offset) {
  cache.moveSubConcept(group.id, child.id, offset);
}

function onSelect(index) {
  const id = Number(index);
  const parent = parentOfConcept(id);
  // 二级概念：保持所属一级概念展开，缩进不变
  if (parent) {
    cache.selectGroup = id;
    expandedId.value = parent.id;
    return;
  }
  cache.selectGroup = id;
  // 一级概念：再点一次收起
  expandedId.value = expandedId.value === id ? null : id;
}

/* 选中二级概念时展开其所属一级概念；移动到其他一级概念后也会自动跟着展开 */
watch(
  () => parentOfConcept(cache.selectGroup)?.id ?? null,
  (parentId) => {
    if (parentId) expandedId.value = parentId;
  },
  { immediate: true },
);

function startAdd() {
  adding.value = true;
  nextTick(() => {
    inputRef.value.input.focus();
  });
}

function confirmAdd() {
  const name = newName.value.trim();
  if (name) {
    if (cache.addConcept(name)) {
      expandedId.value = cache.group.at(-1).id;
      ElMessage.success({
        message: '创建新概念成功!',
        type: 'success',
        duration: 1500,
      });
    } else {
      ElMessage.error({
        message: '概念名已存在, 创建新概念失败!',
        type: 'error',
        duration: 2000,
      });
    }
  }
  adding.value = false;
  newName.value = '';
}

function startAddSub(group) {
  addingSubParent.value = group.id;
  expandedId.value = group.id;
  newSubName.value = '';
  nextTick(() => {
    const input = Array.isArray(subInputRef.value)
      ? subInputRef.value[0]
      : subInputRef.value;
    input?.input?.focus();
  });
}

function confirmAddSub(group) {
  const name = newSubName.value.trim();
  if (name) {
    if (cache.addSubConcept(group.id, name)) {
      ElMessage.success({
        message: '创建二级概念成功!',
        type: 'success',
        duration: 1500,
      });
    } else {
      ElMessage.error({
        message: '概念名已存在, 创建二级概念失败!',
        type: 'error',
        duration: 2000,
      });
    }
  }
  addingSubParent.value = null;
  newSubName.value = '';
}
</script>
