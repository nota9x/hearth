import { afterAll, afterEach, expect, it, vi } from 'vitest';

import { action, pendingActions } from '../../apps/web/src/lib/client';

let pending = 0;
const unsubscribe = pendingActions.subscribe((count) => (pending = count));
afterAll(unsubscribe);
afterEach(() => vi.unstubAllGlobals());

it('keeps reload blocked until overlapping requests finish, including failures', async () => {
  let complete!: (response: Response) => void;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The project targets ES2022.
  const first = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(
        Response.json({ error: { message: 'Rejected' } }, { status: 403 }),
      ),
  );
  const active = action('preferences');
  expect(pending).toBe(1);
  await expect(action('preferences')).rejects.toThrow('Rejected');
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
