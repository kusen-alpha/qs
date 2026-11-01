<template>
  <div>
    <el-table
      :data="tableRows"
      max-height="250"
      :cell-style="{ padding: '3px 0px' }"
      :header-cell-style="{ padding: '3px 0px' }"
      empty-text="请点击右下角 ➕ 号添加"
      :size="setting.tableSize"
      @row-contextmenu="onRowContextmenu"
      @row-click="hideMenu"
      @row-dblclick="onRowDblclick"
      @contextmenu.prevent
    >
      <el-table-column prop="name" label="名称" fixed width="75" align="right">
        <template #default="{ row }">
          <div style="position: relative">
            <div class="alert-icons">
              <AppIcon
                v-if="symbol.showPosition(row.secid)"
                class="alert-icon-top"
                name="star"
              />
              <AppIcon
                v-if="symbol.showAlert(row.secid)"
                class="alert-icon-down"
                name="bell"
              />
            </div>
            <span class="row-symbol-name">{{ row.name }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.price"
        prop="price"
        label="当前价"
        :width="narrowWidth"
        align="center"
      >
        <template #default="{ row }">
          <span>{{ row.price > 100000 ? row.price.toFixed(0) : row.price }}</span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.range"
        prop="range"
        label="涨跌幅"
        :width="wideWidth"
        sortable
        align="center"
      >
        <template #default="{ row }">
          <span :class="row.range > 0 ? upColor : downColor">{{ row.range }}%</span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.price_diff"
        prop="price_diff"
        label="涨跌额"
        :width="wideWidth"
        sortable
        align="center"
      >
        <template #default="{ row }">
          <span :class="row.price_diff > 0 ? upColor : downColor">{{ row.price_diff }}</span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.high"
        prop="high"
        label="最高价"
        :width="narrowWidth"
      />
      <el-table-column
        v-if="setting.watchFields.low"
        prop="low"
        label="最低价"
        :width="narrowWidth"
      />

      <el-table-column
        v-if="setting.watchFields.turn"
        prop="turn"
        label="换手率"
        :width="wideWidth"
        sortable
        align="center"
      >
        <template #default="{ row }">
          <span>{{ row.turn }}%</span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.macd"
        prop="macd"
        label="MACD"
        :width="wideWidth"
        sortable
        align="center"
      >
        <template #default="{ row }">
          <span :class="row.macd > 0 ? upColor : downColor">{{ row.macdText }}</span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.concept_l1"
        prop="concept_l1"
        label="一级概念"
        width="90"
        align="center"
        show-overflow-tooltip
      />
      <el-table-column
        v-if="setting.watchFields.concept_l2"
        prop="concept_l2"
        label="二级概念"
        width="100"
        align="center"
        show-overflow-tooltip
      />
      <el-table-column
        v-if="setting.watchFields.concept_ths"
        prop="concept_ths"
        label="同花顺概念"
        width="150"
        align="center"
        show-overflow-tooltip
      />

      <el-table-column
        v-if="setting.watchFields.position_num"
        prop="position_num"
        label="持仓量"
        :width="narrowWidth"
        align="center"
      >
        <template #default="{ row }">
          <span>{{ row.position_num === '-' ? '-' : formatAmount(row.position_num) }}</span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.position_price"
        prop="position_price"
        label="持仓价"
        :width="narrowWidth"
        align="center"
      />

      <el-table-column
        v-if="setting.watchFields.position_value"
        prop="position_value"
        label="持仓金额"
        :width="wideWidth"
        align="center"
      >
        <template #default="{ row }">
          <span>{{ row.position_value === '-' ? '-' : formatAmount(row.position_value) }}</span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.position_profit"
        prop="position_profit"
        label="收益"
        :width="narrowWidth"
        align="center"
      >
        <template #default="{ row }">
          <span :class="row.position_profit > 0 ? upColor : downColor">
            {{ row.position_profit === '-' ? '-' : formatAmount(row.position_profit) }}
          </span>
        </template>
      </el-table-column>

      <el-table-column
        v-if="setting.watchFields.position_profit_rate"
        prop="position_profit_rate"
        label="收益率"
        :width="wideWidth"
        align="center"
      >
        <template #default="{ row }">
          <span :class="row.position_profit_rate > 0 ? upColor : downColor">
            {{ row.position_profit_rate === '-' ? '-' : formatRate(row.position_profit_rate) }}
          </span>
        </template>
      </el-table-column>
    </el-table>

    <div
      v-if="menu.visible"
      class="raw-context-menu"
      :style="{ top: menu.y + 'px', left: menu.x + 'px' }"
    >
      <ul class="pdd-context-menu">
        <li @click="editSymbol">编辑</li>
        <li class="danger" @click="deleteSymbol">删除</li>
        <li @click="hideMenu">取消</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import AppIcon from '../AppIcon.vue';
import { useSettingStore } from '../../stores/setting';
import { useMonitorStore } from '../../stores/monitor';
import { useSymbolStore } from '../../stores/symbol';
import { useCacheStore } from '../../stores/cache';
import { useMacdStore } from '../../stores/macd';
import { on } from '../../utils/events';
import { openWindow, WindowConfigs } from '../../utils/windows';
import { DetailPanel, StoreEvent, MonitorEvent } from '../../constants';
import { signDays } from '../../utils/macd';
import { loadStockConcepts } from '../../api/ths';
import {
  EastmoneyApi,
  pickBySource,
  mergeRealtime,
  summarizeProfit,
  formatAmount,
  formatRate,
} from '../../api/eastmoney';
import { applyDragRegion } from '../../utils/layout';

const setting = useSettingStore();
const monitor = useMonitorStore();
const symbol = useSymbolStore();
const cache = useCacheStore();
const macd = useMacdStore();

const rows = ref([]);
const quotes = ref([]);
const concepts = ref({});
const api = new EastmoneyApi();
const timers = { realtime: null, alert: null };

const menu = reactive({ visible: false, x: 0, y: 0 });
const currentRow = ref(null);
let offs = [];

/* 行情行可能来自自选列表或实时接口，统一取出 6 位股票代码 */
function codeOf(row) {
  if (row.symbol) return row.symbol;
  const parts = String(row.secid || '').split('.');
  return parts.length > 1 ? parts[1] : '';
}

/* 行情行附加 MACD 连续天数：大于 0 为正数、小于 0 为负数，未取到日 K 显示 - */
const tableRows = computed(() =>
  rows.value.map((row) => {
    const series = macd.series[row.secid];
    const days = series && series.length ? signDays(series) : null;
    const concept = concepts.value[codeOf(row)] || {};
    return {
      ...row,
      macd: days,
      macdText: days === null ? '-' : String(days),
      concept_l1: concept.l1 || '-',
      concept_l2: concept.l2 || '-',
      concept_ths: concept.ths || '-',
    };
  }),
);

const narrowWidth = computed(() => {
  switch (setting.tableSize) {
    case 'default':
      return 72;
    case 'large':
      return 82;
    default:
      return 62;
  }
});

const wideWidth = computed(() => {
  switch (setting.tableSize) {
    case 'default':
      return 86;
    case 'large':
      return 96;
    default:
      return 76;
  }
});

const upColor = computed(() =>
  setting.updownColor === 'redUpGreenDown' ? 'red' : 'green',
);
const downColor = computed(() =>
  setting.updownColor === 'redUpGreenDown' ? 'green' : 'red',
);

function reload() {
  hideMenu();
  rows.value = monitor.watchGroup[0].symbols;
  rows.value = mergeRealtime(quotes.value, rows.value, Object.values(symbol.configs));
}

/* 按需拉取日 K 计算 MACD（列关闭时不发起请求） */
async function ensureMacd() {
  if (!setting.watchFields.macd) return;
  await macd.ensure(pickBySource(monitor.watchGroup, '1').map((s) => s.secid));
}

/* 按需拉取申万行业/同花顺概念（三列都关闭时不发起请求） */
async function ensureConcepts() {
  if (
    !setting.watchFields.concept_l1 &&
    !setting.watchFields.concept_l2 &&
    !setting.watchFields.concept_ths
  ) {
    return;
  }
  const map = await loadStockConcepts(rows.value.map((row) => codeOf(row))).catch(
    () => ({}),
  );
  concepts.value = { ...concepts.value, ...map };
}

async function loopRealtime() {
  let delay = 4000;
  try {
    const data = await api.realtime(pickBySource(monitor.watchGroup, '1'));
    quotes.value = data;
    rows.value = mergeRealtime(quotes.value, rows.value, Object.values(symbol.configs));
    try {
      cache.updateProfit(summarizeProfit(data, Object.values(symbol.configs)));
    } catch (e) {
      console.error(e);
    }
    await import('../../utils/events').then(({ emit }) => emit(StoreEvent.REALTIME_EAST, data));
  } catch (e) {
    console.error(e);
    delay = 20000;
  }
  timers.realtime = setTimeout(loopRealtime, delay);
}

async function loopAlert() {
  let delay = 9000;
  try {
    const list = buildAlerts(quotes.value, symbol.configs);
    const shown = cache.updateAlertQueue(list);
    if (shown.length > 0) {
      for (const item of shown) {
        await notifyAlert(item);
      }
    }
  } catch (e) {
    console.error(e);
    delay = 20000;
  }
  timers.alert = setTimeout(loopAlert, delay);
}

function buildAlerts(list, configs) {
  if (!list || !configs) return [];
  const out = [];
  for (const quote of list) {
    const cfg = configs[quote.secid];
    if (cfg && cfg.crossAlertConfig) out.push(...crossAlerts(quote, cfg.crossAlertConfig));
  }
  return out;
}

function isNumber(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  return NaN;
}

function crossAlerts(quote, cfg) {
  const arr = [];
  const price = toNumber(quote.price);
  const range = toNumber(quote.range);
  const base = {
    name: quote.name,
    secid: quote.secid,
    price,
    range,
    dt: Date.now(),
  };
  if (isNumber(cfg.crossUpPrice) && toNumber(cfg.crossUpPrice) < price) {
    arr.push({ ...base, trigger: '大于', trigger_data: toNumber(cfg.crossUpPrice), state: '价格', state_data: price });
  }
  if (isNumber(cfg.crossDownPrice) && toNumber(cfg.crossDownPrice) > price) {
    arr.push({ ...base, trigger: '小于', trigger_data: toNumber(cfg.crossDownPrice), state: '价格', state_data: price });
  }
  if (isNumber(cfg.crossUpRange) && toNumber(cfg.crossUpRange) < range) {
    arr.push({ ...base, trigger: '大于', trigger_data: toNumber(cfg.crossUpRange), state: '涨幅', state_data: range });
  }
  if (isNumber(cfg.crossDownRange) && toNumber(cfg.crossDownRange) > range) {
    arr.push({ ...base, trigger: '小于', trigger_data: toNumber(cfg.crossDownRange), state: '涨幅', state_data: range });
  }
  return arr;
}

async function notifyAlert(item) {
  let body = `⏰|${item.name}| 触发${item.state}${item.trigger} `;
  if (item.state === '价格') body += `￥${item.price} `;
  else if (item.state === '涨幅') body += `${item.range}% `;
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('趋势', { body });
  }
}

function onRowContextmenu(row, column, event) {
  currentRow.value = row;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.visible = true;
}

function hideMenu() {
  menu.visible = false;
}

async function onRowDblclick(row) {
  const detail = WindowConfigs.detail;
  await openWindow(detail, {
    secid: row.secid,
    panel: DetailPanel.CHART,
  });
}

async function editSymbol() {
  hideMenu();
  await openWindow(WindowConfigs.detail, {
    secid: currentRow.value.secid,
    panel: DetailPanel.SETTING,
  });
}

function deleteSymbol() {
  hideMenu();
  const secid = currentRow.value.secid;
  rows.value = rows.value.filter((r) => r.secid !== secid);
  monitor.deleteWatchList(secid);
  monitor.persist(MonitorEvent.deleteWatchList);
  symbol.deleteSymbolConfig(secid);
}

onMounted(async () => {
  reload();
  loopRealtime();
  loopAlert();
  ensureMacd();
  ensureConcepts();
  applyDragRegion(['el-table__cell', 'cell', 'el-table__empty-block', 'el-table__empty-text']);

  offs.push(await on('stateChange', () => {
    // 其他窗口写库后同步了 localStorage 快照，这里重新读取以拿到最新自选
    monitor.$hydrate({ runHooks: false });
    hideMenu();
    reload();
    ensureMacd();
    ensureConcepts();
  }));
  offs.push(await on('settingChange', (e) => {
    hideMenu();
    if (e.payload.includes('watchFieldsChange') || e.payload.includes('tableSizeChange') || e.payload.includes('updownColorChange')) {
      setting.$hydrate({ runHooks: false });
    }
    if (e.payload.includes('watchFieldsChange')) {
      ensureMacd();
      ensureConcepts();
    }
  }));
  offs.push(await on('symbolConfigChange', () => {
    hideMenu();
    symbol.readConfig();
  }));
  offs.push(await on('hideContextmenu', hideMenu));
});

onBeforeUnmount(() => {
  clearTimeout(timers.realtime);
  clearTimeout(timers.alert);
  offs.forEach((off) => off && off());
});
</script>

<style>
.pdd-context-menu {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
  font-size: 10px;
  min-width: 72px;
}
.pdd-context-menu li {
  padding: 4px 14px;
  cursor: pointer;
  color: #303133;
}
.pdd-context-menu li:hover {
  background: #f5f7fa;
}
.pdd-context-menu li.danger {
  color: #f56c6c;
}
.raw-context-menu {
  position: fixed;
  z-index: 3000;
}
</style>
