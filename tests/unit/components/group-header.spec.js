import { beforeEach, describe, expect, it } from 'vitest';
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

  it('自选（editable=false）的重命名 / 删除按钮禁用', () => {
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
});
