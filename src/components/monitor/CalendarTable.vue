<template>
  <div class="calendar-panel">
    <el-table
      :data="rows"
      max-height="250"
      :cell-style="{ padding: '3px 0px' }"
      :header-cell-style="{ padding: '3px 0px' }"
      empty-text="暂无事件"
      :size="setting.tableSize"
    >
      <el-table-column prop="name" label="名称" min-width="92">
        <template #default="{ row }">
          <span class="calendar-name" :title="row.name">
            <span class="calendar-name-text">{{ row.name }}</span>
            <el-tag size="small" effect="plain" class="calendar-repeat">
              {{ row.repeat_text }}
            </el-tag>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="start_date" label="开始" width="80" align="center" />
      <el-table-column prop="end_date" label="结束" width="80" align="center" />
      <el-table-column prop="countdown_text" label="倒计时" width="58" align="center">
        <template #default="{ row }">
          <span :class="{ 'calendar-ongoing': row.countdown_text === '进行中' }">
            {{ row.countdown_text }}
          </span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSettingStore } from '../../stores/setting';
import { on, emit } from '../../utils/events';
import { applyDragRegion } from '../../utils/layout';
import { buildCalendarRows, formatDate } from '../../utils/calendar';
import { loadCalendarEvents } from '../../utils/db';

const setting = useSettingStore();
const events = ref([]);
const today = ref(new Date());

let offs = [];
let todayTimer = null;

const rows = computed(() => buildCalendarRows(events.value, today.value));

async function load() {
  events.value = await loadCalendarEvents();
  applyDragRegion(['el-table__cell', 'cell', 'el-table__empty-block', 'el-table__empty-text']);
  // 行数变化会改变卡片高度，通知主窗口按内容重新调整尺寸，避免底部图标栏被挤出窗口
  emit('stateChange');
}

/** 跨天后刷新倒计时 */
function refreshToday() {
  const now = new Date();
  if (formatDate(now) !== formatDate(today.value)) today.value = now;
}

onMounted(async () => {
  await load();
  todayTimer = setInterval(refreshToday, 60000);
  offs.push(await on('calendarChanged', load));
});

onBeforeUnmount(() => {
  clearInterval(todayTimer);
  offs.forEach((off) => off && off());
});
</script>

<style scoped>
.calendar-panel {
  display: flex;
  flex-direction: column;
}
.calendar-name {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
}
.calendar-name-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.calendar-repeat {
  flex: none;
  margin-left: 4px;
  transform: scale(0.9);
}
.calendar-ongoing {
  color: #e6a23c;
}
</style>
