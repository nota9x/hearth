import { afterEach, describe, expect, it, vi } from 'vitest';

import { action } from '../../apps/web/src/lib/client';

afterEach(() => vi.restoreAllMocks());

describe('dashboard action responses', () => {
  it('preserves the server explanation for a rejected origin', async () => {
    const message = 'Open http://127.0.0.1:5173 and try again.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { error: { code: 'INVALID_ORIGIN', message } },
        { status: 403 },
      ),
    );
    await expect(action('login')).rejects.toThrow(message);
  });

  it('distinguishes expired sessions from invalid configuration keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { error: { code: 'INVALID_KEY', message: 'The API key is invalid.' } },
        { status: 401 },
      ),
    );
    await expect(action('sxcu')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_KEY',
    });
  });
});
