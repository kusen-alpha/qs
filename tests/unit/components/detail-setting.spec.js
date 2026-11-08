import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import DetailSetting from '@/components/detail/DetailSetting.vue';
import { useSymbolStore } from '@/stores/symbol';
import { freshPinia } from '../../helpers';

const { messageMock, confirmMock } = vi.hoisted(() => ({
  messageMock: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ElMessage: messageMock,
    ElMessageBox: { confirm: confirmMock },
  };
});

const wrappers = [];

async function mountSetting(props = {}, configs = {}) {
  freshPinia();
  const symbol = useSymbolStore();
  symbol.configs = configs;
  const wrapper = mount(DetailSetting, {
    props: {
      name: '贵州茅台',
      code: '600519',
      secid: '1.600519',
      range: '2.5',
      price: '1500',
      ...props,
    },
    global: { plugins: [ElementPlus] },
  });
  wrappers.push(wrapper);
  /* onMounted 里 loadConfig 改写响应式字段，需要等一次调度后再断言 */
  await flushPromises();
  return { wrapper, symbol };
}

function switches(wrapper) {
  return wrapper.findAllComponents({ name: 'ElSwitch' });
}

function numbers(wrapper) {
  return wrapper.findAllComponents({ name: 'ElInputNumber' });
}

async function clickSave(wrapper) {
  await wrapper.find('.bottom-card button').trigger('click');
  await flushPromises();
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('DetailSetting · 个股持仓与提醒设置', () => {
  it('渲染持仓、涨跌幅提醒、价格提醒三组设置与当前行情', async () => {
    const { wrapper } = await mountSetting();
    expect(wrapper.text()).toContain('持仓设置');
    expect(wrapper.text()).toContain('涨跌幅提醒');
    expect(wrapper.text()).toContain('价格提醒');
    expect(wrapper.text()).toContain('持仓价:');
    expect(wrapper.text()).toContain('持仓量:');
    expect(wrapper.text()).toContain('当日涨幅超过:');
    expect(wrapper.text()).toContain('当日跌幅超过:');
    expect(wrapper.text()).toContain('价格涨至:');
    expect(wrapper.text()).toContain('价格跌至:');

    const current = wrapper.findAll('.fontbold');
    expect(current[0].text()).toBe('2.5%');
    expect(current[1].text()).toBe('1500');
    expect(current[0].classes()).toContain('red');
  });

  it('当前涨跌幅为负时使用绿色', async () => {
    const { wrapper } = await mountSetting({ range: '-3.2' });
    const current = wrapper.findAll('.fontbold')[0];
    expect(current.text()).toBe('-3.2%');
    expect(current.classes()).toContain('green');
  });

  it('没有配置时持仓关闭、持仓价 0、持仓量默认 100，全部提醒关闭', async () => {
    const { wrapper } = await mountSetting();
    const allSwitches = switches(wrapper);
    expect(allSwitches).toHaveLength(5);
    allSwitches.forEach((item) => {
      expect(item.props('modelValue')).toBe(false);
    });
    const allNumbers = numbers(wrapper);
    expect(allNumbers[0].props('modelValue')).toBe(0);
    expect(allNumbers[1].props('modelValue')).toBe(100);
    expect(allNumbers[2].props('modelValue')).toBe(0);
    expect(allNumbers[5].props('modelValue')).toBe(0);
  });

  it('挂载时读取已有持仓配置', async () => {
    const { wrapper } = await mountSetting(
      {},
      {
        '1.600519': {
          secid: '1.600519',
          position: { buyPrice: 1200.5, buyAmount: 300 },
        },
      },
    );
    expect(switches(wrapper)[0].props('modelValue')).toBe(true);
    expect(numbers(wrapper)[0].props('modelValue')).toBe(1200.5);
    expect(numbers(wrapper)[1].props('modelValue')).toBe(300);
  });

  it('读取提醒配置：有限数值开关打开，null 保持关闭', async () => {
    const { wrapper } = await mountSetting(
      {},
      {
        '1.600519': {
          secid: '1.600519',
          crossAlertConfig: {
            crossUpRange: 3,
            crossDownRange: null,
            crossUpPrice: null,
            crossDownPrice: 1000,
          },
        },
      },
    );
    expect(switches(wrapper)[1].props('modelValue')).toBe(true);
    expect(numbers(wrapper)[2].props('modelValue')).toBe(3);
    expect(switches(wrapper)[2].props('modelValue')).toBe(false);
    expect(numbers(wrapper)[3].props('modelValue')).toBe(0);
    expect(switches(wrapper)[4].props('modelValue')).toBe(true);
    expect(numbers(wrapper)[5].props('modelValue')).toBe(1000);
  });

  it('保存持仓设置并提示成功', async () => {
    const { wrapper, symbol } = await mountSetting();
    const addConfig = vi.spyOn(symbol, 'addConfig').mockResolvedValue();
    wrapper.vm.positionOpen = true;
    wrapper.vm.buyPrice = 10;
    wrapper.vm.buyAmount = 500;
    await clickSave(wrapper);

    expect(addConfig).toHaveBeenCalledWith({
      secid: '1.600519',
      position: { direction: 1, buyPrice: 10, buyAmount: 500 },
    });
    expect(messageMock).toHaveBeenCalledWith({
      message: '保存成功！',
      type: 'success',
      duration: 1200,
    });
  });

  it('持仓价或持仓量不合法时提示错误且不保存', async () => {
    const { wrapper, symbol } = await mountSetting();
    const addConfig = vi.spyOn(symbol, 'addConfig').mockResolvedValue();
    wrapper.vm.positionOpen = true;
    wrapper.vm.buyPrice = 0;
    wrapper.vm.buyAmount = 100;
    await clickSave(wrapper);
    expect(addConfig).not.toHaveBeenCalled();
    expect(messageMock).toHaveBeenCalledWith({
      message: '持仓价必须大于0',
      type: 'error',
      duration: 2000,
    });

    messageMock.mockClear();
    wrapper.vm.buyPrice = 10;
    wrapper.vm.buyAmount = 0;
    await clickSave(wrapper);
    expect(addConfig).not.toHaveBeenCalled();
    expect(messageMock).toHaveBeenCalledWith({
      message: '持仓数量必须大于0',
      type: 'error',
      duration: 2000,
    });
  });

  it('提醒阈值超过当前行情时先确认，确认后保存', async () => {
    const { wrapper, symbol } = await mountSetting();
    const addConfig = vi.spyOn(symbol, 'addConfig').mockResolvedValue();
    confirmMock.mockResolvedValue('confirm');
    wrapper.vm.upRangeOpen = true;
    wrapper.vm.upRange = 1;
    await clickSave(wrapper);

    expect(confirmMock).toHaveBeenCalledWith(
      '上涨幅度超过当前幅度\n, 确定继续？',
      '警告',
      expect.objectContaining({ type: 'warning' }),
    );
    expect(addConfig).toHaveBeenCalledWith({
      secid: '1.600519',
      crossAlertConfig: {
        crossUpRange: 1,
        crossDownRange: null,
        crossUpPrice: null,
        crossDownPrice: null,
      },
    });
  });

  it('确认弹窗取消时不保存', async () => {
    const { wrapper, symbol } = await mountSetting();
    const addConfig = vi.spyOn(symbol, 'addConfig').mockResolvedValue();
    confirmMock.mockRejectedValue('cancel');
    wrapper.vm.upPriceOpen = true;
    wrapper.vm.upPrice = 1000;
    await clickSave(wrapper);
    expect(confirmMock).toHaveBeenCalled();
    expect(addConfig).not.toHaveBeenCalled();
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('未开启的提醒项在保存时写为 null', async () => {
    const { wrapper, symbol } = await mountSetting();
    const addConfig = vi.spyOn(symbol, 'addConfig').mockResolvedValue();
    confirmMock.mockResolvedValue('confirm');
    wrapper.vm.upPriceOpen = true;
    wrapper.vm.upPrice = 2000;
    wrapper.vm.downRangeOpen = true;
    wrapper.vm.downRange = -20;
    await clickSave(wrapper);

    expect(addConfig).toHaveBeenCalledWith({
      secid: '1.600519',
      crossAlertConfig: {
        crossUpRange: null,
        crossDownRange: -20,
        crossUpPrice: 2000,
        crossDownPrice: null,
      },
    });
  });

  it('切换股票 secid 时重新加载对应配置', async () => {
    const { wrapper } = await mountSetting(
      {},
      {
        '1.600519': { secid: '1.600519', position: { buyPrice: 1200, buyAmount: 100 } },
        '0.000858': { secid: '0.000858', position: { buyPrice: 100, buyAmount: 200 } },
      },
    );
    expect(numbers(wrapper)[0].props('modelValue')).toBe(1200);

    await wrapper.setProps({ secid: '0.000858' });
    await flushPromises();
    expect(switches(wrapper)[0].props('modelValue')).toBe(true);
    expect(numbers(wrapper)[0].props('modelValue')).toBe(100);
    expect(numbers(wrapper)[1].props('modelValue')).toBe(200);
  });

  it('切换到没有配置的股票时恢复默认并关闭持仓', async () => {
    const { wrapper } = await mountSetting(
      {},
      {
        '1.600519': { secid: '1.600519', position: { buyPrice: 1200, buyAmount: 100 } },
      },
    );
    await wrapper.setProps({ secid: '0.600036' });
    await flushPromises();
    expect(switches(wrapper)[0].props('modelValue')).toBe(false);
    expect(numbers(wrapper)[0].props('modelValue')).toBe(0);
    expect(numbers(wrapper)[1].props('modelValue')).toBe(100);
  });
});
