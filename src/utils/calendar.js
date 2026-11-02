/**
 * 日历事件的日期推算。
 * 日期统一用 yyyy-MM-dd 字符串与 UTC 天数运算，避免本地时区/夏令时造成的偏差。
 * 重复规则：
 * - 每月：沿用首次开始日的日号，遇到小月取当月最后一天；每次保持首次的持续天数。
 * - 每年：沿用首次开始日的月/日，2 月 29 日在平年取 2 月 28 日；保持首次的持续天数。
 * - 已结束的事件不进入列表；重复事件自动推进到下一次发生。
 */

const DAY_MS = 86400000;

const REPEAT_TEXT = {
  none: '无',
  monthly: '每月',
  yearly: '每年',
};

export function pad2(value) {
  return value < 10 ? `0${value}` : `${value}`;
}

/** Date（本地时间）-> { year, month, day } */
export function partsOf(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

/** Date -> yyyy-MM-dd */
export function formatDate(date) {
  const { year, month, day } = partsOf(date);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** yyyy-MM-dd -> { year, month, day }，格式不合法返回 null */
export function parseDate(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('-');
  if (parts.length !== 3) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function toUTC({ year, month, day }) {
  return Date.UTC(year, month - 1, day);
}

/** 两个日期相差的日历天数（to - from） */
export function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / DAY_MS);
}

/** 在日期上增加天数，返回新的 { year, month, day } */
export function addDays(date, amount) {
  const value = new Date(toUTC(date) + amount * DAY_MS);
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

/** 在日期上增加月数，日号超出目标月时取该月最后一天 */
export function addMonthsClamped(date, months) {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return {
    year,
    month,
    day: Math.min(date.day, daysInMonth(year, month)),
  };
}

/** 在日期上增加年数，2 月 29 日在平年取 2 月 28 日 */
export function addYearsClamped(date, years) {
  const year = date.year + years;
  return {
    year,
    month: date.month,
    day: Math.min(date.day, daysInMonth(year, date.month)),
  };
}

export function repeatText(type) {
  return REPEAT_TEXT[type] || REPEAT_TEXT.none;
}

/** 以首次区间推算第 index 次重复的发生区间 */
function occurrenceAt(start, duration, repeatType, index) {
  const startDate =
    repeatType === 'monthly'
      ? addMonthsClamped(start, index)
      : addYearsClamped(start, index);
  const endDate = addDays(startDate, duration);
  return {
    start: formatParts(startDate),
    end: formatParts(endDate),
  };
}

function formatParts(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * 计算事件在 today 时应展示的发生区间。
 * - 非重复事件始终返回首次区间（是否已结束由调用方过滤）。
 * - 重复事件优先返回包含 today 的那一次；否则返回下一次发生。
 * 返回 null 表示日期数据非法。
 */
export function nextOccurrence(event, today) {
  const start = parseDate(event && event.start_date);
  const end = parseDate(event && event.end_date);
  if (!start || !end) return null;
  const duration = Math.max(0, daysBetween(start, end));
  const repeatType = event.repeat_type === 'monthly' || event.repeat_type === 'yearly'
    ? event.repeat_type
    : 'none';
  const todayText = formatDate(today);

  if (repeatType === 'none') {
    return { start: event.start_date, end: event.end_date };
  }
  if (todayText <= event.end_date) {
    return { start: event.start_date, end: event.end_date };
  }

  // 从今天所在的大致周期向前后各多算一次，确保能找到包含今天或下一个发生的区间
  const approx =
    repeatType === 'monthly'
      ? (today.getFullYear() - start.year) * 12 + (today.getMonth() + 1 - start.month)
      : today.getFullYear() - start.year;
  const from = Math.max(0, approx - 1);
  for (let index = from; index <= approx + 2; index += 1) {
    const occurrence = occurrenceAt(start, duration, repeatType, index);
    if (occurrence.end >= todayText) return occurrence;
  }
  // 理论上不会走到这里；兜底返回下一年的下一次发生
  return occurrenceAt(start, duration, repeatType, Math.max(0, approx + 1));
}

/**
 * 把一条事件转换成列表行；已结束的事件返回 null。
 * 行内字段：id/name/repeat_type/repeat_text/start_date/end_date/countdown_text/sort_days
 */
export function buildEventRow(event, today) {
  const occurrence = nextOccurrence(event, today);
  if (!occurrence) return null;
  const todayText = formatDate(today);
  if (occurrence.end < todayText) return null;

  let countdownText = '进行中';
  let sortDays = 0;
  if (occurrence.start > todayText) {
    sortDays = daysBetween(
      parseDate(todayText),
      parseDate(occurrence.start),
    );
    countdownText = `${sortDays} 天`;
  } else if (occurrence.start === todayText && occurrence.end === todayText) {
    countdownText = '今天';
  }

  return {
    ...event,
    start_date: occurrence.start,
    end_date: occurrence.end,
    repeat_text: repeatText(event.repeat_type),
    countdown_text: countdownText,
    sort_days: sortDays,
  };
}

/** 生成日历列表：过滤已结束事件，按倒计时升序（进行中/今天在前） */
export function buildCalendarRows(events, today) {
  const rows = [];
  for (const event of events || []) {
    const row = buildEventRow(event, today);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => {
    if (a.sort_days !== b.sort_days) return a.sort_days - b.sort_days;
    if (a.start_date !== b.start_date) return a.start_date < b.start_date ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });
  return rows;
}
