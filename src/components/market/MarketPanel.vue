<template>
  <div class="market-panel">
    <el-button
      v-for="tool in TOOLS"
      :key="tool.key"
      class="market-tool"
      type="primary"
      plain
      size="small"
      @click="openTool(tool.key)"
      >{{ tool.label }}</el-button
    >
  </div>
</template>

<script setup>
import { WindowConfigs, openWindow } from '../../utils/windows';

/* 行情数据类工具：每个按钮打开独立子窗口，避免受主窗口尺寸限制 */
const TOOLS = [{ key: 'marketWidth', label: '市场宽度' }];

function openTool(key) {
  if (key === 'marketWidth') openWindow(WindowConfigs.marketWidth);
}
</script>

<style scoped>
.market-panel {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 6px 2px;
}
.market-tool {
  width: 100%;
  margin-left: 0;
}
</style>
