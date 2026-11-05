import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import HQKLineChart from '@/components/detail/HQKLineChart.vue';

const hq = vi.hoisted(() => {
  const resource = {
    Index: { LineColor: [] },
    CorssCursor: { CorssPoint: { Center: {} }, RightButton: {} },
  };
  const chart = {
    SetOption: vi.fn(),
    ChartDestroy: vi.fn(),
    OnSize: vi.fn(),
  };
  const Init = vi.fn(() => chart);
  return { resource, chart, Init };
});

const { fetchKlineMock, loadBoardKMock } = vi.hoisted(() => ({
  fetchKlineMock: vi.fn(),
  loadBoardKMock: vi.fn(),
}));

vi.mock('hqchart', () => ({
  default: {
    Chart: {
      JSChart: {
        GetResource: () => hq.resource,
        Init: hq.Init,
      },
    },
  },
}));

vi.mock('@/utils/kline', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchKline: fetchKlineMock };
});

vi.mock('@/utils/db', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadBoardK: loadBoardKMock };
});

const wrappers = [];

function mountChart(props = { symbol: '1.600519', name: '贵州茅台', code: '600519' }) {
  const wrapper = mount(HQKLineChart, { props });
  wrappers.push(wrapper);
  return wrapper;
}

function latestOption() {
  return hq.chart.SetOption.mock.calls[hq.chart.SetOption.mock.calls.length - 1][0];
}

async function requestHistoryData() {
  const callback = vi.fn();
  latestOption().NetworkFilter(
    { Name: 'KLineChartContainer::RequestHistoryData' },
    callback,
  );
  await flushPromises();
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0][0];
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('HQKLineChart · 日 K 图表', () => {
  it('挂载时应用主题资源并初始化图表', () => {
    const wrapper = mountChart();
    expect(hq.Init).toHaveBeenCalledTimes(1);
    expect(hq.Init.mock.calls[0][0]).toBe(wrapper.find('.hqchart').element);
    expect(hq.chart.SetOption).toHaveBeenCalledTimes(1);

    expect(hq.resource.UpBarColor).toBe('rgb(241,55,63)');
    expect(hq.resource.DownBarColor).toBe('rgb(75,105,150)');
    expect(hq.resource.UnchagneBarColor).toBe('rgb(43,54,69)');
    expect(hq.resource.EmptyBarBGColor).toBe('rgb(255,255,255)');
    expect(hq.resource.FrameBorderPen).toBe('rgb(225,236,242)');
    expect(hq.resource.FrameSplitPen).toBe('rgb(225,236,242)');
    expect(hq.resource.FrameSplitTextColor).toBe('rgb(117,125,129)');
    expect(hq.resource.FrameSplitTextFont).toBe('12px 微软雅黑');
    expect(hq.resource.FrameTitleBGColor).toBe('rgb(255,255,255)');
    expect(hq.resource.Index.LineColor).toHaveLength(10);
    expect(hq.resource.Index.LineColor[0]).toBe('rgb(255,174,0)');
    expect(hq.resource.CorssCursor.CorssPoint.Center.Color).toBe('rgb(43,54,69)');
    expect(hq.resource.CorssCursor.RightButton.BGColor).toBe('rgb(43,54,69)');
  });

  it('图表选项为日 K + MA + MACD(12,26,9)，不自动更新且关闭右键菜单', () => {
    mountChart();
    const option = latestOption();
    expect(option.Type).toBe('历史K线图');
    expect(option.Symbol).toBe('600519');
    expect(option.IsAutoUpdate).toBe(false);
    expect(option.IsShowRightMenu).toBe(false);
    expect(option.Windows).toEqual([
      { Index: 'MA', Modify: false, Change: false },
      {
        Index: 'MACD',
        Modify: false,
        Change: false,
        Args: [
          { Name: 'SHORT', Value: 12 },
          { Name: 'LONG', Value: 26 },
          { Name: 'MID', Value: 9 },
        ],
      },
    ]);
    expect(option.KLine).toMatchObject({
      Period: 0,
      PageSize: 70,
      IsShowTooltip: true,
    });
    expect(wrapperText()).toContain('日K · MACD(12,26,9)');
  });

  it('RequestHistoryData 返回逐行日 K：日期转数字、首根昨收取开盘价、amount 直传', async () => {
    fetchKlineMock.mockResolvedValue({
      name: '贵州茅台',
      candles: [
        {
          date: '2024-01-02',
          open: 10,
          close: 11,
          high: 12,
          low: 9,
          volume: 100,
          amount: 500,
        },
        {
          date: '2024-01-03',
          open: 11,
          close: 12,
          high: 13,
          low: 10,
          volume: 200,
          amount: 800,
        },
      ],
    });
    mountChart();
    const result = await requestHistoryData();
    expect(result.symbol).toBe('600519');
    expect(result.name).toBe('贵州茅台');
    expect(result.data).toEqual([
      [20240102, 10, 10, 12, 9, 11, 100, 500],
      [20240103, 11, 11, 13, 10, 12, 200, 800],
    ]);
  });

    it('首根开盘价为 0 时用收盘价作昨收，缺失日期与成交量按 0 兜底', async () => {
    fetchKlineMock.mockResolvedValue({
      candles: [{ date: '', open: 0, close: 5, high: 6, low: 4 }],
    });
    mountChart();
    const result = await requestHistoryData();
    expect(result.data).toEqual([[0, 5, 0, 6, 4, 5, 0, 0]]);
    expect(result.name).toBe('贵州茅台');
  });

  it('没有真实日 K 时使用兜底数据并展示提示文案', async () => {
    fetchKlineMock.mockResolvedValue(null);
    const wrapper = mountChart({ symbol: '1.600519', name: '贵州茅台', code: '600519' });
    expect(wrapper.find('.chart-hint').exists()).toBe(false);

    const result = await requestHistoryData();
    await nextTick();
    expect(wrapper.find('.chart-hint').isVisible()).toBe(true);
    expect(wrapper.find('.chart-hint').text()).toBe('示例数据（行情接口不可用）');
    expect(result.data).toHaveLength(120);
    expect(result.data[0]).toHaveLength(8);
    expect(result.data[0][1]).toBe(result.data[0][2]);
    expect(result.data.every((row) => row.every((value) => Number.isFinite(value)))).toBe(true);
  });

  it('NetworkFilter 只放行 RequestHistoryData，其余请求置 PreventDefault', async () => {
    mountChart();
    const option = latestOption();

    const callback = vi.fn();
    const other = { Name: 'KLineChartContainer::RequestMinuteData' };
    option.NetworkFilter(other, callback);
    expect(other.PreventDefault).toBe(true);
    expect(callback).not.toHaveBeenCalled();

    const anonymous = {};
    option.NetworkFilter(anonymous, callback);
    expect(anonymous.PreventDefault).toBe(true);

    expect(() => option.NetworkFilter(null, callback)).not.toThrow();
  });

  it('symbol 变化时销毁旧图表并在下一个 tick 重建', async () => {
    const wrapper = mountChart();
    expect(hq.Init).toHaveBeenCalledTimes(1);
    expect(hq.chart.ChartDestroy).not.toHaveBeenCalled();

    await wrapper.setProps({ symbol: '0.000858' });
    await flushPromises();
    await nextTick();
    expect(hq.chart.ChartDestroy).toHaveBeenCalledTimes(1);
    expect(hq.Init).toHaveBeenCalledTimes(2);
    expect(hq.chart.SetOption).toHaveBeenCalledTimes(2);
    expect(latestOption().Symbol).toBe('000858');
  });

  it('卸载时销毁图表并清空容器', () => {
    const wrapper = mountChart();
    const box = wrapper.find('.hqchart').element;
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(hq.chart.ChartDestroy).toHaveBeenCalledTimes(1);
    expect(box.innerHTML).toBe('');
  });

  it('resize 与窗口 resize 事件调用图表 OnSize，卸载后不再响应', async () => {
    const wrapper = mountChart();
    wrapper.vm.resize();
    expect(hq.chart.OnSize).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('resize'));
    expect(hq.chart.OnSize).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    window.dispatchEvent(new Event('resize'));
    expect(hq.chart.OnSize).toHaveBeenCalledTimes(2);
  });
});

describe('HQKLineChart · 板块指数模式', () => {
  const boardKey = 'sw1:电子';

  it('板块模式使用伪代码 880001，标题为板块名 + 收盘指数', () => {
    const wrapper = mountChart({ boardKey, name: '电子' });
    expect(latestOption().Symbol).toBe('880001');
    expect(latestOption().Type).toBe('历史K线图');
    expect(wrapper.text()).toContain('电子 · 收盘指数 · MACD(12,26,9)');
  });

  it('RequestHistoryData 返回扁平 K 线：开高低收同为收盘价，昨收取前一日收盘，成交额由亿换算为元', async () => {
    loadBoardKMock.mockResolvedValue({
      board: { name: '电子' },
      dates: ['2024-01-02', '2024-01-03'],
      close: [101, 102.5],
      amount: [5000, 6000],
    });
    mountChart({ boardKey, name: '电子' });
    const result = await requestHistoryData();
    expect(loadBoardKMock).toHaveBeenCalledWith(boardKey, 400);
    expect(result.symbol).toBe('880001');
    expect(result.name).toBe('电子');
    expect(result.data).toEqual([
      [20240102, 101, 101, 101, 101, 101, 0, 5000 * 1e8],
      [20240103, 101, 102.5, 102.5, 102.5, 102.5, 0, 6000 * 1e8],
    ]);
  });

  it('板块无历史数据时不落行并展示示例提示', async () => {
    loadBoardKMock.mockResolvedValue(null);
    const wrapper = mountChart({ boardKey, name: '电子' });
    const result = await requestHistoryData();
    await nextTick();
    expect(result.name).toBe('电子');
    expect(result.data).toEqual([]);
    expect(wrapper.find('.chart-hint').isVisible()).toBe(true);
  });

  it('boardKey 变化时销毁旧图表并重建', async () => {
    const wrapper = mountChart({ boardKey, name: '电子' });
    expect(hq.Init).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ boardKey: 'sw2:半导体' });
    await flushPromises();
    await nextTick();
    expect(hq.chart.ChartDestroy).toHaveBeenCalledTimes(1);
    expect(hq.Init).toHaveBeenCalledTimes(2);

    await requestHistoryData();
    expect(loadBoardKMock).toHaveBeenCalledWith('sw2:半导体', 400);
  });
});

function wrapperText() {
  return wrappers[wrappers.length - 1].text();
}
