import { desc, eq, inArray, sql } from 'drizzle-orm';

import { presentAudit } from './audit-presentation';
import { requireAdmin } from './auth';
import type { Database, User } from './db';
import { aliases, auditLog, deliveryDomains, images, users } from './schema';

export async function presentAuditCollection(
  db: Database,
  logs: (typeof auditLog.$inferSelect)[],
) {
  const auditIds = [
    ...new Set(
      logs
        .flatMap((log) => [log.actorId, log.targetId])
        .filter((value): value is string => value !== null),
    ),
  ];
  const auditNames = new Map<string, string>();
  const auditUsers = new Set<string>();
  const auditImages = new Set<string>();
  for (let offset = 0; offset < auditIds.length; offset += 80) {
    const lookupIds = auditIds.slice(offset, offset + 80);
    const [people, pictures, domains, links] = await Promise.all([
      db
        .select({ id: users.id, name: users.displayName })
        .from(users)
        .where(inArray(users.id, lookupIds)),
      db
        .select({
          id: images.id,
          name: images.filename,
          deletedAt: images.deletedAt,
        })
        .from(images)
        .where(inArray(images.id, lookupIds)),
      db
        .select({ id: deliveryDomains.id, name: deliveryDomains.hostname })
        .from(deliveryDomains)
        .where(inArray(deliveryDomains.id, lookupIds)),
      db
        .select({
          id: aliases.id,
          slug: aliases.slug,
          deliveryHostname: deliveryDomains.hostname,
        })
        .from(aliases)
        .innerJoin(
          deliveryDomains,
          eq(deliveryDomains.id, aliases.deliveryDomainId),
        )
        .where(inArray(aliases.id, lookupIds)),
    ]);
    for (const entry of people) auditUsers.add(entry.id);
    for (const entry of pictures)
      if (entry.deletedAt === null) auditImages.add(entry.id);
    for (const entry of [...people, ...pictures, ...domains])
      auditNames.set(entry.id, entry.name);
    for (const entry of links)
      auditNames.set(entry.id, `${entry.deliveryHostname}/${entry.slug}`);
  }

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    actorId: log.actorId,
    actorHref:
      log.actorId && auditUsers.has(log.actorId)
        ? `/admin/users/${encodeURIComponent(log.actorId)}`
        : null,
    targetHref:
      log.targetId && auditImages.has(log.targetId)
        ? `/admin/images/${encodeURIComponent(log.targetId)}`
        : null,
    targetId: log.targetId,
    createdAt: log.createdAt,
    ...presentAudit(log, {
      actor:
        auditNames.get(log.actorId ?? '') ?? log.actorId ?? 'System / unknown',
      target: auditNames.get(log.targetId ?? '') ?? log.targetId ?? 'Workspace',
    }),
  }));
}
export async function recentUserAudit(
  db: Database,
  actor: User | null,
  userId: string,
) {
  requireAdmin(actor);
  const logs = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.actorId, userId))
    .orderBy(desc(auditLog.createdAt), sql`audit_log.rowid desc`)
    .limit(5);
  return presentAuditCollection(db, logs);
}
export type PresentedAudit = Awaited<
  ReturnType<typeof presentAuditCollection>
>[number];
