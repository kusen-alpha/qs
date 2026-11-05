<template>
  <el-card class="setup-card" :body-style="{ padding: '0' }" data-tauri-drag-region>
    <div class="setup-body">
      <el-button class="close-button" type="info" title="关闭" @click="close">
        <el-icon><Close /></el-icon>
      </el-button>
      <div class="setup-head" data-tauri-drag-region>
        <div class="setup-title" data-tauri-drag-region>初始化设置</div>
        <div class="setup-sub" data-tauri-drag-region>
          选择数据存储方式，校验通过后进入主界面
        </div>
      </div>

      <el-alert
        v-if="startupError"
        class="setup-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="`上次配置连接失败：${startupError}`"
      />

      <el-radio-group v-model="form.type" class="type-switch" @change="clearFeedback">
        <el-radio-button label="sqlite">SQLite</el-radio-button>
        <el-radio-button label="mysql">MySQL</el-radio-button>
      </el-radio-group>

      <el-form v-if="form.type === 'sqlite'" label-width="84px" class="setup-form">
        <el-form-item label="数据库文件">
          <div class="path-row">
            <div
              class="path-display"
              :class="{ empty: !form.sqlite.path }"
              :title="form.sqlite.path || '未选择数据库文件'"
            >
              <!-- 容器 direction: rtl 负责左侧省略；内层强制 ltr 保证路径字符顺序正常 -->
              <span class="path-text" dir="ltr">
                {{ sqliteDisplay || '未选择数据库文件' }}
              </span>
            </div>
            <el-button class="path-pick-btn" title="选择数据库所在目录" @click="pickDirectory">
              选择
            </el-button>
          </div>
        </el-form-item>
        <div class="setup-hint">
          自动使用目录中的 stocks.db，没有则新建。
        </div>
      </el-form>

      <el-form v-else label-width="84px" class="setup-form">
        <el-form-item label="主机 / 端口">
          <div class="path-row">
            <el-input v-model="form.mysql.host" placeholder="主机地址，如 127.0.0.1" />
            <el-input
              v-model.number="form.mysql.port"
              class="port-input"
              type="number"
              placeholder="3306"
            />
          </div>
        </el-form-item>
        <el-form-item label="数据库名">
          <el-input v-model="form.mysql.database" placeholder="数据库名，如 qushi" />
        </el-form-item>
        <el-form-item label="用户名">
          <el-input v-model="form.mysql.username" placeholder="默认 root" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.mysql.password"
            type="password"
            show-password
            placeholder="留空则用空密码或已保存密码"
          />
        </el-form-item>
        <div class="setup-hint">数据库不存在时自动创建；用户名、密码可留空。</div>
      </el-form>

      <div class="setup-actions">
        <el-button :loading="testing" :disabled="saving" @click="onTest">测试连接</el-button>
        <el-button type="primary" :loading="saving" :disabled="testing" @click="onSave">
          保存并进入
        </el-button>
      </div>
      <div v-if="feedback" :class="['setup-feedback', feedback.kind || (feedback.ok ? 'ok' : 'error')]">
        {{ feedback.text }}
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Close } from '@element-plus/icons-vue';
import {
  configureDb,
  getDbSetupState,
  listSqliteFiles,
  prepareSqlite,
  testDbConnection,
} from '../utils/db';
import { isTauri } from '../utils/env';
import { setProfileId } from '../utils/file';
import { profileKey } from '../utils/profile';
import { markConfigured } from '../utils/setup';
import { initStores } from '../stores';

const router = useRouter();
const testing = ref(false);
const saving = ref(false);
const startupError = ref('');
const feedback = ref(null);

const form = reactive({
  type: 'sqlite',
  sqlite: { path: '' },
  mysql: { host: '127.0.0.1', port: 3306, database: 'qushi', username: '', password: '' },
});

/** 显示完整路径，超长时右侧保住文件名、左侧省略 */
const sqliteDisplay = computed(() => form.sqlite.path.trim());

async function close() {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } catch (e) {
    /* 关闭失败忽略 */
  }
}

function clearFeedback() {
  feedback.value = null;
}

function setFeedback(ok, text) {
  feedback.value = { ok, text };
}

/** 信息提示（非成功/失败语气），用于目录自动识别结果 */
function setInfo(text) {
  feedback.value = { ok: true, text, kind: 'info' };
}

function buildPayload() {
  if (form.type === 'sqlite') {
    return { type: 'sqlite', sqlite: { path: form.sqlite.path.trim() } };
  }
  return {
    type: 'mysql',
    mysql: {
      host: form.mysql.host.trim(),
      port: Number(form.mysql.port) || 3306,
      database: form.mysql.database.trim(),
      username: form.mysql.username.trim(),
      password: form.mysql.password,
    },
  };
}

function validate() {
  if (form.type === 'sqlite') {
    if (!form.sqlite.path.trim()) {
      setFeedback(false, '请选择 SQLite 数据库文件路径');
      return false;
    }
    return true;
  }
  if (!form.mysql.host.trim() || !form.mysql.database.trim()) {
    setFeedback(false, '请填写主机和数据库名');
    return false;
  }
  const port = Number(form.mysql.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    setFeedback(false, '端口需在 1 - 65535 之间');
    return false;
  }
  return true;
}

async function onTest() {
  if (!validate()) return;
  testing.value = true;
  clearFeedback();
  const result = await testDbConnection(buildPayload());
  testing.value = false;
  setFeedback(!!result?.ok, result?.message || (result?.ok ? '连接成功' : '连接失败'));
}

async function onSave() {
  if (!validate()) return;
  saving.value = true;
  clearFeedback();
  const payload = buildPayload();
  const result = await configureDb(payload);
  if (!result?.ok) {
    saving.value = false;
    setFeedback(false, result?.message || '配置失败');
    return;
  }
  // 切换到该数据库对应的配置目录，再载入它自己的设置与缓存
  setProfileId(profileKey(payload));
  markConfigured();
  await initStores();
  saving.value = false;
  router.replace('/');
}

/** 目录与文件名拼接（Windows 目录用反斜杠，其余用正斜杠） */
function joinPath(dir, name) {
  const base = dir.replace(/[\\/]+$/, '');
  return `${base}${dir.includes('\\') ? '\\' : '/'}${name}`;
}

/**
 * 选择目录：优先沿用目录下已有的 stocks.db；只有其它 .db 文件时取第一个；
 * 都没有时指向 stocks.db，并立即新建（含表结构）。
 */
async function pickDirectory() {
  if (!isTauri()) return;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ title: '选择数据库所在目录', directory: true });
    if (typeof dir !== 'string' || !dir) return;
    const files = await listSqliteFiles(dir);
    const name = files.includes('stocks.db') ? 'stocks.db' : files[0] || 'stocks.db';
    form.sqlite.path = joinPath(dir, name);
    const prepared = await prepareSqlite(form.sqlite.path);
    if (!prepared.ok) {
      setFeedback(false, prepared.message || '创建数据库失败');
      return;
    }
    if (files.length) setInfo(`已使用目录中的 ${name}`);
    else setInfo(`已新建 ${name}`);
  } catch (e) {
    setFeedback(false, `选择目录失败：${String(e)}`);
  }
}

async function enlargeWindow() {
  if (!isTauri()) return;
  try {
    const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/dpi'),
    ]);
    await getCurrentWindow().setSize(new LogicalSize(440, 380));
  } catch (e) {
    /* 窗口尺寸调整失败不影响配置 */
  }
}

onMounted(async () => {
  enlargeWindow();
  const state = await getDbSetupState();
  startupError.value = state?.error || '';
  if (state?.config) {
    form.type = state.config.type === 'mysql' ? 'mysql' : 'sqlite';
    if (state.config.sqlite?.path) form.sqlite.path = state.config.sqlite.path;
    else if (state.default_sqlite_path) form.sqlite.path = state.default_sqlite_path;
    if (state.config.mysql) {
      form.mysql.host = state.config.mysql.host || form.mysql.host;
      form.mysql.port = state.config.mysql.port || 3306;
      form.mysql.database = state.config.mysql.database || form.mysql.database;
      form.mysql.username = state.config.mysql.username || form.mysql.username;
    }
  } else if (state?.default_sqlite_path) {
    form.sqlite.path = state.default_sqlite_path;
  }
});
</script>

<style scoped>
.setup-card {
  width: 100%;
  height: 100%;
  border-radius: 12px;
  background: var(--el-bg-color);
}
.setup-card :deep(.el-card__body) {
  box-sizing: border-box;
  height: 100%;
}
.setup-body {
  position: relative;
  box-sizing: border-box;
  height: 100%;
  padding: 14px 16px 12px;
  display: flex;
  flex-direction: column;
}
.setup-head {
  margin-bottom: 12px;
}
.setup-title {
  padding-right: 32px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.close-button {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 10;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
}
.close-button .el-icon {
  font-size: 18px;
  color: #b9b8b8;
}
.close-button:hover {
  background-color: #e38e8e;
}
.close-button:hover .el-icon {
  color: #f3f3f3;
}
.setup-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.setup-alert {
  margin-bottom: 12px;
}
.type-switch {
  display: flex;
  width: 100%;
  margin-bottom: 12px;
}
.type-switch :deep(.el-radio-button) {
  flex: 1;
}
.type-switch :deep(.el-radio-button__inner) {
  width: 100%;
}
.setup-form {
  flex: 1;
}
.setup-form :deep(.el-form-item) {
  margin-bottom: 10px;
}
.path-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.path-display {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 11px;
  box-sizing: border-box;
  line-height: 30px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 右侧显示完整文件名，超长时从左侧省略 */
  direction: rtl;
  text-align: right;
}
.path-display.empty {
  color: var(--el-text-color-placeholder);
}
.path-text {
  /* 强制按 LTR 排列，避免 rtl 容器把路径片段顺序打乱 */
  direction: ltr;
  unicode-bidi: bidi-override;
}
.path-pick-btn {
  flex: none;
}
.port-input {
  width: 92px;
  flex: none;
}
.setup-hint {
  margin: 2px 0 0 84px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.setup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.setup-feedback {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}
.setup-feedback.ok {
  color: var(--el-color-success);
}
.setup-feedback.error {
  color: var(--el-color-danger);
}
.setup-feedback.info {
  color: var(--el-text-color-secondary);
}
</style>
