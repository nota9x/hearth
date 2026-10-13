export const dateOptions = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  custom: 'Custom date range',
};

export function dateRange(
  value: string,
  from = '',
  to = '',
  now = new Date(),
  timeZone = 'UTC',
): [number, number] | undefined {
  if (
    !/^(?:\d{4}-\d{2}-\d{2}|today|yesterday|7d|30d|this week|last week|this month|last month|custom)$/.test(
      value,
    )
  )
    return;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone.slice(0, 100),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const parts = (date: Date) => {
    const fields = Object.fromEntries(
      formatter.formatToParts(date).map(({ type, value }) => [type, value]),
    );
    return [Number(fields.year), Number(fields.month), Number(fields.day)];
  };
  const [year, month, day] = parts(now);
  const calendarDay = (offset: number) =>
    new Date(Date.UTC(year, month - 1, day + offset));
  const localStart = (date: Date) => {
    const target =
      date.getUTCFullYear() * 10_000 +
      (date.getUTCMonth() + 1) * 100 +
      date.getUTCDate();
    const midnight = Math.floor(date.getTime() / 1000);
    let low = midnight - 2 * 86_400;
    let high = midnight + 2 * 86_400;
    // Find the first instant in this local calendar day. The two boundaries
    // can have different UTC offsets when daylight saving time changes.
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const [y, m, d] = parts(new Date(middle * 1000));
      if (y * 10_000 + m * 100 + d < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  let first = calendarDay(0),
    last = calendarDay(1);
  switch (value) {
    case 'yesterday': {
      first = calendarDay(-1);
      last = calendarDay(0);

      break;
    }
    case '7d': {
      first = calendarDay(-6);
      break;
    }
    case '30d': {
      first = calendarDay(-29);
      break;
    }
    case 'this week':
    case 'last week': {
      const monday = -((calendarDay(0).getUTCDay() + 6) % 7);
      first = calendarDay(monday - (value === 'last week' ? 7 : 0));
      last = calendarDay(monday + (value === 'last week' ? 0 : 7));

      break;
    }
    case 'this month':
    case 'last month': {
      first = new Date(
        Date.UTC(year, month - (value === 'last month' ? 2 : 1), 1),
      );
      last = new Date(
        Date.UTC(year, month - (value === 'last month' ? 1 : 0), 1),
      );

      break;
    }
    default: {
      if (value === 'custom' || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const first = value === 'custom' ? from : value;
        const last = value === 'custom' ? to || from : value;
        if (
          [first, last].some(
            (v) =>
              !(
                /^\d{4}-\d{2}-\d{2}$/.test(v) &&
                !Number.isNaN(Date.parse(v)) &&
                new Date(v).toISOString().startsWith(v)
              ),
          )
        )
          return;
        const startDate = new Date(first);
        const endDate = new Date(last);
        endDate.setUTCDate(endDate.getUTCDate() + 1);
        if (endDate <= startDate) return;
        return [localStart(startDate), localStart(endDate)];
      }
    }
  }
  return [localStart(first), localStart(last)];
}

export function searchText(query: string) {
  const value = query.trim().toLowerCase();
  return dateRange(value) ? '' : value;
}

export function escapeLike(value: string) {
  return value.replaceAll(/[%_!]/g, '!$&');
}

export type SearchFilter = {
  key: string;
  label: string;
  placeholder: string;
  options?: Record<string, string>;
};

export function searchURL(
  current: URL,
  values: Record<string, string>,
  query: string,
  keys: readonly string[],
  timeZone = 'UTC',
) {
  const url = new URL(current);
  for (const key of [...keys, 'q', 'sort', 'page', 'tz'])
    url.searchParams.delete(key);
  for (const key of [...keys, 'sort']) {
    const value = values[key];
    if (value) url.searchParams.set(key, value);
  }
  if (query.trim()) url.searchParams.set('q', query.trim().slice(0, 240));
  if (values.date || dateRange(query.trim().toLowerCase()))
    url.searchParams.set('tz', timeZone);
  return url;
}

export function pageWindow(page: number, pages: number): (number | string)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const first = Math.max(2, Math.min(page - 1, pages - 3));
  const last = Math.min(pages - 1, Math.max(page + 1, 4));
  const result: (number | string)[] = [1];
  if (first === 3) result.push(2);
  else if (first > 3) result.push('gap-2');
  for (let index = first; index <= last; index++) result.push(index);
  if (last === pages - 2) result.push(pages - 1);
  else if (last < pages - 2) result.push(`gap-${last + 1}`);
  result.push(pages);
  return result;
}

export function paginationState(
  requested: string | null,
  total: number,
  size: number,
  maxPages = Number.MAX_SAFE_INTEGER,
) {
  const pages = Math.max(1, Math.min(maxPages, Math.ceil(total / size)));
  const parsed = Number(requested);
  const page = Math.min(
    pages,
    Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : 1),
  );
  return { page, pages, total, size, offset: (page - 1) * size };
}

export function pageURL(current: URL, page: number, parameter = 'page') {
  const url = new URL(current);
  if (page <= 1) url.searchParams.delete(parameter);
  else url.searchParams.set(parameter, String(page));
  return url.pathname + url.search;
}

export function parseSearch(parameters: URLSearchParams) {
  const query = (parameters.get('q') || '').trim().slice(0, 240);
  const text = searchText(query);
  const now = new Date();
  const timeZone = parameters.get('tz') || 'UTC';
  const dates = [
    dateRange(
      parameters.get('date') || '',
      parameters.get('from') || '',
      parameters.get('to') || '',
      now,
      timeZone,
    ),
    dateRange(query.toLowerCase(), '', '', now, timeZone),
  ];
  return { query, text, dates };
}
