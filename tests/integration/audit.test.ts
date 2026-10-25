import { Buffer } from 'node:buffer';

import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { POST } from '../../apps/web/src/routes/api/actions/[action]/+server';
import { GET as media } from '../../apps/web/src/routes/api/media/[id]/+server';
import { auditEvent } from '../../packages/core/audit';
import { presentAudit } from '../../packages/core/audit-presentation';
import {
  authenticateSession,
  createSession,
  createUser,
} from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import { deleteImages, prepareDownloads } from '../../packages/core/images';
import {
  apiKeys,
  auditLog,
  deliveryDomains,
  findings,
  images,
  sessions,
  storageStats,
  users,
} from '../../packages/core/schema';
import { upload } from '../../packages/core/upload';
import { migrateDatabase } from '../helpers/database';
import { maintain } from '../helpers/maintenance';

let mf: Miniflare, env: Env, admin: User, member: User;
const secrets: string[] = ['audit-test-secret', 'audit-test-turnstile'];
const auditIp = '203.0.113.42';
const maintenanceStart = vi.fn<(runId: string) => Promise<void>>();
const maintenanceControl =
  vi.fn<
    (
      paused: boolean,
      event: Awaited<ReturnType<typeof auditEvent>>,
    ) => Promise<void>
  >();
const maintenanceBinding = vi.fn(() => ({
  start: maintenanceStart,
  control: maintenanceControl,
}));
beforeEach(async () => {
  secrets.length = 2;
  maintenanceStart.mockReset().mockResolvedValue(undefined);
  maintenanceBinding.mockClear();
  maintenanceControl.mockReset().mockImplementation(async (_paused, event) => {
    await database(env.DB).insert(auditLog).values(event);
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
    }),
  );
  const binding = await mf.getD1Database('DB');
  await migrateDatabase(binding);
  const limit = { limit: () => Promise.resolve({ success: true }) };
  // @ts-expect-error Miniflare R2 proxies use Undici Headers types, but implement the Workers binding at runtime.
  env = {
    ASSETS: { fetch: vi.fn() },
    MAINTENANCE: {
      getByName: maintenanceBinding,
    },
    DB: binding,
    BUCKET: await mf.getR2Bucket('BUCKET'),
    ENVIRONMENT: 'development',
    APP_ORIGIN: 'http://localhost',
    TURNSTILE_SITE_KEY: 'test',
    MAX_UPLOAD_BYTES: '10485760',
    LOGIN_LIMIT: limit,
    MUTATION_LIMIT: limit,
    SENSITIVE_LIMIT: limit,
    UPLOAD_LIMIT: limit,
  } as Env;
  const first = await createUser(binding, 'Investigator', 'admin', null);
  const second = await createUser(binding, 'Member', 'user', first.userId);
  secrets.push(first.key, second.key);
  [admin] = await database(binding)
    .select()
    .from(users)
    .where(eq(users.id, first.userId));
  [member] = await database(binding)
    .select()
    .from(users)
    .where(eq(users.id, second.userId));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ success: true }))),
  );
});
afterEach(async () => {
  await mf?.dispose();
});

async function action(
  name: string,
  input: Record<string, unknown>,
  actor: User | null = admin,
  event?: string,
  status = 200,
) {
  const db = database(env.DB);
  const previousRows = await db.select({ id: auditLog.id }).from(auditLog);
  const previous = new Set(previousRows.map((log) => log.id));
  const requestEvent: Partial<Parameters<typeof POST>[0]> = {
    url: new URL(`http://localhost/api/actions/${name}`),
    route: { id: '/api/actions/[action]' },
    fetch,
    getClientAddress: () => '127.0.0.1',
    setHeaders: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
    isRemoteRequest: false,
    request: new Request(`http://localhost/api/actions/${name}`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': auditIp },
      body: JSON.stringify({ token: 'audit-test-turnstile', ...input }),
    }),
    params: { action: name },
    locals: { env, user: actor },
    cookies: {
      get: () => 'audit-test-secret',
      getAll: () => [],
      serialize: () => '',
      parse: () => ({ name: 'hearth-local', value: 'audit-test-secret' }),
      set: (_name: string, value: string) => {
        secrets.push(value);
      },
      delete: vi.fn(),
    },
  };
  const response = await POST(requestEvent as Parameters<typeof POST>[0]);
  expect(response.status).toBe(status);
  const currentRows = await db.select().from(auditLog);
  const added = currentRows.filter((log) => !previous.has(log.id));
  if (event) {
    expect(added.map((log) => log.action)).toContain(event);
    for (const log of added) expect(presentAudit(log).actorIp).toBe(auditIp);
  } else expect(added).toHaveLength(0);
  return {
    response,
    logs: added,
    log: added.find((log) => log.action === event),
  };
}

async function seedImage(owner = member, expiresAt: number | null = null) {
  const imageId = id('img');
  await database(env.DB)
    .insert(images)
    .values({
      id: imageId,
      userId: owner.id,
      filename: 'Evidence.png',
      objectKey: `objects/${imageId}`,
      mime: 'image/png',
      extension: 'png',
      size: 20,
      sha256: 'not-a-credential',
      width: 1,
      height: 1,
      createdAt: now(),
      expiresAt,
    });
  return imageId;
}

describe('audit safety and historical presentation', () => {
  it('restricts pause/resume to administrators and presents their captured audit events', async () => {
    await action('maintenance-pause', {}, member, 'auth.access_denied', 403);
    await action('maintenance-resume', {}, null, undefined, 401);
    expect(maintenanceControl).not.toHaveBeenCalled();
    await action('maintenance-pause', {}, admin, 'maintenance.paused');
    await action('maintenance-resume', {}, admin, 'maintenance.resumed');
    expect(maintenanceControl.mock.calls.map(([paused]) => paused)).toEqual([
      true,
      false,
    ]);
  });
  it('authorizes maintenance dispatch and retains scan progress when dispatch fails and is retried', async () => {
    const dispatch = maintenanceStart.mockRejectedValue(
      new Error('unavailable'),
    );
    const binding = maintenanceBinding;
    await action('reconcile', {}, member, 'auth.access_denied', 403);
    await action('reconcile', {}, null, undefined, 401);
    expect(binding).not.toHaveBeenCalled();
    const failed = await action(
      'reconcile',
      {},
      admin,
      'storage.reconciliation',
      503,
    );
    const runId = failed.log!.targetId!;
    expect(dispatch).toHaveBeenCalledWith(runId);
    expect(
      await env.DB.prepare('SELECT status FROM reconciliation_runs WHERE id=?')
        .bind(runId)
        .first(),
    ).toEqual({ status: 'failed' });
    await env.DB.prepare(
      'UPDATE reconciliation_runs SET cursor=?,objectCount=100 WHERE id=?',
    )
      .bind('saved-cursor', runId)
      .run();
    dispatch.mockResolvedValue(undefined);
    await action('reconcile', { id: runId }, admin, 'storage.reconciliation');
    expect(
      await env.DB.prepare(
        'SELECT status,cursor,objectCount FROM reconciliation_runs WHERE id=?',
      )
        .bind(runId)
        .first(),
    ).toEqual({ status: 'running', cursor: 'saved-cursor', objectCount: 100 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    await action('reconcile', {}, admin, undefined, 409);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it('authorizes, validates, and transactionally audits global storage limit changes', async () => {
    await action(
      'storage-limit',
      { limitBytes: 1000 },
      member,
      'auth.access_denied',
      403,
    );
    await action('storage-limit', { limitBytes: 1000 }, null, undefined, 401);
    await action('storage-limit', { limitBytes: 1000 }, admin, undefined, 409);
    await env.DB.prepare(
      'UPDATE storage_capacity SET ready=1,multipartVerified=1 WHERE id=1',
    ).run();
    for (const limitBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await action('storage-limit', { limitBytes }, admin, undefined, 400);
    const saved = await action(
      'storage-limit',
      { limitBytes: 1000 },
      admin,
      'storage.limit_updated',
    );
    expect(saved.log?.metadata).toContain('limitBytes');
    expect(presentAudit(saved.log!).title).toBe('Global storage limit changed');
    await action(
      'storage-limit',
      { limitBytes: null },
      admin,
      'storage.limit_updated',
    );
    expect(
      await env.DB.prepare(
        'SELECT limitBytes FROM storage_capacity WHERE id=1',
      ).first(),
    ).toEqual({ limitBytes: null });
    await env.DB.prepare(
      "CREATE TRIGGER reject_storage_audit BEFORE INSERT ON audit_log WHEN NEW.action='storage.limit_updated' BEGIN SELECT RAISE(ABORT,'injected_audit_failure'); END",
    ).run();
    await action('storage-limit', { limitBytes: 500 }, admin, undefined, 503);
    expect(
      await env.DB.prepare(
        'SELECT limitBytes FROM storage_capacity WHERE id=1',
      ).first(),
    ).toEqual({ limitBytes: null });
  });
});

describe('persisted mutation coverage', () => {
  it('captures account, host, link, configuration, storage, and authentication actions', async () => {
    const db = database(env.DB);
    await action(
      'display-name-settings',
      { restrictDisplayNameChanges: true },
      member,
      'auth.access_denied',
      403,
    );
    await action(
      'user-display-name-policy',
      { userId: member.id, displayNamePolicy: 'allow' },
      member,
      'auth.access_denied',
      403,
    );
    const session = await createSession(env.DB, member.id, 1);
    const globalPolicy = await action(
      'display-name-settings',
      { restrictDisplayNameChanges: true },
      admin,
      'settings.display_name_policy',
    );
    expect(globalPolicy.log).toMatchObject({
      actorId: admin.id,
      targetId: 'restrictDisplayNameChanges',
    });
    expect(presentAudit(globalPolicy.log!).details).toEqual([
      'Restrict display name changes changed from "No" to "Yes"',
    ]);
    const accountPolicy = await action(
      'user-display-name-policy',
      { userId: member.id, displayNamePolicy: 'restrict' },
      admin,
      'user.display_name_policy',
    );
    expect(accountPolicy.log).toMatchObject({
      actorId: admin.id,
      targetId: member.id,
    });
    expect(presentAudit(accountPolicy.log!).details).toEqual([
      'Display name policy changed from "inherit" to "restrict"',
    ]);
    expect(await authenticateSession(env.DB, session)).toMatchObject({
      id: member.id,
      displayNamePolicy: 'restrict',
    });
    await action(
      'user-update',
      {
        userId: member.id,
        displayName: 'Assigned member',
        status: 'active',
        quotaBytes: null,
      },
      admin,
      'user.updated',
    );
    await action(
      'user-display-name-policy',
      { userId: member.id, displayNamePolicy: 'inherit' },
      admin,
      'user.display_name_policy',
    );
    await action(
      'display-name-settings',
      { restrictDisplayNameChanges: false },
      admin,
      'settings.display_name_policy',
    );
    const created = await action(
      'user-create',
      { displayName: 'New user', role: 'admin' },
      admin,
      'user.created',
    );
    const account = z
      .object({ userId: z.string(), key: z.string() })
      .parse(await created.response.json());
    secrets.push(account.key);
    expect(presentAudit(created.log!).target).toBe('New user');
    expect(presentAudit(created.log!).details).toContain(
      'Role changed from "Not set" to "admin"',
    );
    const edited = await action(
      'user-update',
      {
        userId: account.userId,
        displayName: 'Renamed',
        status: 'disabled',
        quotaBytes: 4096,
      },
      admin,
      'user.updated',
    );
    expect(presentAudit(edited.log!).details).toEqual([
      'Display name changed from "New user" to "Renamed"',
      'Status changed from "active" to "disabled"',
      'Storage quota changed from "Not set" to "4,096 bytes"',
    ]);
    await action(
      'user-update',
      {
        userId: account.userId,
        displayName: 'Renamed',
        status: 'active',
        quotaBytes: null,
      },
      admin,
      'user.updated',
    );
    const reset = await action(
      'user-reset',
      { userId: account.userId },
      admin,
      'credential.reset',
    );
    const resetResult = z
      .object({ key: z.string() })
      .parse(await reset.response.json());
    secrets.push(resetResult.key);
    const hostCreated = await action(
      'delivery-domain-save',
      { hostname: 'evidence.example.com', accessMode: 'everyone' },
      admin,
      'domain.created',
    );
    const deliveryDomainId = hostCreated.log!.targetId!;
    const changed = await action(
      'delivery-domain-save',
      {
        id: deliveryDomainId,
        revision: 0,
        hostname: 'evidence.example.com',
        accessMode: 'selected',
        addMembers: [member.id],
      },
      admin,
      'domain.updated',
    );
    expect(presentAudit(changed.log!).target).toBe('evidence.example.com');
    expect(presentAudit(changed.log!).details).toContain(
      'Access mode changed from "everyone" to "selected"',
    );
    await action(
      'delivery-domain-save',
      {
        id: deliveryDomainId,
        revision: 1,
        hostname: 'evidence.example.com',
        accessMode: 'everyone',
      },
      admin,
      'domain.updated',
    );
    await env.DB.prepare(
      "UPDATE delivery_domains SET health='active' WHERE id=?",
    )
      .bind(deliveryDomainId)
      .run();
    await action(
      'delivery-preference',
      { deliveryDomainId },
      member,
      'user.delivery_preference',
    );
    const preferences = await action(
      'preferences',
      {
        displayName: 'Member renamed',
        stripImageMetadata: true,
        expiry: '30d',
        password: secrets[0],
        secret: secrets[0],
      },
      member,
      'user.preferences',
    );
    expect(presentAudit(preferences.log!).actor).toBe('Assigned member');
    expect(presentAudit(preferences.log!).details).toContain(
      'Expiry changed from "Never" to "30 days"',
    );
    await action(
      'settings',
      { siteName: 'Investigation workspace', apiKey: secrets[0] },
      admin,
      'settings.updated',
    );
    const imageId = await seedImage();
    const expiry = await action(
      'image-expiry',
      { ids: [imageId], expiry: '7d' },
      member,
      'image.expiry',
    );
    expect(presentAudit(expiry.log!).target).toBe('Evidence.png');
    expect(presentAudit(expiry.log!).details[0]).toContain(
      'Expiration changed from "Never" to "',
    );
    await action(
      'image-expiry',
      { ids: [imageId], expiry: '30d' },
      member,
      'image.expiry',
    );
    await action('alias-create-options', { imageId }, member);
    const link = await action(
      'alias-create',
      { imageId, deliveryDomainId, slug: 'evidence-link', expiry: 'never' },
      member,
      'alias.created',
    );
    const aliasId = link.log!.targetId!;
    await action(
      'alias-select-all',
      { admin: false, query: '?q=evidence-link' },
      member,
    );
    await action('alias-copy', { ids: [aliasId] }, member);
    await action('alias-expiry-options', { ids: [aliasId] }, member);
    await action(
      'alias-expiry',
      { ids: [aliasId], expiry: '1h' },
      member,
      'alias.expiry',
    );
    await action('alias-primary', { id: aliasId }, member, 'alias.primary');
    const link2 = await action(
      'alias-create',
      { imageId, deliveryDomainId, slug: 'secondary-link', expiry: 'never' },
      member,
      'alias.created',
    );
    await action(
      'alias-delete',
      { ids: [link2.log!.targetId] },
      member,
      'alias.deleted',
    );
    await action('image-delete', { ids: [imageId] }, member, 'image.deleted');
    const emptyHost = await action(
      'delivery-domain-save',
      { hostname: 'disposable.example.com', accessMode: 'everyone' },
      admin,
      'domain.created',
    );
    const removed = await action(
      'delivery-domain-remove',
      {
        id: emptyHost.log!.targetId,
        revision: 0,
        enabled: false,
        expectedLinkCount: 0,
        replacementId: null,
        clearPrimary: false,
      },
      admin,
      'domain.deleted',
    );
    expect(presentAudit(removed.log!).target).toBe('disposable.example.com');
    expect(
      await db
        .select()
        .from(deliveryDomains)
        .where(eq(deliveryDomains.id, emptyHost.log!.targetId!)),
    ).toHaveLength(0);
    const run = await action('reconcile', {}, admin, 'storage.reconciliation');
    const findingId = id('find');
    await db
      .update(storageStats)
      .set({ bytes: 99 })
      .where(eq(storageStats.userId, member.id));
    await db.insert(findings).values({
      id: findingId,
      runId: run.log!.targetId!,
      kind: 'accounting',
      details: JSON.stringify({ userId: member.id }),
      createdAt: now(),
    });
    const repaired = await action(
      'finding-resolve',
      { id: findingId },
      admin,
      'storage.finding_resolved',
    );
    expect(presentAudit(repaired.log!).details).toContain(
      'Original bytes changed from "99 bytes" to "0 bytes"',
    );
    const login = await action(
      'login',
      { key: secrets[2] },
      null,
      'auth.login',
    );
    expect(presentAudit(login.log!).actorIp).toBe(auditIp);
    const failedLogin = await action(
      'login',
      { key: 'img_live_' + 'a'.repeat(32) + '_' + 'b'.repeat(64) },
      null,
      'auth.login_failed',
      401,
    );
    expect(presentAudit(failedLogin.log!)).toMatchObject({
      actor: auditIp,
      actorIp: auditIp,
    });
    await action('logout', {}, member, 'auth.logout');
    const [current] = await db
      .select()
      .from(users)
      .where(eq(users.id, member.id));
    await action(
      'sxcu',
      { key: secrets[3] },
      current,
      'credential.config_exported',
    );
    const rotated = await action('rotate', {}, current, 'credential.rotated');
    const rotatedResult = z
      .object({ key: z.string() })
      .parse(await rotated.response.json());
    secrets.push(rotatedResult.key);
    await action(
      'user-delete',
      { userId: account.userId },
      admin,
      'user.deleted',
    );
  });
  // The action helper checks status and persisted events for each rejected mutation.
  // eslint-disable-next-line vitest/expect-expect
  it('does not record successful mutations for rejected requests or rolled-back batches', async () => {
    await action(
      'settings',
      { siteName: 'Forbidden' },
      member,
      'auth.access_denied',
      403,
    );
    await action(
      'user-update',
      {
        userId: admin.id,
        displayName: 'No admin',
        status: 'disabled',
        quotaBytes: null,
      },
      admin,
      undefined,
      409,
    );
    await action(
      'user-update',
      {
        userId: id('usr'),
        displayName: 'Absent',
        status: 'active',
        quotaBytes: null,
      },
      admin,
      undefined,
      404,
    );
    await action(
      'delivery-domain-details',
      { id: id('dom') },
      admin,
      undefined,
      404,
    );
    await action(
      'preferences',
      { displayName: '', expiry: '30d' },
      member,
      undefined,
      400,
    );
  });
  it('audits upload and automatic expiry, without logging routine maintenance reads', async () => {
    const db = database(env.DB);
    const [current] = await db
      .select()
      .from(users)
      .where(eq(users.id, member.id));
    const form = new FormData();
    form.append(
      'file',
      new Blob(
        [
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
            'base64',
          ),
        ],
        { type: 'image/png' },
      ),
      'Uploaded evidence.png',
    );
    const result = await upload(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { 'cf-connecting-ip': auditIp },
        body: form,
      }),
      current,
      env,
    );
    const [event] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, result.id));
    expect(event.action).toBe('image.uploaded');
    expect(presentAudit(event).target).toBe('Uploaded evidence.png');
    expect(presentAudit(event).actorIp).toBe(auditIp);
    secrets.push(result.deleteUrl.split('#', 2)[1]);
    const deletion = await action(
      'delete-info',
      { imageId: result.id, token: result.deleteUrl.split('#', 2)[1] },
      null,
    );
    expect(deletion.logs).toHaveLength(0);
    await action(
      'delete-token',
      {
        imageId: result.id,
        token: result.deleteUrl.split('#', 2)[1],
        turnstile: 'audit-test-turnstile',
      },
      null,
      'image.deleted',
    );
    const expiredId = await seedImage(member, now() - 100);
    await action('reconcile', {}, admin, 'storage.reconciliation');
    await maintain(env);
    const [expired] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, expiredId));
    expect(presentAudit(expired).context).toContainEqual({
      label: 'Reason',
      value: 'Image expired',
    });
    expect(presentAudit(expired).actor).toBe('System');
    expect(presentAudit(expired).actorIp).toBeNull();
    await maintain(env);
    const completed = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'storage.reconciliation_completed'));
    expect(completed).toHaveLength(1);
    const beforeMaintenance = await db.select().from(auditLog);
    await maintain(env);
    const afterMaintenance = await db.select().from(auditLog);
    expect(afterMaintenance).toHaveLength(beforeMaintenance.length);
  });
  it('audits expiry policy changes and leaves option reads unaudited', async () => {
    const imageId = await seedImage();
    await action('image-expiry-options', { ids: [imageId] }, member);
    const instance = await action(
      'expiry-policy',
      { policy: { requireExpiry: false, maxLifetimeSeconds: 3600 } },
      admin,
      'settings.expiry_policy',
    );
    expect(presentAudit(instance.log!).details).toContain(
      'Maximum lifetime changed from "Unlimited" to "1 hour"',
    );
    const override = await action(
      'user-expiry-policy',
      { userId: member.id, policy: { requireExpiry: true } },
      admin,
      'user.expiry_policy',
    );
    expect(presentAudit(override.log!).details).toContain(
      'Expiry requirement override changed from "Instance default" to "Yes"',
    );
    await action(
      'user-expiry-policy',
      { userId: member.id, policy: null },
      admin,
      'user.expiry_policy',
    );
    await action(
      'expiry-policy',
      { policy: { requireExpiry: false, maxLifetimeSeconds: null } },
      admin,
      'settings.expiry_policy',
    );
  });
  it('audits configured slug length changes and protects the admin setting', async () => {
    const changed = await action(
      'share-slug-settings',
      { length: 8 },
      admin,
      'settings.share_slug_length',
    );
    expect(presentAudit(changed.log!).details).toEqual([
      'Default share-link slug length changed from "5" to "8"',
    ]);
    await action('share-slug-settings', { length: 8 }, admin);
    await action(
      'share-slug-settings',
      { length: 5 },
      member,
      'auth.access_denied',
      403,
    );
    for (const length of [2, 65, 5.5, '5', null])
      await action('share-slug-settings', { length }, admin, undefined, 400);
    await action(
      'share-slug-settings',
      { length: 5 },
      admin,
      'settings.share_slug_length',
    );
  });

  it('never persists credential or session values, even when callers pass whole rows', async () => {
    const db = database(env.DB);
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, admin.id));
    secrets.push(key.secretHash, key.keyId);
    const activeSessions = await db
      .select({ hash: sessions.hash })
      .from(sessions);
    secrets.push(...activeSessions.map((session) => session.hash));
    const row = await auditEvent(db, admin.id, 'user.updated', member.id, {
      before: { ...key, displayName: 'Before' },
      after: { ...key, displayName: 'After' },
      context: { ...key, reason: 'Safety regression' },
    });
    await db.insert(auditLog).values(row);
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const secret of secrets) expect(all).not.toContain(secret);
    expect(all).not.toContain('secretHash');
    expect(all).not.toContain('keyId');
  });
});

describe('image management integration', () => {
  it('prepares authorized originals without exposing storage paths and enforces media permissions', async () => {
    const imageId = await seedImage();
    await env.BUCKET.put(`objects/${imageId}`, 'original');
    const db = database(env.DB);
    await db
      .update(images)
      .set({ previewKey: `previews/${imageId}` })
      .where(eq(images.id, imageId));
    await env.BUCKET.put(`previews/${imageId}`, 'preview');
    const manifest = await prepareDownloads(env.DB, env.BUCKET, member, [
      imageId,
      imageId,
      id('img'),
    ]);
    expect(manifest.images).toEqual([
      {
        id: imageId,
        filename: 'Evidence.png',
        mime: 'image/png',
        size: 8,
        url: `/api/media/${imageId}?download`,
      },
    ]);
    expect(manifest.failed).toHaveLength(1);
    const missingOriginal = await prepareDownloads(env.DB, env.BUCKET, member, [
      await seedImage(),
    ]);
    expect(missingOriginal.images).toEqual([]);
    expect(missingOriginal.failed[0].message).toBe('Original image not found.');
    expect(JSON.stringify(manifest)).not.toContain('objects/');
    expect(JSON.stringify(manifest)).not.toContain('previews/');
    const denied = await prepareDownloads(env.DB, env.BUCKET, member, [
      await seedImage(admin),
    ]);
    expect(denied.images).toEqual([]);
    expect(denied.failed[0].code).toBe('NOT_FOUND');
    const event = {
      request: new Request(
        `https://example.com/api/media/${imageId}?download&preview`,
      ),
      locals: { env, user: member },
      params: { id: imageId },
      url: new URL(`https://example.com/api/media/${imageId}?download&preview`),
    } as Parameters<typeof media>[0];
    const response = await media(event);
    expect(await response.text()).toBe('original');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    const signedOut = await media({ ...event, locals: { env, user: null } });
    expect(signedOut.status).toBe(401);
    const otherUser = await media({
      ...event,
      locals: { env, user: { ...member, id: id('usr') } },
    });
    expect(otherUser.status).toBe(404);
  });
  it('keeps per-image failures actionable while deleting successful images', async () => {
    const first = await seedImage();
    const second = await seedImage();
    let rejectBatch = true;
    const faulty: D1Database = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch<T>(statements: D1PreparedStatement[]) {
        if (rejectBatch) {
          rejectBatch = false;
          throw new Error('database unavailable');
        }
        return env.DB.batch<T>(statements);
      },
      exec: env.DB.exec.bind(env.DB),
      withSession: env.DB.withSession.bind(env.DB),
      dump: env.DB.dump.bind(env.DB),
    };
    const result = await deleteImages(faulty, env.BUCKET, member, [
      first,
      second,
      second,
    ]);
    expect(result.deletedIds).toEqual([second]);
    expect(result.failed).toEqual([
      {
        id: first,
        code: 'UNAVAILABLE',
        message: 'Could not process this image. Please try again.',
      },
    ]);
    const repeated = await deleteImages(env.DB, env.BUCKET, member, [second]);
    expect(repeated.alreadyRemovedIds).toEqual([second]);
    const deniedImage = await seedImage(admin);
    await expect(
      deleteImages(env.DB, env.BUCKET, member, [first, deniedImage]),
    ).rejects.toThrow('Image not found');
    const [unchanged] = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, first));
    expect(unchanged.deletedAt).toBeNull();
  });
  it('audits a concurrent tombstone transition only once', async () => {
    const imageId = await seedImage();
    await Promise.all([
      deleteImages(env.DB, env.BUCKET, member, [imageId]),
      deleteImages(env.DB, env.BUCKET, member, [imageId]),
    ]);
    const logs = await database(env.DB)
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, imageId));
    expect(logs.filter((log) => log.action === 'image.deleted')).toHaveLength(
      1,
    );
  });
});
