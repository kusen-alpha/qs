import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRows,
  ensureMarketWidthHistory,
  loadMarketWidth,
  loadMarketWidthFromDb,
  refreshMarketWidth,
  requestHeaders,
  tokenOf,
  today,
} from '@/api/legulegu';

const state = vi.hoisted(() => ({
  stored: null,
  saved: [],
  response: null,
  error: null,
  url: '',
  calls: 0,
  hang: false,
}));

vi.mock('@/utils/db', () => ({
  loadMarketWidthDb: vi.fn(async () => state.stored),
  saveMarketWidthDb: vi.fn(async (data) => {
    state.saved.push(data);
    return { saved: 1 };
  }),
}));

vi.mock('@/utils/http', () => ({
  request: vi.fn((url, options = {}) => {
    state.url = url;
    state.calls += 1;
    /* 模拟接口不返回：只在超时中止时失败，用于验证 8 秒超时 */
    if (state.hang) {
      return new Promise((resolve, reject) => {
        if (options.signal) {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    }
    if (state.error) return Promise.reject(state.error);
    return Promise.resolve(state.response);
  }),
}));

const payload = {
  dates: ['2026-10-27', '2026-10-28'],
  swCodeNames: [
    { indexCode: '801980.SI', indexName: '美容护理' },
    { indexCode: '801970.SI', indexName: '环保' },
  ],
  maMarketWidth: {
    '801980.SI': [{ value20: 10 }, { value20: 17 }],
    '801970.SI': [{ value20: 52 }, {}],
  },
};

const storedInDb = {
  dates: ['2026-10-27'],
  rows: [
    { name: '美容护理', code: '801980.SI', values: [10] },
    { name: '环保', code: '801970.SI', values: [52] },
  ],
};

beforeEach(() => {
  state.stored = null;
  state.saved = [];
  state.response = { ok: true, data: payload };
  state.error = null;
  state.url = '';
  state.calls = 0;
  state.hang = false;
  localStorage.clear();
});

describe('legulegu · 市场宽度', () => {
  it('token 为当天日期的 MD5', () => {
    expect(tokenOf('2026-10-30')).toBe('f4c20443c57178866623ce24f099a272');
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('请求头带访客 Cookie，并用空 Origin 让 Tauri 插件移除该头', () => {
    const headers = requestHeaders();
    expect(headers.Cookie).toMatch(/^LAAA=/);
    expect(headers['User-Agent']).toContain('Chrome');
    expect(headers.Origin).toBe('');
  });

  it('buildRows 按行业成行，日期成列，取 value20 原始值', () => {
    const payload = {
      dates: ['2026-10-27', '2026-10-28'],
      swCodeNames: [
        { indexCode: '801980.SI', indexName: '美容护理' },
        { indexCode: '801970.SI', indexName: '环保' },
      ],
      maMarketWidth: {
        '801980.SI': [{ value20: 10 }, { value20: 17 }],
        '801970.SI': [{ value20: 52 }, {}],
      },
    };
    const { dates, rows } = buildRows(payload);
    expect(dates).toEqual(['2026-10-27', '2026-10-28']);
    expect(rows.map((row) => row.name)).toEqual(['美容护理', '环保']);
    expect(rows[0].values).toEqual([10, 17]);
    expect(rows[1].values).toEqual([52, null]);
  });
});

describe('legulegu · 市场宽度入库', () => {
  it('默认读库，接口有数据时写库并返回库内完整历史', async () => {
    state.stored = storedInDb;
    const value = await loadMarketWidth(true);
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0].dates).toEqual(['2026-10-27', '2026-10-28']);
    expect(value).toEqual(storedInDb);
  });

  it('接口失败时回落到库内数据', async () => {
    state.stored = storedInDb;
    state.error = new Error('市场宽度接口返回 403');
    await expect(loadMarketWidth(true)).resolves.toEqual(storedInDb);
    expect(state.saved).toHaveLength(0);
  });

  it('库内无数据时从 2024-01-01 整段拉取并返回接口数据', async () => {
    state.stored = null;
    const value = await loadMarketWidth(true);
    expect(value.dates).toEqual(['2026-10-27', '2026-10-28']);
    expect(value.rows[1].values).toEqual([52, null]);
    expect(state.url).toContain('startDate=2024-01-01');
    expect(state.url).not.toContain('severalTradeDays');
  });

  it('库内未覆盖 2024-01-01 时整段补齐', async () => {
    state.stored = {
      dates: ['2026-10-27'],
      range: { first: '2026-09-01', last: '2026-10-27' },
      rows: [{ name: '美容护理', code: '801980.SI', values: [10] }],
    };
    await loadMarketWidth(true);
    expect(state.url).toContain('startDate=2024-01-01');
  });

  it('启动补齐：库内已覆盖 2024 年初时不请求接口', async () => {
    state.stored = {
      dates: ['2026-10-27'],
      range: { first: '2024-01-02', last: '2026-10-27' },
      rows: [{ name: '美容护理', code: '801980.SI', values: [10] }],
    };
    const value = await ensureMarketWidthHistory();
    expect(value).toBe(state.stored);
    expect(state.url).toBe('');
    expect(state.saved).toEqual([]);
  });

  it('启动补齐：库内缺 2024 年数据时整段拉取并落库', async () => {
    state.stored = null;
    const value = await ensureMarketWidthHistory();
    expect(value.dates).toEqual(['2026-10-27', '2026-10-28']);
    expect(state.url).toContain('startDate=2024-01-01');
    expect(state.saved).toHaveLength(1);
  });

  it('库内已覆盖 2024-01-01 时从最后日期增量更新', async () => {
    state.stored = {
      dates: ['2026-10-27'],
      range: { first: '2024-01-02', last: '2026-10-27' },
      rows: [{ name: '美容护理', code: '801980.SI', values: [10] }],
    };
    await loadMarketWidth(true);
    expect(state.url).toContain('startDate=2026-10-27');
    expect(state.url).not.toContain('severalTradeDays');
  });

  it('库内无数据且接口失败时抛出接口错误', async () => {
    state.stored = null;
    state.error = new Error('市场宽度接口返回 403');
    await expect(loadMarketWidth(true)).rejects.toThrow('403');
  });
});

describe('legulegu · 库优先渲染与增量补数', () => {
  const coveredInDb = {
    dates: ['2026-10-27'],
    range: { first: '2024-01-02', last: '2026-10-27' },
    rows: [{ name: '美容护理', code: '801980.SI', values: [10] }],
  };

  it('loadMarketWidthFromDb 只读库、不请求接口', async () => {
    state.stored = coveredInDb;
    await expect(loadMarketWidthFromDb()).resolves.toEqual(coveredInDb);
    expect(state.calls).toBe(0);
  });

  it('库内无数据时 loadMarketWidthFromDb 返回 null', async () => {
    state.stored = null;
    await expect(loadMarketWidthFromDb()).resolves.toBeNull();
    expect(state.calls).toBe(0);
  });

  it('refreshMarketWidth 从库内最大交易日补数并落库，返回完整历史', async () => {
    state.stored = coveredInDb;
    const value = await refreshMarketWidth();
    expect(state.url).toContain('startDate=2026-10-27');
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0].dates).toEqual(['2026-10-27', '2026-10-28']);
    expect(value).toEqual(coveredInDb);
  });

  it('当天 TTL 内再次刷新跳过接口请求', async () => {
    state.stored = coveredInDb;
    await refreshMarketWidth();
    expect(state.calls).toBe(1);
    await expect(refreshMarketWidth()).resolves.toBeNull();
    expect(state.calls).toBe(1);
  });

  it('后台刷新失败时静默返回 null 且不写库', async () => {
    state.stored = coveredInDb;
    state.error = new Error('市场宽度接口返回 403');
    await expect(refreshMarketWidth()).resolves.toBeNull();
    expect(state.saved).toHaveLength(0);
  });

  it('同一窗口并发刷新只请求一次接口', async () => {
    state.stored = coveredInDb;
    const [a, b] = await Promise.all([refreshMarketWidth(), refreshMarketWidth()]);
    expect(state.calls).toBe(1);
    expect(a).toEqual(coveredInDb);
    expect(b).toEqual(coveredInDb);
  });

  it('接口 8 秒未返回时中止请求并提示超时', async () => {
    vi.useFakeTimers();
    try {
      state.hang = true;
      const task = refreshMarketWidth({ force: true });
      const assertion = expect(task).rejects.toThrow('市场宽度接口请求超时');
      await vi.advanceTimersByTimeAsync(8000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
