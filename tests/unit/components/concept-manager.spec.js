import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessageBox } from 'element-plus';
import ConceptManager from '@/components/monitor/ConceptManager.vue';
import { useConceptStore } from '@/stores/concept';
import { useMonitorStore } from '@/stores/monitor';
import { concept, freshPinia, stock } from '../../helpers';

const wrappers = [];

function buildConcepts() {
  return [
    concept('c1', '行业', [], [
      concept('s1', '白酒', [
        stock('600519', '贵州茅台', '1.600519'),
        stock('000858', '五粮液', '0.000858'),
      ]),
      concept('s2', '啤酒', [stock('600600', '青岛啤酒', '1.600600')]),
    ]),
    concept('c2', '板块', [], [concept('s3', '水泥', [])]),
  ];
}

function mountManager(concepts = buildConcepts()) {
  freshPinia();
  const store = useConceptStore();
  const monitor = useMonitorStore();
  [store, monitor].forEach((item) => {
    item.$persist = () => {};
    item.$hydrate = () => {};
  });
  store.concepts = concepts;
  monitor.watchGroup[0].symbols = [
    stock('600519', '贵州茅台', '1.600519'),
    stock('000858', '五粮液', '0.000858'),
    stock('600036', '招商银行', '1.600036'),
  ];
  const wrapper = mount(ConceptManager, { global: { plugins: [ElementPlus] } });
  wrappers.push(wrapper);
  return { wrapper, store, monitor };
}

function menuNames(wrapper) {
  return wrapper.findAll('.menu-item .menu-name').map((node) => node.text());
}

function subRows(wrapper) {
  return wrapper.findComponent({ name: 'ElTable' }).props('data');
}

function headerButtons(wrapper) {
  return wrapper.findAll('.header-ops .el-button');
}

async function addConcept(wrapper, name) {
  await wrapper.find('.button-new-tag').trigger('click');
  await nextTick();
  const input = wrapper.find('.input-new-tag input');
  await input.setValue(name);
  await input.trigger('keyup.enter');
  await nextTick();
}

afterEach(async () => {
  // 等表格的防抖布局任务执行完，卸载后再留出时间消化残留的 requestAnimationFrame
  await new Promise((resolve) => setTimeout(resolve, 80));
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  await new Promise((resolve) => setTimeout(resolve, 120));
});

describe('ConceptManager · 概念管理', () => {
  it('左侧渲染一级概念、成分股数量，默认选中第一个', () => {
    const { wrapper } = mountManager();
    expect(menuNames(wrapper)).toEqual(['行业', '板块']);
    expect(wrapper.findAll('.menu-count-tag').map((tag) => tag.text())).toEqual(['3', '0']);
    expect(wrapper.findAll('.menu-item')[0].classes()).toContain('is-active');
    expect(wrapper.find('.group-name').text()).toBe('行业');
    expect(subRows(wrapper).map((row) => row.name)).toEqual(['白酒', '啤酒']);
  });

  it('点击一级概念切换右侧二级概念列表', async () => {
    const { wrapper } = mountManager();
    await wrapper.findAll('.menu-item')[1].trigger('click');
    await nextTick();
    expect(wrapper.findAll('.menu-item')[1].classes()).toContain('is-active');
    expect(wrapper.findAll('.menu-item')[0].classes()).not.toContain('is-active');
    expect(wrapper.find('.group-name').text()).toBe('板块');
    expect(subRows(wrapper).map((row) => row.name)).toEqual(['水泥']);
  });

  it('没有概念时展示空态，编辑按钮全部禁用', () => {
    const { wrapper } = mountManager([]);
    expect(wrapper.find('.menu-empty').text()).toBe('暂无概念');
    expect(wrapper.find('.group-name').text()).toBe('');
    expect(wrapper.findAll('.header-ops .el-button')).toHaveLength(4);
    headerButtons(wrapper).forEach((button) => {
      expect(button.attributes('disabled')).toBeDefined();
    });
    expect(wrapper.find('.icon_row button').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.el-table__empty-text').text()).toBe('暂无二级概念');
  });

  it('新增一级概念后自动选中新概念', async () => {
    const { wrapper, store } = mountManager();
    await addConcept(wrapper, '新能源');
    expect(store.concepts).toHaveLength(3);
    expect(store.concepts[2].name).toBe('新能源');
    expect(wrapper.findAll('.menu-item')[2].classes()).toContain('is-active');
    expect(wrapper.find('.group-name').text()).toBe('新能源');
    expect(wrapper.find('.button-new-tag').exists()).toBe(true);
  });

  it('新增一级概念时空白名称不会创建', async () => {
    const { wrapper, store } = mountManager();
    await addConcept(wrapper, '   ');
    expect(store.concepts).toHaveLength(2);
    expect(wrapper.find('.button-new-tag').exists()).toBe(true);
  });

  it('重命名当前一级概念', async () => {
    const { wrapper, store } = mountManager();
    await headerButtons(wrapper)[2].trigger('click');
    await nextTick();
    const input = wrapper.find('.concept-header .input-new-tag input');
    expect(input.element.value).toBe('行业');
    await input.setValue('消费');
    await input.trigger('keyup.enter');
    await nextTick();
    expect(store.concepts[0].name).toBe('消费');
    expect(wrapper.find('.group-name').text()).toBe('消费');
  });

  it('重命名输入空白时保留原名称', async () => {
    const { wrapper, store } = mountManager();
    await headerButtons(wrapper)[2].trigger('click');
    await nextTick();
    const input = wrapper.find('.concept-header .input-new-tag input');
    await input.setValue('   ');
    await input.trigger('keyup.enter');
    await nextTick();
    expect(store.concepts[0].name).toBe('行业');
  });

  it('删除概念需要确认，确认后删除并自动选中剩余第一个', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm');
    const { wrapper, store } = mountManager();
    await headerButtons(wrapper)[3].trigger('click');
    await flushPromises();
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(
      '确认删除概念「行业」？',
      '确认删除',
      expect.objectContaining({ type: 'warning' }),
    );
    expect(store.concepts.map((item) => item.name)).toEqual(['板块']);
    expect(wrapper.find('.group-name').text()).toBe('板块');
    expect(wrapper.findAll('.menu-item')).toHaveLength(1);
  });

  it('取消删除时概念保持不变', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel');
    const { wrapper, store } = mountManager();
    await headerButtons(wrapper)[3].trigger('click');
    await flushPromises();
    expect(store.concepts.map((item) => item.name)).toEqual(['行业', '板块']);
    expect(wrapper.find('.group-name').text()).toBe('行业');
  });

  it('一级概念上移下移，边界按钮禁用', async () => {
    const { wrapper, store } = mountManager();
    expect(headerButtons(wrapper)[0].attributes('disabled')).toBeDefined();
    expect(headerButtons(wrapper)[1].attributes('disabled')).toBeUndefined();

    await wrapper.findAll('.menu-item')[1].trigger('click');
    await nextTick();
    expect(headerButtons(wrapper)[0].attributes('disabled')).toBeUndefined();
    expect(headerButtons(wrapper)[1].attributes('disabled')).toBeDefined();

    await headerButtons(wrapper)[0].trigger('click');
    await nextTick();
    expect(menuNames(wrapper)).toEqual(['板块', '行业']);
    expect(store.concepts.map((item) => item.name)).toEqual(['板块', '行业']);
    expect(headerButtons(wrapper)[0].attributes('disabled')).toBeDefined();
  });

  it('新增二级概念后进入重命名输入框，回车保存名称', async () => {
    const { wrapper, store } = mountManager();
    await wrapper.findAll('.menu-add')[0].trigger('click');
    await nextTick();
    expect(subRows(wrapper)).toHaveLength(3);
    const input = wrapper.find('.el-table__body-wrapper input');
    expect(input.exists()).toBe(true);
    await input.setValue('黄酒');
    await input.trigger('keyup.enter');
    await nextTick();
    expect(store.concepts[0].children.map((item) => item.name)).toEqual([
      '白酒',
      '啤酒',
      '黄酒',
    ]);
  });

  it('二级概念上移下移改变顺序', async () => {
    const { wrapper, store } = mountManager();
    await flushPromises();
    await nextTick();
    const rows = wrapper.findAll('.el-table__body-wrapper .el-table__row');
    const beerRow = rows.find((row) => row.text().includes('啤酒'));
    await beerRow.findAll('button')[0].trigger('click');
    await nextTick();
    expect(store.concepts[0].children.map((item) => item.name)).toEqual([
      '啤酒',
      '白酒',
    ]);

    const whiteRow = wrapper
      .findAll('.el-table__body-wrapper .el-table__row')
      .find((row) => row.text().includes('白酒'));
    await whiteRow.findAll('button')[0].trigger('click');
    await nextTick();
    expect(store.concepts[0].children.map((item) => item.name)).toEqual([
      '白酒',
      '啤酒',
    ]);
  });

  it('删除二级概念只移除当前条目', async () => {
    const { wrapper, store } = mountManager();
    await flushPromises();
    await nextTick();
    const rows = wrapper.findAll('.el-table__body-wrapper .el-table__row');
    const whiteRow = rows.find((row) => row.text().includes('白酒'));
    await whiteRow.findAll('button')[3].trigger('click');
    await nextTick();
    expect(store.concepts[0].children.map((item) => item.name)).toEqual(['啤酒']);
    expect(subRows(wrapper).map((row) => row.name)).toEqual(['啤酒']);
  });

  it('二级概念可展开查看股票，展开后显示占位文案', async () => {
    const { wrapper } = mountManager();
    await flushPromises();
    await nextTick();
    const rows = wrapper.findAll('.el-table__body-wrapper .el-table__row');
    const whiteRow = rows.find((row) => row.text().includes('白酒'));
    await whiteRow.find('.el-table__expand-icon').trigger('click');
    await nextTick();
    expect(wrapper.findAll('.sub-stock-name').map((node) => node.text())).toEqual([
      '贵州茅台',
      '五粮液',
    ]);

    await whiteRow.find('.el-table__expand-icon').trigger('click');
    await wrapper.findAll('.menu-item')[1].trigger('click');
    await flushPromises();
    await nextTick();
    const cementRow = wrapper
      .findAll('.el-table__body-wrapper .el-table__row')
      .find((row) => row.text().includes('水泥'));
    await cementRow.find('.el-table__expand-icon').trigger('click');
    await nextTick();
    expect(wrapper.find('.sub-stock-empty').text()).toBe(
      '暂无股票，点击右侧 + 从自选添加',
    );
  });
});
