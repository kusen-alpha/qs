<template>
  <el-scrollbar height="340px" class="scroll-main" style="height: 340px">
    <GeneralSetting v-if="cur === SettingMenu.GENERAL.name" />
    <ViewSetting v-else-if="cur === SettingMenu.VIEW.name" />
    <ShortcutSetting v-else-if="cur === SettingMenu.SHORTCUT.name" />
  </el-scrollbar>
</template>

<script setup>
import { computed } from 'vue';
import GeneralSetting from './GeneralSetting.vue';
import ViewSetting from './ViewSetting.vue';
import ShortcutSetting from './ShortcutSetting.vue';
import { useCacheStore } from '../../stores/cache';
import { SettingMenu } from '../../constants';

const cache = useCacheStore();
const cur = computed(() => cache.curSetting);
</script>
