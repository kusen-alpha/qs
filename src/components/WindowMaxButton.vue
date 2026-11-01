<template>
  <el-button
    class="window-max-button"
    type="info"
    :style="buttonStyle"
    :title="isMaximized ? '还原' : '最大化'"
    @click="toggle"
  >
    <el-icon>
      <svg
        v-if="isMaximized"
        xmlns="http://www.w3.org/2000/svg"
        width="1em"
        height="1em"
        viewBox="0 0 24 24"
      >
        <path
          fill="currentColor"
          d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
        />
      </svg>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        width="1em"
        height="1em"
        viewBox="0 0 24 24"
      >
        <path
          fill="currentColor"
          d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
        />
      </svg>
    </el-icon>
  </el-button>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { isTauri } from '../utils/env';

const props = defineProps({
  /** 按钮宽高 */
  size: { type: Number, default: 28 },
  /** 距窗口右边缘距离，用于与关闭按钮并排 */
  right: { type: Number, default: 34 },
  /** 距窗口上边缘距离 */
  top: { type: Number, default: 3 },
  /** 背景色 */
  background: { type: String, default: '#fff' },
  /** 定位方式，主窗口标题栏内使用 static */
  position: { type: String, default: 'absolute' },
});

const isMaximized = ref(false);

const buttonStyle = computed(() => ({
  position: props.position,
  top: `${props.top}px`,
  right: `${props.right}px`,
  width: `${props.size}px`,
  height: `${props.size}px`,
  padding: '0',
  border: '0',
  '--max-btn-bg': props.background,
}));

async function toggle() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const maximized = await win.isMaximized();
  if (maximized) await win.unmaximize();
  else await win.maximize();
  isMaximized.value = !maximized;
}

onMounted(async () => {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  isMaximized.value = !!(await getCurrentWindow().isMaximized().catch(() => false));
});
</script>

<style scoped>
.window-max-button {
  z-index: 10;
  margin: 0;
  background-color: var(--max-btn-bg, #fff);
}
.window-max-button .el-icon {
  font-size: 22px;
  color: #b9b8b8;
}
.window-max-button:hover {
  background-color: #e38e8e;
}
.window-max-button:hover .el-icon {
  color: #f3f3f3;
}
</style>
