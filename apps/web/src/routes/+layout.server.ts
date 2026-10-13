import { getInstanceName } from '@hearth/core/branding';
import { resolveExpiryPolicy } from '@hearth/core/expiry-policy';
import { getInstanceExpiryPolicy } from '@hearth/core/expiry-policy-store';

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
  depends('app:dashboard');
  const siteName = await getInstanceName(locals.env.DB);
  locals.siteName = siteName;
  const instanceExpiryPolicy = await getInstanceExpiryPolicy(locals.env.DB);
  return {
    user: locals.user,
    siteName,
    siteKey: locals.env.TURNSTILE_SITE_KEY,
    appOrigin: locals.env.APP_ORIGIN,
    instanceExpiryPolicy,
    expiryPolicy: locals.user
      ? resolveExpiryPolicy(instanceExpiryPolicy, locals.user)
      : null,
  };
};
