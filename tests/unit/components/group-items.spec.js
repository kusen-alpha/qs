import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import GroupItems from '@/components/group/GroupItems.vue';
import { useCacheStore } from '@/stores/cache';
import { concept, freshPinia, stock } from '../../helpers';

const wrappers = [];

function mountItems(selectGroup = 2) {
  freshPinia();
  const cache = useCacheStore();
  cache.group = [
    concept(0, '自选', [stock('600519', '贵州茅台')]),
    concept(1, '行业', [], [
      concept(2, '白酒', [stock('000858', '五粮液'), stock('600036', '招商银行')]),
    ]),
  ];
  cache.selectGroup = selectGroup;
  const wrapper = mount(GroupItems, { global: { plugins: [ElementPlus] } });
  wrappers.push(wrapper);
  return { wrapper, cache };
}

afterEach(async () => {
  // 等弹窗的锁屏/布局定时器先执行，避免环境销毁后回调再访问 document
  await new Promise((resolve) => setTimeout(resolve, 80));
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  await new Promise((resolve) => setTimeout(resolve, 120));
});

describe('GroupItems · 股票表格', () => {
  it('自选与二级概念有「添加」「删除」，一级概念没有股票增删按钮', () => {
    const watch = mountItems(0);
    expect(watch.wrapper.findAll('.icon_row button').map((b) => b.text())).toEqual(['添加', '删除']);

    const top = mountItems(1);
    expect(top.wrapper.find('.icon_row').exists()).toBe(false);

    const sub = mountItems(2);
    expect(sub.wrapper.findAll('.icon_row button').map((b) => b.text())).toEqual(['添加', '删除']);
    expect(sub.wrapper.text()).not.toContain('复制');
  });

  it('选中二级概念时表格展示它自己的股票', async () => {
    const { wrapper } = mountItems(2);
    await nextTick();
    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.props('data').map((row) => row.name)).toEqual(['五粮液', '招商银行']);
  });

  it('行内删除按钮只删掉二级概念里的这只股票', async () => {
    const { wrapper, cache } = mountItems(2);
    await nextTick();
    wrapper.vm.deleteOne(cache.findConceptById(2).symbols[0]);
    expect(cache.findConceptById(2).symbols.map((s) => s.symbol)).toEqual(['600036']);
    expect(cache.findConceptById(0).symbols).toHaveLength(1);
  });

  it('自选在表格里展示自己的股票', async () => {
    const { wrapper } = mountItems(0);
    await nextTick();
    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.props('data').map((row) => row.name)).toEqual(['贵州茅台']);
  });

  it('选中一级概念时展示其下所有二级概念股票的并集（按 secid 去重）', async () => {
    const { wrapper, cache } = mountItems(1);
    cache.findConceptById(2).symbols.push(stock('600519', '贵州茅台'));
    await nextTick();
    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.props('data').map((row) => row.symbol)).toEqual([
      '000858',
      '600036',
      '600519',
    ]);
    // 一级概念没有行内删除入口，也没有勾选框
    expect(wrapper.findAll('.el-table__body button')).toHaveLength(0);
    expect(wrapper.findAll('.el-table__body input[type="checkbox"]')).toHaveLength(0);
  });

  it('二级概念「添加」弹窗确认后，勾选的自选股票写入当前二级概念', async () => {
    const { wrapper, cache } = mountItems(2);
    wrapper.vm.openAdd();
    await nextTick();
    expect(wrapper.vm.pickerVisible).toBe(true);
    wrapper.vm.picked = ['1.600519'];
    wrapper.vm.confirmPick();
    expect(cache.findConceptById(2).symbols.map((s) => s.symbol)).toEqual([
      '000858',
      '600036',
      '600519',
    ]);
    expect(wrapper.vm.pickerVisible).toBe(false);
  });

  it('弹窗里已在二级概念中的股票不会被重复添加', async () => {
    const { wrapper, cache } = mountItems(2);
    cache.group[0].symbols.push(stock('000858', '五粮液'));
    wrapper.vm.openAdd();
    await nextTick();
    wrapper.vm.picked = ['1.600519', '1.000858'];
    wrapper.vm.confirmPick();
    expect(cache.findConceptById(2).symbols.map((s) => s.symbol)).toEqual([
      '000858',
      '600036',
      '600519',
    ]);
  });
});
