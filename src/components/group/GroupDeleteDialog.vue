<template>
  <div>
    <p>确定将 <b>{{ name }}</b> 分组</p>
    <p class="action-text delete-text">删除?</p>
    <p v-if="childCount > 0" class="child-warning">
      该概念下的 {{ childCount }} 个二级概念将一并删除
    </p>
  </div>
</template>

<script setup>
defineProps({
  name: {
    type: String,
    default: '',
  },
  childCount: {
    type: Number,
    default: 0,
  },
});
</script>
