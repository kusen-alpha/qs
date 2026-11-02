<template>
  <el-row>
    <el-col :span="isWatch ? 10 : 24" data-tauri-drag-region>
      <div class="button-icons" data-tauri-drag-region>
        <el-tooltip effect="customized" content="设置" :offset="-2">
          <el-button
            class="buttons"
            type="primary"
            size="default"
            color="white"
            :icon="settingIcon"
            style="
              --el-button-bg-color: white;
              --el-button-text-color: var(--el-color-black);
              --el-button-border-color: white;
              --el-button-hover-bg-color: rgb(255, 255, 255);
              --el-button-hover-text-color: var(--el-color-black);
              --el-button-hover-border-color: rgb(255, 255, 255);
              --el-button-active-bg-color: rgb(208, 208, 208);
              --el-button-active-border-color: rgb(208, 208, 208);
            "
            @click="openSetting"
          />
        </el-tooltip>
        <template v-if="showAdd">
          <el-tooltip effect="customized" content="添加" :offset="-2">
            <el-button
              class="buttons"
              type="primary"
              size="default"
              color="white"
              :icon="addIcon"
              style="
                --el-button-bg-color: white;
                --el-button-text-color: var(--el-color-black);
                --el-button-border-color: white;
                --el-button-hover-bg-color: rgb(255, 255, 255);
                --el-button-hover-text-color: var(--el-color-black);
                --el-button-hover-border-color: rgb(255, 255, 255);
                --el-button-active-bg-color: rgb(208, 208, 208);
                --el-button-active-border-color: rgb(208, 208, 208);
              "
              @click="onAdd"
            />
          </el-tooltip>
        </template>
        <template v-if="showChart">
          <el-tooltip effect="customized" content="图表" :offset="-2">
            <el-button
              class="buttons"
              type="primary"
              size="default"
              color="white"
              :icon="chartIcon"
              style="
                --el-button-bg-color: white;
                --el-button-text-color: var(--el-color-black);
                --el-button-border-color: white;
                --el-button-hover-bg-color: rgb(255, 255, 255);
                --el-button-hover-text-color: var(--el-color-black);
                --el-button-hover-border-color: rgb(255, 255, 255);
                --el-button-active-bg-color: rgb(208, 208, 208);
                --el-button-active-border-color: rgb(208, 208, 208);
              "
              @click="openChart"
            />
          </el-tooltip>
        </template>
      </div>
    </el-col>
    <template v-if="isWatch">
      <el-col :span="2" />
      <el-col :span="12" data-tauri-drag-region>
        <el-tooltip effect="customized" content="点击切换" :offset="-2">
          <div class="profit" @click="toggle">
            <span class="profit-text">{{ todayMode ? '今盈亏' : '总盈亏' }}</span>
            <span :class="['profit-value', colorClass]">
              {{ todayMode ? formatAmount(cache.today_profit) : formatAmount(cache.totoal_profit) }}
            </span>
            <span :class="['profit-value', colorClass]">
              {{ todayMode ? formatRate(cache.today_profit_rate) : formatRate(cache.totoal_profit_rate) }}
            </span>
          </div>
        </el-tooltip>
      </el-col>
    </template>
  </el-row>
</template>

<script setup>
import { computed, h, ref } from 'vue';
import AppIcon from '../AppIcon.vue';
import { useCacheStore } from '../../stores/cache';
import { useSettingStore } from '../../stores/setting';
import { openWindow, WindowConfigs } from '../../utils/windows';
import { formatAmount, formatRate } from '../../api/eastmoney';

const props = defineProps({
  // 当前 tab：watch 显示添加/图表/总盈亏，concept 显示添加/图表，sector 只显示图表
  tab: { type: String, default: 'watch' },
});

const isWatch = computed(() => props.tab === 'watch');
const showAdd = computed(() => ['watch', 'concept', 'calendar'].includes(props.tab));
const showChart = computed(() => ['watch', 'concept', 'sector'].includes(props.tab));

const cache = useCacheStore();
const setting = useSettingStore();
const todayMode = ref(false);

const addIcon = () => h(AppIcon, { name: 'plus' });
const chartIcon = () => h(AppIcon, { name: 'chart' });
const settingIcon = () => h(AppIcon, { name: 'setting' });

const colorClass = computed(() => {
  const red = setting.updownColor === 'redUpGreenDown';
  if (todayMode.value) {
    return cache.today_profit >= 0 ? (red ? 'red' : 'green') : red ? 'green' : 'red';
  }
  return cache.totoal_profit >= 0 ? (red ? 'red' : 'green') : red ? 'green' : 'red';
});

function toggle() {
  todayMode.value = !todayMode.value;
}

function onAdd() {
  if (isWatch.value) openSearch();
  else if (props.tab === 'calendar') openWindow(WindowConfigs.calendar);
  else openWindow(WindowConfigs.group);
}

function openSearch() {
  openWindow(WindowConfigs.search);
}
function openChart() {
  if (isWatch.value) {
    openWindow(WindowConfigs.detail);
  } else {
    openWindow(WindowConfigs.boardChart, { kind: props.tab });
  }
}
function openSetting() {
  openWindow(WindowConfigs.setting);
}
</script>
