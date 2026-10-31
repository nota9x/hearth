import { timingSafeEqual } from 'node:crypto';

import { AppError, id } from './common.ts';
import { digest } from './digest.ts';

export function randomSecret(size = 32) {
  return crypto.getRandomValues(new Uint8Array(size)).toHex();
}
export async function verify(value: string, expected: string, purpose: string) {
  const actual = await digest(value, purpose);
  const a = new TextEncoder().encode(actual),
    b = new TextEncoder().encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function newKey() {
  const keyId = id('key').slice(4);
  const plaintext = `img_live_${keyId}_${randomSecret()}`;
  return { keyId, plaintext, secretHash: await digest(plaintext, 'api-key') };
}
export function parseKey(key: string) {
  const match = /^img_live_([a-f0-9]{32})_([a-f0-9]{64})$/.exec(key);
  if (!match) throw new AppError(401, 'INVALID_KEY', 'The API key is invalid.');
  return match[1];
}
