<template>
  <el-card class="setup-card" :body-style="{ padding: '0' }" data-tauri-drag-region>
    <div class="setup-body">
      <div class="setup-head" data-tauri-drag-region>
        <div class="setup-title" data-tauri-drag-region>初始化设置</div>
        <div class="setup-sub" data-tauri-drag-region>
          选择数据存储方式，配置完成并通过连接校验后进入主界面
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
        <el-radio-button label="sqlite">SQLite（本地文件）</el-radio-button>
        <el-radio-button label="mysql">MySQL（远程数据库）</el-radio-button>
      </el-radio-group>

      <el-form v-if="form.type === 'sqlite'" label-width="84px" class="setup-form">
        <el-form-item label="数据库文件">
          <div class="path-row">
            <el-input
              v-model="form.sqlite.path"
              placeholder="选择或输入 SQLite 数据库文件路径"
              spellcheck="false"
            />
            <el-button @click="pickFile">选择</el-button>
          </div>
        </el-form-item>
        <div class="setup-hint">
          文件不存在时会自动新建（含全部表结构）；请勿选择已有数据的旧库，除非确认覆盖。
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
          <el-input v-model="form.mysql.username" placeholder="MySQL 用户名" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.mysql.password"
            type="password"
            show-password
            placeholder="MySQL 密码"
          />
        </el-form-item>
        <div class="setup-hint">数据库不存在时会自动创建；密码会加密保存在本机配置文件中。</div>
      </el-form>

      <div class="setup-actions">
        <el-button :loading="testing" :disabled="saving" @click="onTest">测试连接</el-button>
        <el-button type="primary" :loading="saving" :disabled="testing" @click="onSave">
          保存并进入
        </el-button>
      </div>
      <div v-if="feedback" :class="['setup-feedback', feedback.ok ? 'ok' : 'error']">
        {{ feedback.text }}
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { configureDb, getDbSetupState, testDbConnection } from '../utils/db';
import { isTauri } from '../utils/env';
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
  mysql: { host: '127.0.0.1', port: 3306, database: 'qushi', username: 'root', password: '' },
});

function clearFeedback() {
  feedback.value = null;
}

function setFeedback(ok, text) {
  feedback.value = { ok, text };
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
  if (!form.mysql.host.trim() || !form.mysql.database.trim() || !form.mysql.username.trim()) {
    setFeedback(false, '请填写主机、数据库名和用户名');
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
  const result = await configureDb(buildPayload());
  if (!result?.ok) {
    saving.value = false;
    setFeedback(false, result?.message || '配置失败');
    return;
  }
  markConfigured();
  await initStores();
  saving.value = false;
  router.replace('/');
}

async function pickFile() {
  if (!isTauri()) return;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      multiple: false,
      directory: false,
      defaultPath: form.sqlite.path || undefined,
      filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    if (typeof path === 'string' && path) form.sqlite.path = path;
  } catch (e) {
    setFeedback(false, `选择文件失败：${String(e)}`);
  }
}

async function enlargeWindow() {
  if (!isTauri()) return;
  try {
    const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/dpi'),
    ]);
    await getCurrentWindow().setSize(new LogicalSize(640, 620));
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
  box-sizing: border-box;
  height: 100%;
  padding: 18px 20px 16px;
  display: flex;
  flex-direction: column;
}
.setup-head {
  margin-bottom: 14px;
}
.setup-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
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
  margin-bottom: 16px;
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
  margin-bottom: 14px;
}
.path-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.path-row .el-input {
  flex: 1;
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
  margin-top: 12px;
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
</style>
