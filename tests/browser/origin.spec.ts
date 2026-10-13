import { expect, test } from '../helpers/browser';

test('login from the delivery hostname gets a useful JSON error', async ({
  request,
  baseURL,
}) => {
  const response = await request.post('/api/actions/login', {
    // Reproduce the HTTP origin used by the local delivery hostname.
    // eslint-disable-next-line unicorn/prefer-https
    headers: { Origin: 'http://shots.localhost:5173' },
    data: {},
  });
  expect(response.status()).toBe(403);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['set-cookie']).toBeUndefined();
  expect(await response.json()).toEqual({
    error: {
      code: 'INVALID_ORIGIN',
      message: `Open ${baseURL} and try again. This address cannot submit dashboard requests.`,
    },
  });
});
