import { describe, expect, it } from 'vitest';
import { buildRows, tokenOf, today } from '@/api/legulegu';

describe('legulegu · 市场宽度', () => {
  it('token 为当天日期的 MD5', () => {
    expect(tokenOf('2026-10-30')).toBe('f4c20443c57178866623ce24f099a272');
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
