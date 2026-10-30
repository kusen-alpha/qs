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
            <el-tag type="info" size="small" class="menu-count-tag" effect="light" round>
              {{ group.symbols.length }}
            </el-tag>
            <el-button
              v-if="group.editable !== false"
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
import { h, nextTick, onMounted, ref } from 'vue';
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

onMounted(() => {
  const parent = parentOfConcept(cache.selectGroup);
  if (parent) expandedId.value = parent.id;
});

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
