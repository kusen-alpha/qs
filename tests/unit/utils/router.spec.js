import { beforeEach, describe, expect, it, vi } from 'vitest';
import router from '@/router';

/* 页面组件体积较大（内嵌图表库），路由用例只验证 class 前缀，这里用轻量桩组件避免拖慢用例 */
const { stub } = vi.hoisted(() => ({
  stub: (name) => ({ __esModule: true, default: { name, render: () => null } }),
}));
vi.mock('@/views/Group.vue', () => stub('GroupStub'));
vi.mock('@/views/Setting.vue', () => stub('SettingStub'));
vi.mock('@/views/Monitor.vue', () => stub('MonitorStub'));
vi.mock('@/views/BoardChart.vue', () => stub('BoardChartStub'));
vi.mock('@/views/Setup.vue', () => stub('SetupStub'));
vi.mock('@/views/Calendar.vue', () => stub('CalendarStub'));
vi.mock('@/views/Check.vue', () => stub('CheckStub'));

async function goto(path) {
  const app = document.createElement('div');
  app.id = 'app';
  document.body.innerHTML = '';
  document.body.appendChild(app);
  await router.push(path);
  await router.isReady();
  return app;
}

describe('router · 路由表', () => {
  beforeEach(async () => {
    await goto('/');
  });

  it('页面路由齐全', () => {
    const routes = router.options.routes.map((r) => [r.path, r.name]);
    expect(routes).toEqual([
      ['/setup', 'setup'],
      ['/', 'monitor'],
      ['/edit', 'editor'],
      ['/detail', 'detail'],
      ['/setting', 'setting'],
      ['/group', 'group'],
      ['/market', 'market'],
      ['/calendar', 'calendar'],
      ['/check', 'check'],
      ['/boardchart', 'boardChart'],
    ]);
  });

  it('导航后按页面给 #app 打上样式前缀 class', async () => {
    expect((await goto('/setup')).className).toBe('page-setup');
    expect((await goto('/group')).className).toBe('page-group');
    expect((await goto('/setting')).className).toBe('page-setting');
    expect((await goto('/boardchart')).className).toBe('page-detail');
    expect((await goto('/calendar')).className).toBe('page-calendar');
    expect((await goto('/check')).className).toBe('page-check');
    expect((await goto('/')).className).toBe('page-main');
  });
});
