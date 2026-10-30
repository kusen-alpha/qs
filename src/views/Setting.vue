<template>
  <el-card
    class="bg-card"
    data-tauri-drag-region
    style="
      --el-card-padding: 0px;
      background-color: #f2f2f2;
      animation: none;
    "
  >
    <el-container>
      <el-aside width="150px" class="group-asside">
        <SettingMenu />
      </el-aside>
      <el-container direction="vertical">
        <el-header height="50px" class="group-header" data-tauri-drag-region>
          <SettingHeader />
        </el-header>
        <el-main class="group-main">
          <SettingMain />
          <el-affix
            position="bottom"
            :offset="5"
            class="group-footer"
            style="padding-right: 0"
          >
            <el-button size="default" class="save-button" @click="cancel">
              取消
            </el-button>
            <el-button
              type="primary"
              size="default"
              class="save-button"
              @click="save"
            >
              保存
            </el-button>
          </el-affix>
        </el-main>
      </el-container>
    </el-container>
    <el-button
      class="close-button"
      type="info"
      size="small"
      id="titlebar-close"
      style="
        width: 28px;
        height: 28px;
        padding: 0;
        background-color: #fff;
      "
      @click="close"
    >
      <el-icon class="el-icon">
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
      </el-icon>
    </el-button>
  </el-card>
</template>

<script setup>
import { onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { getCurrent } from '@tauri-apps/api/window';
import SettingMenu from '../components/setting/SettingMenu.vue';
import SettingHeader from '../components/setting/SettingHeader.vue';
import SettingMain from '../components/setting/SettingMain.vue';
import { useSettingStore } from '../stores/setting';
import { useCacheStore } from '../stores/cache';
import { isTauri } from '../utils/env';
import { applyDragRegion } from '../utils/layout';

const setting = useSettingStore();
const cache = useCacheStore();

/** 原产物 o()：用 setting store 的持久化状态重置缓存中的草稿 */
function resetDraft() {
  const draft = JSON.parse(JSON.stringify(setting.$state));
  cache.initSettings(draft);
}

function cancel() {
  resetDraft();
}

function save() {
  try {
    const next = JSON.parse(JSON.stringify(cache.$state));
    setting.updateSettings(next);
    resetDraft();
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

function close() {
  if (isTauri()) {
    getCurrent().close();
    return;
  }
  location.hash = '#/';
}

onMounted(() => {
  resetDraft();
  applyDragRegion([
    'el-card__body',
    'el-card',
    'el-tabs__nav-scroll',
    'el-header',
    'header-row',
    'head-border',
    'group-footer',
    'title',
  ]);
});
</script>
