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

  it.each([
    [403, 'Invalid request origin.'],
    [502, '<html>Bad gateway</html>'],
    [200, '<html>Login</html>'],
  ])('explains non-JSON responses with status %i', async (status, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status }),
    );
    await expect(action('login')).rejects.toThrow(
      'The server returned an unexpected response. Check the site address and try again.',
    );
  });

  it('returns successful action data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ setup: true }),
    );
    await expect(action('login')).resolves.toEqual({ setup: true });
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
