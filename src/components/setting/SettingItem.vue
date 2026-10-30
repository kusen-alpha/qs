<template>
  <div>
    <el-row>
      <el-col :span="7">
        <h3
          class="title"
          data-tauri-drag-region
          style="font-size: 15px; padding: 0 0 0 30px; margin: 12px 0"
        >
          {{ title }}
        </h3>
      </el-col>
      <el-col :span="17">
        <el-row
          class="main-container"
          :style="{ height: hasDesc ? '70%' : '100%' }"
        >
          <slot name="main" />
        </el-row>
        <el-row v-if="hasDesc" class="desc-container">
          <slot name="desc" />
        </el-row>
      </el-col>
    </el-row>
    <el-divider
      v-if="divider"
      class="divider"
      style="margin: 16px 0 10px"
    />
  </div>
</template>

<script setup>
import { computed, useSlots } from 'vue';

defineProps({
  title: {
    type: String,
    required: true,
  },
  divider: {
    type: Boolean,
    default: true,
  },
});

const slots = useSlots();
const hasDesc = computed(() => !!slots.desc);
</script>
