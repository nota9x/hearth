import { and, eq, isNull } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { database } from '../../packages/core/db';
import { dateRange, highlightParts } from '../../packages/core/image-search';
import { imageSearchQuery } from '../../packages/core/image-search-query';
import {
  aliases,
  deliveryDomains,
  images,
  users,
} from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

let mf: Miniflare;
let binding: D1Database;
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  );
  binding = await mf.getD1Database('DB');
  await migrateDatabase(binding);
  const db = database(binding);
  await db.insert(users).values(
    ['alice', 'bob'].map((id) => ({
      id,
      displayName: id,
      createdAt: 1,
      updatedAt: 1,
    })),
  );
  await db.insert(deliveryDomains).values({
    id: 'host',
    hostname: 'shots.example.com',
    createdAt: 1,
    updatedAt: 1,
    health: 'active',
  });
  const fixtures = [
    {
      id: 'a',
      filename: 'screenshot.png',
      size: 100,
      width: 200,
      height: 100,
      createdAt: Date.parse('2026-09-20T23:59:59Z') / 1000,
    },
    {
      id: 'b',
      filename: 'Vacation-Screenshot.png',
      size: 1024 * 1024,
      width: 100,
      height: 200,
      createdAt: Date.parse('2026-09-19T00:00:00Z') / 1000,
    },
    {
      id: 'c',
      filename: 'screen-shot.jpg',
      extension: 'jpg',
      mime: 'image/jpeg',
      size: 5 * 1024 * 1024,
      width: 100,
      height: 100,
      createdAt: Date.parse('2026-08-01T00:00:00Z') / 1000,
    },
    {
      id: 'd',
      filename: '100%_real.png',
      size: 10 * 1024 * 1024,
      width: 100,
      height: 100,
      createdAt: 1,
    },
    {
      id: 'private',
      filename: 'private.png',
      userId: 'bob',
      size: 10,
      width: 1,
      height: 1,
      createdAt: 1,
    },
    {
      id: 'deleted',
      filename: 'screenshot.png',
      deletedAt: 1,
      size: 10,
      width: 1,
      height: 1,
      createdAt: 1,
    },
  ];
  await db.insert(images).values(
    fixtures.map((item) => ({
      userId: 'alice',
      mime: 'image/png',
      extension: 'png',
      sha256: 'hash-' + item.id,
      objectKey: item.id,
      ...item,
    })),
  );
  await db.insert(aliases).values({
    id: 'alias',
    imageId: 'a',
    deliveryDomainId: 'host',
    slug: 'summer-trip-with-a-long-generated-url-123456789',
    createdAt: 1,
  });
});
afterEach(async () => {
  await mf?.dispose();
});

async function find(parameters: string) {
  const { filter, order } = imageSearchQuery(
    new URLSearchParams(parameters),
    'alice',
  );
  const rows = await database(binding)
    .select({ id: images.id })
    .from(images)
    .innerJoin(users, eq(users.id, images.userId))
    .leftJoin(
      aliases,
      and(
        eq(aliases.imageId, images.id),
        eq(aliases.primary, true),
        isNull(aliases.disabledAt),
      ),
    )
    .leftJoin(deliveryDomains, eq(deliveryDomains.id, aliases.deliveryDomainId))
    .where(filter)
    .orderBy(...order);
  return rows.map((image) => image.id);
}

describe('library queries on D1', () => {
  it('matches partial filenames without case sensitivity and ranks exact/prefix first', async () => {
    expect(await find('q=SCREENSHOT')).toEqual(['a', 'b', 'c']);
    expect(await find('q=screenshot.png')).toEqual(['a', 'b']);
  });
  it('finds one-character mistakes but avoids short fuzzy matches', async () => {
    expect(await find('q=screensht')).toEqual(['a', 'b']);
    expect(await find('q=screensxot')).toEqual(['a', 'b']);
    expect(await find('q=screennshot')).toEqual(['a', 'b', 'c']);
    expect(await find('q=sxot')).toEqual([]);
  });
  it('searches full, partial and non-primary public links', async () => {
    for (const query of [
      'summer-trip',
      'example.com/summer',
      'https://shots.example.com/summer-trip-with-a-long-generated-url-123456789?download=1',
      'https://shots.example.com:8788/summer-trip-with-a-long-generated-url-123456789',
    ]) {
      expect(await find('q=' + encodeURIComponent(query))).toEqual(['a']);
    }
  });
  it('treats wildcard characters literally and preserves ownership and tombstones', async () => {
    expect(await find('q=%25_')).toEqual(['d']);
    expect(await find('q=private')).toEqual([]);
    expect(await find('')).toEqual(['a', 'b', 'c', 'd']);
    const query = imageSearchQuery(new URLSearchParams());
    const rows = await database(binding)
      .select()
      .from(images)
      .where(query.filter);
    expect(rows.map((row) => row.id)).toContain('private');
  });
  it('combines date, type, orientation, size, host and text filters', async () => {
    expect(
      await find(
        'q=screenshot&type=png&orientation=landscape&size=small&domain=host&date=custom&from=2026-09-20&to=2026-09-20&sort=newest',
      ),
    ).toEqual(['a']);
    expect(await find('date=custom&from=2026-09-19&to=2026-09-20')).toEqual([
      'a',
      'b',
    ]);
    expect(await find('q=2026-09-19')).toEqual(['b']);
    expect(
      await find('date=custom&from=2026-09-20&tz=America%2FNew_York'),
    ).toEqual(['a']);
    expect(await find('q=2026-09-20&tz=Asia%2FTokyo')).toEqual([]);
    expect(await find('type=jpg&orientation=square')).toEqual(['c']);
  });
  it('uses non-overlapping size ranges and every sort option', async () => {
    expect(await find('size=medium')).toEqual(['b']);
    expect(await find('size=large')).toEqual(['c']);
    expect(await find('size=huge')).toEqual(['d']);
    expect(await find('sort=smallest')).toEqual(['a', 'b', 'c', 'd']);
    expect(await find('sort=largest')).toEqual(['d', 'c', 'b', 'a']);
    expect(await find('sort=oldest')).toEqual(['d', 'c', 'b', 'a']);
    expect(await find('sort=name')).toEqual(['d', 'c', 'a', 'b']);
    expect(await find('sort=name-desc')).toEqual(['b', 'a', 'c', 'd']);
    expect(imageSearchQuery(new URLSearchParams('sort=best')).sort).toBe(
      'newest',
    );
  });
});

describe('date interpretation and highlighting', () => {
  const now = new Date('2026-09-20T15:00:00Z');
  it.each([
    ['today', '2026-09-20', '2026-09-21'],
    ['yesterday', '2026-09-19', '2026-09-20'],
    ['7d', '2026-09-14', '2026-09-21'],
    ['30d', '2026-08-22', '2026-09-21'],
    ['this week', '2026-09-14', '2026-09-21'],
    ['last week', '2026-09-07', '2026-09-14'],
    ['this month', '2026-09-01', '2026-10-01'],
    ['last month', '2026-08-01', '2026-09-01'],
  ])('interprets %s with exclusive end boundaries', (query, start, end) => {
    expect(dateRange(query, '', '', now)).toEqual([
      Date.parse(start) / 1000,
      Date.parse(end) / 1000,
    ]);
  });
  it('rejects invalid and reversed custom dates', () => {
    expect(dateRange('2026-02-30')).toBeUndefined();
    expect(dateRange('custom', '2026-09-20', '2026-09-19')).toBeUndefined();
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
  it('highlights literal matches without interpreting markup', () => {
    expect(highlightParts('<ScreenSHOT>.png', 'screenshot')).toEqual([
      { text: '<', match: false },
      { text: 'ScreenSHOT', match: true },
      { text: '>.png', match: false },
    ]);
    expect(highlightParts('today.png', 'today')).toEqual([
      { text: 'today.png', match: false },
    ]);
  });
});
