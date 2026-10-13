import { imageSize } from 'image-size';

import { AppError } from './common';
import { createGifValidator } from './gif';

const types: Record<string, { mime: string; extension: string }> = {
  png: { mime: 'image/png', extension: 'png' },
  jpg: { mime: 'image/jpeg', extension: 'jpg' },
  gif: { mime: 'image/gif', extension: 'gif' },
  webp: { mime: 'image/webp', extension: 'webp' },
  avif: { mime: 'image/avif', extension: 'avif' },
};
export function inspectImage(
  prefix: Uint8Array,
  size: number,
  tail: Uint8Array,
  gif?: ReturnType<typeof createGifValidator>,
) {
  try {
    const dimensions = imageSize(prefix);
    const type =
      dimensions.type === 'heif' &&
      new TextDecoder().decode(prefix.subarray(8, 32)).includes('avif')
        ? 'avif'
        : dimensions.type;
    const format = type ? types[type] : undefined;
    if (
      !format ||
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width * dimensions.height > 100_000_000 ||
      size < 20
    )
      throw new Error('invalid');
    if (type === 'jpg' && !(tail.at(-2) === 255 && tail.at(-1) === 217))
      throw new Error('truncated');
    if (type === 'png' && !new TextDecoder().decode(tail).includes('IEND'))
      throw new Error('truncated');
    if (type === 'gif') {
      if (!gif) {
        if (prefix.length !== size)
          throw new Error('Incomplete GIF validation');
        gif = createGifValidator();
        gif.write(prefix);
      }
      gif.finish();
    }
    if (
      type === 'webp' &&
      new DataView(
        prefix.buffer,
        prefix.byteOffset,
        prefix.byteLength,
      ).getUint32(4, true) +
        8 !==
        size
    )
      throw new Error('truncated');
    return { ...format, width: dimensions.width, height: dimensions.height };
  } catch {
    throw new AppError(
      400,
      'INVALID_FILE_TYPE',
      'Upload a valid PNG, JPEG, GIF, WebP, or AVIF image (up to 100 megapixels).',
    );
  }
}
export { filename, serveObject } from './serve';
