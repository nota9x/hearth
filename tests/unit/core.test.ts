import { describe, expect, it } from 'vitest';

import { hostnameSchema, slugSchema } from '../../packages/core/common';

describe('validation and authorization', () => {
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
