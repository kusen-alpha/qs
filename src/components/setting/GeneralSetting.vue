<template>
  <div>
    <SettingItem title="自定义监控列">
      <template #main>
        <div class="checkbox-cols">
          <el-checkbox-group
            class="checkbox-group"
            size="small"
            v-model="checkedFields"
          >
            <el-checkbox-button
              v-for="item in firstCols"
              :key="item.key"
              class="monitor-checkbox"
              border
              size="small"
              :label="item.key"
            >
              {{ item.label }}
            </el-checkbox-button>
          </el-checkbox-group>
          <el-checkbox-group
            class="checkbox-group"
            size="small"
            v-model="checkedFields"
          >
            <el-checkbox-button
              v-for="item in secondCols"
              :key="item.key"
              class="monitor-checkbox"
              border
              size="small"
              :label="item.key"
            >
              {{ item.label }}
            </el-checkbox-button>
          </el-checkbox-group>
        </div>
      </template>
      <template #desc> 选择需要显示的列, 开启太多列会影响界面宽度 </template>
    </SettingItem>

    <SettingItem title="边缘折叠">
      <template #main>
        <el-switch
          size="default"
          v-model="cache.isEdgeFold"
          active-color="#13ce66"
        />
      </template>
      <template #desc> 开启后，当移动到屏幕边缘时面板会自动折叠 </template>
    </SettingItem>

    <SettingItem title="开机自启动">
      <template #main>
        <el-switch
          size="default"
          v-model="cache.isOpenWithSystem"
          active-color="#13ce66"
        />
      </template>
      <template #desc> 开启后，程序会在系统启动时自动启动 </template>
    </SettingItem>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import SettingItem from './SettingItem.vue';
import { useCacheStore } from '../../stores/cache';

const cache = useCacheStore();

const firstCols = [
  { key: 'price', label: '当前价' },
  { key: 'range', label: '涨跌幅' },
  { key: 'price_diff', label: '涨跌额' },
  { key: 'high', label: '最高价' },
  { key: 'low', label: '最低价' },
  { key: 'turn', label: '换手率' },
  { key: 'macd', label: 'MACD' },
];

const secondCols = [
  { key: 'concept_l1', label: '一级概念' },
  { key: 'concept_l2', label: '二级概念' },
  { key: 'concept_ths', label: '同花顺概念' },
  { key: 'position_profit_rate', label: '收益率' },
  { key: 'position_profit', label: '收益额' },
  { key: 'position_num', label: '持仓量' },
  { key: 'position_price', label: '持仓价' },
  { key: 'position_value', label: '持仓金额' },
];

const checkedFields = computed({
  get() {
    const out = [];
    for (const key in cache.watchFields) {
      if (cache.watchFields[key]) out.push(key);
    }
    return out;
  },
  set(list) {
    for (const key in cache.watchFields) cache.watchFields[key] = false;
    for (const key of list) cache.watchFields[key] = true;
  },
});
</script>
