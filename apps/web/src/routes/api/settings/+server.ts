import { resolveExpiryPolicy } from '@hearth/core/expiry-policy';
import { getInstanceExpiryPolicy } from '@hearth/core/expiry-policy-store';

import { readDashboard } from '#lib/server/dashboard.ts';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
  const data = await readDashboard({
    locals,
    url,
    params: {
      path: url.searchParams.has('admin') ? 'admin/settings' : 'settings',
    },
  });
  const instanceExpiryPolicy = await getInstanceExpiryPolicy(locals.env.DB);
  return Response.json(
    {
      ...data,
      instanceExpiryPolicy,
      expiryPolicy: resolveExpiryPolicy(instanceExpiryPolicy, data.user),
      appOrigin: locals.env.APP_ORIGIN,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
