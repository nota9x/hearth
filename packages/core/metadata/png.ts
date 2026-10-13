import type { ImageReader } from './binary';
import {
  ascii,
  crc32,
  invalid,
  minimalExif,
  orientationState,
  text,
  view,
} from './binary';

const rendering = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'acTL',
  'fcTL',
  'fdAT',
  'iCCP',
  'gAMA',
  'cHRM',
  'sRGB',
  'cICP',
  'mDCV',
  'cLLI',
  'sBIT',
  'bKGD',
  'pHYs',
  'hIST',
  'sPLT',
]);

function exifChunk(payload: Uint8Array) {
  const type = ascii('eXIf');
  const bytes = new Uint8Array(payload.length + 12);
  const data = view(bytes);
  data.setUint32(0, payload.length);
  bytes.set(type, 4);
  bytes.set(payload, 8);
  data.setUint32(bytes.length - 4, crc32(payload, crc32(type)) ^ 0xff_ff_ff_ff);
  return bytes;
}

export async function* stripPng(reader: ImageReader) {
  yield await reader.read(8);
  const readOrientation = orientationState();
  let first = true;
  let image = false;
  let oriented = false;
  let chunks = 0;
  while (true) {
    if (++chunks > 65_536) invalid();
    const header = await reader.read(8);
    const length = view(header).getUint32(0);
    const type = text(header.subarray(4));
    if (
      !/^[a-zA-Z]{4}$/.test(type) ||
      length > 0x7f_ff_ff_ff ||
      (first && type !== 'IHDR') ||
      (!first && type === 'IHDR')
    )
      invalid();
    first = false;
    if ((type === 'IHDR' && length !== 13) || (type === 'IEND' && length !== 0))
      invalid();
    const keep = rendering.has(type);
    if (!keep && type[0] === type[0].toUpperCase()) invalid();
    let checksum = crc32(header.subarray(4));
    let exif: Uint8Array | undefined;
    if (type === 'eXIf') {
      exif = await reader.read(length);
      checksum = crc32(exif, checksum);
    } else {
      if (keep) yield header;
      for await (const chunk of reader.pieces(length)) {
        checksum = crc32(chunk, checksum);
        if (keep) yield chunk;
      }
    }
    const ending = await reader.read(4);
    if (view(ending).getUint32(0) !== (checksum ^ 0xff_ff_ff_ff) >>> 0)
      invalid();
    if (keep) yield ending;
    else if (exif) {
      const value = readOrientation(exif);
      if (value !== 1 && !oriented) {
        yield exifChunk(minimalExif(value));
        oriented = true;
      }
    }
    if (type === 'IDAT') image = true;
    else if (type === 'IEND') {
      if (!image) invalid();
      await reader.end();
      return;
    }
  }
}
