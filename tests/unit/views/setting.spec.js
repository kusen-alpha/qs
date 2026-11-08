import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Setting from '@/views/Setting.vue';
import { useCacheStore } from '@/stores/cache';
import { useSettingStore } from '@/stores/setting';
import { freshPinia } from '../../helpers';

function mountSetting() {
  freshPinia();
  const setting = useSettingStore();
  const cache = useCacheStore();
  setting.tableSize = 'small';
  setting.fixedWidth = 380;
  const wrapper = mount(Setting, {
    global: {
      plugins: [ElementPlus],
      stubs: {
        SettingMenu: true,
        SettingHeader: true,
        SettingMain: true,
      },
    },
  });
  return { wrapper, cache, setting };
}

async function clickSaveButton(wrapper, index) {
  const buttons = wrapper.findAll('.save-button');
  await buttons[index].trigger('click');
}

describe('Setting 视图 · 保存 / 取消', () => {
  it('挂载时用持久化设置初始化草稿缓存', () => {
    const { cache } = mountSetting();
    expect(cache.tableSize).toBe('small');
    expect(cache.fixedWidth).toBe(380);
  });

  it('保存把草稿写回设置并重新同步草稿', async () => {
    const { wrapper, cache, setting } = mountSetting();
    cache.tableSize = 'large';
    cache.fixedWidth = 420;
    await clickSaveButton(wrapper, 1);
    expect(setting.tableSize).toBe('large');
    expect(setting.fixedWidth).toBe(420);
    expect(cache.tableSize).toBe('large');
  });

  it('取消丢弃草稿，恢复为已保存设置', async () => {
    const { wrapper, cache } = mountSetting();
    cache.tableSize = 'large';
    cache.fixedWidth = 420;
    await clickSaveButton(wrapper, 0);
    expect(cache.tableSize).toBe('small');
    expect(cache.fixedWidth).toBe(380);
  });
});
