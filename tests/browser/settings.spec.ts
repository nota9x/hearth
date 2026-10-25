import { readFile } from 'node:fs/promises';

import { expect, signIn, test } from '../helpers/browser';

test('personal settings preserve drafts across refreshes and save only changed fields', async ({
  page,
  request,
  baseURL,
  hearth,
}) => {
  await signIn(page, request, baseURL!);
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await page.goto('/settings');
  const preferences = page.getByRole('region', {
    name: 'Personal preferences',
  });
  const save = preferences.getByRole('button', { name: 'Save preferences' });
  await expect(save).toBeDisabled();
  const name = page.getByLabel('Display name', { exact: true });
  await name.fill('Settings draft');
  await expect(preferences.getByRole('status')).toContainText(
    'Unsaved changes',
  );
  await hearth.DB.prepare(
    "UPDATE users SET defaultExpiry='7d',uploadCount=uploadCount+1 WHERE role='admin'",
  ).run();
  const refresh = page.waitForResponse('**/api/settings');
  await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await refresh;
  await expect(name).toHaveValue('Settings draft');
  const submitted = page.waitForRequest('**/api/actions/preferences');
  await save.click();
  const submission = await submitted;
  expect(submission.postDataJSON()).toEqual({
    displayName: 'Settings draft',
  });
  await expect(preferences.getByRole('status')).toHaveText('Saved');
  await expect(
    page.getByLabel('Default image expiry', { exact: true }),
  ).toHaveValue('7d');
  const metadata = page.getByRole('switch', { name: 'Strip image metadata' });
  await metadata.focus();
  await page.keyboard.press('Space');
  await expect(metadata).not.toBeChecked();
  await page
    .getByLabel('Default image expiry', { exact: true })
    .selectOption('duration');
  await page
    .getByLabel('Default duration (seconds)', { exact: true })
    .fill('120');
  await save.click();
  await expect(preferences.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(name).toHaveValue('Settings draft');
  await expect(metadata).not.toBeChecked();
  await expect(
    page.getByLabel('Default duration (seconds)', { exact: true }),
  ).toHaveValue('120');
  await name.fill('Discard this draft');
  await preferences.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(name).toHaveValue('Settings draft');
  await expect(save).toBeDisabled();
  await name.fill('');
  await expect(save).toBeDisabled();
  await preferences.getByRole('button', { name: 'Reset', exact: true }).click();
  expect(errors).toEqual([]);
});

test('administration groups save independently, preserve other drafts, and reset invalid custom lifetimes', async ({
  page,
  request,
  baseURL,
  hearth,
}) => {
  await signIn(page, request, baseURL!);
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET ready=1,multipartVerified=1 WHERE id=1',
  ).run();
  await hearth.DB.prepare(
    "UPDATE app_settings SET value=json_set(value,'$.automaticFloor',7) WHERE key='shareSlugConfiguration'",
  ).run();
  await page.goto('/admin/settings');
  const workspace = page.getByRole('region', { name: 'Workspace name' });
  const links = page.getByRole('region', { name: 'Share-link IDs' });
  const policy = page.getByRole('region', { name: 'Expiry policy' });
  const storage = page.getByRole('region', { name: 'Global storage limit' });
  await expect(links).toContainText('Current allocation length: 7 characters');
  await page.getByLabel('Name', { exact: true }).fill('Pending workspace');
  await page
    .getByLabel('Default share-link slug length', { exact: true })
    .fill('8');
  await links.getByRole('button', { name: 'Save slug length' }).click();
  await expect(links.getByRole('status')).toHaveText('Saved');
  await expect(links).toContainText('Current allocation length: 8 characters');
  await page
    .getByLabel('Default share-link slug length', { exact: true })
    .fill('5');
  await links.getByRole('button', { name: 'Save slug length' }).click();
  await expect(links.getByRole('status')).toHaveText('Saved');
  await expect(links).toContainText('Current allocation length: 7 characters');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Pending workspace',
  );
  await expect(workspace.getByRole('status')).toContainText('Unsaved changes');
  await workspace.getByRole('button', { name: 'Save name' }).click();
  await expect(workspace.getByRole('status')).toHaveText('Saved');
  await page
    .getByLabel('Maximum lifetime', { exact: true })
    .selectOption('custom');
  await page.getByLabel('Duration', { exact: true }).fill('');
  await expect(
    policy.getByRole('button', { name: 'Save expiry policy' }),
  ).toBeDisabled();
  await page
    .getByLabel('Maximum lifetime', { exact: true })
    .selectOption('3600');
  await expect(
    policy.getByRole('button', { name: 'Save expiry policy' }),
  ).toBeEnabled();
  await page
    .getByLabel('Maximum lifetime', { exact: true })
    .selectOption('custom');
  await page.getByLabel('Duration', { exact: true }).fill('');
  await policy.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByLabel('Duration', { exact: true })).toHaveCount(0);
  await page
    .getByLabel('Maximum lifetime', { exact: true })
    .selectOption('3600');
  await expect(
    page.getByRole('switch', { name: 'Require image and link expiry' }),
  ).not.toBeChecked();
  await expect(policy).toContainText(
    'This maximum requires expiry even with the switch off.',
  );
  await policy.getByRole('button', { name: 'Save expiry policy' }).click();
  await expect(policy.getByRole('status').last()).toHaveText('Saved');
  await page.getByRole('switch', { name: 'Enable global limit' }).check();
  await page.getByLabel('Capacity', { exact: true }).fill('0.123456');
  await page.getByLabel('Unit', { exact: true }).selectOption('MB');
  await storage.getByRole('button', { name: 'Save limit' }).click();
  await expect(storage).toContainText('123.5 KB global limit');
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Pending workspace',
  );
  await expect(
    page.getByLabel('Default share-link slug length', { exact: true }),
  ).toHaveValue('5');
  await expect(
    page.getByLabel('Maximum lifetime', { exact: true }),
  ).toHaveValue('3600');
  await expect(page.getByLabel('Capacity', { exact: true })).toHaveValue(
    '0.123456',
  );
  await expect(
    page.getByRole('switch', { name: 'Enable global limit' }),
  ).toBeChecked();
});

test('failed settings reads preserve drafts and distinguish confirmed saves from failed mutations', async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page, request, baseURL!);
  await page.goto('/admin/settings');
  const workspace = page.getByRole('region', { name: 'Workspace name' });
  const links = page.getByRole('region', { name: 'Share-link IDs' });
  await page.getByLabel('Name', { exact: true }).fill('Saved while offline');
  await page
    .getByLabel('Default share-link slug length', { exact: true })
    .fill('9');
  await page.route('**/api/settings?admin', (route) => route.abort());
  await workspace.getByRole('button', { name: 'Save name' }).click();
  await expect(workspace.getByRole('status').last()).toContainText(
    'Saved, but',
  );
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Saved while offline',
  );
  await expect(links.getByRole('status')).toContainText('Unsaved changes');
  await expect(
    page.getByLabel('Default share-link slug length', { exact: true }),
  ).toHaveValue('9');
  await page.getByLabel('Name', { exact: true }).fill('Another draft');
  await workspace.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Saved while offline',
  );
  await page.unroute('**/api/settings?admin');
  await page.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(page.getByRole('button', { name: 'Retry refresh' })).toHaveCount(
    0,
  );
  await expect(
    page.getByLabel('Default share-link slug length', { exact: true }),
  ).toHaveValue('9');
  await links.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Saved while offline',
  );
});

test('unsaved navigation can be canceled or discarded without losing history direction', async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page, request, baseURL!);
  await page.goto('/images');
  await page
    .locator('aside')
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Keep this draft');
  await page
    .locator('aside')
    .getByRole('link', { name: 'Images', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: 'Discard unsaved changes?',
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Keep this draft',
  );
  await page.evaluate(() => history.back());
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.evaluate(() => history.back());
  await confirmation.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/\/images$/);
  // Popstate changes the URL before SvelteKit finishes leaving the settings page.
  await expect(
    page.getByRole('heading', { name: 'Images', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByLabel('Display name', { exact: true }),
  ).not.toHaveValue('Keep this draft');
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Discard via link');
  await page
    .locator('aside')
    .getByRole('link', { name: 'Images', exact: true })
    .click();
  await confirmation.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/\/images$/);
  await page
    .locator('aside')
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Unsaved on refresh');
  const unload = page.waitForEvent('dialog');
  const reloading = page
    .reload({ timeout: 5000 })
    // eslint-disable-next-line unicorn/prefer-await -- Attach rejection handling before answering the blocking browser prompt.
    .catch((error: unknown) => error);
  const prompt = await unload;
  expect(prompt.type()).toBe('beforeunload');
  await prompt.dismiss();
  expect(await reloading).toBeInstanceOf(Error);
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Unsaved on refresh',
  );
  await page
    .getByRole('region', { name: 'Personal preferences' })
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
});

test('key rotation confirms revocation, reveals the replacement once, and signs out after saving it', async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page, request, baseURL!);
  await page.goto('/settings');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  const sharex = page.getByRole('dialog', { name: 'Set up ShareX' });
  const credential = sharex.getByLabel('Current API key', { exact: true });
  await expect(credential).toBeEmpty();
  await credential.fill('invalid');
  await sharex
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await expect(sharex.getByText('The API key is invalid.')).toBeVisible();
  await credential.fill(await readFile(process.env.TEST_KEY_FILE!, 'utf8'));
  const currentConfig = page.waitForEvent('download');
  await sharex
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await currentConfig;
  await expect(sharex).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Rotate key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rotate API key' });
  await expect(dialog).toContainText('Rotation cannot be undone');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Unsaved before rotation');
  await page.getByRole('button', { name: 'Rotate key', exact: true }).click();
  await expect(dialog).toContainText('unsaved preferences will be lost');
  await dialog
    .getByRole('button', { name: 'Rotate API key', exact: true })
    .click();
  const replacement = page.getByRole('dialog', { name: 'Save your API key' });
  await expect(replacement).toBeVisible();
  await expect(replacement.locator('.secret')).not.toBeEmpty();
  const download = page.waitForEvent('download');
  await replacement
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  const config = await download;
  expect(config.suggestedFilename()).toBe('Hearth.sxcu');
  await replacement.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('.secret')).toHaveCount(0);
  const oldKey = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key: oldKey, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(401);
});
