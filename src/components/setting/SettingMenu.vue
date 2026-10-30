<template>
  <el-menu
    class="el-menu-vertical-demo"
    default-active="0"
    style="background-color: #fff"
    @select="onSelect"
  >
    <div class="top-menu">
      <el-menu-item
        v-for="item in topMenu"
        :key="item.id"
        :index="item.id"
        style="
          padding-left: 30px !important;
          height: 49px;
          line-height: 49px;
          margin: 0;
        "
      >
        <span>{{ item.name }}</span>
      </el-menu-item>
    </div>
    <div :style="{ height: spacerHeight }" />
  </el-menu>
</template>

<script setup>
import { computed } from 'vue';
import { useCacheStore } from '../../stores/cache';
import { SettingMenu } from '../../constants';

const cache = useCacheStore();

const topMenu = [SettingMenu.GENERAL, SettingMenu.VIEW, SettingMenu.SHORTCUT];

/** 450 - 菜单项 * 49 */
const spacerHeight = computed(() => 450 - topMenu.length * 49 + 'px');

function onSelect(index) {
  for (const key in SettingMenu) {
    if (SettingMenu[key].id === index) {
      cache.curSetting = SettingMenu[key].name;
      break;
    }
  }
}
</script>
