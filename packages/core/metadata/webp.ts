/* eslint-disable unicorn/no-break-in-nested-loop, unicorn/prefer-simple-condition-first -- Container dispatch follows binary field order and stream boundaries. */
import type { ImageReader } from './binary';
import {
  invalid,
  join,
  minimalExif,
  orientationState,
  text,
  view,
} from './binary';

export type WebpHeader = { header?: Uint8Array; features?: Uint8Array };
const render = new Set(['VP8 ', 'VP8L', 'ALPH', 'ICCP', 'ANIM']);

export async function* stripWebp(reader: ImageReader, state: WebpHeader) {
  const header = await reader.read(12);
  const end = view(header).getUint32(4, true) + 8;
  if (end < 20) invalid();
  state.header = header;
  yield header;
  const readOrientation = orientationState();
  let length = 12;
  let oriented = false;
  let image = false;
  let chunks = 0;
  while (reader.offset < end) {
    if (++chunks > 65_536 || reader.offset + 8 > end) invalid();
    const chunkHeader = await reader.read(8);
    const type = text(chunkHeader.subarray(0, 4));
    const size = view(chunkHeader).getUint32(4, true);
    if (reader.offset + size + (size & 1) > end) invalid();
    switch (type) {
      case 'VP8X': {
        if (state.features || size !== 10 || length !== 12) invalid();
        const features = await reader.read(10);
        features[0] &= 50;
        features.fill(0, 1, 4);
        state.features = features;
        yield chunkHeader;
        yield features;
        length += 18;

        break;
      }
      case 'EXIF': {
        const value = readOrientation(await reader.read(size));
        if (value !== 1 && !oriented) {
          if (!state.features) invalid();
          state.features[0] |= 8;
          const payload = minimalExif(value);
          const replacement = new Uint8Array(chunkHeader);
          view(replacement).setUint32(4, payload.length, true);
          yield join(replacement, payload);
          length += 8 + payload.length;
          oriented = true;
        }

        break;
      }
      case 'ANMF': {
        if (!state.features || !(state.features[0] & 2) || size < 16) invalid();
        const frameEnd = reader.offset + size;
        yield chunkHeader;
        yield await reader.read(16);
        let frameImage = false;
        while (reader.offset < frameEnd) {
          if (++chunks > 65_536 || reader.offset + 8 > frameEnd) invalid();
          const subheader = await reader.read(8);
          const subtype = text(subheader.subarray(0, 4));
          const subsize = view(subheader).getUint32(4, true);
          if (reader.offset + subsize + (subsize & 1) > frameEnd) invalid();
          const keep = ['ALPH', 'VP8 ', 'VP8L'].includes(subtype);
          if (!keep) subheader.set(new TextEncoder().encode('JUNK'));
          yield subheader;
          for await (const chunk of reader.pieces(subsize))
            yield keep ? chunk : new Uint8Array(chunk.length);
          if (subsize & 1) {
            await reader.skip(1);
            yield new Uint8Array(1);
          }
          if (subtype === 'VP8 ' || subtype === 'VP8L') frameImage = true;
        }
        if (!frameImage) invalid();
        length += 8 + size + (size & 1);
        image = true;

        break;
      }
      default: {
        if (render.has(type)) {
          yield chunkHeader;
          yield* reader.pieces(size);
          if (size & 1) yield new Uint8Array(1);
          length += 8 + size + (size & 1);
          if (type === 'VP8 ' || type === 'VP8L') image = true;
        } else await reader.skip(size);
      }
    }
    if (size & 1) await reader.skip(1);
  }
  if (!image) invalid();
  await reader.end();
  view(header).setUint32(4, length - 8, true);
}
