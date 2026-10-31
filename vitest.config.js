import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

/**
 * 回归测试配置（与 vite.config.js 保持同样的 alias / Vue 插件）。
 * Tauri API 在测试里统一指向 tests/mocks/tauri-api.js，避免真的调用 IPC。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      {
        find: /^@tauri-apps\/api\/(core|tauri|event|window|webviewWindow|fs|path|http)$/,
        replacement: path.resolve(process.cwd(), 'tests/mocks/tauri-api.js'),
      },
      {
        find: /^@tauri-apps\/plugin-(fs|http|global-shortcut)$/,
        replacement: path.resolve(process.cwd(), 'tests/mocks/tauri-api.js'),
      },
      { find: '@', replacement: path.resolve(process.cwd(), 'src') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.js'],
    setupFiles: ['./tests/setup.js'],
    clearMocks: true,
    restoreMocks: true,
  },
});
