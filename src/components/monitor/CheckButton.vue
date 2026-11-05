<template>
  <div class="check-root">
    <el-button class="check-trigger" type="info" text title="数据校验" @click="open">
      <el-icon>
        <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">
          <path
            fill="currentColor"
            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
          />
        </svg>
      </el-icon>
    </el-button>
  </div>
</template>

<script setup>
import { openWindow, WindowConfigs } from '../../utils/windows';

function open() {
  openWindow(WindowConfigs.check);
}
</script>

<style scoped>
.check-root {
  display: flex;
  align-items: center;
}
.check-trigger {
  z-index: 10;
  width: 20px;
  height: 20px;
  min-height: 20px;
  margin: 0;
  padding: 0;
  border: none;
  background-color: transparent;
}
.check-trigger .el-icon {
  font-size: 18px;
  color: #909399;
}
.check-trigger:hover {
  background-color: transparent;
}
.check-trigger:hover .el-icon {
  color: #409eff;
}
</style>
