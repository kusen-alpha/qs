<template>
  <div class="box detail-box">
    <div class="right detail-right">
      <div class="chart-toolbar" data-tauri-drag-region>
        <span class="chart-title">日K · MACD(12,26,9)</span>
        <span v-if="isFallback" class="chart-hint">示例数据（行情接口不可用）</span>
      </div>
      <div class="rightContent">
        <div class="contentBox">
          <div class="hqchart" id="hqchart_kline" ref="klineBox"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import HQChart from 'hqchart';
import { fetchKline, fallbackKline, secidToSymbol } from '../../utils/kline';

const props = defineProps({
  symbol: { type: String, default: '' },
  name: { type: String, default: '' },
  code: { type: String, default: '' },
});

const klineBox = ref(null);
const isFallback = ref(false);
let klineChart = null;

function applyTheme() {
  const res = HQChart.Chart.JSChart.GetResource();
  res.UpBarColor = 'rgb(241,55,63)';
  res.DownBarColor = 'rgb(75,105,150)';
  res.UnchagneBarColor = 'rgb(43,54,69)';
  res.EmptyBarBGColor = 'rgb(255,255,255)';
  res.FrameBorderPen = 'rgb(225,236,242)';
  res.FrameSplitPen = 'rgb(225,236,242)';
  res.FrameSplitTextColor = 'rgb(117,125,129)';
  res.FrameSplitTextFont = '12px 微软雅黑';
  res.FrameTitleBGColor = 'rgb(255,255,255)';
  res.Index.LineColor = [
    'rgb(255,174,0)', 'rgb(25,199,255)', 'rgb(175,95,162)', 'rgb(236,105,65)', 'rgb(68,114,196)',
    'rgb(229,0,79)', 'rgb(0,128,255)', 'rgb(252,96,154)', 'rgb(42,230,215)', 'rgb(24,71,178)',
  ];
  res.CorssCursor.CorssPoint.Center.Color = 'rgb(43,54,69)';
  res.CorssCursor.RightButton.BGColor = 'rgb(43,54,69)';
}

/** HQChart 日线 Date 为 YYYYMMDD 数字 */
function dateNumber(text) {
  const digits = String(text || '').replace(/\D/g, '').slice(0, 8);
  return digits ? Number(digits) : 0;
}

function toRowList(candles) {
  return candles.map((c, i) => {
    const yclose = i === 0 ? c.open || c.close : candles[i - 1].close;
    return [dateNumber(c.date), yclose, c.open, c.high, c.low, c.close, c.volume || 0, c.amount || 0];
  });
}

async function loadDayRows() {
  const res = await fetchKline(props.symbol);
  const hasReal = Boolean(res && res.candles && res.candles.length);
  isFallback.value = !hasReal;
  const candles = hasReal ? res.candles : fallbackKline(props.symbol);
  return {
    stockName: (res && res.name) || props.name || '',
    rows: toRowList(candles),
  };
}

/** HQChart 数据对接：只提供日 K 历史数据，其余请求一律拦截（不访问外部服务） */
function networkFilter(obj, callback) {
  const requestName = obj && obj.Name;
  if (!requestName) {
    if (obj) obj.PreventDefault = true;
    return;
  }
  if (requestName === 'KLineChartContainer::RequestHistoryData') {
    loadDayRows().then((result) => {
      callback({ symbol: secidToSymbol(props.symbol), name: result.stockName, data: result.rows });
    });
    return;
  }
  obj.PreventDefault = true;
}

function klineOption() {
  return {
    Type: '历史K线图',
    Symbol: secidToSymbol(props.symbol),
    NetworkFilter: networkFilter,
    IsAutoUpdate: false,
    IsShowRightMenu: false,
    Windows: [
      { Index: 'MA', Modify: false, Change: false },
      {
        Index: 'MACD',
        Modify: false,
        Change: false,
        Args: [
          { Name: 'SHORT', Value: 12 },
          { Name: 'LONG', Value: 26 },
          { Name: 'MID', Value: 9 },
        ],
      },
    ],
    IsShowCorssCursorInfo: true,
    Border: { Left: 1, Right: 1, Top: 25, Bottom: 25 },
    KLine: {
      Right: 1,
      Period: 0,
      PageSize: 70,
      IsShowTooltip: true,
    },
  };
}

function buildKline() {
  if (!klineBox.value || klineChart) return;
  const chart = HQChart.Chart.JSChart.Init(klineBox.value);
  chart.SetOption(klineOption());
  klineChart = chart;
}

function destroyChart() {
  if (klineChart) {
    klineChart.ChartDestroy();
    klineChart = null;
  }
  if (klineBox.value) klineBox.value.innerHTML = '';
}

function rebuild() {
  destroyChart();
  nextTick(() => buildKline());
}

function onResize() {
  if (klineChart) klineChart.OnSize();
}

watch(
  () => props.symbol,
  () => rebuild(),
);

onMounted(() => {
  applyTheme();
  buildKline();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  destroyChart();
});

defineExpose({
  resize: onResize,
});
</script>

<style scoped>
.detail-box {
  width: 100%;
  height: 100%;
  margin: 0;
  text-align: left;
  letter-spacing: normal;
}
.detail-box .detail-right {
  position: relative;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.detail-box .chart-toolbar {
  flex: none;
  min-height: 30px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  background: #fafafa;
  border-bottom: 1px solid #dadada;
}
.detail-box .chart-title {
  font-size: 12px;
  color: #606266;
}
.detail-box .chart-hint {
  margin-left: 8px;
  font-size: 12px;
  color: #e6a23c;
}
.detail-box .rightContent {
  flex: 1;
  height: auto;
  min-height: 0;
  width: 100%;
}
.detail-box .rightContent .contentBox {
  height: 100%;
  width: 100%;
}
.detail-box .hqchart {
  height: 100% !important;
  width: 100%;
  position: relative;
  background: #fff;
}
.detail-box :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}
</style>
