const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?/;
const DEFAULT_CUTOFF = '15:00';

function pad(value) {
  return String(value).padStart(2, '0');
}

export function parseLocalDateTime(value = new Date()) {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  const text = String(value).trim();
  const match = text.match(DATE_TIME_RE);
  if (!match) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new TypeError(`Invalid date value: ${value}`);
    }
    return parsed;
  }

  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

export function toLocalDate(value = new Date()) {
  if (typeof value === 'string' && DATE_RE.test(value.trim())) {
    return value.trim();
  }

  const date = parseLocalDateTime(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toLocalDateTime(value = new Date()) {
  const date = parseLocalDateTime(value);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join(' ');
}

export function addLocalDays(value, days) {
  const date = parseLocalDateTime(toLocalDate(value));
  date.setDate(date.getDate() + days);
  return toLocalDate(date);
}

export function isWeekday(value) {
  const day = parseLocalDateTime(toLocalDate(value)).getDay();
  return day >= 1 && day <= 5;
}

function cutoffToMinutes(cutoff) {
  const [hour, minute] = cutoff.split(':').map(Number);
  return hour * 60 + minute;
}

export function isBeforeOrAtCutoff(value = new Date(), cutoff = DEFAULT_CUTOFF) {
  const date = parseLocalDateTime(value);
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes <= cutoffToMinutes(cutoff);
}

export function isTradingDateFromCalendar(value, rows = []) {
  const date = toLocalDate(value);
  const row = rows.find((item) => item.trade_date === date);

  if (row) {
    return Number(row.is_open) === 1;
  }

  return isWeekday(date);
}

export function nextWeekdayTradingDate(value, { inclusive = false } = {}) {
  let date = inclusive ? toLocalDate(value) : addLocalDays(value, 1);

  for (let i = 0; i < 370; i += 1) {
    if (isWeekday(date)) {
      return date;
    }
    date = addLocalDays(date, 1);
  }

  throw new Error('Unable to find next weekday trading date.');
}

export function nextTradingDateFromCalendar(value, rows = [], { inclusive = false } = {}) {
  let date = inclusive ? toLocalDate(value) : addLocalDays(value, 1);

  for (let i = 0; i < 370; i += 1) {
    if (isTradingDateFromCalendar(date, rows)) {
      return date;
    }
    date = addLocalDays(date, 1);
  }

  throw new Error('Unable to find next trading date.');
}

export function resolveApplicationTradeDate(value = new Date(), rows = []) {
  const submittedDate = toLocalDate(value);

  if (isBeforeOrAtCutoff(value) && isTradingDateFromCalendar(submittedDate, rows)) {
    return submittedDate;
  }

  return nextTradingDateFromCalendar(submittedDate, rows, { inclusive: false });
}
