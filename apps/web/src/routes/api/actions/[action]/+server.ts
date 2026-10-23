import { auditActorIp, auditEvent, type AuditValues } from '@hearth/core/audit';
import {
  authenticateKey,
  createSession,
  createUser,
  requireAdmin,
  requireUser,
  rotateKey,
} from '@hearth/core/auth';
import { AppError, id, idSchema, now } from '@hearth/core/common';
import { verify } from '@hearth/core/crypto';
import { database } from '@hearth/core/db';
import {
  changeDeliveryAvailability,
  domainDetails,
  domainMembers,
  saveDeliveryDomain,
  setDeliveryPreference,
  setPrimaryDeliveryDomain,
} from '@hearth/core/delivery-domains';
import { digest } from '@hearth/core/digest';
import {
  displayNamePolicySchema,
  getDisplayNameRestriction,
} from '@hearth/core/display-name-policy';
import { validateDeliveryDomain } from '@hearth/core/domain-validation';
import type { Env } from '@hearth/core/env';
import {
  expiryOverridesSchema,
  expiryPolicySchema,
} from '@hearth/core/expiry-policy';
import { getInstanceExpiryPolicy } from '@hearth/core/expiry-policy-store';
import { imageSearchQuery } from '@hearth/core/image-search-query';
import {
  changeImageExpiry,
  deleteImage,
  deleteImages,
  imageExpiryOptions,
  prepareDownloads,
} from '@hearth/core/images';
import { linkSearchQuery } from '@hearth/core/link-search';
import {
  changeLinkExpiry,
  createLink,
  deleteLinks,
  linkCreationOptions,
  linkExpiryOptions,
  makePrimaryLink,
  selectedLinks,
} from '@hearth/core/links';
import {
  advanceOnboarding,
  armOnboardingUpload,
  finishOnboarding,
  skipOnboardingUpload,
} from '@hearth/core/onboarding';
import { savePreferences } from '@hearth/core/preferences';
import { contentUrl } from '@hearth/core/public-urls';
import {
  aliases,
  apiKeys,
  auditLog,
  deleteTokens,
  deliveryDomains,
  findings,
  images,
  reconciliation,
  sessions,
  settings,
  storageCapacity,
  storageObjects,
  storageStats,
  users,
} from '@hearth/core/schema';
import { rateLimit, turnstile } from '@hearth/core/security';
import { setShareSlugDefault } from '@hearth/core/share-slugs';
import { sharexConfig } from '@hearth/core/sharex';
import { deleteStoredObjects } from '@hearth/core/storage';
import type { RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { body, failure } from '#lib/server/http.ts';

async function startMaintenance(environment: Env, runId: string) {
  try {
    await environment.MAINTENANCE.getByName('instance').start(runId);
  } catch {
    await environment.DB.prepare(
      "UPDATE reconciliation_runs SET status='failed',error='Maintenance could not start. Retry to continue from saved progress.',updatedAt=? WHERE id=? AND status='running'",
    )
      .bind(now(), runId)
      .run();
    console.error(
      JSON.stringify({ event: 'maintenance.dispatch_failed', runId }),
    );
    throw new AppError(
      503,
      'MAINTENANCE_UNAVAILABLE',
      'Maintenance could not start. Retry the storage scan.',
    );
  }
}

export const POST: RequestHandler<{ action: string }> = async ({
  request,
  locals,
  cookies,
  params,
}) => {
  const environment = locals.env,
    database_ = database(environment.DB),
    timestamp = now(),
    actorIp = auditActorIp(request),
    cookie =
      environment.ENVIRONMENT === 'production'
        ? '__Host-hearth'
        : 'hearth-local';
  try {
    const largeSelection = [
      'delivery-domain-save',
      'image-expiry',
      'image-expiry-options',
      'alias-expiry',
      'alias-expiry-options',
    ].includes(params.action);
    const input = z
      .record(z.string(), z.unknown())
      .parse(await body(request, largeSelection ? 2_000_000 : 16_384));
    if (params.action === 'login') {
      await rateLimit(
        environment.LOGIN_LIMIT,
        await digest(
          request.headers.get('cf-connecting-ip') || 'local',
          'login-ip',
        ),
      );
      await turnstile(input.token, environment, 'login');
      const { user, key } = await authenticateKey(
        environment.DB,
        z.string().max(160).parse(input.key),
      );
      const token = await createSession(
        environment.DB,
        user.id,
        key.version,
        actorIp,
      );
      cookies.set(cookie, token, {
        path: '/',
        httpOnly: true,
        secure: environment.ENVIRONMENT === 'production',
        sameSite: 'lax',
        maxAge: 30 * 86_400,
      });
      return Response.json({
        ok: true,
        userId: user.id,
        destination: user.onboardingStatus === 'pending' ? '/onboarding' : '/',
      });
    }
    if (params.action === 'delete-token' || params.action === 'delete-info') {
      await rateLimit(
        environment.SENSITIVE_LIMIT,
        await digest(
          request.headers.get('cf-connecting-ip') || 'local',
          'delete-ip',
        ),
      );
      if (params.action === 'delete-token')
        await turnstile(input.turnstile, environment, 'delete');
      const imageId = idSchema.parse(input.imageId),
        token = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(input.token);
      const [stored] = await database_
        .select()
        .from(deleteTokens)
        .where(eq(deleteTokens.imageId, imageId));
      if (
        !stored ||
        stored.consumedAt ||
        !(await verify(token, stored.hash, 'delete'))
      )
        throw new AppError(
          404,
          'INVALID_DELETE_LINK',
          'This deletion link is invalid or has already been used.',
        );
      const [image] = await database_
        .select({ filename: images.filename })
        .from(images)
        .where(and(eq(images.id, imageId), isNull(images.deletedAt)));
      if (!image)
        throw new AppError(
          404,
          'INVALID_DELETE_LINK',
          'This image has already been removed.',
        );
      if (params.action === 'delete-info')
        return Response.json({ filename: image.filename });
      await deleteImage(
        environment.DB,
        environment.BUCKET,
        imageId,
        null,
        'Deletion link',
        actorIp,
      );
      return Response.json({ ok: true });
    }
    const user = requireUser(locals.user);
    await rateLimit(environment.MUTATION_LIMIT, user.id);
    const audit = (
      action: string,
      targetId: string | null = null,
      options: {
        name?: string;
        before?: AuditValues;
        after?: AuditValues;
        context?: AuditValues;
      } = {},
    ) =>
      auditEvent(database_, user.id, action, targetId, {
        ...options,
        actorIp,
      });
    switch (params.action) {
      case 'logout': {
        await database_.batch([
          database_
            .delete(sessions)
            .where(
              eq(
                sessions.hash,
                await digest(cookies.get(cookie) || '', 'session'),
              ),
            ),
          database_
            .insert(auditLog)
            .values(await audit('auth.logout', user.id)),
        ]);
        cookies.delete(cookie, { path: '/' });
        break;
      }
      case 'delivery-preference': {
        await setDeliveryPreference(
          environment.DB,
          user,
          idSchema.nullable().parse(input.deliveryDomainId),
          actorIp,
        );
        break;
      }
      case 'preferences': {
        await savePreferences(environment.DB, user, input, actorIp);
        break;
      }
      case 'onboarding-progress': {
        return Response.json(
          await advanceOnboarding(environment.DB, user, input.step, actorIp),
        );
      }
      case 'onboarding-upload-arm': {
        return Response.json(
          await armOnboardingUpload(environment.DB, user, actorIp),
        );
      }
      case 'onboarding-upload-skip': {
        return Response.json(
          await skipOnboardingUpload(environment.DB, user, actorIp),
        );
      }
      case 'onboarding-complete':
      case 'onboarding-skip': {
        return Response.json(
          await finishOnboarding(
            environment.DB,
            user,
            params.action === 'onboarding-complete' ? 'completed' : 'skipped',
            actorIp,
          ),
        );
      }
      case 'sxcu': {
        const key = z.string().max(160).parse(input.key);
        const authenticated = await authenticateKey(environment.DB, key);
        if (authenticated.user.id !== user.id)
          throw new AppError(
            403,
            'WRONG_KEY',
            'Enter your own current API key.',
          );
        await database_
          .insert(auditLog)
          .values(await audit('credential.config_exported', user.id));
        return Response.json(sharexConfig(environment.APP_ORIGIN, key));
      }
      case 'rotate': {
        await rateLimit(environment.SENSITIVE_LIMIT, user.id);
        await turnstile(input.token, environment, 'sensitive');
        const key = await rotateKey(
          environment.DB,
          user.id,
          user.id,
          false,
          actorIp,
        );
        cookies.delete(cookie, { path: '/' });
        return Response.json({
          key,
          config: sharexConfig(environment.APP_ORIGIN, key),
        });
      }
      case 'image-select-all': {
        const admin = z.boolean().parse(input.admin);
        if (admin) requireAdmin(user);
        const rows = await database_
          .select({ id: images.id })
          .from(images)
          .where(
            and(
              imageSearchQuery(
                new URLSearchParams(
                  z
                    .string()
                    .max(4000)
                    .parse(input.query ?? ''),
                ),
                admin ? undefined : user.id,
              ).filter,
            ),
          );
        return Response.json({ ids: rows.map((image) => image.id) });
      }
      case 'image-delete': {
        const ids = z.array(idSchema).min(1).max(100).parse(input.ids);
        return Response.json(
          await deleteImages(
            environment.DB,
            environment.BUCKET,
            user,
            ids,
            actorIp,
          ),
        );
      }
      case 'image-download': {
        const ids = z.array(idSchema).min(1).max(100).parse(input.ids);
        return Response.json(
          await prepareDownloads(environment.DB, environment.BUCKET, user, ids),
        );
      }
      case 'image-expiry-options': {
        return Response.json(
          await imageExpiryOptions(
            environment.DB,
            user,
            z.array(idSchema).min(1).parse(input.ids),
          ),
        );
      }
      case 'image-expiry': {
        await changeImageExpiry(
          environment.DB,
          user,
          z.array(idSchema).min(1).parse(input.ids),
          z.string().parse(input.expiry),
          typeof input.expiresAt === 'string' ? input.expiresAt : undefined,
          actorIp,
        );
        break;
      }
      case 'alias-select-all': {
        const admin = z.boolean().parse(input.admin);
        if (admin) requireAdmin(user);
        const parameters = new URLSearchParams(
          z
            .string()
            .max(4000)
            .parse(input.query ?? ''),
        );
        const query = linkSearchQuery(parameters, admin ? undefined : user.id);
        const rows = await database_
          .select({ id: aliases.id })
          .from(aliases)
          .innerJoin(images, eq(images.id, aliases.imageId))
          .innerJoin(
            deliveryDomains,
            eq(deliveryDomains.id, aliases.deliveryDomainId),
          )
          .innerJoin(users, eq(users.id, images.userId))
          .where(query.filter)
          .orderBy(...query.order);
        return Response.json({ ids: rows.map((row) => row.id) });
      }
      case 'alias-create-options': {
        return Response.json(
          await linkCreationOptions(
            environment.DB,
            user,
            idSchema.parse(input.imageId),
          ),
        );
      }
      case 'alias-create': {
        return Response.json(
          await createLink(
            environment.DB,
            user,
            {
              imageId: idSchema.parse(input.imageId),
              deliveryDomainId: idSchema.parse(input.deliveryDomainId),
              slug: z.string().max(64).optional().parse(input.slug),
              expiry: z.string().parse(input.expiry),
              expiresAt: z.string().optional().parse(input.expiresAt),
            },
            actorIp,
          ),
        );
      }
      case 'alias-delete': {
        return Response.json(
          await deleteLinks(
            environment.DB,
            user,
            z.array(idSchema).min(1).max(100).parse(input.ids),
            actorIp,
          ),
        );
      }
      case 'alias-copy': {
        const ids = z.array(idSchema).min(1).max(100).parse(input.ids);
        const rows = await selectedLinks(environment.DB, user, ids);
        return Response.json({
          links: rows
            .filter(
              (row) =>
                row.link.disabledAt === null && row.image.deletedAt === null,
            )
            .map((row) => ({
              id: row.link.id,
              url: contentUrl(row.deliveryHostname, row.link.slug, environment),
            })),
        });
      }
      case 'alias-expiry-options': {
        return Response.json(
          await linkExpiryOptions(
            environment.DB,
            user,
            z.array(idSchema).min(1).parse(input.ids),
          ),
        );
      }
      case 'alias-expiry': {
        await changeLinkExpiry(
          environment.DB,
          user,
          z.array(idSchema).min(1).parse(input.ids),
          z.string().parse(input.expiry),
          z.string().optional().parse(input.expiresAt),
          actorIp,
        );
        break;
      }
      case 'alias-primary': {
        await makePrimaryLink(
          environment.DB,
          user,
          idSchema.parse(input.id),
          actorIp,
        );
        break;
      }
      default: {
        requireAdmin(user);
        await rateLimit(environment.SENSITIVE_LIMIT, `admin:${user.id}`);
        switch (params.action) {
          case 'display-name-settings': {
            const restrictDisplayNameChanges = z
              .boolean()
              .parse(input.restrictDisplayNameChanges);
            const previous = await getDisplayNameRestriction(environment.DB);
            if (previous === restrictDisplayNameChanges) break;
            await database_.batch([
              database_
                .insert(settings)
                .values({
                  key: 'restrictDisplayNameChanges',
                  value: String(restrictDisplayNameChanges),
                })
                .onConflictDoUpdate({
                  target: settings.key,
                  set: { value: String(restrictDisplayNameChanges) },
                }),
              database_.insert(auditLog).values(
                await audit(
                  'settings.display_name_policy',
                  'restrictDisplayNameChanges',
                  {
                    name: 'Display name policy',
                    before: { restrictDisplayNameChanges: previous },
                    after: { restrictDisplayNameChanges },
                  },
                ),
              ),
            ]);
            break;
          }
          case 'user-display-name-policy': {
            const userId = idSchema.parse(input.userId);
            const displayNamePolicy = displayNamePolicySchema.parse(
              input.displayNamePolicy,
            );
            const [target] = await database_
              .select()
              .from(users)
              .where(
                and(eq(users.id, userId), sql`${users.status} != 'deleted'`),
              );
            if (!target)
              throw new AppError(404, 'NOT_FOUND', 'User not found.');
            if (target.displayNamePolicy === displayNamePolicy) break;
            await database_.batch([
              database_
                .update(users)
                .set({ displayNamePolicy, updatedAt: timestamp })
                .where(
                  and(eq(users.id, userId), sql`${users.status} != 'deleted'`),
                ),
              database_.insert(auditLog).values(
                await audit('user.display_name_policy', userId, {
                  before: { displayNamePolicy: target.displayNamePolicy },
                  after: { displayNamePolicy },
                }),
              ),
            ]);
            break;
          }
          case 'share-slug-settings': {
            await setShareSlugDefault(
              environment.DB,
              input.length,
              user,
              actorIp,
            );
            break;
          }
          case 'expiry-policy': {
            const policy = expiryPolicySchema.parse(input.policy);
            const previous = await getInstanceExpiryPolicy(environment.DB);
            if (JSON.stringify(previous) === JSON.stringify(policy)) break;
            await database_.batch([
              database_
                .insert(settings)
                .values({ key: 'expiryPolicy', value: JSON.stringify(policy) })
                .onConflictDoUpdate({
                  target: settings.key,
                  set: { value: JSON.stringify(policy) },
                }),
              database_.insert(auditLog).values(
                await audit('settings.expiry_policy', 'expiryPolicy', {
                  name: 'Expiry policy',
                  before: previous,
                  after: policy,
                }),
              ),
            ]);
            break;
          }
          case 'user-expiry-policy': {
            const userId = idSchema.parse(input.userId);
            const parsed = expiryOverridesSchema.nullable().parse(input.policy);
            const policy =
              parsed && Object.keys(parsed).length > 0 ? parsed : null;
            const [target] = await database_
              .select()
              .from(users)
              .where(
                and(eq(users.id, userId), sql`${users.status} != 'deleted'`),
              );
            if (!target)
              throw new AppError(404, 'NOT_FOUND', 'User not found.');
            const values = (overrides: typeof policy): AuditValues => ({
              requireExpiryOverride: overrides?.requireExpiry ?? null,
              maxLifetimeOverride:
                overrides?.maxLifetimeSeconds === undefined
                  ? 'Instance default'
                  : overrides.maxLifetimeSeconds,
            });
            const before = values(target.expiryPolicy),
              after = values(policy);
            if (JSON.stringify(before) === JSON.stringify(after)) break;
            await database_.batch([
              database_
                .update(users)
                .set({ expiryPolicy: policy, updatedAt: timestamp })
                .where(eq(users.id, userId)),
              database_
                .insert(auditLog)
                .values(
                  await audit('user.expiry_policy', userId, { before, after }),
                ),
            ]);
            break;
          }
          case 'user-create': {
            await turnstile(input.token, environment, 'sensitive');
            const result = await createUser(
              environment.DB,
              z.string().trim().min(1).max(80).parse(input.displayName),
              z.enum(['user', 'admin']).parse(input.role),
              user.id,
              actorIp,
            );
            return Response.json(result);
          }
          case 'user-update': {
            const userId = idSchema.parse(input.userId),
              status = z.enum(['active', 'disabled']).parse(input.status),
              displayName = z
                .string()
                .trim()
                .min(1)
                .max(80)
                .parse(input.displayName),
              quotaBytes = z
                .number()
                .int()
                .nonnegative()
                .nullable()
                .parse(input.quotaBytes);
            const [target] = await database_
              .select()
              .from(users)
              .where(
                and(eq(users.id, userId), sql`${users.status} != 'deleted'`),
              );
            if (!target)
              throw new AppError(404, 'NOT_FOUND', 'User not found.');
            await database_.batch([
              database_
                .update(users)
                .set({ status, displayName, quotaBytes, updatedAt: timestamp })
                .where(
                  and(eq(users.id, userId), sql`${users.status} != 'deleted'`),
                ),
              database_.delete(sessions).where(eq(sessions.userId, userId)),
              database_.insert(auditLog).values(
                await audit('user.updated', userId, {
                  after: { status, displayName, quotaBytes },
                  context: { sessionsRevoked: true },
                }),
              ),
            ]);
            break;
          }
          case 'user-reset': {
            await turnstile(input.token, environment, 'sensitive');
            const userId = idSchema.parse(input.userId);
            const [target] = await database_
              .select()
              .from(users)
              .where(and(eq(users.id, userId), eq(users.status, 'active')));
            if (!target)
              throw new AppError(404, 'NOT_FOUND', 'Active user not found.');
            return Response.json({
              key: await rotateKey(
                environment.DB,
                userId,
                user.id,
                true,
                actorIp,
              ),
            });
          }
          case 'user-delete': {
            await turnstile(input.token, environment, 'sensitive');
            const userId = idSchema.parse(input.userId);
            const [target] = await database_
              .select()
              .from(users)
              .where(
                and(eq(users.id, userId), sql`${users.status} != 'deleted'`),
              );
            if (!target)
              throw new AppError(404, 'NOT_FOUND', 'User not found.');
            const affectedImages = await database_
              .select({ id: images.id, filename: images.filename })
              .from(images)
              .where(and(eq(images.userId, userId), isNull(images.deletedAt)));
            await database_.batch([
              database_
                .update(users)
                .set({
                  status: 'deleted',
                  updatedAt: timestamp,
                  preferredDeliveryDomainId: null,
                })
                .where(eq(users.id, userId)),
              database_.delete(sessions).where(eq(sessions.userId, userId)),
              database_
                .update(images)
                .set({ deletedAt: timestamp })
                .where(
                  and(eq(images.userId, userId), isNull(images.deletedAt)),
                ),
              database_.delete(apiKeys).where(eq(apiKeys.userId, userId)),
              database_.insert(auditLog).values(
                await audit('user.deleted', userId, {
                  after: { status: 'deleted' },
                  context: {
                    sessionsRevoked: true,
                    imagesDeleted: affectedImages.map(
                      (image) => `${image.filename} (${image.id})`,
                    ),
                  },
                }),
              ),
            ]);
            break;
          }
          case 'delivery-domain-save': {
            return Response.json(
              await saveDeliveryDomain(
                environment.DB,
                user,
                input,
                environment,
                actorIp,
              ),
            );
          }
          case 'delivery-domain-details': {
            return Response.json(
              await domainDetails(
                environment.DB,
                user,
                idSchema.parse(input.id),
              ),
            );
          }
          case 'delivery-domain-members': {
            return Response.json(
              await domainMembers(
                environment.DB,
                user,
                idSchema.nullable().parse(input.id),
                new URLSearchParams(
                  z
                    .string()
                    .max(4000)
                    .parse(input.query ?? ''),
                ),
              ),
            );
          }
          case 'delivery-domain-validate': {
            return Response.json(
              await validateDeliveryDomain(
                environment,
                user,
                idSchema.parse(input.id),
              ),
            );
          }
          case 'delivery-domain-primary': {
            await setPrimaryDeliveryDomain(
              environment.DB,
              user,
              idSchema.parse(input.id),
              z.number().int().nonnegative().parse(input.revision),
              actorIp,
            );
            break;
          }
          case 'delivery-domain-availability':
          case 'delivery-domain-remove': {
            await changeDeliveryAvailability(
              environment.DB,
              user,
              {
                id: idSchema.parse(input.id),
                revision: z.number().int().nonnegative().parse(input.revision),
                enabled: z.boolean().parse(input.enabled),
                expectedLinkCount: z
                  .number()
                  .int()
                  .nonnegative()
                  .parse(input.expectedLinkCount),
                replacementId: idSchema.nullable().parse(input.replacementId),
                clearPrimary: z.boolean().parse(input.clearPrimary),
                remove: params.action === 'delivery-domain-remove',
              },
              actorIp,
            );
            break;
          }
          case 'storage-limit': {
            const limitBytes = z
              .number()
              .int()
              .min(1)
              .max(Number.MAX_SAFE_INTEGER)
              .nullable()
              .parse(input.limitBytes);
            const [previous] = await database_
              .select()
              .from(storageCapacity)
              .where(eq(storageCapacity.id, 1));
            if (limitBytes !== null && !previous.ready)
              throw new AppError(
                409,
                'STORAGE_INITIALIZATION_REQUIRED',
                'Initialize storage accounting before enabling a global limit. Completed files will be preserved.',
              );
            await database_.batch([
              database_
                .update(storageCapacity)
                .set({ limitBytes })
                .where(eq(storageCapacity.id, 1)),
              database_.insert(auditLog).values(
                await audit('storage.limit_updated', 'storage', {
                  name: 'Global storage limit',
                  before: { limitBytes: previous.limitBytes },
                  after: { limitBytes },
                }),
              ),
            ]);
            break;
          }
          case 'maintenance-pause':
          case 'maintenance-resume': {
            const paused = params.action === 'maintenance-pause';
            await environment.MAINTENANCE.getByName('instance').control(
              paused,
              await audit(
                paused ? 'maintenance.paused' : 'maintenance.resumed',
                'maintenance',
                { name: 'Maintenance' },
              ),
            );
            break;
          }
          case 'reconcile': {
            const matchingReconciliation = await database_
              .select()
              .from(reconciliation)
              .where(eq(reconciliation.status, 'running'));
            if (matchingReconciliation.length > 0)
              throw new AppError(
                409,
                'RUNNING',
                'A reconciliation is already running.',
              );
            const retryId =
              input.id === undefined ? null : idSchema.parse(input.id);
            if (retryId) {
              const retryEvent = await audit(
                'storage.reconciliation',
                retryId,
                {
                  name: 'Storage scan',
                  context: { reason: 'Administrator retry' },
                },
              );
              const results = await environment.DB.batch([
                environment.DB.prepare(
                  "UPDATE reconciliation_runs SET status='running',attempt=attempt+1,error=NULL,updatedAt=? WHERE id=? AND status='failed'",
                ).bind(timestamp, retryId),
                environment.DB.prepare(
                  "INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,'storage.reconciliation',?,?,? WHERE changes()>0",
                ).bind(
                  id('evt'),
                  user.id,
                  retryId,
                  retryEvent.metadata,
                  timestamp,
                ),
              ]);
              if (!results[0].meta.changes)
                throw new AppError(
                  409,
                  'SCAN_CHANGED',
                  'This scan cannot be retried. Refresh and try again.',
                );
              await startMaintenance(environment, retryId);
              break;
            }
            const runId = id('rec');
            const event = await audit('storage.reconciliation', runId, {
              name: 'Storage reconciliation',
              context: { reason: 'Administrator request' },
            });
            const created = await environment.DB.batch([
              environment.DB.prepare(
                "INSERT INTO reconciliation_runs(id,status,startedAt) SELECT ?,'running',? WHERE NOT EXISTS(SELECT 1 FROM reconciliation_runs WHERE status='running') ON CONFLICT DO NOTHING",
              ).bind(runId, timestamp),
              environment.DB.prepare(
                "INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,'storage.reconciliation',?,?,? WHERE changes()>0",
              ).bind(event.id, user.id, runId, event.metadata, timestamp),
            ]);
            if (!created[0].meta.changes)
              throw new AppError(
                409,
                'RUNNING',
                'A reconciliation is already running.',
              );
            await startMaintenance(environment, runId);
            break;
          }
          case 'finding-resolve': {
            const findingId = idSchema.parse(input.id);
            const [finding] = await database_
              .select()
              .from(findings)
              .where(
                and(eq(findings.id, findingId), isNull(findings.resolvedAt)),
              );
            if (!finding)
              throw new AppError(404, 'NOT_FOUND', 'Finding not found.');
            const repairs = [];
            let repairBefore: AuditValues = {},
              repairAfter: AuditValues = {};
            if (finding.kind === 'orphan' && finding.objectKey) {
              const matchingImages = await database_
                .select()
                .from(images)
                .where(
                  sql`${images.objectKey}=${finding.objectKey} OR ${images.previewKey}=${finding.objectKey}`,
                );
              if (matchingImages.length > 0)
                throw new AppError(
                  409,
                  'OBJECT_REFERENCED',
                  'The object is now referenced and cannot be removed.',
                );
              const entry = await environment.DB.prepare(
                'SELECT state FROM storage_objects WHERE key=?',
              )
                .bind(finding.objectKey)
                .first<{ state: string }>();
              if (entry && entry.state !== 'live')
                throw new AppError(
                  409,
                  'UPLOAD_IN_PROGRESS',
                  'This file belongs to an upload or recovery operation. Cleanup will handle it safely.',
                );
              await deleteStoredObjects(environment.DB, environment.BUCKET, [
                finding.objectKey,
              ]);
            } else if (finding.kind === 'physical-size' && finding.objectKey) {
              const object = await environment.BUCKET.head(finding.objectKey);
              if (!object)
                throw new AppError(
                  409,
                  'OBJECT_CHANGED',
                  'The file is now missing. Run another scan.',
                );
              repairs.push(
                database_
                  .update(storageObjects)
                  .set({ storedBytes: object.size })
                  .where(
                    and(
                      eq(storageObjects.key, finding.objectKey),
                      eq(storageObjects.state, 'live'),
                    ),
                  ),
              );
            } else if (
              finding.kind === 'physical-missing' &&
              finding.objectKey
            ) {
              if (await environment.BUCKET.head(finding.objectKey))
                throw new AppError(
                  409,
                  'OBJECT_RESTORED',
                  'The file has been restored. Run another scan.',
                );
              await deleteStoredObjects(environment.DB, environment.BUCKET, [
                finding.objectKey,
              ]);
              repairs.push(
                database_
                  .update(images)
                  .set({ previewKey: null, previewSize: 0 })
                  .where(eq(images.previewKey, finding.objectKey)),
              );
            } else if (finding.kind === 'ledger') {
              repairs.push(
                database_
                  .update(storageCapacity)
                  .set({
                    persistedBytes: sql`(SELECT coalesce(sum(storedBytes),0) FROM storage_objects)`,
                    reservedBytes: sql`(SELECT coalesce(sum(reservedBytes),0) FROM storage_objects)`,
                  })
                  .where(eq(storageCapacity.id, 1)),
              );
            } else if (finding.kind === 'accounting') {
              const details = z
                .object({ userId: idSchema })
                .parse(JSON.parse(finding.details));
              const [previous] = await database_
                .select()
                .from(storageStats)
                .where(eq(storageStats.userId, details.userId));
              const [actual] = await database_
                .select({
                  bytes: sql<number>`coalesce(sum(size),0)`,
                  previewBytes: sql<number>`coalesce(sum(previewSize),0)`,
                  imageCount: sql<number>`count(*)`,
                })
                .from(images)
                .where(
                  and(
                    eq(images.userId, details.userId),
                    isNull(images.deletedAt),
                  ),
                );
              repairBefore = previous ?? {};
              repairAfter = actual;
              repairs.push(
                database_
                  .update(storageStats)
                  .set({
                    bytes: sql`(select coalesce(sum(size),0) from images where userId=${details.userId} and deletedAt is null)`,
                    previewBytes: sql`(select coalesce(sum(previewSize),0) from images where userId=${details.userId} and deletedAt is null)`,
                    imageCount: sql`(select count(*) from images where userId=${details.userId} and deletedAt is null)`,
                  })
                  .where(eq(storageStats.userId, details.userId)),
              );
            } else if (finding.kind === 'missing' && finding.imageId) {
              if (await environment.BUCKET.head(finding.objectKey!))
                throw new AppError(
                  409,
                  'OBJECT_RESTORED',
                  'The original has been restored. Run reconciliation again.',
                );
              await deleteImage(
                environment.DB,
                environment.BUCKET,
                finding.imageId,
                user.id,
                'Missing storage object',
                actorIp,
              );
            } else
              throw new AppError(
                400,
                'UNSUPPORTED_FINDING',
                'This finding needs another storage scan before repair.',
              );
            await database_.batch([
              database_
                .update(findings)
                .set({ resolvedAt: timestamp })
                .where(eq(findings.id, findingId)),
              ...repairs,
              database_
                .update(storageCapacity)
                .set({
                  blocked: sql`CASE WHEN ready=0 AND multipartVerified=0 THEN blocked ELSE EXISTS(SELECT 1 FROM reconciliation_findings WHERE resolvedAt IS NULL AND kind IN ('ledger','physical-size')) END`,
                })
                .where(eq(storageCapacity.id, 1)),
              database_.insert(auditLog).values(
                await audit('storage.finding_resolved', findingId, {
                  name: `${finding.kind} finding`,
                  before: repairBefore,
                  after: repairAfter,
                  context: {
                    kind: finding.kind,
                    objectKey: finding.objectKey,
                    imageId: finding.imageId,
                    runId: finding.runId,
                  },
                }),
              ),
            ]);
            const pendingCleanup = finding.imageId
              ? await environment.DB.prepare(
                  'SELECT id FROM images WHERE id=? AND deletedAt IS NOT NULL AND purgedAt IS NULL',
                )
                  .bind(finding.imageId)
                  .first()
              : null;
            return Response.json({
              ok: true,
              cleanupPending: Boolean(pendingCleanup),
            });
          }
          case 'settings': {
            const siteName = z
              .string()
              .trim()
              .min(1)
              .max(60)
              .parse(input.siteName);
            const [previous] = await database_
              .select()
              .from(settings)
              .where(eq(settings.key, 'siteName'));
            await database_.batch([
              database_
                .insert(settings)
                .values({ key: 'siteName', value: siteName })
                .onConflictDoUpdate({
                  target: settings.key,
                  set: { value: siteName },
                }),
              database_.insert(auditLog).values(
                await audit('settings.updated', 'siteName', {
                  name: 'Workspace settings',
                  before: { siteName: previous?.value ?? 'hearth' },
                  after: { siteName },
                }),
              ),
            ]);
            break;
          }
          default: {
            throw new AppError(404, 'NOT_FOUND', 'Action not found.');
          }
        }
      }
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (
      params.action === 'login' &&
      error instanceof AppError &&
      error.code === 'INVALID_KEY'
    ) {
      await database_.insert(auditLog).values(
        await auditEvent(database_, null, 'auth.login_failed', null, {
          actorIp,
          context: { reason: 'Invalid credentials or inactive account' },
        }),
      );
    }
    if (error instanceof AppError && error.code === 'FORBIDDEN') {
      await database_.insert(auditLog).values(
        await auditEvent(
          database_,
          locals.user?.id ?? null,
          'auth.access_denied',
          null,
          {
            actorIp,
            context: { reason: 'Administrator access required' },
          },
        ),
      );
    }
    return failure(error, locals.env.ENVIRONMENT);
  }
};
