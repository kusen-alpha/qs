<template>
  <el-card
    class="bg-card check-window"
    data-tauri-drag-region
    style="--el-card-padding: 0px; background-color: #f2f2f2; animation: none"
  >
    <div class="check-header" data-tauri-drag-region>
      <span class="check-title" data-tauri-drag-region>数据校验</span>
    </div>

    <div class="check-body">
      <div class="check-list">
        <el-tooltip
          v-for="item in items"
          :key="item.key"
          placement="top"
          effect="light"
          :show-after="400"
          popper-class="check-tip-popper"
        >
          <template #content>
            <div class="check-tip">
              <p class="check-tip-desc">{{ item.desc }}</p>
              <p v-if="item.message" class="check-tip-summary">{{ item.message }}</p>
              <div v-if="item.issues.length" class="check-tip-issues">
                <div v-for="issue in item.issues" :key="issue.secid" class="check-tip-issue">
                  <span class="check-tip-issue-name">{{ issue.name }} {{ issue.symbol }}</span>
                  <span class="check-tip-issue-reason">{{ issue.reasons.join('；') }}</span>
                </div>
              </div>
              <p v-else-if="item.result" class="check-tip-ok">未发现异常</p>
            </div>
          </template>
          <div class="check-item" :class="`is-${item.state}`">
            <span class="check-item-dot" />
            <div class="check-item-info">
              <span class="check-item-name">{{ item.name }}</span>
              <span class="check-item-message">{{ item.message || '尚未校验' }}</span>
            </div>
            <el-tag :type="tagType(item.state)" size="small" effect="light">
              {{ stateText(item.state) }}
            </el-tag>
            <div class="check-item-ops">
              <el-button
                link
                type="primary"
                size="small"
                :disabled="!item.result"
                @click="openDetail(item)"
              >
                详情
              </el-button>
              <el-button
                v-if="item.state === 'fail'"
                link
                type="danger"
                size="small"
                :loading="item.repairing"
                :disabled="runningAll"
                @click="repair(item)"
              >
                修复
              </el-button>
              <el-button
                v-else
                link
                type="primary"
                size="small"
                :loading="item.state === 'running'"
                :disabled="busy"
                @click="runOne(item)"
              >
                校验
              </el-button>
            </div>
          </div>
        </el-tooltip>
      </div>
    </div>

    <div class="check-footer">
      <span class="check-summary">{{ summaryText }}</span>
      <el-button
        type="primary"
        :loading="runningAll"
        :disabled="!runningAll && busy"
        @click="runAll"
      >
        一键校验
      </el-button>
    </div>

    <el-dialog
      v-model="detailVisible"
      :title="detailTitle"
      width="420px"
      append-to-body
      class="check-detail-dialog"
    >
      <div v-if="detailItem" class="check-detail">
        <div class="check-detail-head">
          <el-tag :type="tagType(detailItem.state)" size="small" effect="light">
            {{ stateText(detailItem.state) }}
          </el-tag>
          <span class="check-detail-summary">{{ detailItem.message }}</span>
        </div>
        <p class="check-detail-desc">{{ detailItem.desc }}</p>
        <div v-if="detailItem.issues.length" class="check-detail-issues">
          <div v-for="issue in detailItem.issues" :key="issue.secid" class="check-detail-issue">
            <span class="check-detail-issue-name">{{ issue.name }} {{ issue.symbol }}</span>
            <span class="check-detail-issue-reason">{{ issue.reasons.join('；') }}</span>
          </div>
        </div>
        <p v-else class="check-detail-empty">
          {{ detailItem.result ? '未发现异常' : '暂无校验结果' }}
        </p>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <WindowMaxButton />
    <el-button
      class="close-button"
      type="info"
      size="small"
      id="titlebar-close"
      @click="closeWindow"
    >
      <el-icon class="el-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">
          <path
            fill="currentColor"
            d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"
          />
        </svg>
      </el-icon>
    </el-button>
  </el-card>
</template>

<script setup>
import { computed, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WindowMaxButton from '../components/WindowMaxButton.vue';
import { useMonitorStore } from '../stores/monitor';
import {
  checkStocksData,
  checkWatchHistory,
  repairOrphanStocks,
  repairStocksData,
  repairWatchHistory,
} from '../utils/check';
import { isTauri } from '../utils/env';

const monitor = useMonitorStore();
const stocks = computed(() => monitor.watchGroup[0]?.symbols || []);

/** 校验项列表：run 返回 { status, summary, issues }，fix 接收校验结果执行修复 */
const CHECKS = [
  {
    key: 'stocks',
    name: '校验 stocks 表股票数据',
    desc: '检查自选股票在 stocks 表中是否有记录，且名称、现价、涨跌幅、换手率、申万行业、同花顺行业是否齐全；同时清理已不属于自选或任何概念的孤儿股票',
    run: () => checkStocksData(stocks.value),
    fix: async (result) => {
      const issues = result.issues || [];
      const orphanSecids = issues.filter((issue) => issue.orphan).map((issue) => issue.secid);
      const otherSecids = issues.filter((issue) => !issue.orphan).map((issue) => issue.secid);
      await repairOrphanStocks(orphanSecids);
      await repairStocksData(otherSecids);
    },
  },
  {
    key: 'history',
    name: '校验 histories 表股票历史数据',
    desc: '检查所有自选股票的日K是否齐全（2024-01-01 起至最新交易日）',
    run: () => checkWatchHistory(stocks.value),
    fix: (result) => repairWatchHistory(result.issues.map((issue) => issue.secid)),
  },
];

const runningAll = ref(false);
const detailVisible = ref(false);
const detailItem = ref(null);
const detailTitle = computed(() =>
  detailItem.value ? `校验结果 · ${detailItem.value.name}` : '校验结果',
);

const items = ref(
  CHECKS.map(({ key, name, desc, run, fix }) => ({
    key,
    name,
    desc,
    run,
    fix,
    state: 'idle',
    message: '',
    issues: [],
    result: null,
    repairing: false,
  })),
);

const busy = computed(() => runningAll.value || items.value.some((item) => item.repairing));

const summaryText = computed(() => {
  if (runningAll.value) return '校验中…';
  if (items.value.some((item) => item.repairing)) return '修复中…';
  const done = items.value.filter((item) => ['ok', 'fail', 'error'].includes(item.state));
  if (!done.length) return '尚未校验';
  const failed = done.filter((item) => item.state !== 'ok').length;
  return `已校验 ${done.length} 项，通过 ${done.length - failed} 项，未通过 ${failed} 项`;
});

function tagType(state) {
  if (state === 'ok') return 'success';
  if (state === 'fail') return 'danger';
  if (state === 'error') return 'warning';
  return 'info';
}

function stateText(state) {
  return (
    { idle: '待校验', running: '校验中', ok: '通过', fail: '未通过', error: '异常' }[state] ||
    '待校验'
  );
}

async function execute(item) {
  item.state = 'running';
  item.message = '';
  item.issues = [];
  item.result = null;
  try {
    const result = await item.run();
    item.result = result;
    item.issues = result.issues || [];
    item.message = result.summary || '';
    item.state = result.status === 'ok' ? 'ok' : 'fail';
  } catch (e) {
    item.state = 'error';
    item.message = `校验失败：${(e && e.message) || e}`;
  }
}

/** 校验失败后修复，修复完成自动复查 */
async function repair(item) {
  if (busy.value || !item.result) return;
  item.repairing = true;
  try {
    await item.fix(item.result);
    await execute(item);
  } catch (e) {
    item.state = 'error';
    item.message = `修复失败：${(e && e.message) || e}`;
  } finally {
    item.repairing = false;
  }
}

function runOne(item) {
  if (busy.value || item.state === 'running') return;
  execute(item);
}

async function runAll() {
  if (busy.value) return;
  runningAll.value = true;
  try {
    for (const item of items.value) {
      await execute(item);
    }
  } finally {
    runningAll.value = false;
  }
}

/** 打开某个校验项的详细结果弹窗 */
function openDetail(item) {
  if (!item.result) return;
  detailItem.value = item;
  detailVisible.value = true;
}

function closeWindow() {
  if (!isTauri()) return;
  getCurrentWindow().close().catch(() => {});
}
</script>

<style scoped>
.check-window {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.check-header {
  flex: none;
  height: 34px;
  display: flex;
  align-items: center;
  padding: 0 72px 0 14px;
  box-sizing: border-box;
}
.check-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}
.check-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 2px 14px 0;
  box-sizing: border-box;
}
.check-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding-right: 2px;
}
.check-item {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background-color: #fff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.check-item:hover {
  border-color: #d9ecff;
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.12);
}
.check-item-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #c0c4cc;
}
.check-item.is-running .check-item-dot {
  background-color: #409eff;
}
.check-item.is-ok .check-item-dot {
  background-color: #67c23a;
}
.check-item.is-fail .check-item-dot {
  background-color: #f56c6c;
}
.check-item.is-error .check-item-dot {
  background-color: #e6a23c;
}
.check-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.check-item-name {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.check-item-message {
  font-size: 12px;
  color: #909399;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.check-item-ops {
  flex: none;
  display: flex;
  align-items: center;
}
.check-item-ops :deep(.el-button + .el-button) {
  margin-left: 2px;
}
.check-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 8px 14px 10px;
  box-sizing: border-box;
}
.check-summary {
  margin-right: auto;
  padding-left: 2px;
  font-size: 12px;
  color: #909399;
}
.check-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.check-detail-summary {
  font-size: 12px;
  color: #606266;
}
.check-detail-desc {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.check-detail-issues {
  max-height: 240px;
  margin-top: 8px;
  overflow-y: auto;
}
.check-detail-issue {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background-color: #fafafa;
  font-size: 12px;
  line-height: 1.5;
}
.check-detail-issue + .check-detail-issue {
  margin-top: 4px;
}
.check-detail-issue-name {
  flex: none;
  color: #606266;
}
.check-detail-issue-reason {
  color: #f56c6c;
  word-break: break-all;
}
.check-detail-empty {
  margin: 16px 0 4px;
  font-size: 12px;
  color: #909399;
  text-align: center;
}
.close-button {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background-color: #fff;
}
.close-button .el-icon {
  font-size: 22px;
  color: #b9b8b8;
}
.close-button:hover {
  background-color: #e38e8e;
}
.close-button:hover .el-icon {
  color: #f3f3f3;
}
</style>

<style>
.check-tip-popper {
  max-width: 340px;
  line-height: 1.6;
}
.check-tip-desc {
  margin: 0;
  font-size: 12px;
  color: #909399;
}
.check-tip-summary {
  margin: 6px 0 0;
  font-size: 12px;
  color: #606266;
}
.check-tip-issues {
  max-height: 200px;
  margin-top: 6px;
  overflow-y: auto;
}
.check-tip-issue {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
}
.check-tip-issue-name {
  flex: none;
  color: #606266;
}
.check-tip-issue-reason {
  color: #f56c6c;
  word-break: break-all;
}
.check-tip-ok {
  margin: 6px 0 0;
  font-size: 12px;
  color: #67c23a;
}
</style>
