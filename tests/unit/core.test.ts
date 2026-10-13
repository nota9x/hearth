import { describe, expect, it } from 'vitest';

import { hostnameSchema, slugSchema } from '../../packages/core/common';
import { newKey } from '../../packages/core/crypto';
import { sharexConfig, sxcuSchema } from '../../packages/core/sharex';

describe('validation and authorization', () => {
  it('normalizes custom addresses and blocks unsafe or reserved names', () => {
    expect(slugSchema.parse(' Hello-world ')).toBe('hello-world');
    for (const s of ['../x', 'login', '<script>', 'a/b', 'a'.repeat(65)])
      expect(slugSchema.safeParse(s).success).toBe(false);
    for (const s of [
      'app',
      'admin',
      'https://x.com',
      '-hello.example.com',
      'hello-.example.com',
    ])
      expect(hostnameSchema.safeParse(s).success).toBe(false);
  });
});
describe('ShareX 21 uploader contract', () => {
  it('generates multipart bearer request and extracts both URLs and errors', async () => {
    const key = await newKey(),
      config = sharexConfig('https://app.example.com', key.plaintext);
    expect(sxcuSchema.safeParse(config).success).toBe(true);
    expect(config.DestinationType).toBe('ImageUploader, FileUploader');
    expect(config.Headers.Authorization).toBe(`Bearer ${key.plaintext}`);
    expect(config.RequestURL).toBe('https://app.example.com/api/v1/images');
    const response = {
      url: 'https://shots.example.com/a123',
      deleteUrl: 'https://app.example.com/delete/img_abc#secret',
      error: { message: 'Example failure' },
    };
    const extract = (expression: string) => {
      let value: unknown = response;
      const pathSegments = expression.slice(6, -1).split('.');
      for (const key of pathSegments) {
        value = Reflect.get(value as object, key);
      }
      return value;
    };
    expect(extract(config.URL)).toBe(response.url);
    expect(extract(config.DeletionURL)).toBe(response.deleteUrl);
    expect(extract(config.ErrorMessage)).toBe(response.error.message);
  });
});
