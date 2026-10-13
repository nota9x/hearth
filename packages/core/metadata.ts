import { AppError } from './common';
import { createGifValidator } from './gif';
import { stripAvif } from './metadata/avif';
import { ImageReader, invalid, text } from './metadata/binary';
import { stripJpeg } from './metadata/jpeg';
import { stripPng } from './metadata/png';
import { stripWebp, type WebpHeader } from './metadata/webp';

export function sanitizeImage(source: AsyncIterable<Uint8Array>) {
  const webp: WebpHeader = {};
  async function* bytes() {
    const reader = new ImageReader(source);
    try {
      const signature = await reader.read(12);
      reader.unread(signature);
      if (signature[0] === 255 && signature[1] === 216)
        yield* stripJpeg(reader);
      else if (
        signature[0] === 137 &&
        text(signature.subarray(1, 8)) === 'PNG\r\n\u{1A}\n'
      )
        yield* stripPng(reader);
      else if (
        text(signature.subarray(0, 4)) === 'RIFF' &&
        text(signature.subarray(8)) === 'WEBP'
      )
        yield* stripWebp(reader, webp);
      else if (text(signature.subarray(4, 8)) === 'ftyp')
        yield* stripAvif(reader);
      else if (['GIF87a', 'GIF89a'].includes(text(signature.subarray(0, 6)))) {
        const output: Uint8Array[] = [];
        const gif = createGifValidator({
          stripMetadata: true,
          emit: (chunk) => {
            output.push(chunk);
          },
        });
        while (true) {
          const chunk = await reader.take();
          if (!chunk) break;
          gif.write(chunk);
          for (const part of output) yield part;
          output.length = 0;
        }
        try {
          gif.finish();
        } catch {
          invalid();
        }
      } else invalid();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        422,
        'METADATA_STRIPPING_FAILED',
        'The image metadata could not be safely removed.',
      );
    }
  }
  return {
    bytes: bytes(),
    get deferredHeader() {
      return !!webp.header;
    },
    patchHeader(first: Uint8Array) {
      if (webp.header) first.set(webp.header, 0);
      if (webp.features) first.set(webp.features, 20);
    },
  };
}
