<template>
  <el-card class="bg-card">
    <el-container>
      <el-aside width="180px" class="group-asside">
        <GroupMenu />
      </el-aside>
      <el-container>
        <el-header height="58px" class="group-header">
          <GroupHeader />
        </el-header>
        <el-main class="group-main">
          <GroupItems />
        </el-main>
        <el-footer height="40px" class="group-footer">
          <p class="tips-text">*可用左侧菜单的 ↑↓ 调整概念顺序，点「保存」后生效</p>
          <el-button
            type="primary"
            size="default"
            class="save-button"
            @click="save"
          >保存</el-button>
        </el-footer>
      </el-container>
    </el-container>
    <WindowMaxButton />
    <el-button
      class="close-button"
      type="info"
      size="small"
      id="titlebar-close"
      @click="closeWindow"
    >
      <i class="el-icon">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="1em"
          height="1em"
          viewBox="0 0 24 24"
          class="el-icon"
        >
          <path
            fill="currentColor"
            d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"
          />
        </svg>
      </i>
    </el-button>
  </el-card>
</template>

<script setup>
import { onMounted, watch } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ElMessage } from 'element-plus';
import GroupMenu from '../components/group/GroupMenu.vue';
import GroupHeader from '../components/group/GroupHeader.vue';
import GroupItems from '../components/group/GroupItems.vue';
import WindowMaxButton from '../components/WindowMaxButton.vue';
import { useMonitorStore } from '../stores/monitor';
import { useCacheStore } from '../stores/cache';
import { MonitorEvent } from '../constants';
import { isTauri } from '../utils/env';
import { applyDragRegion } from '../utils/layout';

const monitor = useMonitorStore();
const cache = useCacheStore();

function loadGroups() {
  const groups = JSON.parse(JSON.stringify(monitor.watchGroup));
  for (const group of groups) {
    group.id_str = String(group.id);
    group.children = (group.children || []).map((child) => ({
      ...child,
      id_str: String(child.id),
      symbols: child.symbols || [],
    }));
  }
  cache.group = groups;
  if (!groups.find((g) => g.id == cache.selectGroup) && groups.length) {
    cache.selectGroup = groups[0].id;
  }
}

watch(
  () => cache.group.length,
  () => {
    if (!cache.findConceptById(cache.selectGroup) && cache.group.length) {
      cache.selectGroup = cache.group[0].id;
    }
  },
);

function save() {
  try {
    monitor.watchGroup = cache.group;
    monitor.persist(MonitorEvent.addWatchList);
    ElMessage.success({
      message: '保存成功',
      type: 'success',
      duration: 1200,
    });
  } catch (e) {
    ElMessage.error({
      message: '保存失败: ' + e.message,
      type: 'error',
      duration: 2000,
    });
  }
}

function closeWindow() {
  if (!isTauri()) return;
  getCurrentWindow().close().catch(() => {});
}

onMounted(() => {
  loadGroups();
  applyDragRegion([
    'el-card__body',
    'el-card',
    'el-tabs__nav-scroll',
    'el-header',
    'header-row',
    'head-border',
    'group-footer',
  ]);
});
</script>

<style scoped>
/* app.css 去掉 data-v 作用域后，其它页面的同名规则会覆盖 group 原有样式。
   以下只还原原版分组页的计算值，不新增外观。 */
.bg-card {
  --el-card-padding: 0px;
  animation: none;
}
.group-main {
  padding: 1px;
}
.group-footer {
  padding-right: 10px;
}
.group-footer .save-button {
  margin-right: 0;
}
.close-button {
  border: 0;
  height: 28px;
  width: 28px;
  margin-top: 3px;
  margin-right: 3px;
  background-color: #fff;
}
.close-button .el-icon {
  font-size: 22px;
  color: #b9b8b8;
}
.close-button:hover {
  background-color: #e38e8e;
}
.close-button:hover .el-icon {
  color: #f3f3f3;
}
</style>
