<template>
  <el-row class="row-item">
    <el-col :span="4">
      <h3 class="title" data-tauri-drag-region style="padding-left: 0">
        {{ title }}
      </h3>
    </el-col>
    <el-col :span="7">
      <p class="description">{{ desc }}</p>
    </el-col>
    <el-col :span="5">
      <el-button
        :disabled="disabled"
        class="btn"
        text
        bg
        type="info"
        size="default"
        @click="startRecord"
      >
        {{ displayText }}
      </el-button>
    </el-col>
    <el-col :span="8">
      <p v-show="message" class="description" :style="{ color: color }">
        {{ message }}
      </p>
    </el-col>
  </el-row>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';

const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  shotcut: {
    type: Array,
    required: true,
  },
  desc: {
    type: String,
    required: false,
    default: '这是描述',
  },
  disabled: {
    type: Boolean,
    required: false,
    default: false,
  },
});

const emit = defineEmits(['change', 'update:shotcut']);

const recording = ref(false);
const keys = ref([]);
let pressed = 0;

const displayText = computed(() =>
  recording.value ? '记录按键中' : props.shotcut.join(' + '),
);

const message = ref('');
const color = ref('red');

function startRecord() {
  pressed = 0;
  keys.value = [];
  recording.value = true;
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
}

function onKeyDown(e) {
  pressed++;
  if (pressed <= 1) {
    keys.value.push(e.key);
  } else {
    if (pressed === 2) keys.value.push(e.key);
    finish();
  }
}

function onKeyUp() {
  finish();
}

function finish() {
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  recording.value = false;
  if (validate(keys.value)) {
    emit('change', keys.value);
  }
  keys.value = [];
}

function validate(list) {
  if (list.length === 0) {
    showError('未输入快捷键组合');
    return false;
  } else if (list.length === 1) {
    showError('快捷键组合需要两个按键');
    return false;
  } else if (['Shift', 'Control', 'Alt'].includes(list[0])) {
    if (list[0] === list[1] || ['Shift', 'Control', 'Alt'].includes(list[1])) {
      showError('输入无效');
      return false;
    }
    return true;
  } else {
    showError('输入无效');
    return false;
  }
}

function showError(text) {
  message.value = text;
  color.value = 'red';
  setTimeout(() => {
    message.value = '';
  }, 2000);
}

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
});
</script>
