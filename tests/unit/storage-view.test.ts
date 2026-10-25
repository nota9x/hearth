import { describe, expect, it } from 'vitest';

import {
  parseStorageLimit,
  storageLimitInput,
} from '../../packages/core/storage-view';

describe('precise storage limits and presentation', () => {
  it('presents every configured byte exactly in a supported input unit', () => {
    for (const bytes of [
      1,
      1_234_000_001,
      1_234_567_000,
      2_500_000_000_000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const input = storageLimitInput(bytes);
      expect(parseStorageLimit(input.amount, input.unit)).toBe(bytes);
    }
  });
  it.each(['0', '0.0000001', '9007199255'])(
    'rejects invalid or imprecise values %s',
    (value) => {
      expect(() => parseStorageLimit(value, 'GB')).toThrow();
    },
  );
});
