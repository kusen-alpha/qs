import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import GroupItemChangeDialog from '@/components/group/GroupItemChangeDialog.vue';
import { concept, stock } from '../../helpers';

const groups = [concept(0, '自选'), concept(1, '行业', [], [concept(2, '白酒')])];
// 实际使用时传入的是拍平后的一级 + 二级概念
const allGroups = [groups[0], groups[1], groups[1].children[0]];

function mountDialog(props = {}) {
  return mount(GroupItemChangeDialog, {
    props: {
      action: 'copy',
      symbols: [stock('600519', '贵州茅台')],
      groups: allGroups,
      curGroup: groups[0],
      ...props,
    },
    global: { plugins: [ElementPlus] },
  });
}

describe('GroupItemChangeDialog · 复制/删除目标选择', () => {
  it('展示选中股票的名称与数量', () => {
    const wrapper = mountDialog();
    expect(wrapper.text()).toContain('贵州茅台');
    expect(wrapper.text()).toContain('1');
  });

  it('多只股票只展示前两个名称', () => {
    const wrapper = mountDialog({
      symbols: [stock('000858', '五粮液'), stock('600036', '招商银行'), stock('601318', '中国平安')],
    });
    expect(wrapper.text()).toContain('五粮液, 招商银行');
    expect(wrapper.text()).not.toContain('中国平安');
    expect(wrapper.text()).toContain('3');
  });

  it('可复制目标排除当前概念', () => {
    const wrapper = mountDialog();
    const options = wrapper.findAllComponents({ name: 'ElOption' });
    expect(options.map((o) => o.props('label'))).toEqual(['行业', '白酒']);
  });

  it('copy 显示目标选择，delete 显示删除提示', () => {
    const copyWrapper = mountDialog({ action: 'copy' });
    const copyTexts = copyWrapper.findAll('.action-text');
    expect(copyTexts[0].text()).toBe('复制至分组:');
    expect(copyTexts[0].isVisible()).toBe(true);
    expect(copyTexts[1].text()).toBe('从分组删除');
    expect(copyTexts[1].isVisible()).toBe(false);

    const deleteWrapper = mountDialog({ action: 'delete' });
    const deleteTexts = deleteWrapper.findAll('.action-text');
    expect(deleteTexts[0].isVisible()).toBe(false);
    expect(deleteTexts[1].isVisible()).toBe(true);
  });

  it('选择目标后向父组件抛出 selectGroupChange', () => {
    const wrapper = mountDialog();
    wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('change', '白酒');
    expect(wrapper.emitted('selectGroupChange')[0]).toEqual(['白酒']);
  });

  it('openClear 清空已选目标', async () => {
    const wrapper = mountDialog();
    const select = wrapper.findComponent({ name: 'ElSelect' });
    select.vm.$emit('update:modelValue', '白酒');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'ElSelect' }).props('modelValue')).toBe('白酒');
    wrapper.vm.openClear();
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'ElSelect' }).props('modelValue')).toBe('');
  });
});
