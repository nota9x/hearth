/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed browser API responses. */
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { expect, signIn, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test('Domains manages validation, primary selection, diagnostics, search and deletion paging', async ({
  hearth,
  proxy,
  page,
  request,
  baseURL,
  browser,
}) => {
  test.setTimeout(180_000);
  const key = await signIn(page, request, baseURL!);
  const headers = { Origin: baseURL! };
  const errors: string[] = [];
  page.on('pageerror', (problem) => {
    errors.push(problem.message);
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const stamp = 123_456_789,
    hostname = `gallery-${stamp}.localhost`;
  await page.goto('/admin/domains');
  await expect(
    page.getByRole('heading', { name: 'Domains', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.domain-context, .context-card')).toHaveCount(0);
  await expect(page.locator('.preference-panel')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Add delivery domain', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('textbox', { name: 'Hostname', exact: true })
    .fill(hostname);
  await dialog
    .getByRole('textbox', { name: 'Notes (optional)', exact: true })
    .fill('Gallery delivery');
  await dialog
    .getByRole('button', { name: 'Add delivery domain', exact: true })
    .click();
  await expect(
    dialog.getByText('Pending validation', { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Validate domain', exact: true })
    .click();
  await expect(dialog.getByText('Active', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    dialog.getByText('Production DNS and TLS were not checked.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Close dialog', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole('article', {
    name: `Delivery domain ${hostname}`,
    exact: true,
  });
  await row.getByLabel(`Actions for ${hostname}`, { exact: true }).click();
  await row
    .getByRole('button', { name: 'Set as instance default', exact: true })
    .click();
  await expect(dialog).toContainText(
    'Existing links keep their assigned domain.',
  );
  await dialog
    .getByRole('button', { name: 'Set as instance default', exact: true })
    .click();
  await expect(
    row.getByText('Instance default', { exact: true }),
  ).toBeVisible();
  const followed = await request.post('/api/actions/delivery-preference', {
    headers,
    data: { deliveryDomainId: null },
  });
  expect(followed.status()).toBe(200);
  const uploaded = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name: 'domain-qa.gif',
        mimeType: 'image/gif',
        buffer: await readFile('tests/fixtures/animated.gif'),
      },
    },
  });
  expect(uploaded.status()).toBe(201);
  const image = z
    .object({ id: z.string(), url: z.string() })
    .parse(await uploaded.json());
  expect(new URL(image.url).hostname).toBe(hostname);
  const second = await configureDeliveryDomain(
    request,
    baseURL!,
    `media-${stamp}.localhost`,
    true,
  );
  await page.reload();
  await expect(row.getByText('Instance default', { exact: true })).toHaveCount(
    0,
  );
  await page.goto(`/links?image=${image.id}`);
  await expect(page.locator('.link-row')).toContainText(hostname);
  await page.goto('/admin/domains');
  await row.getByLabel(`Actions for ${hostname}`, { exact: true }).click();
  await row.getByRole('button', { name: 'Remove domain', exact: true }).click();
  await expect(dialog).toContainText('1 share link');
  await expect(dialog).toContainText('Images remain saved');
  await dialog
    .getByRole('button', { name: 'Remove domain & revoke links', exact: true })
    .click();
  await expect(row).toHaveCount(0);
  expect((await request.get(`/api/media/${image.id}`)).status()).toBe(200);
  const search = page.getByRole('textbox', {
    name: 'Search domains',
    exact: true,
  });
  await search.fill('no-domain-can-match-this');
  await expect(
    page.getByRole('heading', { name: 'No domains match your search' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Clear search', exact: true }).click();
  // A deterministic fixture covers deleting the only row on the final filtered page.
  await hearth.DB.prepare(
    `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<25) INSERT INTO delivery_domains(id,hostname,notes,createdAt,updatedAt) SELECT 'dom_'||lower(hex(randomblob(16))),'paging-'||x||'-${stamp}.localhost','Paging ${stamp}',unixepoch()+x,unixepoch() FROM n`,
  ).run();
  await page.goto(`/admin/domains?q=Paging+${stamp}&page=2`);
  await expect(page.locator('.domain-row')).toHaveCount(1);
  await page
    .locator('.domain-row')
    .getByLabel(/^Actions for/)
    .click();
  await page
    .getByRole('button', { name: 'Remove domain', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Remove domain & revoke links', exact: true })
    .click();
  await expect(page.locator('.domain-row')).toHaveCount(24);
  await expect(page.locator('.page-status')).toContainText('Page 1 of 1');
  await expect(page).not.toHaveURL(/page=2/);
  const created = await request.post('/api/actions/user-create', {
    headers,
    data: {
      displayName: `Domain member ${stamp}`,
      role: 'user',
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(created.status()).toBe(200);
  const member = z
    .object({ key: z.string(), userId: z.string() })
    .parse(await created.json());
  await hearth.DB.prepare(
    "UPDATE users SET onboardingStatus='exempt' WHERE id=?",
  )
    .bind(member.userId)
    .run();
  const context = await browser.newContext({ proxy, baseURL });
  try {
    await context.request.post('/api/actions/login', {
      headers,
      data: { key: member.key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
    const forbidden = await context.request.post(
      '/api/actions/delivery-domain-primary',
      { headers, data: { id: second.id, revision: 2 } },
    );
    expect(forbidden.status()).toBe(403);
    const memberPage = await context.newPage();
    await memberPage.goto('/domains');
    await expect(
      memberPage.getByRole('button', { name: 'Add delivery domain' }),
    ).toHaveCount(0);
    await expect(
      memberPage.getByText('Your delivery preference', { exact: true }),
    ).toBeVisible();
    await memberPage.goto('/images');
    await expect(
      memberPage.getByRole('button', { name: 'Upload your first image' }),
    ).toBeEnabled();
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});

for (const role of ['user'] as const) {
  test(`Domains distinguishes the instance default from a saved selection for ${role}`, async ({
    hearth,
    page,
    request,
    baseURL,
  }) => {
    const headers = { Origin: baseURL! };
    const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
    const login = await request.post('/api/actions/login', {
      headers,
      data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
    expect(login.status()).toBe(200);
    const instanceDefault = await configureDeliveryDomain(
      request,
      baseURL!,
      'default.localhost',
      true,
    );
    const personal = await configureDeliveryDomain(
      request,
      baseURL!,
      'personal.localhost',
    );
    const created = await request.post('/api/actions/user-create', {
      headers,
      data: {
        displayName: 'Domain member',
        role: 'user',
        token: 'XXXX.DUMMY.TOKEN.XXXX',
      },
    });
    expect(created.status()).toBe(200);
    const member = z
      .object({ key: z.string(), userId: z.string() })
      .parse(await created.json());
    await hearth.DB.prepare(
      "UPDATE users SET onboardingStatus='exempt' WHERE id=?",
    )
      .bind(member.userId)
      .run();
    const signInKey = { admin: key, user: member.key }[role];
    const signedIn = await page.request.post('/api/actions/login', {
      headers,
      data: { key: signInKey, token: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
    expect(signedIn.status()).toBe(200);
    await page.goto('/domains');
    const panel = page.locator('.preference-panel');
    const defaultRow = page.getByRole('article', {
      name: 'Delivery domain default.localhost',
      exact: true,
    });
    const personalRow = page.getByRole('article', {
      name: 'Delivery domain personal.localhost',
      exact: true,
    });
    await expect(page.locator('.domain-context, .context-card')).toHaveCount(0);
    await expect(panel).toContainText(
      'Using instance default: default.localhost',
    );
    await expect(
      page.getByRole('button', { name: 'Use instance default', exact: true }),
    ).toHaveCount(0);
    await expect(defaultRow.getByText('Active', { exact: true })).toBeVisible();
    await expect(
      defaultRow.getByText('Instance default', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('.domain-state')
        .getByText('Your selection', { exact: true }),
    ).toHaveCount(0);

    await defaultRow
      .getByLabel('Actions for default.localhost', { exact: true })
      .click();
    await defaultRow
      .getByRole('button', { name: 'Use for my new links', exact: true })
      .click();
    await expect(panel).toContainText('Your selection: default.localhost');
    await expect(
      defaultRow.getByText('Your selection', { exact: true }),
    ).toBeVisible();
    await expect(
      defaultRow.getByText('Instance default', { exact: true }),
    ).toBeVisible();
    await defaultRow
      .getByLabel('Actions for default.localhost', { exact: true })
      .click();
    await defaultRow
      .getByRole('button', { name: 'Use instance default', exact: true })
      .click();
    await expect(panel).toContainText(
      'Using instance default: default.localhost',
    );
    await expect(
      defaultRow.getByText('Your selection', { exact: true }),
    ).toHaveCount(0);

    await personalRow
      .getByLabel('Actions for personal.localhost', { exact: true })
      .click();
    await personalRow
      .getByRole('button', { name: 'Use for my new links', exact: true })
      .click();
    await expect(panel).toContainText('Your selection: personal.localhost');
    await expect(
      personalRow.getByText('Your selection', { exact: true }),
    ).toBeVisible();
    await expect(
      personalRow.getByText('Instance default', { exact: true }),
    ).toHaveCount(0);
    await hearth.DB.prepare(
      "UPDATE delivery_domains SET health='unhealthy' WHERE id=?",
    )
      .bind(personal.id)
      .run();
    await page.reload();
    await expect(panel).toContainText(
      'Your selection is unavailable. No usable delivery domain available.',
    );
    await expect(
      personalRow.getByText('Unhealthy', { exact: true }),
    ).toBeVisible();
    await expect(personalRow.getByText('Active', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      personalRow.getByText('Your selection', { exact: true }),
    ).toBeVisible();
    await expect(defaultRow.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.locator('.domain-warning')).toContainText(
      'will be saved privately',
    );
    await hearth.DB.prepare('UPDATE delivery_domains SET enabled=0 WHERE id=?')
      .bind(personal.id)
      .run();
    await page.reload();
    await expect(
      personalRow.getByText('Disabled', { exact: true }),
    ).toBeVisible();
    await expect(personalRow.getByText('Active', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      personalRow.getByText('Your selection', { exact: true }),
    ).toBeVisible();
    await expect(panel).toContainText('Your selection is unavailable.');
    await panel
      .getByRole('button', { name: 'Use instance default', exact: true })
      .click();
    await expect(panel).toContainText(
      'Using instance default: default.localhost',
    );
    await expect(page.locator('.domain-warning')).toHaveCount(0);

    await hearth.DB.prepare(
      "UPDATE delivery_domains SET enabled=1,health='active' WHERE id=?",
    )
      .bind(personal.id)
      .run();
    await hearth.DB.prepare(
      "UPDATE delivery_domains SET health='unhealthy' WHERE id=?",
    )
      .bind(instanceDefault.id)
      .run();
    await page.reload();
    await expect(panel).toContainText(
      'Following instance default. No usable delivery domain available.',
    );
    await expect(
      defaultRow.getByText('Unhealthy', { exact: true }),
    ).toBeVisible();
    await expect(defaultRow.getByText('Active', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      defaultRow.getByText('Instance default', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Use instance default', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.domain-warning')).toContainText(
      'instance default (default.localhost) is not currently validated as healthy',
    );
    await expect(
      personalRow.getByText('Active', { exact: true }),
    ).toBeVisible();

    await hearth.DB.prepare(
      'UPDATE delivery_domains SET isPrimary=0 WHERE id=?',
    )
      .bind(instanceDefault.id)
      .run();
    await page.reload();
    await expect(panel).toContainText(
      'Following instance default. No usable delivery domain available.',
    );
    await expect(page.locator('.domain-warning')).toContainText(
      'No instance default is configured.',
    );
    await expect(
      personalRow.getByText('Active', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('.domain-state')
        .getByText('Your selection', { exact: true }),
    ).toHaveCount(0);
  });
}
