import { describe, expect, it } from 'vitest';

import { dateRange } from '../../packages/core/image-search';

describe('calendar date boundaries', () => {
  const now = new Date('2026-09-20T15:00:00Z');
  it.each([
    ['today', '2026-09-20', '2026-09-21'],
    ['last week', '2026-09-07', '2026-09-14'],
    ['last month', '2026-08-01', '2026-09-01'],
  ])('interprets %s with exclusive end boundaries', (query, start, end) => {
    expect(dateRange(query, '', '', now)).toEqual([
      Date.parse(start) / 1000,
      Date.parse(end) / 1000,
    ]);
  });
  it('uses local calendar days across UTC midnight and daylight saving changes', () => {
    expect(
      dateRange(
        'today',
        '',
        '',
        new Date('2026-09-21T02:00:00Z'),
        'America/New_York',
      ),
    ).toEqual([
      Date.parse('2026-09-20T04:00:00Z') / 1000,
      Date.parse('2026-09-21T04:00:00Z') / 1000,
    ]);
    expect(
      dateRange('custom', '2026-03-08', '', now, 'America/New_York'),
    ).toEqual([
      Date.parse('2026-03-08T05:00:00Z') / 1000,
      Date.parse('2026-03-09T04:00:00Z') / 1000,
    ]);
    expect(
      dateRange('custom', '2026-11-01', '', now, 'America/New_York'),
    ).toEqual([
      Date.parse('2026-11-01T04:00:00Z') / 1000,
      Date.parse('2026-11-02T05:00:00Z') / 1000,
    ]);
    expect(dateRange('2026-09-20', '', '', now, 'Asia/Tokyo')).toEqual([
      Date.parse('2026-09-19T15:00:00Z') / 1000,
      Date.parse('2026-09-20T15:00:00Z') / 1000,
    ]);
  });
});
