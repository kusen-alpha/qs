import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import CalendarTable from '@/components/monitor/CalendarTable.vue';
import { emit, on } from '@/utils/events';
import { freshPinia } from '../../helpers';

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));

vi.mock('@/utils/db', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadCalendarEvents: loadMock };
});

const EVENTS = [
  {
    id: 1,
    name: '股东大会',
    start_date: '2026-11-05',
    end_date: '2026-11-06',
    repeat_type: 'none',
  },
  {
    id: 2,
    name: '月度复盘',
    start_date: '2025-01-31',
    end_date: '2025-01-31',
    repeat_type: 'monthly',
  },
  {
    id: 3,
    name: '已结束事件',
    start_date: '2026-10-01',
    end_date: '2026-10-02',
    repeat_type: 'none',
  },
];

const wrappers = [];

async function mountTable() {
  freshPinia();
  loadMock.mockResolvedValue(EVENTS);
  const wrapper = mount(CalendarTable, { global: { plugins: [ElementPlus] } });
  wrappers.push(wrapper);
  await flushPromises();
  wrapper.vm.today = new Date(2026, 10, 2);
  await nextTick();
  return wrapper;
}

afterEach(async () => {
  // 先卸载再等待：ElTable 卸载时会排一个 50ms 的 debounce 布局任务，
  // 若先等待后卸载，该任务会残留到测试环境销毁之后触发 requestAnimationFrame 报错。
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  await new Promise((resolve) => setTimeout(resolve, 80));
});

function tableData(wrapper) {
  return wrapper.findComponent({ name: 'ElTable' }).props('data');
}

describe('CalendarTable · 日历列表', () => {
  it('展示未结束事件，重复事件自动推进到下一次', async () => {
    const wrapper = await mountTable();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(tableData(wrapper).map((row) => row.name)).toEqual(['股东大会', '月度复盘']);
    expect(tableData(wrapper).map((row) => row.countdown_text)).toEqual(['3 天', '28 天']);
    expect(tableData(wrapper)[1].start_date).toBe('2026-11-30');
  });

  it('列表不再提供操作列', async () => {
    const wrapper = await mountTable();
    const headers = wrapper.findAll('.el-table__header th').map((th) => th.text());
    expect(headers).toEqual(['名称', '开始', '结束', '倒计时']);
  });

  it('列表为只读，不包含事件管理弹窗', async () => {
    const wrapper = await mountTable();
    expect(wrapper.findComponent({ name: 'CalendarEventDialog' }).exists()).toBe(false);
    expect(wrapper.find('.el-dialog').exists()).toBe(false);
  });

  it('收到 calendarChanged 后重新加载列表', async () => {
    await mountTable();
    loadMock.mockClear();
    await emit('calendarChanged');
    await flushPromises();
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('加载完成后通知主窗口重新计算高度，避免底部图标栏被挤出', async () => {
    await mountTable();
    const handler = vi.fn();
    const off = await on('stateChange', handler);
    await emit('calendarChanged');
    await flushPromises();
    off();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
