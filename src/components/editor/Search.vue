<template>
  <el-row>
    <el-col :span="24">
      <el-input
        v-model="keyword"
        size="large"
        placeholder="输入 A 股代码、名称、简拼或关键词"
        class="input-with-select"
        @input="onInput"
        @keydown.down.prevent="moveDown"
        @keydown.up.prevent="moveUp"
        @keydown.enter.prevent="onEnter"
      />
    </el-col>
  </el-row>
  <el-table
    v-if="list.length > 0"
    ref="tableRef"
    :data="list"
    stripe
    style="width: 100%"
    max-height="375"
    :show-header="false"
    class="table-search"
    size="default"
    table-layout="auto"
    highlight-current-row
  >
    <el-table-column prop="Code" label="Code" />
    <el-table-column prop="Name" label="Name" />
    <el-table-column prop="SecurityTypeName" label="SecurityTypeName">
      <template #default="{ row }">
        <el-tag
          effect="dark"
          disable-transitions
          :class="'type-tag ' + typeClass(row.SecurityTypeName)"
        >
          {{ row.SecurityTypeName }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="IsAddCurGroup" label="IsAddCurGroup" fixed="right">
      <template #default="{ row }">
        <div class="action-btns">
          <el-button
            type="primary"
            class="action-btn"
            :icon="Plus"
            plain
            :disabled="row.IsAddCurGroup"
            @click.stop="add(row)"
          />
        </div>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import { useMonitorStore } from '../../stores/monitor';
import { MonitorEvent } from '../../constants';
import { request } from '../../utils/http';
import { on } from '../../utils/events';
import { isTauri } from '../../utils/env';

const monitor = useMonitorStore();

const typeClassMap = {
  深A: 'bg1',
  沪A: 'bg2',
  三板: 'bg3',
  科创板: 'bg4',
  板块: 'bg5',
  期货: 'bg6',
};

const keyword = ref('');
const list = ref([]);
const tableRef = ref(null);
const activeIndex = ref(-1);
let timer = null;
let offs = [];

const SEARCH_HEADERS = {
  Host: 'searchadapter.eastmoney.com',
  Connection: 'keep-alive',
  Referer: 'https://www.eastmoney.com/',
  Accept: '*/*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 Edg/108.0.1462.54',
};

function typeClass(name) {
  return name in typeClassMap ? typeClassMap[name] : 'bg-other';
}

function buildParams(input, count = '5') {
  return {
    input,
    count,
    type: '14',
    token: 'D43BF722C8E33BDC906FB84D85E326E8',
    markettype: '',
    mktnum: '',
    jys: '',
    classify: '',
    securitytype: '',
    status: '',
  };
}

function clearList() {
  list.value = [];
}

function markAdded(rows) {
  if (!rows) return rows;
  rows.forEach((row) => {
    row.IsAddCurGroup = monitor.existSymbolInGroup(row.QuoteID);
  });
  return rows;
}

async function searchStock() {
  const params = new URLSearchParams();
  Object.entries(buildParams(keyword.value, '15')).forEach((pair) => params.append(...pair));
  try {
    const res = await request(
      'https://searchadapter.eastmoney.com/api/suggest/get?' + params.toString(),
      { method: 'GET', headers: SEARCH_HEADERS },
    );
    const payload = res && res.data;
    const rows =
      payload && payload.QuotationCodeTable && payload.QuotationCodeTable.Data;
    list.value = rows ? markAdded(rows) : [];
  } catch (e) {
    list.value = [];
  }
}

function doSearch() {
  if (keyword.value === '') {
    clearList();
    return;
  }
  searchStock();
}

function onInput() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    doSearch();
  }, 600);
}

function add(row) {
  if (!row || row.IsAddCurGroup) return;
  monitor.addWatchList(row);
  if (isTauri()) monitor.persist(MonitorEvent.addWatchList);
  for (let i = 0; i < list.value.length; i++) {
    if (list.value[i].QuoteID === row.QuoteID) {
      list.value[i].IsAddCurGroup = true;
    }
  }
}

function moveDown() {
  if (!list.value.length) return;
  activeIndex.value = (activeIndex.value + 1) % list.value.length;
  selectActive();
}

function moveUp() {
  if (!list.value.length) return;
  activeIndex.value =
    (activeIndex.value - 1 + list.value.length) % list.value.length;
  selectActive();
}

function selectActive() {
  nextTick(() => {
    const row = list.value[activeIndex.value];
    if (tableRef.value && row) tableRef.value.setCurrentRow(row);
  });
}

function onEnter() {
  if (!list.value.length) return;
  const index = activeIndex.value < 0 ? 0 : activeIndex.value;
  add(list.value[index]);
}

watch(list, () => {
  activeIndex.value = -1;
});

onMounted(async () => {
  offs.push(
    await on('stateChange', () => {
      monitor.$hydrate({ runHooks: false });
      markAdded(list.value);
    }),
  );
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  offs.forEach((off) => off && off());
});
</script>
