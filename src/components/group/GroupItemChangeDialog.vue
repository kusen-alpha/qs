<template>
  <div>
    <p>
      将 <b>{{ names }}</b> 等 <b>{{ symbols.length }}</b> 个股票
    </p>
    <div v-show="action == 'copy'">
      <p class="action-text">复制至分组:</p>
      <el-select
        v-model="target"
        placeholder="选择分组"
        @change="onChange"
      >
        <el-option
          v-for="group in targets"
          :key="group.id"
          size="small"
          :label="group.name"
          :value="group.name"
        />
      </el-select>
    </div>
    <div v-show="action == 'delete'">
      <p class="action-text delete-text">从分组删除</p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  action: {
    type: String,
    required: true,
  },
  symbols: {
    type: Array,
    default: () => [],
  },
  groups: {
    type: Array,
    default: () => [],
  },
  curGroup: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['selectGroupChange']);

const target = ref('');
const targets = computed(() =>
  props.groups.filter((group) => group.id !== props.curGroup.id),
);

const names = computed(() => {
  if (props.symbols.length === 1) return props.symbols[0].name + ' ';
  if (props.symbols.length > 1) {
    return props.symbols[0].name + ', ' + props.symbols[1].name + ' ';
  }
  return ' ';
});

function onChange(value) {
  emit('selectGroupChange', value);
}

defineExpose({
  openClear: () => {
    target.value = '';
  },
});
</script>
