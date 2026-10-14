/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed browser responses. */
import { readFile } from 'node:fs/promises';

import { expect, test } from '../helpers/browser';

test('storage explains capacity, reservations, settings, scans, and confirmed repairs on desktop and mobile', async ({
  hearth,
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: {
      key: await readFile(process.env.TEST_KEY_FILE!, 'utf8'),
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await page.goto('/admin/storage');
  await expect(
    page.getByText(/Physical accounting is being established/),
  ).toBeVisible();
  await expect(
    page.getByRole('switch', { name: 'Enable global limit' }),
  ).toHaveCount(0);
  await page.goto('/admin/settings');
  await expect(
    page.getByRole('switch', { name: 'Enable global limit' }),
  ).toBeDisabled();
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET ready=1,multipartVerified=1 WHERE id=1',
  ).run();
  await page.goto('/admin/storage');
  await expect(
    page.getByRole('heading', { name: 'Storage', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Storage has no configured capacity limit.'),
  ).toBeVisible();
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.goto('/admin/settings');
  await page.getByRole('switch', { name: 'Enable global limit' }).check();
  await page.getByLabel('Capacity', { exact: true }).fill('0.0001');
  await page
    .getByRole('combobox', { name: 'Unit', exact: true })
    .selectOption('MB');
  const savedLimit0 = page.waitForResponse('/api/actions/storage-limit');
  await page.getByRole('button', { name: 'Save limit' }).click();
  expect((await savedLimit0).status()).toBe(200);
  await page.goto('/admin/storage');
  await expect(page.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  // eslint-disable-next-line playwright/no-useless-await -- D1 first executes SQL; this is not a locator.
  const configured = await hearth.DB.prepare(
    'SELECT limitBytes FROM storage_capacity',
  ).first();
  expect(configured).toEqual({ limitBytes: 100 });
  await page.goto('/admin/settings');
  await page.getByLabel('Capacity', { exact: true }).fill('0');
  await expect(page.getByRole('button', { name: 'Save limit' })).toBeDisabled();
  await page.getByLabel('Capacity', { exact: true }).fill('1');
  const savedLimit1 = page.waitForResponse('/api/actions/storage-limit');
  await page.getByRole('button', { name: 'Save limit' }).click();
  expect((await savedLimit1).status()).toBe(200);
  await page.goto('/admin/storage');
  await expect(page.getByRole('meter')).toHaveAttribute(
    'aria-valuetext',
    /1 MB available/,
  );
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET limitBytes=1234000001 WHERE id=1',
  ).run();
  await page.goto('/admin/settings');
  await expect(page.getByLabel('Capacity', { exact: true })).toHaveValue(
    '1234.000001',
  );
  await expect(
    page.getByRole('combobox', { name: 'Unit', exact: true }),
  ).toHaveValue('MB');
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET limitBytes=1000000 WHERE id=1',
  ).run();
  await page.goto('/admin/storage');
  await hearth.DB.batch([
    hearth.DB.prepare(
      "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt) SELECT 'img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',id,'existing-image','image.png','image/png','png',500000,'fixture',1,1,1 FROM users LIMIT 1",
    ),
    hearth.DB.prepare(
      "INSERT INTO storage_objects(key,kind,imageId,userId,state,token,storedBytes,updatedAt) SELECT objectKey,'original',id,userId,'live','fixture',size,1 FROM images WHERE objectKey='existing-image'",
    ),
    hearth.DB.prepare(
      "INSERT INTO storage_objects(key,kind,state,token,storedBytes,updatedAt) VALUES('review-me','untracked','live','fixture',300000,1)",
    ),
    hearth.DB.prepare(
      "INSERT INTO storage_objects(key,kind,token,reservedBytes,stagedBytes,updatedAt) VALUES('uploading','original','fixture',100000,50000,1)",
    ),
    hearth.DB.prepare(
      "INSERT INTO reconciliation_runs(id,status,startedAt,completedAt,objectCount,bytes) VALUES('rec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','completed',1,2,1,800000)",
    ),
    hearth.DB.prepare(
      "INSERT INTO reconciliation_runs(id,status,startedAt,objectCount,bytes) VALUES('rec_cccccccccccccccccccccccccccccccc','running',3,4,5000000)",
    ),
    hearth.DB.prepare(
      "INSERT INTO reconciliation_findings(id,runId,kind,objectKey,details,createdAt) VALUES('find_ffffffffffffffffffffffffffffffff','rec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','orphan','review-me','review',2)",
    ),
  ]);
  await page.reload();
  await expect(page.getByRole('meter')).toHaveAttribute('aria-valuenow', '90');
  await expect(page.getByRole('meter')).toHaveAttribute(
    'aria-valuetext',
    /100 KB available/,
  );
  await expect(
    page.getByText('Scan in progress', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/4 objects observed so far/)).toBeVisible();
  await expect(
    page.getByText(/These are incomplete observations/),
  ).toBeVisible();
  await expect(page.getByText(/Reserved capacity includes/)).toBeVisible();
  await expect(page.getByText('PNG', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Browser administrator', exact: true }),
  ).toBeVisible();
  const diagnostics = page.getByRole('button', {
    name: 'Advanced diagnostics & history',
  });
  await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  await diagnostics.focus();
  await page.keyboard.press('Enter');
  await expect(diagnostics).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Confirmed completed objects')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/admin/settings');
  await page.getByLabel('Capacity', { exact: true }).fill('0.0005');
  await expect(
    page.getByText(/This limit is below allocated storage/),
  ).toBeVisible();
  const savedLimit2 = page.waitForResponse('/api/actions/storage-limit');
  await page.getByRole('button', { name: 'Save limit' }).click();
  expect((await savedLimit2).status()).toBe(200);
  await page.goto('/admin/storage');
  await expect(
    page.getByText(/New capacity-consuming writes are blocked/),
  ).toBeVisible();
  await hearth.DB.prepare(
    "UPDATE reconciliation_runs SET status='failed',error='Storage access failed.' WHERE id='rec_cccccccccccccccccccccccccccccccc'",
  ).run();
  await page.reload();
  await expect(page.getByText('Storage access failed.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry scan' }).click();
  await expect(
    page.getByText('Scan in progress', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete file', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('review-me');
  await expect(dialog).toContainText(/permanent/i);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete file', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Permanently delete file', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('No storage problems need attention.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Delete file', exact: true }),
  ).toHaveCount(0);
  await page.goto('/admin/settings');
  await page.getByRole('switch', { name: 'Enable global limit' }).uncheck();
  const savedLimit3 = page.waitForResponse('/api/actions/storage-limit');
  await page.getByRole('button', { name: 'Save limit' }).click();
  expect((await savedLimit3).status()).toBe(200);
  await page.goto('/admin/storage');
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET limitBytes=1000000 WHERE id=1',
  ).run();
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.goto('/admin/settings');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('switch', { name: 'Enable global limit' }).focus();
  await expect(
    page.getByRole('switch', { name: 'Enable global limit' }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('storage findings paginate, expose styled details, and resolve all with cancellation and partial failures', async ({
  hearth,
  page,
  request,
  baseURL,
}) => {
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: {
      key: await readFile(process.env.TEST_KEY_FILE!, 'utf8'),
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  const protectedKey = 'objects/' + 'long-object-key-'.repeat(12);
  await hearth.DB.prepare(
    "INSERT INTO reconciliation_runs(id,status,startedAt,completedAt) VALUES('rec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','completed',1,2)",
  ).run();
  await hearth.DB.prepare(
    "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt) SELECT 'img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',id,?,'protected.png','image/png','png',1,'fixture',1,1,1 FROM users LIMIT 1",
  )
    .bind(protectedKey)
    .run();
  await hearth.DB.batch(
    Array.from({ length: 12 }, (_, index) =>
      hearth.DB.prepare(
        "INSERT INTO reconciliation_findings(id,runId,kind,objectKey,details,createdAt) VALUES(?,'rec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','orphan',?,'review',?)",
      ).bind(
        'find_' + String(index).padStart(32, '0'),
        index === 0 ? protectedKey : 'untracked-' + index,
        12 - index,
      ),
    ),
  );
  await page.goto('/admin/storage');
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByRole('article')).toHaveCount(10);
  await expect(attention.getByText('12 issues', { exact: true })).toBeVisible();
  const firstFinding = attention.getByRole('article').first();
  const details = firstFinding.getByRole('button', {
    name: 'Details',
    exact: true,
  });
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(
    firstFinding.getByText(protectedKey, { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await attention.getByRole('link', { name: 'Next page' }).click();
  await expect(attention.getByRole('article')).toHaveCount(2);
  await attention
    .getByRole('button', { name: 'Resolve all', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Resolve all 12 listed issues');
  await expect(dialog).toContainText('Permanently delete 12 untracked files');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // eslint-disable-next-line playwright/no-useless-await -- D1 first executes SQL; this is not a locator.
  const unresolved = await hearth.DB.prepare(
    'SELECT count(*) AS count FROM reconciliation_findings WHERE resolvedAt IS NULL',
  ).first();
  expect(unresolved).toEqual({ count: 12 });
  await page.clock.install();
  let limitedRequests = 2;
  await page.route('**/api/actions/finding-resolve', async (route) => {
    if (limitedRequests-- > 0) {
      await route.fulfill({
        status: 429,
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many attempts. Try again in one minute.',
          },
        },
      });
    } else await route.continue();
  });
  await attention
    .getByRole('button', { name: 'Resolve all', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Resolve all issues', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    'Continuing in one minute',
  );
  await dialog
    .getByRole('button', { name: 'Stop after current issue' })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    '0 resolved. 12 issues remain after stopping',
  );
  await dialog
    .getByRole('button', { name: 'Resolve all issues', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    'Continuing in one minute',
  );
  await page.clock.fastForward(60_000);
  await expect(dialog.getByRole('alert')).toContainText(
    '11 resolved. 1 issue remains',
  );
  await expect(dialog).toContainText(
    'The object is now referenced and cannot be removed.',
  );
  await expect(attention.getByRole('article')).toHaveCount(1);
  // eslint-disable-next-line playwright/no-useless-await -- D1 first executes SQL; this is not a locator.
  const remaining = await hearth.DB.prepare(
    'SELECT objectKey FROM reconciliation_findings WHERE resolvedAt IS NULL',
  ).first();
  expect(remaining).toEqual({ objectKey: protectedKey });
  // eslint-disable-next-line playwright/no-useless-await -- D1 first executes SQL; this is not a locator.
  const audit = await hearth.DB.prepare(
    "SELECT count(*) AS count FROM audit_log WHERE action='storage.finding_resolved'",
  ).first();
  expect(audit).toEqual({ count: 11 });
  await hearth.DB.prepare(
    "UPDATE images SET objectKey='retained-original' WHERE objectKey=?",
  )
    .bind(protectedKey)
    .run();
  await dialog
    .getByRole('button', { name: 'Resolve all issues', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    attention.getByText('No storage problems need attention.'),
  ).toBeVisible();
  await expect(
    attention.getByRole('button', { name: 'Resolve all', exact: true }),
  ).toHaveCount(0);
});
