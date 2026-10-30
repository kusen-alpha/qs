<template>
  <el-card class="concept-card">
    <div class="concept-layout">
      <ConceptManager />
      <el-button class="concept-close" type="info" size="small" @click="close">
        <el-icon>
          <Close />
        </el-icon>
      </el-button>
    </div>
  </el-card>
</template>

<script setup>
import { onMounted } from 'vue';
import { Close } from '@element-plus/icons-vue';
import ConceptManager from '../components/monitor/ConceptManager.vue';
import { applyDragRegion } from '../utils/layout';
import { closeWindow, WindowConfigs } from '../utils/windows';

function close() {
  closeWindow(WindowConfigs.concept);
}

onMounted(() => {
  applyDragRegion(['el-card__body', 'el-card', 'concept-header', 'header-row']);
});
</script>

<style>
.concept-card {
  position: relative;
  background-color: #f2f2f2;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  border: 0;
  box-shadow: none;
  --el-card-padding: 0px;
  --el-card-border-radius: 4px;
}
.concept-card .el-card__body {
  padding: 0;
  height: 100%;
  box-sizing: border-box;
}
.concept-layout {
  position: relative;
  height: 100%;
}
.concept-close {
  position: absolute;
  top: 3px;
  right: 3px;
  height: 28px;
  width: 28px;
  padding: 0;
  border: 0;
  background-color: #fff;
  z-index: 10;
}
.concept-close .el-icon {
  font-size: 22px;
  color: #b9b8b8;
}
.concept-close:hover {
  background-color: #e38e8e;
}
.concept-close:hover .el-icon {
  color: #f3f3f3;
}
</style>
