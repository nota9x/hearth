import { describe, expect, it } from 'vitest';

import {
  parseStorageLimit,
  storageBytes,
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
    expect(storageLimitInput(1_234_000_001)).toEqual({
      unit: 'MB',
      amount: '1234.000001',
    });
  });
  it('converts decimals to exact bytes without floating point multiplication', () => {
    expect(parseStorageLimit('0.000001', 'MB')).toBe(1);
    expect(parseStorageLimit('1.234567', 'GB')).toBe(1_234_567_000);
    expect(parseStorageLimit('2.5', 'TB')).toBe(2_500_000_000_000);
  });
  it.each(['0', '-1', 'Infinity', 'NaN', '1e6', '0.0000001', '9007199255'])(
    'rejects invalid or imprecise values %s',
    (value) => {
      expect(() => parseStorageLimit(value, 'GB')).toThrow();
    },
  );
  it('uses understandable decimal storage units', () => {
    expect(storageBytes(0)).toBe('0 B');
    expect(storageBytes(812_800_000)).toBe('812.8 MB');
    expect(storageBytes(1_000_000_000_000)).toBe('1 TB');
  });
});
