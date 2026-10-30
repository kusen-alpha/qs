<template>
  <div>
    <SettingItem title="面板字体大小">
      <template #main>
        <el-radio-group v-model="cache.tableSize" size="default">
          <el-radio-button label="large" border>大</el-radio-button>
          <el-radio-button label="default" border>默认</el-radio-button>
          <el-radio-button label="small" border>小</el-radio-button>
        </el-radio-group>
      </template>
    </SettingItem>

    <SettingItem title="固定宽度">
      <template #main>
        <el-switch
          size="default"
          v-model="cache.isFixWidth"
          active-color="#13ce66"
        />
        <el-input-number
          class="fixed-width-input"
          step-strictly
          size="small"
          v-model="cache.fixedWidth"
          :min="300"
          :max="800"
          :step="20"
        />
      </template>
      <template #desc> 开启后，监控面板会固定宽度，不会随着字段数量变化 </template>
    </SettingItem>

    <SettingItem title="涨跌颜色">
      <template #main>
        <el-radio-group v-model="cache.updownColor" size="default">
          <el-radio-button label="redUpGreenDown" border>红涨绿跌</el-radio-button>
          <el-radio-button label="redDownGreenUp" border>红跌绿涨</el-radio-button>
        </el-radio-group>
      </template>
    </SettingItem>

    <SettingItem title="界面透明度">
      <template #main>
        <el-slider
          v-model="cache.viewOpacity"
          :min="0"
          :max="100"
          :format-tooltip="formatPercent"
        />
      </template>
      <template #desc> 调节界面透明度，便于上班时使用 </template>
    </SettingItem>

    <SettingItem title="界面灰度">
      <template #main>
        <el-slider
          v-model="cache.viewGray"
          :min="0"
          :max="100"
          :format-tooltip="formatPercent"
        />
      </template>
      <template #desc> 调节界面灰度，100时界面为黑白色 </template>
    </SettingItem>
  </div>
</template>

<script setup>
import SettingItem from './SettingItem.vue';
import { useCacheStore } from '../../stores/cache';

const cache = useCacheStore();

function formatPercent(value) {
  return value + '%';
}
</script>
