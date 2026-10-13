import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createGifValidator } from '../../packages/core/gif';
import { inspectImage } from '../../packages/core/media';

const staticGif = new Uint8Array(readFileSync('tests/fixtures/upload.gif'));
const animatedGif = new Uint8Array(readFileSync('tests/fixtures/animated.gif'));

describe('GIF validation', () => {
  it.each([staticGif, animatedGif])(
    'accepts static and animated GIFs with inert trailer padding',
    (bytes) => {
      const padded = new Uint8Array([...bytes, 0, 0, 13, 10, 32]);
      for (const input of [bytes, padded]) {
        const gif = createGifValidator();
        for (const byte of input) gif.write(new Uint8Array([byte]));
        expect(
          inspectImage(
            input.subarray(0, 13),
            input.length,
            input.subarray(-32),
            gif,
          ),
        ).toMatchObject({ mime: 'image/gif', width: 2, height: 3 });
        expect(
          inspectImage(input, input.length, input.subarray(-32)).mime,
        ).toBe('image/gif');
      }
    },
  );
  it('rejects every truncated prefix, even with a forged trailer', () => {
    for (let end = 13; end < animatedGif.length - 1; end++) {
      const truncated = animatedGif.subarray(0, end);
      expect(() =>
        inspectImage(truncated, truncated.length, truncated.subarray(-32)),
      ).toThrow();
    }
    const forged = new Uint8Array([...staticGif.subarray(0, 13), 59]);
    expect(() => inspectImage(forged, forged.length, forged)).toThrow();
  });
  it('rejects signatures, zero/oversize dimensions and appended active payloads', () => {
    const wrongSignature = new Uint8Array(staticGif);
    wrongSignature[3] = 57;
    const zero = new Uint8Array(staticGif);
    zero[6] = 0;
    zero[7] = 0;
    const huge = new Uint8Array(staticGif);
    huge.fill(255, 6, 10);
    const payload = new Uint8Array([
      ...staticGif,
      ...new TextEncoder().encode('<script>alert(1)</script>'),
    ]);
    for (const bytes of [wrongSignature, zero, huge, payload])
      expect(() =>
        inspectImage(bytes, bytes.length, bytes.subarray(-32)),
      ).toThrow();
  });
});
