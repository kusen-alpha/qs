import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import GroupMenu from '@/components/group/GroupMenu.vue';
import { useCacheStore } from '@/stores/cache';
import { concept, freshPinia, stock } from '../../helpers';

function mountMenu() {
  freshPinia();
  const cache = useCacheStore();
  cache.group = [
    concept(0, '自选', [stock('600519', '贵州茅台')]),
    concept(1, '行业', [], [concept(2, '白酒', [stock('000858', '五粮液')])]),
  ];
  cache.selectGroup = 0;
  const wrapper = mount(GroupMenu, { global: { plugins: [ElementPlus] } });
  return { wrapper, cache };
}

async function typeAndEnter(wrapper, selector, value) {
  const input = wrapper.find(`${selector} input`);
  await input.setValue(value);
  await input.trigger('keyup.enter');
}

async function clickItem(wrapper, name) {
  const item = wrapper.findAll('.el-menu-item').find((w) => w.text().includes(name));
  await item.trigger('click');
}

describe('GroupMenu · 两级概念菜单', () => {
  let wrapper;
  let cache;

  beforeEach(() => {
    ({ wrapper, cache } = mountMenu());
  });

  it('底部按钮为「+ 新概念」', () => {
    expect(wrapper.find('.button-new-tag').text()).toBe('+ 新概念');
    expect(wrapper.text()).not.toContain('新分组');
  });

  it('一级概念默认收缩，只渲染一级概念', () => {
    const texts = wrapper.findAll('.el-menu-item').map((w) => w.text());
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('自选');
    expect(texts[1]).toContain('行业');
    expect(wrapper.findAll('.sub-item')).toHaveLength(0);
  });

  it('点击一级概念展开二级，再点一次收起', async () => {
    await clickItem(wrapper, '行业');
    expect(cache.selectGroup).toBe(1);
    expect(wrapper.findAll('.sub-item')).toHaveLength(1);
    expect(wrapper.find('.sub-item').text()).toContain('白酒');

    await clickItem(wrapper, '行业');
    expect(wrapper.findAll('.sub-item')).toHaveLength(0);
  });

  it('展开另一个一级概念时，前一个自动收起', async () => {
    cache.group.push(concept(3, '板块', [], [concept(4, '水泥', [stock('600585')])]));
    await nextTick();

    await clickItem(wrapper, '行业');
    await clickItem(wrapper, '板块');
    expect(cache.selectGroup).toBe(3);
    expect(wrapper.findAll('.sub-item').map((w) => w.text())).toEqual([
      expect.stringContaining('水泥'),
    ]);
  });

  it('点击二级概念保持所属一级概念展开，缩进样式不变', async () => {
    await clickItem(wrapper, '行业');
    await clickItem(wrapper, '白酒');
    expect(cache.selectGroup).toBe(2);
    expect(wrapper.findAll('.sub-item')).toHaveLength(1);
    expect(wrapper.find('.sub-item').classes()).toContain('is-active');
  });

  it('只有可编辑的一级概念右侧有 + 号（自选没有）', () => {
    const buttons = wrapper.findAll('.add-sub-button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].element.closest('.el-menu-item').textContent).toContain('行业');
  });

  it('点 + 新概念 输入名称并回车创建一级概念', async () => {
    await wrapper.find('.button-new-tag').trigger('click');
    await typeAndEnter(wrapper, '.input-new-tag', '板块');
    expect(cache.group).toHaveLength(3);
    expect(cache.group[2]).toMatchObject({ name: '板块', children: [] });
  });

  it('重名创建一级概念会被拒绝', async () => {
    await wrapper.find('.button-new-tag').trigger('click');
    await typeAndEnter(wrapper, '.input-new-tag', '行业');
    expect(cache.group).toHaveLength(2);
  });

  it('点一级概念右侧 + 弹出输入框，确认后新增二级概念', async () => {
    await wrapper.find('.add-sub-button').trigger('click');
    expect(wrapper.find('.sub-input-new-tag').exists()).toBe(true);
    await typeAndEnter(wrapper, '.sub-input-new-tag', '啤酒');
    expect(cache.group[1].children.map((c) => c.name)).toEqual(['白酒', '啤酒']);
  });

  it('二级概念同一一级概念下不能重名，不同一级概念之间可以重名', async () => {
    await wrapper.find('.add-sub-button').trigger('click');
    await typeAndEnter(wrapper, '.sub-input-new-tag', '白酒');
    expect(cache.group[1].children).toHaveLength(1);

    cache.group.push(concept(3, '板块'));
    await nextTick();
    expect(cache.addSubConcept(3, '白酒')).toBe(true);
    expect(cache.group[2].children.map((c) => c.name)).toEqual(['白酒']);

    cache.group[1].children.forEach((c) => expect(c.children || []).toHaveLength(0));
  });

  it('↑↓ 按钮可调整一级概念与二级概念顺序', async () => {
    cache.group[1].children.push(concept(3, '啤酒'));
    cache.group.push(concept(4, '板块'));
    await nextTick();

    const board = wrapper.findAll('.concept-item').find((w) => w.text().includes('板块'));
    await board.findAll('.move-btn')[0].trigger('click');
    expect(cache.group.map((g) => g.name)).toEqual(['自选', '板块', '行业']);

    await clickItem(wrapper, '行业');
    const beer = wrapper.findAll('.sub-item').find((w) => w.text().includes('啤酒'));
    await beer.findAll('.move-btn')[0].trigger('click');
    expect(cache.group.find((g) => g.id === 1).children.map((c) => c.name)).toEqual([
      '啤酒',
      '白酒',
    ]);
  });
});
