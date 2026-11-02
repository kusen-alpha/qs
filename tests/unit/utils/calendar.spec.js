import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  addYearsClamped,
  buildCalendarRows,
  formatDate,
  parseDate,
} from '@/utils/calendar';

const TODAY = new Date(2026, 10, 2); // 2026-11-02
const todayText = '2026-11-02';

function event(overrides = {}) {
  return {
    id: 1,
    name: '事件',
    start_date: '2026-11-05',
    end_date: '2026-11-06',
    repeat_type: 'none',
    ...overrides,
  };
}

describe('calendar · 日期推算', () => {
  it('格式化与解析 yyyy-MM-dd', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(parseDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseDate('2026-02-30')).toBe(null);
    expect(parseDate('2026-13-01')).toBe(null);
  });

  it('每月重复遇到小月时取当月最后一天', () => {
    expect(addMonthsClamped({ year: 2025, month: 1, day: 31 }, 1)).toEqual({
      year: 2025,
      month: 2,
      day: 28,
    });
    expect(addMonthsClamped({ year: 2025, month: 1, day: 31 }, 2)).toEqual({
      year: 2025,
      month: 3,
      day: 31,
    });
  });

  it('每年重复时 2 月 29 日在平年取 2 月 28 日', () => {
    expect(addYearsClamped({ year: 2024, month: 2, day: 29 }, 1)).toEqual({
      year: 2025,
      month: 2,
      day: 28,
    });
    expect(addYearsClamped({ year: 2024, month: 2, day: 29 }, 4)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });
});

describe('calendar · 列表行', () => {
  it('未来事件按距开始天数显示倒计时', () => {
    const rows = buildCalendarRows([event()], TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].start_date).toBe('2026-11-05');
    expect(rows[0].countdown_text).toBe('3 天');
  });

  it('进行中的事件显示“进行中”', () => {
    const rows = buildCalendarRows(
      [event({ start_date: '2026-11-01', end_date: '2026-11-03' })],
      TODAY,
    );
    expect(rows[0].countdown_text).toBe('进行中');
  });

  it('单日事件当天显示“今天”', () => {
    const rows = buildCalendarRows(
      [event({ start_date: todayText, end_date: todayText })],
      TODAY,
    );
    expect(rows[0].countdown_text).toBe('今天');
  });

  it('已结束的非重复事件不进入列表', () => {
    expect(buildCalendarRows([event({ start_date: '2026-10-01', end_date: '2026-10-02' })], TODAY))
      .toHaveLength(0);
  });

  it('每月重复事件过期后自动推进到下一次发生', () => {
    const rows = buildCalendarRows(
      [
        event({
          id: 8,
          start_date: '2025-01-31',
          end_date: '2025-01-31',
          repeat_type: 'monthly',
        }),
      ],
      new Date(2026, 1, 28),
    );
    expect(rows[0].start_date).toBe('2026-02-28');
    expect(rows[0].end_date).toBe('2026-02-28');
    expect(rows[0].countdown_text).toBe('今天');
    expect(rows[0].repeat_text).toBe('每月');
  });

  it('每年重复事件保持首次的持续天数', () => {
    const rows = buildCalendarRows(
      [
        event({
          id: 9,
          start_date: '2024-02-29',
          end_date: '2024-03-02',
          repeat_type: 'yearly',
        }),
      ],
      new Date(2028, 1, 20),
    );
    expect(rows[0].start_date).toBe('2028-02-29');
    expect(rows[0].end_date).toBe('2028-03-02');
    expect(rows[0].countdown_text).toBe('9 天');
  });

  it('按倒计时升序排列，已结束事件被过滤', () => {
    const rows = buildCalendarRows(
      [
        event({ id: 1, start_date: '2026-11-20', end_date: '2026-11-20' }),
        event({ id: 2, start_date: '2026-10-01', end_date: '2026-10-02' }),
        event({ id: 3, start_date: '2026-11-03', end_date: '2026-11-03' }),
        event({ id: 4, start_date: '2026-11-02', end_date: '2026-11-02' }),
      ],
      TODAY,
    );
    expect(rows.map((row) => row.id)).toEqual([4, 3, 1]);
  });
});
