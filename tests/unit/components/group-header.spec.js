import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import GroupHeader from '@/components/group/GroupHeader.vue';
import { useCacheStore } from '@/stores/cache';
import { concept, freshPinia, stock } from '../../helpers';

function mountHeader(selectGroup) {
  freshPinia();
  const cache = useCacheStore();
  cache.group = [
    concept(0, '自选', [stock('600519')]),
    concept(1, '行业', [], [concept(2, '白酒', [stock('000858')])]),
  ];
  cache.selectGroup = selectGroup;
  const wrapper = mount(GroupHeader, {
    global: {
      plugins: [ElementPlus],
      stubs: {
        'el-tooltip': { template: '<div><slot /></div>' },
      },
    },
  });
  return { wrapper, cache };
}

describe('GroupHeader · 选中概念头部', () => {
  it('选中二级概念时显示其名称', () => {
    const { wrapper } = mountHeader(2);
    expect(wrapper.find('.group-name').text()).toBe('白酒');
  });

  it('可选中的概念都能重命名', async () => {
    const { wrapper, cache } = mountHeader(2);
    await wrapper.findAll('button')[0].trigger('click');
    const input = wrapper.find('.input-new-tag input');
    await input.setValue('白酒改');
    await wrapper.find('.input-new-tag button').trigger('click');
    expect(cache.findConceptById(2).name).toBe('白酒改');
  });

  it('自选（id=0）的重命名 / 删除按钮禁用', () => {
    const { wrapper } = mountHeader(0);
    const buttons = wrapper.findAll('button');
    expect(buttons[0].attributes('disabled')).toBeDefined();
    expect(buttons[1].attributes('disabled')).toBeDefined();
  });

  it('删除二级概念后选中项回落到首个一级概念', async () => {
    const { wrapper, cache } = mountHeader(2);
    await wrapper.findAll('button')[1].trigger('click');
    const footerButtons = wrapper.findAll('.el-dialog button');
    const confirm = footerButtons.find((b) => b.text().includes('确认'));
    await confirm.trigger('click');
    expect(cache.group[1].children).toEqual([]);
    expect(cache.selectGroup).toBe(0);
  });

  it('二级概念在删除按钮右侧有移动按钮，一级概念没有', () => {
    const sub = mountHeader(2);
    expect(sub.wrapper.findAll('button')).toHaveLength(3);
    // 三个操作按钮同属右侧操作列，整体左移以避开窗口最大化 / 关闭按钮
    expect(sub.wrapper.find('.header-ops').findAll('button')).toHaveLength(3);

    const top = mountHeader(1);
    expect(top.wrapper.findAll('button')).toHaveLength(2);
  });

  it('移动弹窗里只能选其他一级概念，确认后二级概念挂到目标下', async () => {
    const { wrapper, cache } = mountHeader(2);
    cache.group.push(concept(3, '板块'));
    await nextTick();

    await wrapper.findAll('button')[2].trigger('click');
    expect(wrapper.vm.moveVisible).toBe(true);
    expect(wrapper.vm.moveTargets.map((g) => g.id)).toEqual([3]);

    wrapper.vm.moveTarget = 3;
    const confirm = wrapper
      .findAll('.el-dialog button')
      .find((b) => b.text().includes('确认'));
    await confirm.trigger('click');

    expect(cache.group[1].children).toEqual([]);
    expect(cache.group[2].children.map((c) => c.name)).toEqual(['白酒']);
    expect(wrapper.vm.moveVisible).toBe(false);
  });

  it('目标一级概念下已有同名二级概念时移动失败', async () => {
    const { wrapper, cache } = mountHeader(2);
    cache.group.push(concept(3, '板块', [], [concept(4, '白酒')]));
    await nextTick();

    await wrapper.findAll('button')[2].trigger('click');
    wrapper.vm.moveTarget = 3;
    const confirm = wrapper
      .findAll('.el-dialog button')
      .find((b) => b.text().includes('确认'));
    await confirm.trigger('click');

    expect(cache.group[1].children.map((c) => c.name)).toEqual(['白酒']);
    expect(cache.group[2].children.map((c) => c.name)).toEqual(['白酒']);
  });
});
