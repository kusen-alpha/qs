import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestBytes: vi.fn(),
  loadBoards: vi.fn(),
  saveBoards: vi.fn(),
  saveIndustries: vi.fn(),
  loadIndustries: vi.fn(),
  saveStockConcepts: vi.fn(),
}));

vi.mock('@/utils/http', () => ({ requestBytes: mocks.requestBytes }));
vi.mock('@/utils/env', () => ({ isTauri: () => true }));
vi.mock('@/utils/db', () => ({
  loadBoards: mocks.loadBoards,
  saveBoards: mocks.saveBoards,
  saveIndustries: mocks.saveIndustries,
  loadIndustries: mocks.loadIndustries,
  saveStockConcepts: mocks.saveStockConcepts,
}));

const COMPANY_URL = 'https://basic.10jqka.com.cn/600519/company.html';
const FIELD_URL = 'https://basic.10jqka.com.cn/600519/field.html';
const CONCEPT_URL = 'https://basic.10jqka.com.cn/600519/concept.html';
const BOARD_URL = 'https://q.10jqka.com.cn/thshy/';

const SW_PAGE =
  '<td><strong class="hltip fl">所属申万行业：</strong><span>食品饮料 — 白酒Ⅱ</span>';
const FIELD_PAGE =
  '<a href="http://index.10jqka.com.cn/list/field/0881273/" class="fr more">更多&gt;&gt;</a>';
const BOARD_PAGE =
  '<a href="http://q.10jqka.com.cn/thshy/detail/code/881273/" target="_blank">白酒</a>';

/** 记录本次用例的页面内容与失败地址，供伪造的 TextDecoder 取用 */
let pages = {};
let failing = new Set();

class FakeTextDecoder {
  decode(bytes) {
    return pages[String(bytes)] || '';
  }
}

function setupNetwork(nextPages = {}, failures = []) {
  pages = nextPages;
  failing = new Set(failures);
  mocks.requestBytes.mockImplementation(async (url) => {
    if (failing.has(url)) return { ok: false, status: 502, data: url };
    if (pages[url]) return { ok: true, status: 200, data: url };
    return { ok: false, status: 404, data: url };
  });
}

const OLD_ROW = {
  code: '600519',
  l1: '食品饮料',
  l2: '白酒Ⅱ',
  ths: '白酒',
  updated_at: Date.now() - 8 * 24 * 60 * 60 * 1000,
};

beforeEach(() => {
  // 重置模块可清空 ths.js 的模块级缓存；localStorage 同步清空
  vi.resetModules();
  localStorage.clear();
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.loadBoards.mockResolvedValue(null);
  mocks.loadIndustries.mockResolvedValue([]);
  vi.stubGlobal('TextDecoder', FakeTextDecoder);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ths · 行业抓取失败不覆盖旧值', () => {
  it('loadStockConcepts 抓取全部失败时返回库内旧值且不写库、不刷新缓存计时', async () => {
    mocks.loadIndustries.mockResolvedValue([OLD_ROW]);
    setupNetwork();
    const { loadStockConcepts } = await import('@/api/ths');

    const out = await loadStockConcepts(['600519']);

    expect(out['600519']).toEqual({
      l1: '食品饮料',
      l2: '白酒Ⅱ',
      ths: '白酒',
      gns: [],
    });
    expect(mocks.saveIndustries).not.toHaveBeenCalled();
  });

  it('refreshStockIndustries 强制重抓失败时保留旧值且不写库', async () => {
    mocks.loadIndustries.mockResolvedValue([OLD_ROW]);
    setupNetwork();
    const { refreshStockIndustries } = await import('@/api/ths');

    const out = await refreshStockIndustries(['600519']);

    expect(out['600519']).toEqual({ l1: '食品饮料', l2: '白酒Ⅱ', ths: '白酒' });
    expect(mocks.saveIndustries).not.toHaveBeenCalled();
  });

  it('申万抓取成功、同花顺失败时只更新申万并保留原同花顺行业', async () => {
    mocks.loadIndustries.mockResolvedValue([OLD_ROW]);
    setupNetwork({ [COMPANY_URL]: SW_PAGE }, [FIELD_URL, BOARD_URL]);
    const { refreshStockIndustries } = await import('@/api/ths');

    const out = await refreshStockIndustries(['600519']);

    expect(out['600519']).toEqual({ l1: '食品饮料', l2: '白酒Ⅱ', ths: '白酒' });
    expect(mocks.saveIndustries).toHaveBeenCalledTimes(1);
    expect(mocks.saveIndustries).toHaveBeenCalledWith({
      '600519': { l1: '食品饮料', l2: '白酒Ⅱ', ths: '白酒' },
    });
  });

  it('抓取成功时正常写库（申万行业 + 同花顺板块名）', async () => {
    mocks.loadIndustries.mockResolvedValue([]);
    setupNetwork({
      [COMPANY_URL]: SW_PAGE,
      [FIELD_URL]: FIELD_PAGE,
      [BOARD_URL]: BOARD_PAGE,
      [CONCEPT_URL]: '<td class="gnName" clid="885761">白酒</td>',
    });
    const { refreshStockIndustries } = await import('@/api/ths');

    const out = await refreshStockIndustries(['600519']);

    expect(out['600519']).toEqual({ l1: '食品饮料', l2: '白酒Ⅱ', ths: '白酒' });
    expect(mocks.saveIndustries).toHaveBeenCalledWith({
      '600519': { l1: '食品饮料', l2: '白酒Ⅱ', ths: '白酒' },
    });
  });
});
