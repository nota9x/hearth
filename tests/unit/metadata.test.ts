/* eslint-disable vitest/no-conditional-expect -- Assertions follow format-specific rendering contracts. */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

import { imageSize } from 'image-size';
import { describe, expect, it } from 'vitest';

import { sanitizeImage } from '../../packages/core/metadata';

const fixture = (name: string) =>
  readFileSync(`tests/fixtures/metadata/${name}`);
async function sanitize(input: Uint8Array, chunkSize = 7) {
  const chunks = function* () {
    for (let offset = 0; offset < input.length; offset += chunkSize)
      yield input.subarray(offset, offset + chunkSize);
  };
  const source = sanitizeImage(Readable.from(chunks()));
  const parts: Buffer[] = [];
  for await (const chunk of source.bytes) parts.push(Buffer.from(chunk));
  const output = Buffer.concat(parts);
  source.patchHeader(output);
  return output;
}
function pngChunks(bytes: Buffer) {
  const chunks: { type: string; payload: Buffer }[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    expect(crc32(bytes.subarray(offset + 4, offset + 8 + length))).toBe(
      bytes.readUInt32BE(offset + 8 + length),
    );
    chunks.push({ type, payload });
    offset += length + 12;
  }
  return chunks;
}
function jpegSegments(bytes: Buffer) {
  const result: { marker: number; payload: Buffer }[] = [];
  let offset = 2;
  while (offset < bytes.length) {
    expect(bytes[offset]).toBe(255);
    const marker = bytes[offset + 1];
    if (marker === 217) break;
    const length = bytes.readUInt16BE(offset + 2);
    result.push({
      marker,
      payload: bytes.subarray(offset + 4, offset + 2 + length),
    });
    offset += length + 2;
    if (marker === 218) break;
  }
  return result;
}
function webpChunks(bytes: Buffer) {
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  const result: { type: string; payload: Buffer }[] = [];
  for (let offset = 12; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    result.push({
      type: bytes.toString('ascii', offset, offset + 4),
      payload: bytes.subarray(offset + 8, offset + 8 + size),
    });
    offset += size + (size & 1) + 8;
  }
  return result;
}
function app(marker: number, payload: Buffer) {
  const header = Buffer.from([255, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}
function pngChunk(type: string, payload: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length);
  header.write(type, 4, 'ascii');
  const ending = Buffer.alloc(4);
  ending.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), payload])));
  return Buffer.concat([header, payload, ending]);
}
function orientedTiff(value: number) {
  const bytes = Buffer.alloc(26);
  bytes.write('II');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(274, 10);
  bytes.writeUInt16LE(3, 12);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt16LE(value, 18);
  return bytes;
}
function* failingSource() {
  yield fixture('clean.png').subarray(0, 32);
  throw new Error('Private parser context');
}

describe('lossless image metadata sanitization', () => {
  it('fails closed with a safe error when sanitization cannot finish', async () => {
    const sanitizer = sanitizeImage(Readable.from(failingSource()));
    const consume = async () => {
      for await (const bytes of sanitizer.bytes) void bytes;
    };
    await expect(consume()).rejects.toMatchObject({
      status: 422,
      code: 'METADATA_STRIPPING_FAILED',
      message: 'The image metadata could not be safely removed.',
    });
  });

  it.each([2, 6, 7])('preserves native AVIF orientation %i', async (value) => {
    const input = fixture(`orientation-${value}.avif`);
    const output = await sanitize(input);
    for (const type of ['irot', 'imir']) {
      const offset = input.indexOf(Buffer.from(type));
      if (offset === -1) continue;
      const property = input.subarray(offset - 4, offset + 5);
      expect(output.includes(property)).toBe(true);
    }
    expect(output.includes(Buffer.from('Exif'))).toBe(false);
    expect(output.includes(Buffer.from('Private'))).toBe(false);
  });

  it('rebuilds orientation-only PNG and WebP EXIF and clears WebP reserved fields', async () => {
    const tiff = orientedTiff(7);
    const png = fixture('clean.png');
    const outputPng = await sanitize(
      Buffer.concat([
        png.subarray(0, 33),
        pngChunk('eXIf', tiff),
        png.subarray(33),
      ]),
    );
    expect(
      pngChunks(outputPng).find((chunk) => chunk.type === 'eXIf')!.payload,
    ).toEqual(tiff);
    const webp = fixture('private.webp');
    const chunks = webpChunks(webp).filter((chunk) => chunk.type !== 'EXIF');
    const parts = chunks.map(({ type, payload }) => {
      const header = Buffer.alloc(8);
      header.write(type);
      header.writeUInt32LE(payload.length, 4);
      return Buffer.concat([header, payload, Buffer.alloc(payload.length & 1)]);
    });
    const exifHeader = Buffer.alloc(8);
    exifHeader.write('EXIF');
    exifHeader.writeUInt32LE(tiff.length, 4);
    const input = Buffer.concat([
      webp.subarray(0, 12),
      ...parts,
      exifHeader,
      tiff,
    ]);
    input.writeUInt32LE(input.length - 8, 4);
    input[20] |= 193;
    input.fill(65, 21, 24);
    const outputWebp = webpChunks(await sanitize(input));
    expect(outputWebp.find((chunk) => chunk.type === 'EXIF')!.payload).toEqual(
      tiff,
    );
    const flags = outputWebp.find((chunk) => chunk.type === 'VP8X')!.payload;
    expect(flags[0] & 8).toBe(8);
    expect(flags[0] & 193).toBe(0);
    expect(flags.subarray(1, 4)).toEqual(Buffer.alloc(3));
  });

  it('rejects unknown JPEG coding extensions and unsafe AVIF properties, extents and OBUs', async () => {
    const jpeg = fixture('orientation-1.jpg');
    await expect(
      sanitize(
        Buffer.concat([
          jpeg.subarray(0, 2),
          app(240, Buffer.from('Private Extension')),
          jpeg.subarray(2),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'METADATA_STRIPPING_UNSUPPORTED' });
    const avif = fixture('private.avif');
    const unknown = Buffer.from(avif);
    unknown.write('priv', unknown.indexOf(Buffer.from('av1C')));
    await expect(sanitize(unknown)).rejects.toMatchObject({
      code: 'METADATA_STRIPPING_UNSUPPORTED',
    });
    const overlap = Buffer.from(avif);
    const iloc = overlap.indexOf(Buffer.from('iloc')) + 4;
    const start = overlap.readUInt32BE(iloc + 14);
    overlap.writeUInt32BE(start, iloc + 28);
    await expect(sanitize(overlap)).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    });
    const privateObu = Buffer.from(avif);
    privateObu[start] = 42;
    await expect(sanitize(privateObu)).rejects.toMatchObject({
      code: 'METADATA_STRIPPING_UNSUPPORTED',
    });
  });

  it.each([1, 2, 6, 8])(
    'preserves JPEG orientation %i with no private IFDs',
    async (value) => {
      const input = fixture(`orientation-${value}.jpg`);
      const before = jpegSegments(input).find(
        (entry) => entry.marker === 225,
      )!.payload;
      expect(before.includes(Buffer.from([0x88, 0x25]))).toBe(true);
      const output = await sanitize(input);
      const exif = jpegSegments(output).find(
        (entry) => entry.marker === 225,
      )?.payload;
      expect(imageSize(output).orientation ?? 1).toBe(value);
      if (exif) {
        const littleEndian = exif.toString('ascii', 6, 8) === 'II';
        const tiff = new DataView(
          exif.buffer,
          exif.byteOffset + 6,
          exif.byteLength - 6,
        );
        const directory = tiff.getUint32(4, littleEndian);
        expect(tiff.getUint16(directory, littleEndian)).toBe(1);
        expect(tiff.getUint16(directory + 2, littleEndian)).toBe(0x1_12);
        expect(tiff.getUint32(directory + 14, littleEndian)).toBe(0);
        expect(exif.includes(Buffer.from('Private'))).toBe(false);
      }
      const profile = (bytes: Buffer) =>
        jpegSegments(bytes).filter((entry) => entry.marker === 226);
      expect(profile(output)).toEqual(profile(input));
      const scan = (bytes: Buffer) =>
        bytes.subarray(bytes.indexOf(Buffer.from([255, 218])));
      expect(scan(output)).toEqual(scan(input));
    },
  );

  it('reads big-endian TIFF orientation and removes comments, XMP, and IPTC', async () => {
    const tiff = Buffer.alloc(26);
    tiff.write('MM');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x1_12, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(7, 18);
    const input = fixture('orientation-1.jpg');
    const exif = app(225, Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
    const metadata = [
      app(254, Buffer.from('Private Comment')),
      app(225, Buffer.from('https://ns.adobe.com/xap/1.0/\0Private XMP')),
      app(237, Buffer.from('Photoshop 3.0\0Private IPTC')),
    ];
    const clean = await sanitize(input);
    const output = await sanitize(
      Buffer.concat([
        clean.subarray(0, 2),
        exif,
        ...metadata,
        clean.subarray(2),
      ]),
    );
    expect(imageSize(output).orientation).toBe(7);
    expect(output.includes(Buffer.from('Private'))).toBe(false);
  });

  it('removes metadata between scans without dropping entropy-coded bytes', async () => {
    const input = await sanitize(fixture('orientation-1.jpg'));
    const ending = input.length - 2;
    const scanHeader = jpegSegments(input).find(
      (entry) => entry.marker === 218,
    )!;
    const output = await sanitize(
      Buffer.concat([
        input.subarray(0, ending),
        app(254, Buffer.from('Private Inter-scan Comment')),
        app(218, scanHeader.payload),
        Buffer.from([1, 255, 0, 2, 255, 208, 3, 255, 217]),
      ]),
    );
    expect(output.includes(Buffer.from('Private'))).toBe(false);
    expect(output.subarray(-9)).toEqual(
      Buffer.from([1, 255, 0, 2, 255, 208, 3, 255, 217]),
    );
  });

  it.each(['private.png', 'animated.png'])(
    'preserves PNG pixels, ICC, alpha, and APNG controls in %s',
    async (name) => {
      const input = fixture(name),
        output = await sanitize(input);
      const before = pngChunks(input),
        after = pngChunks(output);
      expect(
        before.some((chunk) =>
          ['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(chunk.type),
        ),
      ).toBe(true);
      expect(
        after.some((chunk) =>
          ['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(chunk.type),
        ),
      ).toBe(false);
      for (const type of ['IHDR', 'IDAT', 'iCCP', 'acTL', 'fcTL', 'fdAT']) {
        expect(after.filter((chunk) => chunk.type === type)).toEqual(
          before.filter((chunk) => chunk.type === type),
        );
      }
    },
  );

  it.each(['private.webp', 'animated.webp'])(
    'preserves WebP pixels, ICC, alpha and animation in %s',
    async (name) => {
      const input = fixture(name),
        output = await sanitize(input);
      const before = webpChunks(input),
        after = webpChunks(output);
      expect(before.some((chunk) => chunk.type === 'EXIF')).toBe(true);
      expect(after.some((chunk) => ['EXIF', 'XMP '].includes(chunk.type))).toBe(
        false,
      );
      expect(
        after.find((chunk) => chunk.type === 'VP8X')!.payload[0] & 12,
      ).toBe(0);
      for (const type of ['VP8 ', 'VP8L', 'ICCP', 'ALPH', 'ANIM', 'ANMF']) {
        expect(after.filter((chunk) => chunk.type === type)).toEqual(
          before.filter((chunk) => chunk.type === type),
        );
      }
    },
  );

  it('retains only safe GIF controls, frames and loop count', async () => {
    const input = fixture('private.gif'),
      output = await sanitize(Buffer.concat([input, Buffer.from([0, 13, 10])]));
    expect(output.at(-1)).toBe(59);
    expect(output.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
    expect(output.includes(Buffer.from([3, 1, 3, 0, 0]))).toBe(true);
    expect(output.includes(Buffer.from('Private Comment'))).toBe(false);
    expect(output.length).toBe(input.length - 19);
  });

  it('erases AVIF private descriptors, strings and payload ranges while retaining ICC and alpha', async () => {
    const input = fixture('private.avif'),
      output = await sanitize(input);
    expect(output.length).toBe(input.length);
    expect(output.includes(Buffer.from('Exif'))).toBe(false);
    expect(output.includes(Buffer.from('application/rdf+xml'))).toBe(false);
    expect(output.includes(Buffer.from('Color\0'))).toBe(false);
    expect(
      output.includes(
        Buffer.from('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha'),
      ),
    ).toBe(true);
    const profileOffset = input.indexOf(Buffer.from('colrprof'));
    const profileSize = input.readUInt32BE(profileOffset - 4);
    expect(
      output.includes(
        input.subarray(profileOffset - 4, profileOffset - 4 + profileSize),
      ),
    ).toBe(true);
    // Retained AV1 payloads remain at their original absolute iloc addresses.
    const iloc = input.indexOf(Buffer.from('iloc')) + 4;
    const count = input.readUInt16BE(iloc + 6);
    for (let index = 0; index < count; index++) {
      const entry = iloc + 8 + index * 14;
      const id = input.readUInt16BE(entry),
        offset = input.readUInt32BE(entry + 6),
        size = input.readUInt32BE(entry + 10);
      if (id <= 2)
        expect(output.subarray(offset, offset + size)).toEqual(
          input.subarray(offset, offset + size),
        );
      else
        expect(output.subarray(offset, offset + size)).toEqual(
          Buffer.alloc(size),
        );
    }
  });

  it('rejects malformed EXIF, conflicting orientations and forged PNG lengths/CRCs', async () => {
    const jpeg = await sanitize(fixture('orientation-1.jpg'));
    await expect(
      sanitize(
        Buffer.concat([
          jpeg.subarray(0, 2),
          app(225, Buffer.from('Exif\0\0invalid')),
          jpeg.subarray(2),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    const a = jpegSegments(fixture('orientation-2.jpg')).find(
      (entry) => entry.marker === 225,
    )!;
    const b = jpegSegments(fixture('orientation-3.jpg')).find(
      (entry) => entry.marker === 225,
    )!;
    await expect(
      sanitize(
        Buffer.concat([
          jpeg.subarray(0, 2),
          app(225, a.payload),
          app(225, b.payload),
          jpeg.subarray(2),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'METADATA_STRIPPING_UNSUPPORTED' });
    const png = fixture('private.png');
    const forged = Buffer.from(png);
    forged.writeUInt32BE(0x7f_ff_ff_ff, 8);
    await expect(sanitize(forged)).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    });
    const corrupt = Buffer.from(png);
    corrupt[29] ^= 1;
    await expect(sanitize(corrupt)).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    });
  });

  it('discards oversized compressed/text metadata without decompressing or buffering it', async () => {
    const base = fixture('clean.png');
    const privateChunk = pngChunk('zTXt', Buffer.alloc(2 * 1024 * 1024, 65));
    expect(
      await sanitize(
        Buffer.concat([
          base.subarray(0, -12),
          privateChunk,
          base.subarray(-12),
        ]),
        65_536,
      ),
    ).toEqual(base);
  });

  it('rejects every truncated fixture and unsupported animated AVIF brands', async () => {
    for (const name of [
      'private.png',
      'private.webp',
      'private.gif',
      'private.avif',
      'orientation-8.jpg',
    ]) {
      const bytes = fixture(name);
      await expect(sanitize(bytes.subarray(0, -1))).rejects.toBeDefined();
    }
    const animated = Buffer.from(fixture('private.avif'));
    animated.write('avis', 8);
    await expect(sanitize(animated)).rejects.toMatchObject({
      code: 'METADATA_STRIPPING_UNSUPPORTED',
    });
  });
});
