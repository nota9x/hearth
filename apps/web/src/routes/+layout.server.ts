import { getInstanceName } from '@hearth/core/branding';
import {
  displayNameChangesRestricted,
  getDisplayNameRestriction,
} from '@hearth/core/display-name-policy';
import { resolveExpiryPolicy } from '@hearth/core/expiry-policy';
import { getInstanceExpiryPolicy } from '@hearth/core/expiry-policy-store';

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
  depends('app:dashboard');
  const [siteName, instanceExpiryPolicy, restrictDisplayNameChanges] =
    await Promise.all([
      getInstanceName(locals.env.DB),
      getInstanceExpiryPolicy(locals.env.DB),
      getDisplayNameRestriction(locals.env.DB),
    ]);
  locals.siteName = siteName;
  return {
    restrictDisplayNameChanges,
    displayNameRestricted:
      !!locals.user &&
      displayNameChangesRestricted(restrictDisplayNameChanges, locals.user),
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
