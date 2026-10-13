import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { z } from 'zod';

export async function configureDeliveryDomain(
  request: APIRequestContext,
  origin: string,
  hostname: string,
  primary = false,
) {
  const headers = { Origin: origin };
  const saved = await request.post('/api/actions/delivery-domain-save', {
    headers,
    data: { hostname, accessMode: 'everyone' },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const domain = z.object({ id: z.string() }).parse(await saved.json());
  const checked = await request.post('/api/actions/delivery-domain-validate', {
    headers,
    data: { id: domain.id },
  });
  expect(checked.status(), await checked.text()).toBe(200);
  const validated = z
    .object({ health: z.string(), revision: z.number() })
    .parse(await checked.json());
  expect(validated.health).toBe('active');
  if (primary) {
    const selected = await request.post(
      '/api/actions/delivery-domain-primary',
      { headers, data: { id: domain.id, revision: validated.revision } },
    );
    expect(selected.status(), await selected.text()).toBe(200);
  }
  return domain;
}
