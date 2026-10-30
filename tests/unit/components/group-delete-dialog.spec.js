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
});
