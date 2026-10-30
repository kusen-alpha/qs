<template>
  <div>
    <p>确定将 <b>{{ name }}</b> 分组</p>
    <p class="action-text delete-text">删除?</p>
  </div>
</template>

<script setup>
defineProps({
  name: {
    type: String,
    default: '',
  },
});
</script>
