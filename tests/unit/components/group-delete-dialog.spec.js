import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import GroupDeleteDialog from '@/components/group/GroupDeleteDialog.vue';

describe('GroupDeleteDialog · 删除确认', () => {
  it('展示待删除概念名称与提示', () => {
    const wrapper = mount(GroupDeleteDialog, { props: { name: '白酒' } });
    expect(wrapper.text()).toContain('白酒');
    expect(wrapper.find('.delete-text').text()).toBe('删除?');
  });

  it('未传名称时不报错', () => {
    const wrapper = mount(GroupDeleteDialog);
    expect(wrapper.text()).toContain('删除?');
  });

  it('删除一级概念时提示会连带删除二级概念', () => {
    const wrapper = mount(GroupDeleteDialog, { props: { name: '行业', childCount: 3 } });
    expect(wrapper.find('.child-warning').text()).toContain('3 个二级概念将一并删除');
  });

  it('没有二级概念时不显示连带删除提示', () => {
    const wrapper = mount(GroupDeleteDialog, { props: { name: '白酒' } });
    expect(wrapper.find('.child-warning').exists()).toBe(false);
  });
});
