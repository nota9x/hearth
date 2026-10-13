import { AppError } from '../common';

export const metadataLimit = 1_048_576;
export const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export const ascii = (value: string) => new TextEncoder().encode(value);
export const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function invalid(): never {
  throw new AppError(
    400,
    'INVALID_FILE_TYPE',
    'The image is malformed or truncated.',
  );
}
export function unsupported(): never {
  throw new AppError(
    422,
    'METADATA_STRIPPING_UNSUPPORTED',
    'This image layout cannot be safely stripped of metadata. Use another image format or disable Strip image metadata in Settings.',
  );
}
export function join(...parts: Uint8Array[]) {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export class ImageReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private pending: Uint8Array[] = [];
  offset = 0;
  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  unread(bytes: Uint8Array) {
    if (bytes.length === 0) {
      return;
    }

    this.pending.unshift(bytes);
    this.offset -= bytes.length;
  }
  async take(maximum = 65_536): Promise<Uint8Array | undefined> {
    while (this.pending.length === 0) {
      const next = await this.iterator.next();
      if (next.done) return;
      if (!(next.value instanceof Uint8Array)) invalid();
      if (next.value.length > 0) this.pending.push(next.value);
    }
    const bytes = this.pending.shift()!;
    const output = bytes.subarray(0, maximum);
    if (output.length < bytes.length)
      this.pending.unshift(bytes.subarray(output.length));
    this.offset += output.length;
    return output;
  }
  async *pieces(length: number): AsyncGenerator<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) invalid();
    while (length) {
      const chunk = await this.take(Math.min(length, 65_536));
      if (!chunk) invalid();
      length -= chunk.length;
      yield chunk;
    }
  }
  async read(length: number) {
    if (length > metadataLimit) unsupported();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for await (const chunk of this.pieces(length)) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async skip(length: number) {
    for await (const chunk of this.pieces(length)) void chunk;
  }
  async end() {
    if (await this.take()) invalid();
  }
}

export function orientation(bytes: Uint8Array) {
  if (text(bytes.subarray(0, 6)) === 'Exif\0\0') bytes = bytes.subarray(6);
  if (bytes.length < 8) invalid();
  const little = text(bytes.subarray(0, 2)) === 'II';
  if (!little && text(bytes.subarray(0, 2)) !== 'MM') invalid();
  const data = view(bytes);
  if (data.getUint16(2, little) !== 42) invalid();
  const offset = data.getUint32(4, little);
  if (offset < 8 || offset + 2 > bytes.length) invalid();
  const count = data.getUint16(offset, little);
  if (count > 4096 || offset + 2 + count * 12 + 4 > bytes.length) invalid();
  let result = 1;
  let found = false;
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    if (data.getUint16(entry, little) !== 0x1_12) continue;
    const value = data.getUint16(entry + 8, little);
    if (
      data.getUint16(entry + 2, little) !== 3 ||
      data.getUint32(entry + 4, little) !== 1 ||
      value < 1 ||
      value > 8 ||
      (found && value !== result)
    )
      unsupported();
    found = true;
    result = value;
  }
  return result;
}

export function minimalExif(value: number) {
  const bytes = new Uint8Array(26);
  bytes.set(ascii('II'));
  const data = view(bytes);
  data.setUint16(2, 42, true);
  data.setUint32(4, 8, true);
  data.setUint16(8, 1, true);
  data.setUint16(10, 0x1_12, true);
  data.setUint16(12, 3, true);
  data.setUint32(14, 1, true);
  data.setUint16(18, value, true);
  return bytes;
}

export function orientationState() {
  let saved: number | undefined;
  return (bytes: Uint8Array) => {
    const value = orientation(bytes);
    if (saved !== undefined && saved !== value) unsupported();
    saved = value;
    return value;
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let index = 0; index < 8; index++)
    value = (value >>> 1) ^ (value & 1 ? 0xed_b8_83_20 : 0);
  return value >>> 0;
});
export function crc32(bytes: Uint8Array, state = 0xff_ff_ff_ff) {
  for (const byte of bytes)
    state = crcTable[(state ^ byte) & 255] ^ (state >>> 8);
  return state >>> 0;
}
