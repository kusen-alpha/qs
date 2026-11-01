import { describe, expect, it } from 'vitest';
import {
  parseBoardMap,
  parseFieldBoardCode,
  parseStockConcepts,
  parseSwIndustry,
} from '@/api/ths';

describe('ths · 申万行业解析', () => {
  it('解析一级/二级行业与原始串', () => {
    const html =
      '<td><strong class="hltip fl">所属申万行业：</strong><span>食品饮料 — 白酒Ⅱ</span>';
    expect(parseSwIndustry(html)).toEqual({
      raw: '食品饮料 — 白酒Ⅱ',
      l1: '食品饮料',
      l2: '白酒Ⅱ',
    });
  });

  it('字段缺失（港股/美股错误页）返回 null', () => {
    expect(parseSwIndustry('<html><body>无此字段</body></html>')).toBeNull();
    expect(parseSwIndustry('')).toBeNull();
  });
});

describe('ths · 同花顺行业板块', () => {
  it('从 field.html 提取板块代码（去掉前导 0）', () => {
    const html =
      '<a href="http://index.10jqka.com.cn/list/field/0881273/" class="fr more">更多&gt;&gt;</a>';
    expect(parseFieldBoardCode(html)).toBe('881273');
    expect(parseFieldBoardCode('<html><body>无此字段</body></html>')).toBeNull();
    expect(parseFieldBoardCode('')).toBeNull();
  });

  it('解析板块全表为代码到名称的映射', () => {
    const html = [
      '<a href="http://q.10jqka.com.cn/thshy/detail/code/881273/" target="_blank">白酒</a>',
      '<a href="http://q.10jqka.com.cn/thshy/detail/code/881149/" target="_blank">公路铁路运输</a>',
    ].join('');
    expect(parseBoardMap(html)).toEqual({
      881273: '白酒',
      881149: '公路铁路运输',
    });
    expect(parseBoardMap('')).toEqual({});
  });
});

describe('ths · 官方概念成分', () => {
  it('提取概念代码与名称，去掉标签与多余空白', () => {
    const html = [
      '<table><tr><td class="gnName" clid="885761"> 白酒 </td>',
      '<td class="gnName" clid="885789"><a>锂电池</a></td></tr></table>',
    ].join('');
    expect(parseStockConcepts(html)).toEqual([
      { code: '885761', name: '白酒' },
      { code: '885789', name: '锂电池' },
    ]);
  });

  it('缺少 clid 时 code 为空串，重名概念只保留一条', () => {
    const html = [
      '<td class="gnName">白酒</td>',
      '<td class="gnName" clid="">白酒</td>',
      '<td class="other">不是概念</td>',
    ].join('');
    expect(parseStockConcepts(html)).toEqual([{ code: '', name: '白酒' }]);
  });

  it('空页面返回空数组', () => {
    expect(parseStockConcepts('')).toEqual([]);
  });
});
