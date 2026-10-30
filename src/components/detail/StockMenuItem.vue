<template>
  <div class="stock-item">
    <el-row class="stock-item-name" align="middle">
      <el-col class="stock-item-col" :span="24">{{ name }}</el-col>
    </el-row>
    <el-row class="stock-item-code" align="middle">
      <el-col class="stock-item-col" :span="16" style="float: left">{{ code }}</el-col>
      <el-col
        class="stock-item-range"
        :class="rangeValue >= 0 ? 'red' : 'green'"
        :span="8"
        style="float: right"
      >{{ range }}%</el-col>
    </el-row>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, default: '' },
  code: { type: String, default: '' },
  range: { type: [String, Number], default: '-' },
});

const rangeValue = computed(() => parseFloat(props.range));
</script>
