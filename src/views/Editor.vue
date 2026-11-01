<template>
  <el-card class="bg-card">
    <div class="common-layout">
      <Search />
      <WindowMaxButton :size="30" :right="36" background="#f2f2f2" />
      <el-button
        class="close-button"
        type="info"
        id="titlebar-close"
        @click="close"
      >
        <el-icon>
          <Close class="el-icon" />
        </el-icon>
      </el-button>
    </div>
  </el-card>
</template>

<script setup>
import { onMounted } from 'vue';
import { Close } from '@element-plus/icons-vue';
import Search from '../components/editor/Search.vue';
import WindowMaxButton from '../components/WindowMaxButton.vue';
import { applyDragRegion } from '../utils/layout';
import { closeWindow, WindowConfigs } from '../utils/windows';

function close() {
  closeWindow(WindowConfigs.search);
}

onMounted(() => {
  applyDragRegion(['el-card__body', 'el-card']);
});
</script>

<style>
/* 原 Editor 组件的 scoped 规则；app.css 去作用域后同名规则被其它页面覆盖，此处按原样恢复 */
.bg-card {
  background-color: #f2f2f2;
  height: 100%;
  width: 100%;
  box-sizing: content-box;
  --el-card-padding: 10px;
}
/* app.css 去作用域后，其它页面的 .el-input__inner 规则泄漏到本页，按原版计算值还原 */
.input-with-select .el-input__inner {
  width: 100% !important;
  height: 38px;
  margin-left: 0;
}
.input-with-select .el-select .el-input__wrapper,
.input-with-select .el-select .el-input__inner {
  min-width: 0;
}
.close-button {
  position: absolute;
  top: 0;
  right: 0;
  margin-top: 3px;
  margin-right: 3px;
  height: 30px;
  width: 30px;
  border: 0;
  background-color: #f2f2f2;
}
.close-button .el-icon {
  font-size: 22px;
  color: #b9b8b8;
  background-color: #fff0;
}
.close-button:hover {
  position: absolute;
  top: 0;
  right: 0;
  margin-top: 3px;
  margin-right: 3px;
  height: 30px;
  width: 30px;
  border: 0;
  background-color: #e38e8e;
}
.close-button:hover .el-icon {
  font-size: 22px;
  color: #f3f3f3;
  background-color: #fff0;
}
</style>
