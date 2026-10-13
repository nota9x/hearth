import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import { fuzzyPatterns, imageFormats, sortOptions } from './image-search';
import { images } from './schema';
import { parseSearch } from './search';

export function imageSearchQuery(parameters: URLSearchParams, userId?: string) {
  const { query, text, dates } = parseSearch(parameters);
  let address = text;
  try {
    address = decodeURIComponent(
      text.includes('/')
        ? text.replace(/^https?:\/\//, '').split(/[?#]/, 1)[0]
        : text,
    );
  } catch {
    /*
    Search malformed URL text literally.
    */
  }
  // Ignore the development delivery port when matching a pasted public URL.
  address = address.replace(/:\d+(?=\/)/, '');
  const score = text
    ? sql<number>`case
    when lower(${images.filename}) = ${text} then 100
    when instr(lower(${images.filename}), ${text}) = 1 then 80
    when instr(lower(${images.filename}), ${text}) > 0 then 60
    when exists(select 1 from aliases a join delivery_domains h on h.id=a.deliveryDomainId where a.imageId=${images.id} and a.disabledAt is null and instr(lower(h.hostname || '/' || a.slug), ${address}) > 0) then 40
    when lower(${images.sha256}) = ${text} then 30
    when exists(select 1 from json_each(${JSON.stringify(fuzzyPatterns(text))}) p where lower(${images.filename}) like p.value escape '!') then 10
    else 0 end`
    : sql<number>`0`;
  const type = parameters.get('type') || '';
  const orientation = parameters.get('orientation');
  const size = parameters.get('size');
  const mb = 1024 * 1024;
  const base = and(
    userId ? eq(images.userId, userId) : undefined,
    isNull(images.deletedAt),
  );
  const filter = and(
    base,
    !userId && parameters.get('owner')
      ? eq(images.userId, parameters.get('owner')!)
      : undefined,
    text ? sql`${score} > 0` : undefined,
    ...dates.flatMap((range) =>
      range
        ? [gte(images.createdAt, range[0]), lt(images.createdAt, range[1])]
        : [],
    ),
    Object.hasOwn(imageFormats, type) ? eq(images.extension, type) : undefined,
    orientation === 'landscape'
      ? sql`${images.width} > ${images.height}`
      : orientation === 'portrait'
        ? sql`${images.width} < ${images.height}`
        : orientation === 'square'
          ? sql`${images.width} = ${images.height}`
          : undefined,
    size === 'small'
      ? lt(images.size, mb)
      : size === 'medium'
        ? and(gte(images.size, mb), lt(images.size, 5 * mb))
        : size === 'large'
          ? and(gte(images.size, 5 * mb), lt(images.size, 10 * mb))
          : size === 'huge'
            ? gte(images.size, 10 * mb)
            : undefined,
    parameters.get('domain')
      ? sql`exists(select 1 from aliases a where a.imageId=${images.id} and a.disabledAt is null and a.deliveryDomainId=${parameters.get('domain')})`
      : undefined,
  );
  const requestedSort = parameters.get('sort') || (text ? 'best' : 'newest');
  const sort =
    Object.hasOwn(sortOptions, requestedSort) &&
    (requestedSort !== 'best' || text)
      ? requestedSort
      : 'newest';
  const order =
    sort === 'best'
      ? desc(score)
      : sort === 'oldest'
        ? asc(images.createdAt)
        : sort === 'name'
          ? asc(sql`lower(${images.filename})`)
          : sort === 'name-desc'
            ? desc(sql`lower(${images.filename})`)
            : sort === 'largest'
              ? desc(images.size)
              : sort === 'smallest'
                ? asc(images.size)
                : desc(images.createdAt);
  return {
    filter,
    base,
    order: [order, desc(images.createdAt), asc(images.id)],
    sort,
    query,
  };
}
