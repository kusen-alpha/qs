<template>
  <h1 class="title" data-tauri-drag-region style="padding-left: 0">
    <span class="title-text">{{ cache.curSetting }}</span>
  </h1>
</template>

<script setup>
import { useCacheStore } from '../../stores/cache';

const cache = useCacheStore();
</script>
