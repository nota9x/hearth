import { load as loadDashboard } from '#lib/server/dashboard.ts';

import type { PageServerLoad } from './$types';

export const load = ((event) =>
  loadDashboard({
    ...event,
    params: { path: 'admin/settings' },
  })) satisfies PageServerLoad;
