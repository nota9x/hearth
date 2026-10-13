import { escapeLike, searchText } from './search';

export { dateOptions, dateRange, escapeLike, searchText } from './search';

// These are the formats accepted by inspectImage; shared with the library UI.
export const imageFormats = {
  png: 'PNG',
  jpg: 'JPG / JPEG',
  webp: 'WebP',
  gif: 'GIF',
  avif: 'AVIF',
};
export const sizeOptions = {
  small: 'Under 1 MB',
  medium: '1–5 MB',
  large: '5–10 MB',
  huge: '10+ MB',
};
export const sortOptions = {
  best: 'Best match',
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name A–Z',
  'name-desc': 'Name Z–A',
  largest: 'Largest first',
  smallest: 'Smallest first',
};
export const filterKeys = [
  'date',
  'from',
  'to',
  'type',
  'orientation',
  'size',
  'domain',
  'owner',
] as const;

// Only one edit in a reasonably long filename fragment. No fuzzy URL matching.
export function fuzzyPatterns(query: string) {
  if (!/^[\p{L}\p{N}-]{6,32}$/u.test(query)) return [];
  const patterns = new Set<string>();
  for (let index = 0; index <= query.length; index++) {
    const before = escapeLike(query.slice(0, index));
    const after = escapeLike(query.slice(index));
    patterns.add(`%${before}_${after}%`);
    if (!(index < query.length)) {
      continue;
    }

    patterns.add(`%${before}${escapeLike(query.slice(index + 1))}%`);
    patterns.add(`%${before}_${escapeLike(query.slice(index + 1))}%`);
  }
  return [...patterns];
}

export function highlightParts(filename: string, query: string) {
  const needle = searchText(query);
  if (!needle) return [{ text: filename, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  let index = filename.toLowerCase().indexOf(needle);
  while (index !== -1) {
    parts.push(
      { text: filename.slice(cursor, index), match: false },
      { text: filename.slice(index, index + needle.length), match: true },
    );
    cursor = index + needle.length;
    index = filename.toLowerCase().indexOf(needle, cursor);
  }
  parts.push({ text: filename.slice(cursor), match: false });
  return parts;
}
