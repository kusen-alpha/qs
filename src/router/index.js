import { createRouter, createWebHashHistory } from 'vue-router';
import { isTauri } from '../utils/env';
import { readSetupState } from '../utils/setup';

const routes = [
  { path: '/setup', name: 'setup', component: () => import('../views/Setup.vue') },
  { path: '/', name: 'monitor', component: () => import('../views/Monitor.vue') },
  { path: '/edit', name: 'editor', component: () => import('../views/Editor.vue') },
  { path: '/detail', name: 'detail', component: () => import('../views/Detail.vue') },
  { path: '/setting', name: 'setting', component: () => import('../views/Setting.vue') },
  { path: '/group', name: 'group', component: () => import('../views/Group.vue') },
  { path: '/market', name: 'market', component: () => import('../views/MarketWidth.vue') },
  { path: '/calendar', name: 'calendar', component: () => import('../views/Calendar.vue') },
  { path: '/check', name: 'check', component: () => import('../views/Check.vue') },
  {
    path: '/boardchart',
    name: 'boardChart',
    component: () => import('../views/BoardChart.vue'),
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 原版 CSS 的组件作用域规则按页面前缀隔离，这里给 #app 打上页面标记
const PAGE_CLASS = {
  setup: 'setup',
  monitor: 'main',
  editor: 'edit',
  detail: 'detail',
  setting: 'setting',
  group: 'group',
  market: 'market',
  calendar: 'calendar',
  check: 'check',
  // 板块/概念图表页沿用看盘页的样式前缀（左侧菜单 + 右侧图表）
  boardChart: 'detail',
};

// 数据库未配置时只允许停留在初始化向导，配置成功后才能进入主界面
router.beforeEach(async (to) => {
  if (!isTauri() || to.name === 'setup') return true;
  const state = await readSetupState();
  if (!state || !state.configured) return { name: 'setup', replace: true };
  return true;
});

router.afterEach((to) => {
  const el = document.getElementById('app');
  if (el) el.className = `page-${PAGE_CLASS[to.name] || 'main'}`;
});

export default router;
