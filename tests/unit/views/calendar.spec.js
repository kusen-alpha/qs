import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus';
import Calendar from '@/views/Calendar.vue';
import { emit } from '@/utils/events';

const { loadMock, saveMock, deleteMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  saveMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/utils/db', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadCalendarEvents: loadMock,
    saveCalendarEvent: saveMock,
    deleteCalendarEvent: deleteMock,
  };
});

vi.mock('@/utils/events', () => ({ emit: vi.fn(), on: vi.fn() }));

vi.mock('@/utils/env', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isTauri: () => true };
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
];

const wrappers = [];

async function mountView() {
  saveMock.mockResolvedValue(5);
  deleteMock.mockResolvedValue(1);
  loadMock.mockResolvedValue(EVENTS);
  const wrapper = mount(Calendar, { global: { plugins: [ElementPlus] } });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('Calendar 页面 · 独立事件管理窗口', () => {
  it('打开时加载全部已有事件（含已结束事件）', async () => {
    const wrapper = await mountView();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(wrapper.vm.events).toEqual(EVENTS);
    expect(wrapper.text()).toContain('已有事件（2）');
    expect(wrapper.text()).toContain('股东大会');
  });

  it('新增事件保存名称、日期与重复类型，并通知主窗口刷新', async () => {
    vi.spyOn(ElMessage, 'success').mockImplementation(() => {});
    const wrapper = await mountView();
    wrapper.vm.form.name = ' 新品发布 ';
    wrapper.vm.form.start_date = '2026-11-10';
    wrapper.vm.form.end_date = '2026-11-12';
    wrapper.vm.form.repeat_type = 'yearly';
    await wrapper.vm.save();
    await flushPromises();

    expect(saveMock).toHaveBeenCalledWith({
      name: '新品发布',
      start_date: '2026-11-10',
      end_date: '2026-11-12',
      repeat_type: 'yearly',
    });
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('calendarChanged');
    expect(wrapper.vm.form.name).toBe('');
  });

  it('编辑已有事件时回填首次日期并带上 id', async () => {
    const wrapper = await mountView();
    wrapper.vm.startEdit(EVENTS[1]);
    await nextTick();
    expect(wrapper.vm.editingId).toBe(2);
    expect(wrapper.vm.isEdit).toBe(true);
    expect(wrapper.vm.form).toMatchObject({
      name: '月度复盘',
      start_date: '2025-01-31',
      end_date: '2025-01-31',
      repeat_type: 'monthly',
    });

    await wrapper.vm.save();
    await flushPromises();
    expect(saveMock).toHaveBeenLastCalledWith({
      id: 2,
      name: '月度复盘',
      start_date: '2025-01-31',
      end_date: '2025-01-31',
      repeat_type: 'monthly',
    });
    expect(wrapper.vm.editingId).toBe(null);
  });

  it('确认删除后调用删除命令、重新加载并通知主窗口刷新', async () => {
    const wrapper = await mountView();
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue();
    await wrapper.vm.remove(EVENTS[0]);
    await flushPromises();
    expect(deleteMock).toHaveBeenCalledWith(1);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('calendarChanged');
  });

  it('删除重复事件时确认框提示会移除整条系列', async () => {
    const wrapper = await mountView();
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue();
    await wrapper.vm.remove(EVENTS[1]);
    await flushPromises();

    expect(confirm.mock.calls[0][0]).toContain('整条系列');
    expect(deleteMock).toHaveBeenCalledWith(2);
  });

  it('删除非重复事件不显示系列提示', async () => {
    const wrapper = await mountView();
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue();
    await wrapper.vm.remove(EVENTS[0]);
    await flushPromises();

    expect(confirm.mock.calls[0][0]).not.toContain('整条系列');
  });

  it('删除返回 0 行时提示失败并重新加载', async () => {
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => {});
    const wrapper = await mountView();
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue();
    deleteMock.mockResolvedValueOnce(0);
    await wrapper.vm.remove(EVENTS[0]);
    await flushPromises();
    expect(error).toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('calendarChanged');
  });

  it('名称为空、日期缺失或结束早于开始时阻止保存', async () => {
    vi.spyOn(ElMessage, 'warning').mockImplementation(() => {});
    saveMock.mockClear();
    const wrapper = await mountView();

    wrapper.vm.form.name = '   ';
    wrapper.vm.form.start_date = '2026-11-01';
    wrapper.vm.form.end_date = '2026-11-02';
    await wrapper.vm.save();

    wrapper.vm.form.name = '事件';
    wrapper.vm.form.start_date = '';
    wrapper.vm.form.end_date = '';
    await wrapper.vm.save();

    wrapper.vm.form.start_date = '2026-11-05';
    wrapper.vm.form.end_date = '2026-11-01';
    await wrapper.vm.save();

    expect(saveMock).not.toHaveBeenCalled();
  });

  it('结束日期选择器禁用早于开始日期的日期', async () => {
    const wrapper = await mountView();
    wrapper.vm.form.start_date = '2026-11-05';
    expect(wrapper.vm.disabledEndDate(new Date(2026, 10, 4))).toBe(true);
    expect(wrapper.vm.disabledEndDate(new Date(2026, 10, 5))).toBe(false);
  });

  it('窗口标题栏与关闭按钮存在', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.calendar-title').text()).toBe('日历事件');
    expect(wrapper.find('#titlebar-close').exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'WindowMaxButton' }).exists()).toBe(true);
  });
});
