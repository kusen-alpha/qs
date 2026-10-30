<template>
  <el-row class="header-row">
    <el-col :span="10">
      <el-input
        v-if="editing"
        ref="inputRef"
        v-model="newName"
        size="default"
        class="input-new-tag"
        maxlength="18"
        show-word-limit
        @keyup.enter="confirmRename"
      >
        <template #append>
          <el-button :icon="CheckIcon" @click="confirmRename" />
        </template>
      </el-input>
      <h6 v-else class="head-border group-name" data-tauri-drag-region>
        {{ current.name }}
      </h6>
    </el-col>
    <el-col :span="8" />
    <el-col :span="6">
      <el-tooltip
        effect="customized"
        placement="bottom"
        :show-after="200"
        content="重命名"
        :offset="-3"
      >
        <el-button
          type="primary"
          :disabled="!current.editable"
          size="default"
          :icon="EditIcon"
          circle
          @click="startRename"
        />
      </el-tooltip>
      <el-tooltip effect="customized" content="删除分组" :offset="-3">
        <el-button
          type="danger"
          :disabled="!current.editable"
          size="default"
          :icon="DeleteIcon"
          circle
          @click="deleteVisible = true"
        />
      </el-tooltip>
    </el-col>
  </el-row>

  <el-dialog
    v-model="deleteVisible"
    title="确认删除"
    class="item-change-dialog"
    width="60%"
  >
    <GroupDeleteDialog :name="current.name" />
    <template #footer>
      <span class="dialog-footer">
        <el-button @click="deleteVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmDelete">确认</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, h, nextTick, ref } from 'vue';
import { useCacheStore } from '../../stores/cache';
import GroupDeleteDialog from './GroupDeleteDialog.vue';

const cache = useCacheStore();

const editing = ref(false);
const newName = ref('');
const deleteVisible = ref(false);
const inputRef = ref();

const current = computed(() => cache.findConceptById(cache.selectGroup) || {});

const EditIcon = () =>
  h(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 1024 1024' },
    [
      h('path', {
        fill: 'currentColor',
        d: 'm199.04 672.64 193.984 112 224-387.968-193.92-112-224 388.032zm-23.872 60.16 32.896 148.288 144.896-45.696L175.168 732.8zM455.04 229.248l193.92 112 56.704-98.112-193.984-112-56.64 98.112zM104.32 708.8l384-665.024 304.768 175.936L409.152 884.8h.064l-248.448 78.336L104.32 708.8zm384 254.272v-64h448v64h-448z',
      }),
    ],
  );

const DeleteIcon = () =>
  h(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 1024 1024' },
    [
      h('path', {
        fill: 'currentColor',
        d: 'M352 192V95.936a32 32 0 0 1 32-32h256a32 32 0 0 1 32 32V192h256a32 32 0 1 1 0 64H96a32 32 0 0 1 0-64h256zm64 0h192v-64H416v64zM192 960a32 32 0 0 1-32-32V256h704v672a32 32 0 0 1-32 32H192zm224-192a32 32 0 0 0 32-32V416a32 32 0 0 0-64 0v320a32 32 0 0 0 32 32zm192 0a32 32 0 0 0 32-32V416a32 32 0 0 0-64 0v320a32 32 0 0 0 32 32z',
      }),
    ],
  );

const CheckIcon = () =>
  h(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 1024 1024' },
    [
      h('path', {
        fill: 'currentColor',
        d: 'M406.656 832.768 156.8 582.912l90.368-90.368 159.488 159.488 397.056-397.056 90.368 90.368z',
      }),
    ],
  );

function startRename() {
  editing.value = true;
  newName.value = current.value.name;
  nextTick(() => {
    inputRef.value.input.focus();
  });
}

function confirmRename() {
  if (newName.value) {
    cache.changeGroupName(current.value.id, newName.value);
  }
  editing.value = false;
  newName.value = '';
}

function confirmDelete() {
  cache.deleteGroup(current.value.id);
  deleteVisible.value = false;
}
</script>

<style scoped>
/* .el-input__inner 的样式在 app.css 中来自分组菜单的输入框，会串入本页的重命名输入框。 */
.input-new-tag .el-input__inner {
  width: 100% !important;
  height: 40px;
  margin-left: 0;
  border: 1px solid var(--el-border-color);
}
</style>
