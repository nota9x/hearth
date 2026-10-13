import {
  availableDeliveryDomains,
  deliveryDomainPage,
  primaryDeliveryDomain,
  selectDeliveryDomain,
} from '@hearth/core/delivery-domains';
import { hasBootstrapSetup } from '@hearth/core/onboarding';
import { redirect, type ServerLoad } from '@sveltejs/kit';

export const load = (async ({ locals, url, depends }) => {
  depends('app:onboarding');
  const user = locals.user;
  if (!user) redirect(303, '/login');
  const bootstrap = hasBootstrapSetup(user);
  const revisit = url.searchParams.get('revisit') === '1';
  const [available, primaryDomain, selection, setup] = await Promise.all([
    availableDeliveryDomains(locals.env.DB, user.id),
    primaryDeliveryDomain(locals.env.DB),
    selectDeliveryDomain(locals.env.DB, user.id),
    bootstrap
      ? deliveryDomainPage(locals.env.DB, user, url.searchParams)
      : null,
  ]);
  return {
    user,
    available,
    primaryDomain,
    selection,
    bootstrap,
    setupDomains: setup?.domains ?? [],
    setupPagination: setup?.pagination ?? null,
    revisit: revisit || user.onboardingStatus !== 'pending',
    startStep: revisit
      ? 0
      : user.onboardingStatus === 'pending'
        ? !bootstrap && user.onboardingStep === 1
          ? 2
          : user.onboardingStep
        : user.onboardingStatus === 'completed'
          ? 7
          : 0,
  };
}) satisfies ServerLoad;
