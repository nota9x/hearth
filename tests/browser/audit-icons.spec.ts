import { readFile } from 'node:fs/promises';

import { auditActionTitles } from '../../packages/core/audit-search';
import { expect, test } from '../helpers/browser';

test('audit icons cover every known action and fall back for unknown actions', async ({
  hearth,
  page,
  request,
  baseURL,
}) => {
  const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);

  const actions = [
    ...Object.keys(auditActionTitles),
    'future.event',
    'image.upload_failed',
  ];
  await hearth.DB.prepare('DELETE FROM audit_log').run();
  await hearth.DB.batch(
    actions.map((action, index) =>
      hearth.DB.prepare(
        'INSERT INTO audit_log(id,action,metadata,createdAt) VALUES(?,?,?,?)',
      ).bind(
        `audit-icon-${index}`,
        action,
        JSON.stringify({ version: 2, targetName: action }),
        2_000_000_000 + index,
      ),
    ),
  );

  await page.goto('/admin/audit-log');
  await expect(page.locator('details.audit-entry')).toHaveCount(actions.length);
  for (const action of Object.keys(auditActionTitles)) {
    const icon = page
      .locator('details.audit-entry')
      .filter({
        has: page.locator('summary small', {
          hasText: new RegExp(`${action.replaceAll('.', String.raw`\.`)}$`),
        }),
      })
      .locator('.section-icon svg');
    await expect(icon).toHaveCount(1);
    await expect(icon).not.toHaveClass(/(?:^|\s)lucide-shield(?:\s|$)/);
    await expect(icon).toHaveAttribute('width', '19');
    await expect(icon).toHaveAttribute('height', '19');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(
      icon.locator('path, circle, rect, line, polyline'),
    ).not.toHaveCount(0);
  }

  const representativeIcons = {
    'image.uploaded': 'image-up',
    'image.deleted': 'image-minus',
    'image.retention': 'timer',
    'alias.created': 'link',
    'alias.deleted': 'unlink',
    'alias.expiry': 'timer',
    'domain.enabled': 'globe-check',
    'domain.disabled': 'globe-lock',
    'domain.deleted': 'globe-x',
    'auth.login': 'log-in',
    'auth.logout': 'log-out',
    'auth.login_failed': 'circle-x',
    'auth.access_denied': 'shield-ban',
    'credential.reset': 'key-round',
    'credential.rotated': 'rotate-ccw-key',
    'credential.config_exported': 'file-down',
    'user.active': 'user-round-check',
    'user.disabled': 'user-round-x',
    'user.deleted': 'user-round-minus',
    'settings.updated': 'settings',
    'share_slug.expanded': 'expand',
    'storage.reconciliation': 'refresh-cw',
    'storage.reconciliation_completed': 'database-check',
    'storage.finding_resolved': 'list-checks',
    'storage.initialized': 'database-plus',
    'admin.bootstrapped': 'shield-user',
    'onboarding.upload_started': 'scan-eye',
    'onboarding.completed': 'list-check',
    'onboarding.skipped': 'skip-forward',
    'future.event': 'shield',
    'image.upload_failed': 'shield',
  };
  for (const [action, icon] of Object.entries(representativeIcons)) {
    await expect(
      page
        .locator('details.audit-entry')
        .filter({
          has: page.locator('summary small', {
            hasText: new RegExp(`${action.replaceAll('.', String.raw`\.`)}$`),
          }),
        })
        .locator('.section-icon svg'),
    ).toHaveClass(new RegExp(String.raw`(?:^|\s)lucide-${icon}(?:\s|$)`));
  }
});
