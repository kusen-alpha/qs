import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'monitor', component: () => import('../views/Monitor.vue') },
  { path: '/edit', name: 'editor', component: () => import('../views/Editor.vue') },
  { path: '/detail', name: 'detail', component: () => import('../views/Detail.vue') },
  { path: '/setting', name: 'setting', component: () => import('../views/Setting.vue') },
  { path: '/group', name: 'group', component: () => import('../views/Group.vue') },
  { path: '/market', name: 'market', component: () => import('../views/MarketWidth.vue') },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 原版 CSS 的组件作用域规则按页面前缀隔离，这里给 #app 打上页面标记
const PAGE_CLASS = {
  monitor: 'main',
  editor: 'edit',
  detail: 'detail',
  setting: 'setting',
  group: 'group',
  market: 'market',
};

router.afterEach((to) => {
  const el = document.getElementById('app');
  if (el) el.className = `page-${PAGE_CLASS[to.name] || 'main'}`;
});

export default router;
