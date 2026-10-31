import { describe, expect, it } from 'vitest';
import {
  parseBoardMap,
  parseFieldBoardCode,
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
