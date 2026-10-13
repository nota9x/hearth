function dimensions(width: number, height: number) {
  if (!width || !height || width * height > 100_000_000)
    throw new Error('Invalid GIF dimensions');
}

// GIF is a block stream: 0x3b is a trailer only at a block boundary, not
// necessarily the last file byte. Keep at most one small block in memory.
// Like the other format checks, this validates structure, not LZW decoding.
export function createGifValidator(options?: {
  stripMetadata?: boolean;
  emit?: (bytes: Uint8Array) => void;
}) {
  let complete = false;
  let invalid = false;
  const word = (bytes: Uint8Array, offset: number) =>
    bytes[offset] | (bytes[offset + 1] << 8);
  type Block = { length: number; keep: boolean };
  const keep = (length: number): Block => ({ length, keep: true });
  const discard = (length: number): Block => ({ length, keep: false });
  const emit = (bytes: Uint8Array) => options?.emit?.(bytes);
  function* blocks(): Generator<Block, void, Uint8Array> {
    const signature = new TextDecoder().decode(yield keep(6));
    if (signature !== 'GIF87a' && signature !== 'GIF89a') return;
    const screen = yield keep(7);
    const width = word(screen, 0),
      height = word(screen, 2);
    dimensions(width, height);
    const globalTable = !!(screen[4] & 128);
    if (globalTable) yield keep(3 * (1 << ((screen[4] & 7) + 1)));
    let frames = 0;
    while (true) {
      const marker = (yield discard(1))[0];
      if (marker === 59) {
        if (!frames) throw new Error('GIF has no image');
        complete = true;
        emit(new Uint8Array([59]));
        return;
      }
      if (marker === 44) {
        emit(new Uint8Array([44]));
        const frame = yield keep(9);
        const frameWidth = word(frame, 4),
          frameHeight = word(frame, 6);
        dimensions(frameWidth, frameHeight);
        if (
          word(frame, 0) + frameWidth > width ||
          word(frame, 2) + frameHeight > height
        )
          throw new Error('GIF frame exceeds canvas');
        const localTable = !!(frame[8] & 128);
        if (!globalTable && !localTable) throw new Error('Missing GIF palette');
        if (localTable) yield keep(3 * (1 << ((frame[8] & 7) + 1)));
        const codeSize = (yield keep(1))[0];
        if (codeSize < 2 || codeSize > 8)
          throw new Error('Invalid GIF code size');
        let bytes = 0;
        let size = (yield keep(1))[0];
        while (size) {
          yield keep(size);
          bytes += size;
          size = (yield keep(1))[0];
        }
        if (!bytes) throw new Error('Empty GIF frame');
        frames++;
      } else if (marker === 33) {
        const label = (yield discard(1))[0];
        let size = (yield discard(1))[0];
        const fixedSize =
          label === 249 ? 4 : label === 255 ? 11 : label === 1 ? 12 : undefined;
        if (fixedSize !== undefined && size !== fixedSize)
          throw new Error('Invalid GIF extension');
        let retain = !options?.stripMetadata || label === 249 || label === 1;
        let loop = false;
        if (label === 255) {
          const app = yield discard(size);
          const name = new TextDecoder().decode(app);
          loop =
            options?.stripMetadata === true &&
            ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(name);
          retain = !options?.stripMetadata || name === 'ICCRGBG1012';
          if (retain || loop) emit(new Uint8Array([33, label, size, ...app]));
          size = (yield discard(1))[0];
        } else if (retain) emit(new Uint8Array([33, label]));
        let loopWritten = false;
        while (size) {
          if (retain) emit(new Uint8Array([size]));
          const data = yield retain ? keep(size) : discard(size);
          if (loop && size === 3 && data[0] === 1) {
            if (loopWritten) throw new Error('Duplicate GIF loop control');
            emit(new Uint8Array([3, ...data]));
            loopWritten = true;
          }
          size = (yield discard(1))[0];
          if (label === 249 && size)
            throw new Error('Invalid GIF control terminator');
        }
        if (loop && !loopWritten) throw new Error('Invalid GIF loop control');
        if (retain || loop) emit(new Uint8Array([0]));
      } else throw new Error('Invalid GIF block');
    }
  }
  const parser = blocks();
  let next = parser.next();
  const buffer = new Uint8Array(768);
  let buffered = 0;
  return {
    write(chunk: Uint8Array) {
      if (invalid) return;
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (next.done) {
            // Allow only inert encoder padding after the parsed trailer.
            if (complete)
              for (const byte of chunk.subarray(offset))
                if (![0, 9, 10, 13, 32].includes(byte))
                  throw new Error('Data after GIF trailer');
            return;
          }
          const length = Math.min(
            next.value.length - buffered,
            chunk.length - offset,
          );
          buffer.set(chunk.subarray(offset, offset + length), buffered);
          buffered += length;
          offset += length;
          if (buffered !== next.value.length) {
            continue;
          }

          if (next.value.keep) emit(buffer.slice(0, buffered));
          next = parser.next(buffer.subarray(0, buffered));
          buffered = 0;
        }
      } catch {
        invalid = true;
      }
    },
    finish() {
      if (invalid || !complete) throw new Error('Invalid or truncated GIF');
    },
  };
}
