import { describe, expect, it, vi } from 'vitest';

import { hostnameSchema, slugSchema } from '../../packages/core/common';
import { randomSecret } from '../../packages/core/crypto';
import { digest } from '../../packages/core/digest';

describe('validation and authorization', () => {
  it('preserves canonical secrets and purpose-separated persisted digests', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockReturnValue(
      new Uint8Array([0, 1, 15, 16, 128, 255]),
    );
    expect(randomSecret(6)).toBe('00010f1080ff');
    expect(await digest('known-6', 'api-key')).toBe(
      '0640324e76ae405c280f856dd01e3c60cbb7507141c351c4d415f2190200797b',
    );
    expect(await digest('known-6', 'session')).not.toBe(
      await digest('known-6', 'api-key'),
    );
  });
  it('normalizes custom addresses and blocks unsafe or reserved names', () => {
    expect(slugSchema.parse(' Hello-world ')).toBe('hello-world');
    for (const s of ['../x', 'login', '<script>', 'a/b', 'a'.repeat(65)])
      expect(slugSchema.safeParse(s).success).toBe(false);
    for (const s of [
      'app',
      'admin',
      'https://x.com',
      '0x7f000001',
      'images.example.com\nattacker.com',
      '-hello.example.com',
      'hello-.example.com',
    ])
      expect(hostnameSchema.safeParse(s).success).toBe(false);
  });
});
