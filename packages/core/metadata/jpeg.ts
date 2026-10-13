/* eslint-disable unicorn/no-await-expression-member, unicorn/no-break-in-nested-loop, unicorn/prefer-simple-condition-first -- Container dispatch follows binary field order and stream boundaries. */
import type { ImageReader } from './binary';
import {
  ascii,
  invalid,
  join,
  minimalExif,
  orientationState,
  text,
  unsupported,
  view,
} from './binary';

function segment(marker: number, payload: Uint8Array) {
  const header = new Uint8Array([255, marker, 0, 0]);
  view(header).setUint16(2, payload.length + 2);
  return join(header, payload);
}

const codingMarkers = new Set([
  192, 193, 194, 195, 196, 197, 198, 199, 201, 202, 203, 204, 205, 206, 207,
  218, 219, 221,
]);

export async function* stripJpeg(reader: ImageReader) {
  yield await reader.read(2);
  const readOrientation = orientationState();
  let marker: number | undefined;
  let scans = 0;
  let oriented = false;
  let iccBytes = 0;
  const profiles = new Set<number>();
  let profileCount: number | undefined;
  let segments = 0;
  while (true) {
    if (++segments > 65_536) unsupported();
    if (marker === undefined) {
      if ((await reader.read(1))[0] !== 255) invalid();
      let padding = 0;
      do {
        if (++padding > 4096) invalid();
        marker = (await reader.read(1))[0];
      } while (marker === 255);
    }
    if (marker === 217) {
      if (
        !scans ||
        (profileCount !== undefined && profiles.size !== profileCount)
      )
        invalid();
      yield new Uint8Array([255, 217]);
      await reader.end();
      return;
    }
    if (marker === 0 || marker === 216 || (marker >= 208 && marker <= 215))
      invalid();
    if (marker === 1) {
      yield new Uint8Array([255, 1]);
      marker = undefined;
      continue;
    }
    const length = view(await reader.read(2)).getUint16(0);
    if (length < 2) invalid();
    const payload = await reader.read(length - 2);
    if (marker === 225 && text(payload.subarray(0, 6)) === 'Exif\0\0') {
      const value = readOrientation(payload);
      if (value !== 1 && !oriented) {
        yield segment(225, join(ascii('Exif\0\0'), minimalExif(value)));
        oriented = true;
      }
    } else if (marker === 224 && text(payload.subarray(0, 5)) === 'JFIF\0') {
      if (
        payload.length < 14 ||
        payload.length !== 14 + 3 * payload[12] * payload[13]
      )
        invalid();
      const jfif = payload.slice(0, 14);
      jfif[12] = jfif[13] = 0;
      yield segment(marker, jfif);
    } else if (
      marker === 226 &&
      text(payload.subarray(0, 12)) === 'ICC_PROFILE\0'
    ) {
      if (
        payload.length < 14 ||
        !payload[12] ||
        payload[12] > payload[13] ||
        profiles.has(payload[12]) ||
        (profileCount !== undefined && profileCount !== payload[13])
      )
        invalid();
      iccBytes += payload.length;
      if (iccBytes > 1_048_576) unsupported();
      profiles.add(payload[12]);
      profileCount = payload[13];
      yield segment(marker, payload);
    } else if (marker === 238 && text(payload.subarray(0, 5)) === 'Adobe') {
      if (payload.length !== 12) unsupported();
      yield segment(marker, payload);
    } else if (
      (marker === 226 && text(payload.subarray(0, 4)) === 'MPF\0') ||
      (marker === 232 && text(payload.subarray(0, 5)) === 'SPIFF') ||
      (marker === 235 && text(payload.subarray(0, 2)) === 'JP')
    ) {
      unsupported();
    } else if (!(marker >= 224 && marker <= 239) && marker !== 254) {
      if (!codingMarkers.has(marker)) unsupported();
      yield segment(marker, payload);
    }
    if (marker !== 218) {
      marker = undefined;
      continue;
    }
    scans++;
    // Scan compressed bytes without decoding; stuffed FF and restart markers are data.
    while (true) {
      const chunk = await reader.take();
      if (!chunk) invalid();
      let index = chunk.indexOf(255);
      while (
        index !== -1 &&
        index + 1 < chunk.length &&
        (chunk[index + 1] === 0 ||
          (chunk[index + 1] >= 208 && chunk[index + 1] <= 215))
      ) {
        index = chunk.indexOf(255, index + 2);
      }
      if (index === -1) {
        yield chunk;
        continue;
      }
      if (index) yield chunk.subarray(0, index);
      reader.unread(chunk.subarray(index));
      const pair = await reader.read(2);
      if (pair[1] === 0 || (pair[1] >= 208 && pair[1] <= 215)) {
        yield pair;
        continue;
      }
      marker = pair[1];
      let padding = 0;
      while (marker === 255) {
        if (++padding > 4096) invalid();
        marker = (await reader.read(1))[0];
      }
      break;
    }
  }
}
