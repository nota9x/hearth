/* eslint-disable unicorn/no-break-in-nested-loop, unicorn/no-unreadable-for-of-expression, unicorn/prefer-simple-condition-first -- Container dispatch follows binary field order and stream boundaries. */
import type { ImageReader } from './binary';
import {
  ascii,
  invalid,
  join,
  orientation,
  text,
  unsupported,
  view,
} from './binary';

type Box = { type: string; bytes: Uint8Array; payload: Uint8Array };
const countLimit = 4096;
function boxes(bytes: Uint8Array): Box[] {
  const result: Box[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (result.length === countLimit || offset + 8 > bytes.length) invalid();
    const size = view(bytes).getUint32(offset);
    if (size < 8 || offset + size > bytes.length) unsupported();
    result.push({
      type: text(bytes.subarray(offset + 4, offset + 8)),
      bytes: bytes.subarray(offset, offset + size),
      payload: bytes.subarray(offset + 8, offset + size),
    });
    offset += size;
  }
  return result;
}
function box(type: string, payload: Uint8Array) {
  const header = new Uint8Array(8);
  view(header).setUint32(0, payload.length + 8);
  header.set(ascii(type), 4);
  return join(header, payload);
}
function number(bytes: Uint8Array, offset: number, size: number) {
  if (![0, 1, 2, 4, 8].includes(size) || offset + size > bytes.length)
    unsupported();
  let value = 0;
  for (let index = 0; index < size; index++)
    value = value * 256 + bytes[offset + index];
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}
function full(bytes: Uint8Array, versions: number[]) {
  if (
    bytes.length < 4 ||
    !versions.includes(bytes[0]) ||
    bytes[1] ||
    bytes[2] ||
    bytes[3]
  )
    unsupported();
}
function one(children: Box[], type: string) {
  const matches = children.filter((child) => child.type === type);
  if (matches.length !== 1) unsupported();
  return matches[0].payload;
}

function sanitizeIndex(payload: Uint8Array, originalSize: number) {
  type Extent = { start: number; length: number; id: number; kind: string };
  full(payload, [0]);
  const children = boxes(payload.subarray(4));
  if (
    children.some(
      (child) =>
        ![
          'hdlr',
          'pitm',
          'iinf',
          'iloc',
          'iprp',
          'iref',
          'free',
          'uuid',
        ].includes(child.type),
    )
  )
    unsupported();
  const handler = one(children, 'hdlr');
  full(handler, [0]);
  if (handler.length < 25 || text(handler.subarray(8, 12)) !== 'pict')
    unsupported();
  const cleanHandler = new Uint8Array(25);
  cleanHandler.set(ascii('pict'), 8);
  const primary = one(children, 'pitm');
  full(primary, [0, 1]);
  const primaryId = number(primary, 4, primary[0] === 0 ? 2 : 4);
  if (primary.length !== (primary[0] === 0 ? 6 : 8)) invalid();
  const info = one(children, 'iinf');
  full(info, [0, 1]);
  const countBytes = info[0] === 0 ? 2 : 4;
  const definitions = boxes(info.subarray(4 + countBytes));
  if (
    definitions.length > countLimit ||
    number(info, 4, countBytes) !== definitions.length
  )
    invalid();
  const items = new Map<number, string>();
  const cleanDefinitions: Uint8Array[] = [];
  for (const definition of definitions) {
    if (definition.type !== 'infe') unsupported();
    const entry = definition.payload;
    full(entry, [2, 3]);
    const idBytes = entry[0] === 2 ? 2 : 4;
    const itemId = number(entry, 4, idBytes);
    if (items.has(itemId) || number(entry, 4 + idBytes, 2)) invalid();
    const kind = text(entry.subarray(6 + idBytes, 10 + idBytes));
    if (!['av01', 'Exif', 'mime'].includes(kind)) unsupported();
    if (
      entry.length < 11 + idBytes ||
      !entry.subarray(10 + idBytes).includes(0)
    )
      invalid();
    items.set(itemId, kind);
    if (kind === 'av01')
      cleanDefinitions.push(
        box('infe', join(entry.subarray(0, 10 + idBytes), new Uint8Array(1))),
      );
  }
  const renderIds = [...items]
    .filter(([, kind]) => kind === 'av01')
    .map(([itemId]) => itemId);
  if (!renderIds.includes(primaryId) || renderIds.length > 2) unsupported();
  const cleanInfoHeader = info.slice(0, 4 + countBytes);
  if (countBytes === 2) view(cleanInfoHeader).setUint16(4, renderIds.length);
  else view(cleanInfoHeader).setUint32(4, renderIds.length);

  const locations = one(children, 'iloc');
  full(locations, [0, 1, 2]);
  const version = locations[0];
  const offsetSize = locations[4] >>> 4,
    lengthSize = locations[4] & 15;
  const baseSize = locations[5] >>> 4,
    indexSize = locations[5] & 15;
  if (
    ![0, 4, 8].includes(offsetSize) ||
    ![4, 8].includes(lengthSize) ||
    ![0, 4, 8].includes(baseSize) ||
    indexSize
  )
    unsupported();
  const idBytes = version === 2 ? 4 : 2;
  const locationCount = number(locations, 6, idBytes);
  if (locationCount !== items.size || locationCount > countLimit) invalid();
  const locationHeader = locations.slice(0, 6 + idBytes);
  if (idBytes === 2) view(locationHeader).setUint16(6, renderIds.length);
  else view(locationHeader).setUint32(6, renderIds.length);
  let cursor = locationHeader.length;
  const extents: Extent[] = [];
  const retainedLocations: Uint8Array[] = [];
  const located = new Set<number>();
  for (let index = 0; index < locationCount; index++) {
    const start = cursor;
    const itemId = number(locations, cursor, idBytes);
    cursor += idBytes;
    const kind = items.get(itemId);
    if (!kind || located.has(itemId)) invalid();
    located.add(itemId);
    if (version !== 0) {
      if (number(locations, cursor, 2)) unsupported();
      cursor += 2;
    }
    if (number(locations, cursor, 2)) unsupported();
    cursor += 2;
    const base = number(locations, cursor, baseSize);
    cursor += baseSize;
    const count = number(locations, cursor, 2);
    cursor += 2;
    // One contiguous extent allows OBU inspection without a media reconstruction buffer.
    if (count !== 1) unsupported();
    const extentStart = base + number(locations, cursor, offsetSize);
    cursor += offsetSize;
    const length = number(locations, cursor, lengthSize);
    cursor += lengthSize;
    if (!length || !Number.isSafeInteger(extentStart + length)) invalid();
    extents.push({ start: extentStart, length, id: itemId, kind });
    if (kind === 'av01')
      retainedLocations.push(locations.subarray(start, cursor));
  }
  if (cursor !== locations.length) invalid();
  extents.sort((a, b) => a.start - b.start);
  for (let index = 1; index < extents.length; index++) {
    if (
      extents[index].start <
      extents[index - 1].start + extents[index - 1].length
    )
      invalid();
  }

  const properties = boxes(one(children, 'iprp'));
  if (properties.length !== 2) unsupported();
  const propertyBoxes = boxes(one(properties, 'ipco'));
  const allowed = new Set([
    'ispe',
    'pixi',
    'av1C',
    'colr',
    'auxC',
    'irot',
    'imir',
    'clap',
    'pasp',
    'clli',
    'mdcv',
  ]);
  for (const property of propertyBoxes) {
    if (!allowed.has(property.type)) unsupported();
    const bytes = property.payload;
    switch (property.type) {
      case 'av1C': {
        if (bytes.length !== 4 || bytes[0] !== 0x81) unsupported();

        break;
      }
      case 'ispe': {
        full(bytes, [0]);
        if (
          bytes.length !== 12 ||
          !number(bytes, 4, 4) ||
          !number(bytes, 8, 4) ||
          number(bytes, 4, 4) * number(bytes, 8, 4) > 100_000_000
        )
          invalid();

        break;
      }
      case 'colr': {
        const colorType = text(bytes.subarray(0, 4));
        if (
          !['nclx', 'prof', 'rICC'].includes(colorType) ||
          (colorType === 'nclx' && bytes.length !== 11)
        )
          unsupported();

        break;
      }
      case 'auxC': {
        full(bytes, [0]);
        if (
          text(bytes.subarray(4)) !==
          'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0'
        )
          unsupported();

        break;
      }
      case 'irot':
      case 'imir': {
        if (bytes.length !== 1 || bytes[0] > (property.type === 'irot' ? 3 : 1))
          invalid();

        break;
      }
      case 'clap': {
        if (bytes.length !== 32) invalid();
        for (const denominator of [4, 12, 20, 28])
          if (!number(bytes, denominator, 4)) invalid();

        break;
      }
      case 'pasp': {
        if (bytes.length !== 8 || !number(bytes, 0, 4) || !number(bytes, 4, 4))
          invalid();

        break;
      }
      case 'pixi': {
        full(bytes, [0]);
        if (!bytes[4] || bytes.length !== 5 + bytes[4]) invalid();

        break;
      }
      default: {
        if (bytes.length !== (property.type === 'clli' ? 4 : 24)) invalid();
      }
    }
  }
  const associations = one(properties, 'ipma');
  if (
    associations.length < 8 ||
    ![0, 1].includes(associations[0]) ||
    associations[1] ||
    associations[2] ||
    associations[3] > 1
  )
    unsupported();
  const associationCount = number(associations, 4, 4);
  if (associationCount > countLimit) unsupported();
  cursor = 8;
  const retainedAssociations: Uint8Array[] = [];
  const associated = new Set<number>();
  const orientations = new Set<number>();
  const alphaIds = new Set<number>();
  for (let index = 0; index < associationCount; index++) {
    const start = cursor;
    const associationIdBytes = associations[0] === 0 ? 2 : 4;
    const itemId = number(associations, cursor, associationIdBytes);
    cursor += associationIdBytes;
    if (
      !items.has(itemId) ||
      associated.has(itemId) ||
      cursor >= associations.length
    )
      invalid();
    associated.add(itemId);
    const count = associations[cursor++];
    const types = new Set<string>();
    for (let index = 0; index < count; index++) {
      const size = associations[3] === 1 ? 2 : 1;
      const index =
        number(associations, cursor, size) & (size === 1 ? 127 : 32_767);
      cursor += size;
      if (!index) continue;
      const property = propertyBoxes[index - 1];
      if (!property) invalid();
      const propertyType =
        property.type === 'colr'
          ? `colr:${text(property.payload.subarray(0, 4))}`
          : property.type;
      if (types.has(propertyType)) invalid();
      types.add(propertyType);
      if (['irot', 'imir'].includes(property.type)) orientations.add(itemId);
      if (property.type === 'auxC') alphaIds.add(itemId);
    }
    if (items.get(itemId) !== 'av01') {
      continue;
    }

    if (['av1C', 'ispe', 'pixi'].some((type) => !types.has(type)))
      unsupported();
    retainedAssociations.push(associations.subarray(start, cursor));
  }
  if (
    cursor !== associations.length ||
    renderIds.some((itemId) => !associated.has(itemId))
  )
    invalid();
  const associationHeader = associations.slice(0, 8);
  view(associationHeader).setUint32(4, retainedAssociations.length);

  const references = children.filter((child) => child.type === 'iref');
  if (references.length > 1) invalid();
  let cleanReferences: Uint8Array | undefined;
  let alphaReferenced = false;
  if (references.length > 0) {
    const reference = references[0].payload;
    full(reference, [0, 1]);
    const size = reference[0] === 0 ? 2 : 4;
    const retained: Uint8Array[] = [];
    for (const relation of boxes(reference.subarray(4))) {
      const from = number(relation.payload, 0, size);
      const count = number(relation.payload, size, 2);
      if (
        !items.has(from) ||
        !count ||
        count > countLimit ||
        relation.payload.length !== size + 2 + count * size
      )
        invalid();
      const targets = Array.from({ length: count }, (_, index) =>
        number(relation.payload, size + 2 + index * size, size),
      );
      if (targets.some((itemId) => !items.has(itemId))) invalid();
      if (items.get(from) !== 'av01') {
        if (
          relation.type !== 'cdsc' ||
          targets.some((itemId) => items.get(itemId) !== 'av01')
        )
          unsupported();
        continue;
      }
      if (
        relation.type !== 'auxl' ||
        from === primaryId ||
        count !== 1 ||
        targets[0] !== primaryId ||
        !alphaIds.has(from) ||
        alphaReferenced
      )
        unsupported();
      alphaReferenced = true;
      retained.push(relation.bytes);
    }
    if (retained.length > 0)
      cleanReferences = box(
        'iref',
        join(reference.subarray(0, 4), ...retained),
      );
  }
  if ((renderIds.length === 2) !== alphaReferenced || alphaIds.has(primaryId))
    unsupported();
  // Only properties referenced by retained images may survive (including ICC profiles).
  const used = new Set<number>();
  for (const entry of retainedAssociations) {
    const size = associations[3] === 1 ? 2 : 1;
    const idSize = associations[0] === 0 ? 2 : 4;
    for (let p = idSize + 1; p < entry.length; p += size)
      used.add(number(entry, p, size) & (size === 1 ? 127 : 32_767));
  }
  if (propertyBoxes.some((_, index) => !used.has(index + 1))) unsupported();
  const cleanProperties = box(
    'iprp',
    join(
      box('ipco', join(...propertyBoxes.map((property) => property.bytes))),
      box('ipma', join(associationHeader, ...retainedAssociations)),
    ),
  );
  const indexParts = [
    box('hdlr', cleanHandler),
    box('pitm', primary),
    box('iinf', join(cleanInfoHeader, ...cleanDefinitions)),
    box('iloc', join(locationHeader, ...retainedLocations)),
    cleanProperties,
    ...(cleanReferences ? [cleanReferences] : []),
  ];
  let clean = box('meta', join(new Uint8Array(4), ...indexParts));
  const spare = originalSize - clean.length;
  if (spare < 0) unsupported();
  if (spare >= 8) clean = join(clean, box('free', new Uint8Array(spare - 8)));
  else if (spare) {
    indexParts[0] = box('hdlr', join(cleanHandler, new Uint8Array(spare)));
    clean = box('meta', join(new Uint8Array(4), ...indexParts));
  }
  return { clean, extents, nativeOrientation: orientations.has(primaryId) };
}

async function* av1(reader: ImageReader, length: number) {
  const end = reader.offset + length;
  let count = 0;
  while (reader.offset < end) {
    if (++count > 65_536) unsupported();
    const header = await reader.read(1);
    const type = (header[0] >>> 3) & 15;
    if (
      header[0] & 0x81 ||
      !(header[0] & 2) ||
      ![1, 2, 3, 4, 5, 6, 7, 8, 15].includes(type)
    )
      unsupported();
    const prefix = [header];
    if (header[0] & 4) {
      const extension = await reader.read(1);
      if (extension[0] & 7) invalid();
      prefix.push(extension);
    }
    let size = 0,
      scale = 1,
      done = false;
    for (let index = 0; index < 8; index++) {
      const byte = await reader.read(1);
      prefix.push(byte);
      size += (byte[0] & 127) * scale;
      scale *= 128;
      if (!(byte[0] & 128)) {
        done = true;
        break;
      }
    }
    if (!done || !Number.isSafeInteger(size) || reader.offset + size > end)
      invalid();
    if (type === 5) {
      const data = await reader.read(size);
      // Only fixed HDR metadata is needed for still-image rendering.
      if (!((data[0] === 1 && size === 6) || (data[0] === 2 && size === 26)))
        unsupported();
      yield join(...prefix, data);
    } else {
      yield join(...prefix);
      for await (const chunk of reader.pieces(size))
        yield type === 15 ? new Uint8Array(chunk.length) : chunk;
    }
  }
}

export async function* stripAvif(reader: ImageReader) {
  let index: ReturnType<typeof sanitizeIndex> | undefined;
  let media = false;
  let first = true;
  const consumed = new Set<number>();
  let count = 0;
  while (true) {
    const leading = await reader.take(8);
    if (!leading) break;
    reader.unread(leading);
    if (++count > countLimit) unsupported();
    const header = await reader.read(8);
    const size = view(header).getUint32(0),
      type = text(header.subarray(4));
    if (size < 8) unsupported();
    if (first && type !== 'ftyp') invalid();
    first = false;
    switch (type) {
      case 'ftyp': {
        if (reader.offset !== 8 || size < 16 || size > 256 || size % 4)
          unsupported();
        const brands = await reader.read(size - 8);
        const names = [text(brands.subarray(0, 4))];
        for (let p = 8; p < brands.length; p += 4)
          names.push(text(brands.subarray(p, p + 4)));
        if (!names.includes('avif') || names.includes('avis')) unsupported();
        yield join(header, brands);

        break;
      }
      case 'meta': {
        if (index || media || size > 524_288) unsupported();
        index = sanitizeIndex(await reader.read(size - 8), size);
        yield index.clean;

        break;
      }
      case 'mdat': {
        if (!index || media) unsupported();
        media = true;
        const end = reader.offset + size - 8;
        if (
          index.extents.some(
            (extent) =>
              extent.start < reader.offset ||
              extent.start + extent.length > end,
          )
        )
          invalid();
        yield header;
        for (const extent of index.extents) {
          for await (const chunk of reader.pieces(extent.start - reader.offset))
            yield new Uint8Array(chunk.length);
          if (extent.kind === 'av01') yield* av1(reader, extent.length);
          else if (extent.kind === 'Exif') {
            const data = await reader.read(extent.length);
            if (data.length < 12) invalid();
            const offset = number(data, 0, 4) + 4;
            if (offset + 8 > data.length) invalid();
            if (
              orientation(data.subarray(offset)) !== 1 &&
              !index.nativeOrientation
            )
              unsupported();
            yield new Uint8Array(data.length);
          } else
            for await (const chunk of reader.pieces(extent.length))
              yield new Uint8Array(chunk.length);
          consumed.add(extent.id);
        }
        for await (const chunk of reader.pieces(end - reader.offset))
          yield new Uint8Array(chunk.length);

        break;
      }
      default: {
        if (['free', 'skip', 'uuid', 'udta'].includes(type)) {
          header.set(ascii('free'), 4);
          yield header;
          for await (const chunk of reader.pieces(size - 8))
            yield new Uint8Array(chunk.length);
        } else unsupported();
      }
    }
  }
  if (!media || !index || consumed.size !== index.extents.length) invalid();
}
