<template>
  <div class="stock-setting detail-setting">
    <el-scrollbar height="380">
      <div class="pd10-r">
        <h6 class="head-border flexend">
          <p style="margin-right: auto">持仓设置</p>
        </h6>
        <el-row class="box">
          <el-col :span="5" class="content">
            <el-switch v-model="positionOpen" size="default" active-text="开" inactive-text="关" />
          </el-col>
          <el-col :span="8" class="content">
            <span class="setting-text">持仓价:</span>
            <el-input-number v-model="buyPrice" :min="0" :max="999999" :step="0.1" :precision="2" size="small" />
          </el-col>
          <el-col :span="8" class="content">
            <span class="setting-text">持仓量:</span>
            <el-input-number v-model="buyAmount" :min="0" :max="900000000" :step="1" size="small" />
          </el-col>
        </el-row>
        <el-divider />
      </div>

      <div class="pd10-r">
        <h6 class="head-border flexend">
          <p style="margin-right: auto">涨跌幅提醒</p>
          <p class="fleft font14">当前涨跌幅:</p>
          <p class="fleft font14 mg10-l fontbold" :class="rangeValue >= 0 ? 'red' : 'green'">{{ props.range }}%</p>
        </h6>
        <el-row class="box">
          <el-col :span="5" class="content">
            <el-switch v-model="upRangeOpen" size="default" active-text="开" inactive-text="关" />
          </el-col>
          <el-col :span="13" class="content">
            <span class="setting-text">当日涨幅超过:</span>
            <el-input-number v-model="upRange" :min="0" :max="100" :step="0.1" :precision="2" size="small" />
            <span class="setting-text">%</span>
          </el-col>
        </el-row>
        <el-row class="box">
          <el-col :span="5" class="content">
            <el-switch v-model="downRangeOpen" size="default" active-text="开" inactive-text="关" />
          </el-col>
          <el-col :span="13" class="content">
            <span class="setting-text">当日跌幅超过:</span>
            <el-input-number v-model="downRange" :min="-100" :max="0" :step="0.1" :precision="2" size="small" />
            <span class="setting-text">%</span>
          </el-col>
        </el-row>
        <el-divider />
      </div>

      <div class="pd10-r">
        <h6 class="head-border flexend">
          <p style="margin-right: auto">价格提醒</p>
          <p class="fleft font14">当前价格:</p>
          <p class="fleft font14 mg10-l fontbold">{{ props.price }}</p>
        </h6>
        <el-row class="box">
          <el-col :span="5" class="content">
            <el-switch v-model="upPriceOpen" size="default" active-text="开" inactive-text="关" />
          </el-col>
          <el-col :span="13" class="content">
            <span class="setting-text">价格涨至:</span>
            <el-input-number v-model="upPrice" :min="0" :step="0.1" :precision="2" size="small" />
          </el-col>
        </el-row>
        <el-row class="box">
          <el-col :span="5" class="content">
            <el-switch v-model="downPriceOpen" size="default" active-text="开" inactive-text="关" />
          </el-col>
          <el-col :span="13" class="content">
            <span class="setting-text">价格跌至:</span>
            <el-input-number v-model="downPrice" :min="0" :step="0.1" :precision="2" size="small" />
          </el-col>
        </el-row>
        <el-divider />
      </div>
    </el-scrollbar>
    <el-affix :offset="5" position="bottom">
      <div class="bottom-card">
        <el-button type="primary" style="height: 27px" @click="save">保存</el-button>
      </div>
    </el-affix>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useSymbolStore } from '../../stores/symbol';

const props = defineProps({
  name: { type: String, default: '' },
  code: { type: String, default: '' },
  secid: { type: String, default: '' },
  range: { type: [String, Number], default: '-' },
  price: { type: [String, Number], default: '-' },
});

const symbolStore = useSymbolStore();

const positionOpen = ref(false);
const buyPrice = ref(0);
const buyAmount = ref(100);
const upRangeOpen = ref(false);
const upRange = ref(0);
const downRangeOpen = ref(false);
const downRange = ref(0);
const upPriceOpen = ref(false);
const upPrice = ref(0);
const downPriceOpen = ref(false);
const downPrice = ref(0);

const rangeValue = computed(() => parseFloat(props.range));

function loadConfig() {
  const config = symbolStore.configs[props.secid];
  if (config && config.position) {
    positionOpen.value = true;
    buyPrice.value = Number(config.position.buyPrice) || 0;
    buyAmount.value = Number(config.position.buyAmount) || 0;
  } else {
    positionOpen.value = false;
    buyPrice.value = 0;
    buyAmount.value = 100;
  }
  if (config && config.crossAlertConfig) {
    const c = config.crossAlertConfig;
    setNumberField(c.crossUpRange, upRangeOpen, upRange);
    setNumberField(c.crossDownRange, downRangeOpen, downRange);
    setNumberField(c.crossUpPrice, upPriceOpen, upPrice);
    setNumberField(c.crossDownPrice, downPriceOpen, downPrice);
  } else {
    upRangeOpen.value = false;
    upRange.value = 0;
    downRangeOpen.value = false;
    downRange.value = 0;
    upPriceOpen.value = false;
    upPrice.value = 0;
    downPriceOpen.value = false;
    downPrice.value = 0;
  }
}

function setNumberField(value, openRef, valueRef) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    openRef.value = true;
    valueRef.value = value;
  } else {
    openRef.value = false;
    valueRef.value = 0;
  }
}

function buildConfig() {
  const config = { secid: props.secid };
  if (positionOpen.value) {
    config.position = {
      direction: 1,
      buyPrice: buyPrice.value,
      buyAmount: buyAmount.value,
    };
  }
  if (upRangeOpen.value || downRangeOpen.value || upPriceOpen.value || downPriceOpen.value) {
    config.crossAlertConfig = {
      crossUpRange: upRangeOpen.value ? upRange.value : null,
      crossDownRange: downRangeOpen.value ? downRange.value : null,
      crossUpPrice: upPriceOpen.value ? upPrice.value : null,
      crossDownPrice: downPriceOpen.value ? downPrice.value : null,
    };
  }
  return config;
}

function validate() {
  if (positionOpen.value) {
    if (buyPrice.value <= 0) return { valid: false, msg: '持仓价必须大于0' };
    if (buyAmount.value <= 0) return { valid: false, msg: '持仓数量必须大于0' };
  }
  let warning = '';
  if (upRangeOpen.value && rangeValue.value > upRange.value) warning += '上涨幅度超过当前幅度\n';
  if (downRangeOpen.value && rangeValue.value < downRange.value) warning += '下跌幅度超过当前跌幅\n';
  const priceValue = parseFloat(props.price);
  if (upPriceOpen.value && Number.isFinite(priceValue) && priceValue > upPrice.value) warning += '上涨价格超过当前价格\n';
  if (downPriceOpen.value && Number.isFinite(priceValue) && priceValue < downPrice.value) warning += '下跌价格超过当前价格\n';
  return { valid: true, msg: warning };
}

async function save() {
  const result = validate();
  if (!result.valid) {
    ElMessage({ message: result.msg, type: 'error', duration: 2000 });
    return;
  }
  if (result.msg.length > 0) {
    try {
      await ElMessageBox.confirm(`${result.msg}, 确定继续？`, '警告', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      });
    } catch (e) {
      return;
    }
  }
  await symbolStore.addConfig(buildConfig());
  ElMessage({ message: '保存成功！', type: 'success', duration: 1200 });
}

watch(() => props.secid, loadConfig);
onMounted(loadConfig);
</script>

<style scoped>
.detail-setting {
  height: 100%;
  width: 100%;
}
.detail-setting .box {
  height: auto;
  margin: 5px 0;
  letter-spacing: normal;
  text-align: left;
}
.detail-setting .content {
  display: flex;
  align-items: center;
}
.detail-setting :deep(.el-input__wrapper) {
  width: 100% !important;
}
.detail-setting :deep(.el-input__inner) {
  width: 100% !important;
  margin-left: 0 !important;
  height: 20px !important;
}
.detail-setting :deep(.el-input-number) {
  width: 128px;
}
</style>
