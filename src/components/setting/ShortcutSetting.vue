<template>
  <div>
    <div style="padding-bottom: 10px">
      <KeyBindItem
        title="老板键"
        :shotcut="cache.shortcutBoss"
        desc="显示/隐藏面板"
        @change="onBoss"
      />
    </div>
    <span class="remark-text">
      * 为避免快捷键冲突，请使用使用 <b>Ctrl</b>、<b>Alt</b> 或
      <b>Shift</b> 作为组合键的开头
    </span>
  </div>
</template>

<script setup>
import KeyBindItem from './KeyBindItem.vue';
import { useCacheStore } from '../../stores/cache';

const cache = useCacheStore();

function normalize(keys) {
  return keys.map((key) =>
    key === 'Control'
      ? 'Ctrl'
      : key.length === 1 && key >= 'a' && key <= 'z'
        ? key.toUpperCase()
        : key,
  );
}

function onBoss(keys) {
  cache.shortcutBoss = normalize(keys);
}
</script>
