<template>
  <el-card
    class="bg-card calendar-window"
    data-tauri-drag-region
    style="--el-card-padding: 0px; background-color: #f2f2f2; animation: none"
  >
    <div class="calendar-header" data-tauri-drag-region>
      <span class="calendar-title" data-tauri-drag-region>
        {{ isEdit ? '编辑事件' : '日历事件' }}
      </span>
    </div>

    <div class="calendar-body">
      <el-form label-width="76px" size="default" @submit.prevent>
        <el-form-item label="事件名称">
          <el-input
            v-model="form.name"
            maxlength="30"
            show-word-limit
            placeholder="请输入事件名称"
            @keyup.enter="save"
          />
        </el-form-item>
        <el-form-item label="开始日期">
          <el-date-picker
            v-model="form.start_date"
            class="calendar-date-picker"
            popper-class="calendar-date-popper"
            type="date"
            value-format="YYYY-MM-DD"
            format="YYYY-MM-DD"
            placeholder="选择开始日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="结束日期">
          <el-date-picker
            v-model="form.end_date"
            class="calendar-date-picker"
            popper-class="calendar-date-popper"
            type="date"
            value-format="YYYY-MM-DD"
            format="YYYY-MM-DD"
            placeholder="选择结束日期"
            :disabled-date="disabledEndDate"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="重复">
          <el-select v-model="form.repeat_type" style="width: 100%">
            <el-option label="无" value="none" />
            <el-option label="每月" value="monthly" />
            <el-option label="每年" value="yearly" />
          </el-select>
        </el-form-item>
      </el-form>

      <div class="calendar-form-actions">
        <el-button v-if="isEdit" @click="cancelEdit">取消编辑</el-button>
        <el-button type="primary" :loading="saving" @click="save">
          {{ isEdit ? '保存修改' : '添加事件' }}
        </el-button>
      </div>

      <el-divider content-position="left">已有事件（{{ events.length }}）</el-divider>
      <div class="calendar-event-list">
        <div
          v-for="item in events"
          :key="item.id"
          class="calendar-event-item"
          :class="{ editing: item.id === editingId }"
        >
          <div class="calendar-event-info">
            <span class="calendar-event-name" :title="item.name">{{ item.name }}</span>
            <div class="calendar-event-meta">
              <span class="calendar-event-date">
                {{ item.start_date }} ~ {{ item.end_date }}
              </span>
              <el-tag size="small" effect="plain">{{ repeatText(item.repeat_type) }}</el-tag>
            </div>
          </div>
          <div class="calendar-event-ops">
            <el-button link type="primary" size="small" @click="startEdit(item)">编辑</el-button>
            <el-button link type="danger" size="small" @click="remove(item)">删除</el-button>
          </div>
        </div>
        <p v-if="!events.length" class="calendar-event-empty">暂无事件</p>
      </div>
    </div>

    <WindowMaxButton />
    <el-button
      class="close-button"
      type="info"
      size="small"
      id="titlebar-close"
      @click="closeWindow"
    >
      <el-icon class="el-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">
          <path
            fill="currentColor"
            d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"
          />
        </svg>
      </el-icon>
    </el-button>
  </el-card>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WindowMaxButton from '../components/WindowMaxButton.vue';
import { formatDate, repeatText } from '../utils/calendar';
import {
  deleteCalendarEvent,
  loadCalendarEvents,
  saveCalendarEvent,
} from '../utils/db';
import { emit } from '../utils/events';
import { isTauri } from '../utils/env';

const events = ref([]);
const editingId = ref(null);
const isEdit = computed(() => editingId.value != null);
const saving = ref(false);
const form = reactive({
  name: '',
  start_date: '',
  end_date: '',
  repeat_type: 'none',
});

async function loadEvents() {
  events.value = await loadCalendarEvents();
}

/** 编辑时回填首次录入的日期，保存后由列表自动推算下一次发生 */
function startEdit(item) {
  editingId.value = item.id;
  form.name = item.name;
  form.start_date = item.start_date;
  form.end_date = item.end_date;
  form.repeat_type = item.repeat_type || 'none';
}

function cancelEdit() {
  reset();
}

function reset() {
  editingId.value = null;
  form.name = '';
  form.start_date = '';
  form.end_date = '';
  form.repeat_type = 'none';
  saving.value = false;
}

/** 结束日期不能早于开始日期 */
function disabledEndDate(time) {
  return Boolean(form.start_date) && formatDate(time) < form.start_date;
}

async function save() {
  const name = form.name.trim();
  if (!name) {
    ElMessage.warning('请输入事件名称');
    return;
  }
  if (!form.start_date || !form.end_date) {
    ElMessage.warning('请选择开始和结束日期');
    return;
  }
  if (form.end_date < form.start_date) {
    ElMessage.warning('结束日期不能早于开始日期');
    return;
  }

  saving.value = true;
  const payload = {
    name,
    start_date: form.start_date,
    end_date: form.end_date,
    repeat_type: form.repeat_type,
  };
  if (isEdit.value) payload.id = editingId.value;
  const id = await saveCalendarEvent(payload);
  saving.value = false;
  if (id == null) {
    ElMessage.error('保存失败');
    return;
  }
  ElMessage.success(isEdit.value ? '修改成功' : '添加成功');
  reset();
  await loadEvents();
  emit('calendarChanged');
}

function remove(item) {
  ElMessageBox.confirm(`确认删除事件「${item.name}」？`, '确认删除', { type: 'warning' })
    .then(async () => {
      await deleteCalendarEvent(item.id);
      if (editingId.value === item.id) reset();
      await loadEvents();
      emit('calendarChanged');
    })
    .catch(() => {});
}

function closeWindow() {
  if (!isTauri()) return;
  getCurrentWindow().close().catch(() => {});
}

onMounted(loadEvents);
</script>

<style scoped>
.calendar-window {
  position: relative;
  height: 100vh;
  overflow: hidden;
}
.calendar-header {
  height: 34px;
  display: flex;
  align-items: center;
  padding: 0 72px 0 14px;
  box-sizing: border-box;
}
.calendar-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}
.calendar-body {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 34px);
  padding: 4px 14px 10px;
  box-sizing: border-box;
}
.calendar-body :deep(.el-form-item) {
  margin-bottom: 12px;
}
.calendar-window :deep(.el-input__wrapper) {
  border-radius: 6px;
  background-color: #fff;
  box-shadow: 0 0 0 1px var(--el-border-color) inset;
  transition: box-shadow 0.15s ease;
}
.calendar-window :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px var(--el-border-color-darker) inset;
}
.calendar-window :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}
.calendar-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.calendar-body :deep(.el-divider) {
  margin: 10px 0 6px;
}
.calendar-event-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.calendar-event-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.calendar-event-item.editing {
  background: var(--el-fill-color-light);
}
.calendar-event-info {
  flex: 1;
  min-width: 0;
}
.calendar-event-name {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.calendar-event-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.calendar-event-date {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  white-space: nowrap;
}
.calendar-event-ops {
  flex: none;
  display: flex;
  align-items: center;
  margin-left: 8px;
}
.calendar-event-ops :deep(.el-button + .el-button) {
  margin-left: 2px;
}
.calendar-event-empty {
  margin: 16px 0;
  color: var(--el-text-color-secondary);
  text-align: center;
  font-size: 12px;
}
.close-button {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background-color: #fff;
}
.close-button .el-icon {
  font-size: 22px;
  color: #b9b8b8;
}
.close-button:hover {
  background-color: #e38e8e;
}
.close-button:hover .el-icon {
  color: #f3f3f3;
}
</style>

<style>
.calendar-date-popper.el-popper {
  border: none;
  background: transparent;
  box-shadow: none;
}
.calendar-date-popper .el-popper__arrow {
  display: none;
}
.calendar-date-popper .el-picker-panel {
  width: 264px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 4px 6px 6px;
  box-sizing: border-box;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.12);
}
.calendar-date-popper .el-picker-panel__content {
  width: 100%;
}
.calendar-date-popper .el-date-picker__header {
  margin: 2px 6px 4px;
}
.calendar-date-popper .el-date-picker__header-label {
  font-size: 12px;
  font-weight: 600;
}
.calendar-date-popper .el-date-table th {
  padding: 3px 0;
  font-size: 10px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
}
.calendar-date-popper .el-date-table td {
  height: 28px;
  padding: 2px 0;
}
.calendar-date-popper .el-date-table td .el-date-table-cell {
  height: 28px;
  padding: 2px 0;
}
.calendar-date-popper .el-date-table td .el-date-table-cell__text {
  width: 22px;
  height: 22px;
  line-height: 22px;
  font-size: 11px;
}
.calendar-date-popper .el-date-table td.today .el-date-table-cell__text {
  color: var(--el-color-primary);
  font-weight: 600;
}
</style>
