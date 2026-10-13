import type { User } from '@hearth/core/db';
import type {
  EffectiveExpiryPolicy,
  ExpiryPolicy,
} from '@hearth/core/expiry-policy';
import { writable } from 'svelte/store';

import { invalidate } from '$app/navigation';

import { createRefresh } from './refresh';

const routeRefresh = { run: undefined as (() => Promise<void>) | undefined };
export const dashboardSnapshot = writable<{
  user: User | null;
  siteName: string;
  siteKey: string;
  appOrigin: string;
  instanceExpiryPolicy: ExpiryPolicy;
  expiryPolicy: EffectiveExpiryPolicy | null;
  hasUnseenImages: boolean;
} | null>(null);
export function setDashboardRefresh(refresh: () => Promise<void>) {
  routeRefresh.run = refresh;
  return () => {
    routeRefresh.run = undefined;
    dashboardSnapshot.set(null);
  };
}
export const dashboard = createRefresh(() =>
  routeRefresh.run ? routeRefresh.run() : invalidate('app:dashboard'),
);
