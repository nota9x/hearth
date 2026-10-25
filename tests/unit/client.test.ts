import { afterAll, expect, it, vi } from 'vitest';

import { action, pendingActions } from '../../apps/web/src/lib/client';

let pending = 0;
const unsubscribe = pendingActions.subscribe((count) => (pending = count));
afterAll(unsubscribe);

it('keeps reload blocked until overlapping requests finish, including failures', async () => {
  const { promise: first, resolve: complete } =
    Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'INVALID_KEY', message: 'Use your current key.' } },
          { status: 401 },
        ),
      ),
  );
  const active = action('preferences');
  expect(pending).toBe(1);
  await expect(action('sxcu')).rejects.toMatchObject({
    status: 401,
    code: 'INVALID_KEY',
    message: 'Use your current key.',
  });
  expect(pending).toBe(1);
  complete(Response.json({ saved: true }));
  await expect(active).resolves.toEqual({ saved: true });
  expect(pending).toBe(0);
});

it('releases the reload guard after a network or response-decoding failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Disconnected'))
      .mockResolvedValueOnce(new Response('invalid JSON')),
  );
  await expect(action('preferences')).rejects.toThrow('Disconnected');
  expect(pending).toBe(0);
  await expect(action('preferences')).rejects.toThrow('unexpected response');
  expect(pending).toBe(0);
});
