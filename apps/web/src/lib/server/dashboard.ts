import { instanceName } from '@hearth/core/branding-view';
import { idSchema, now } from '@hearth/core/common';
import { database } from '@hearth/core/db';
import {
  availableDeliveryDomains,
  deliveryDomainPage,
  selectDeliveryDomain,
} from '@hearth/core/delivery-domains';
import { imageCollection, imageFields } from '@hearth/core/image-collection';
import { imageSearchQuery } from '@hearth/core/image-search-query';
import {
  effectiveExpiry,
  LINK_PAGE_SIZE,
  linkSearchQuery,
} from '@hearth/core/link-search';
import { contentUrl } from '@hearth/core/public-urls';
import {
  aliases,
  apiKeys,
  deliveryDomains,
  findings,
  images,
  reconciliation,
  settings,
  snapshots,
  storageCapacity,
  storageStats,
  users,
} from '@hearth/core/schema';
import { paginationState } from '@hearth/core/search';
import { getShareSlugConfig } from '@hearth/core/share-slugs';
import {
  storageOverview,
  storageWarnings,
} from '@hearth/core/storage-overview';
import {
  error,
  redirect,
  type ServerLoad,
  type ServerLoadEvent,
} from '@sveltejs/kit';
import { and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';

export const load = (async (event) => {
  const { depends } = event;
  depends('app:dashboard');
  return readDashboard(event);
}) satisfies ServerLoad<{ path: string }>;

export async function readDashboard({
  locals,
  params,
  url,
}: Pick<ServerLoadEvent<{ path: string }>, 'locals' | 'params' | 'url'>) {
  const path = params.path || '',
    admin = path === 'admin' || path.startsWith('admin/');
  const parts = path.split('/'),
    section = admin ? parts[1] || 'overview' : parts[0] || 'overview',
    detailId = admin ? parts[2] : parts[1];
  if (
    ![
      'overview',
      'images',
      'links',
      'domains',
      'settings',
      ...(admin ? ['users', 'storage', 'audit-log'] : []),
    ].includes(section)
  )
    error(404, 'Page not found.');
  if (detailId && !idSchema.safeParse(detailId).success)
    error(404, 'Page not found.');
  if (
    parts.length > (admin ? 3 : 2) ||
    (detailId && section !== 'images' && !(admin && section === 'users'))
  )
    error(404, 'Page not found.');
  const user = locals.user;
  if (!user) redirect(303, '/login');
  if (user.onboardingStatus === 'pending') redirect(303, '/onboarding');
  if (admin && user.role !== 'admin')
    error(403, 'Administrator access is required.');
  const database_ = database(locals.env.DB);
  if (!admin && section === 'images') {
    await database_
      .update(users)
      .set({ seenUploadCount: sql`${users.uploadCount}` })
      .where(eq(users.id, user.id));
  }
  const page = Math.max(
      1,
      Math.min(10_000, Math.floor(Number(url.searchParams.get('page'))) || 1),
    ),
    timestamp = now();
  const allowed =
    section === 'domains'
      ? await availableDeliveryDomains(locals.env.DB, user.id)
      : [];
  const ownership = admin ? undefined : eq(images.userId, user.id);
  const searchQuery = imageSearchQuery(
    url.searchParams,
    admin ? undefined : user.id,
  );
  const { sort, query: search } = searchQuery;
  const userManagement =
    admin && section === 'users'
      ? await import('@hearth/core/user-management')
      : null;
  const userListing =
    userManagement && !detailId
      ? await userManagement.userPage(database_, user, url.searchParams)
      : null;
  const member =
    userManagement && detailId
      ? await userManagement.userDetails(database_, user, detailId)
      : null;
  if (section === 'users' && detailId && !member) error(404, 'User not found.');
  const auditCollection =
    member || (admin && section === 'audit-log')
      ? await import('@hearth/core/audit-collection')
      : null;
  const [ownedImages, activity] = member
    ? await Promise.allSettled([
        imageCollection(
          database_,
          locals.env,
          new URLSearchParams({
            page: url.searchParams.get('imagePage') || '1',
          }),
          member.user.id,
          8,
        ),
        auditCollection!.recentUserAudit(database_, user, member.user.id),
      ])
    : [];
  const memberImages =
    ownedImages?.status === 'fulfilled' ? ownedImages.value : null;
  const memberActivity = activity?.status === 'fulfilled' ? activity.value : [];
  const needsImages = ['images', 'overview'].includes(section) && !detailId;
  const collection = needsImages
    ? await imageCollection(
        database_,
        locals.env,
        url.searchParams,
        admin ? undefined : user.id,
        section === 'overview' ? 8 : 24,
      )
    : null;
  const imagePagination =
    collection?.pagination ?? paginationState(null, 0, 24);
  const needsStats = section === 'overview' || section === 'storage';
  const [stats] = needsStats
    ? await database_
        .select({
          bytes: sql<number>`coalesce(sum(${storageStats.bytes}+${storageStats.previewBytes}),0)`,
          imageCount: sql<number>`coalesce(sum(${storageStats.imageCount}),0)`,
        })
        .from(storageStats)
        .where(admin ? undefined : eq(storageStats.userId, user.id))
    : [{ bytes: 0, imageCount: 0 }];
  const [uploads] = needsStats
    ? await database_
        .select({ count: count() })
        .from(images)
        .where(
          and(
            ownership,
            gt(
              images.createdAt,
              admin
                ? Math.floor(timestamp / 86_400) * 86_400
                : Math.floor(
                    new Date(
                      new Date().getFullYear(),
                      new Date().getMonth(),
                      1,
                    ).getTime() / 1000,
                  ),
            ),
          ),
        )
    : [{ count: 0 }];
  const [linkCount] = needsStats
    ? await database_
        .select({ count: count() })
        .from(aliases)
        .innerJoin(images, eq(images.id, aliases.imageId))
        .innerJoin(
          deliveryDomains,
          eq(deliveryDomains.id, aliases.deliveryDomainId),
        )
        .innerJoin(users, eq(users.id, images.userId))
        .where(
          and(
            ownership,
            eq(deliveryDomains.enabled, true),
            eq(users.status, 'active'),
            isNull(aliases.disabledAt),
            isNull(images.deletedAt),
            or(isNull(aliases.expiresAt), gt(aliases.expiresAt, timestamp)),
            or(isNull(images.expiresAt), gt(images.expiresAt, timestamp)),
          ),
        )
    : [{ count: 0 }];
  const [key] = await database_
    .select({
      rotatedAt: apiKeys.rotatedAt,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id));
  const requestedImage =
    section === 'images'
      ? detailId
      : section === 'links'
        ? url.searchParams.get('image')
        : null;
  const matchingImages = requestedImage
    ? await database_
        .select({ ...imageFields, ownerId: users.id, owner: users.displayName })
        .from(images)
        .innerJoin(users, eq(users.id, images.userId))
        .where(
          and(
            eq(images.id, requestedImage),
            ownership,
            isNull(images.deletedAt),
          ),
        )
    : [];
  const image = section === 'images' ? (matchingImages[0] ?? null) : null;
  if (detailId && section === 'images' && !image)
    error(404, 'Image not found.');
  const linkQuery = linkSearchQuery(
    image ? new URLSearchParams({ image: image.id }) : url.searchParams,
    admin ? undefined : user.id,
    timestamp,
  );
  const linkFrom = () =>
    database_
      .select({ count: count() })
      .from(aliases)
      .innerJoin(images, eq(images.id, aliases.imageId))
      .innerJoin(
        deliveryDomains,
        eq(deliveryDomains.id, aliases.deliveryDomainId),
      )
      .innerJoin(users, eq(users.id, images.userId));
  const needsLinks = section === 'links' || !!image;
  const [linkTotal] = needsLinks
    ? await linkFrom().where(linkQuery.filter)
    : [{ count: 0 }];
  const [linkUnfiltered] = needsLinks
    ? await linkFrom().where(linkQuery.base)
    : [{ count: 0 }];
  const linkPagination = paginationState(
    url.searchParams.get(image ? 'linkPage' : 'page'),
    linkTotal.count,
    LINK_PAGE_SIZE,
  );
  const linkList = needsLinks
    ? await database_
        .select({
          alias: aliases,
          filename: images.filename,
          deliveryHostname: deliveryDomains.hostname,
          ownerId: users.id,
          owner: users.displayName,
          deliveryEnabled: deliveryDomains.enabled,
          ownerStatus: users.status,
          imageExpiresAt: images.expiresAt,
          width: images.width,
          height: images.height,
          linkCount: sql<number>`(SELECT count(*) FROM aliases a WHERE a.imageId=${images.id} AND a.disabledAt IS NULL)`,
        })
        .from(aliases)
        .innerJoin(images, eq(images.id, aliases.imageId))
        .innerJoin(
          deliveryDomains,
          eq(deliveryDomains.id, aliases.deliveryDomainId),
        )
        .innerJoin(users, eq(users.id, images.userId))
        .where(linkQuery.filter)
        .orderBy(...linkQuery.order)
        .limit(LINK_PAGE_SIZE)
        .offset(linkPagination.offset)
    : [];
  const linkDeliveryDomains =
    section === 'links'
      ? await database_
          .selectDistinct({
            id: deliveryDomains.id,
            hostname: deliveryDomains.hostname,
          })
          .from(deliveryDomains)
          .innerJoin(aliases, eq(aliases.deliveryDomainId, deliveryDomains.id))
          .innerJoin(images, eq(images.id, aliases.imageId))
          .where(
            and(
              ownership,
              isNull(aliases.disabledAt),
              isNull(images.deletedAt),
            ),
          )
          .orderBy(deliveryDomains.hostname)
      : [];
  const imageDomains =
    section === 'images'
      ? await database_
          .selectDistinct({
            id: deliveryDomains.id,
            hostname: deliveryDomains.hostname,
          })
          .from(deliveryDomains)
          .innerJoin(aliases, eq(aliases.deliveryDomainId, deliveryDomains.id))
          .innerJoin(images, eq(images.id, aliases.imageId))
          .where(
            and(
              ownership,
              isNull(images.deletedAt),
              isNull(aliases.disabledAt),
            ),
          )
          .orderBy(deliveryDomains.hostname)
      : [];
  const linkOwners =
    admin && section === 'links'
      ? await database_
          .selectDistinct({ id: users.id, name: users.displayName })
          .from(users)
          .innerJoin(images, eq(images.userId, users.id))
          .innerJoin(aliases, eq(aliases.imageId, images.id))
          .where(and(isNull(aliases.disabledAt), isNull(images.deletedAt)))
          .orderBy(users.displayName)
      : [];
  const members: {
    user: typeof users.$inferSelect;
    stats: typeof storageStats.$inferSelect | null;
  }[] = [];
  const domainPage =
    section === 'domains'
      ? await deliveryDomainPage(locals.env.DB, user, url.searchParams)
      : null;
  const deliverySelection = await selectDeliveryDomain(locals.env.DB, user.id);
  const auditSearch =
    admin && section === 'audit-log'
      ? await import('@hearth/core/audit-search-query')
      : null;
  const audit = auditSearch
    ? await auditSearch.searchAuditLog(database_, user, url.searchParams)
    : null;
  const logs = audit
    ? await auditCollection!.presentAuditCollection(database_, audit.logs)
    : [];
  const scopedId =
    admin && section === 'images'
      ? url.searchParams.get('owner')
      : admin && section === 'audit-log'
        ? url.searchParams.get('actorId')
        : null;
  const [scopedUser] = scopedId
    ? await database_
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, scopedId))
    : [];
  const runs =
    admin && section === 'storage'
      ? await database_
          .select()
          .from(reconciliation)
          .orderBy(desc(reconciliation.startedAt))
          .limit(10)
      : [];
  const storageFindings =
    admin && section === 'storage'
      ? await database_
          .select()
          .from(findings)
          .where(isNull(findings.resolvedAt))
          .orderBy(
            sql`CASE ${findings.kind} WHEN 'ledger' THEN 0 WHEN 'physical-size' THEN 1 WHEN 'missing' THEN 2 WHEN 'orphan' THEN 3 ELSE 4 END`,
            desc(findings.createdAt),
          )
          .limit(100)
      : [];
  const types =
    admin && section === 'storage'
      ? await database_
          .select({
            mime: images.mime,
            bytes: sql<number>`sum(${images.size})`,
            count: count(),
          })
          .from(images)
          .where(isNull(images.deletedAt))
          .groupBy(images.mime)
          .orderBy(desc(sql`sum(${images.size})`))
      : [];
  const history =
    admin && section === 'storage'
      ? await database_
          .select()
          .from(snapshots)
          .orderBy(desc(snapshots.day))
          .limit(30)
      : [];
  const [siteName] = await database_
    .select()
    .from(settings)
    .where(eq(settings.key, 'siteName'));
  const [capacitySettings] =
    admin && section === 'settings'
      ? await database_
          .select()
          .from(storageCapacity)
          .where(eq(storageCapacity.id, 1))
      : [];
  return {
    storageWarnings: await storageWarnings(locals.env.DB, user.id),
    storage:
      admin && section === 'storage'
        ? await storageOverview(locals.env.DB)
        : null,
    storageCapacity: capacitySettings ?? null,
    section,
    shareSlugConfiguration:
      admin && section === 'settings'
        ? await getShareSlugConfig(locals.env.DB)
        : null,
    admin,
    path,
    page:
      audit?.pagination.page ??
      (section === 'domains'
        ? domainPage!.pagination.page
        : section === 'links'
          ? linkPagination.page
          : section === 'images'
            ? imagePagination.page
            : section === 'users'
              ? (userListing?.pagination.page ?? 1)
              : page),
    imagePagination,
    linkPagination,
    userListing,
    member,
    memberImages,
    memberActivity,
    memberImagesError:
      ownedImages?.status === 'rejected'
        ? 'Images could not be loaded. Please try again.'
        : null,
    memberActivityError:
      activity?.status === 'rejected'
        ? 'Activity could not be loaded. Please try again.'
        : null,
    scopedUser: scopedUser ?? null,
    linkTotal: linkTotal.count,
    linkUnfilteredTotal: linkUnfiltered.count,
    linkDeliveryDomains,
    imageDomains,
    linkOwners,
    search: audit?.query ?? (section === 'links' ? linkQuery.query : search),
    sort: audit?.sort ?? (section === 'links' ? linkQuery.sort : sort),
    auditPagination: audit?.pagination ?? null,
    auditTotal: audit?.pagination.total ?? 0,
    auditUnfilteredTotal: audit?.unfilteredTotal ?? 0,
    auditActions: audit?.actions ?? {},
    user,
    hasUnseenImages:
      (section !== 'images' || admin) &&
      user.uploadCount > user.seenUploadCount,
    image: image || null,
    linkImage: section === 'links' ? (matchingImages[0] ?? null) : null,
    images: memberImages?.images ?? collection?.images ?? [],
    total: collection?.pagination.total ?? 0,
    unfilteredTotal: collection?.unfilteredTotal ?? 0,
    stats,
    uploads: uploads.count,
    activeLinks: linkCount.count,
    allowed,
    domainPage,
    deliverySelection,
    key: key || null,
    links: linkList.map((r) => ({
      ...r.alias,
      filename: r.filename,
      deliveryHostname: r.deliveryHostname,
      owner: admin ? r.owner : '',
      ownerId: admin ? r.ownerId : null,
      available: r.deliveryEnabled && r.ownerStatus === 'active',
      imageExpiresAt: r.imageExpiresAt,
      effectiveExpiresAt: effectiveExpiry(r.alias.expiresAt, r.imageExpiresAt),
      width: r.width,
      height: r.height,
      linkCount: r.linkCount,
      url: contentUrl(r.deliveryHostname, r.alias.slug, locals.env),
    })),
    members,
    logs,
    runs,
    findings: storageFindings,
    types,
    history,
    siteName: instanceName(siteName?.value),
    siteKey: locals.env.TURNSTILE_SITE_KEY,
  };
}
