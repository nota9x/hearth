import { z } from 'zod';

import { auditEvent } from './audit';
import { requireUser } from './auth';
import { AppError } from './common';
import { database, type User } from './db';

export function hasBootstrapSetup(user: User) {
  return user.bootstrapAdministrator && user.role === 'admin';
}

export async function advanceOnboarding(
  binding: D1Database,
  actor: User,
  input: unknown,
  actorIp?: string | null,
) {
  requireUser(actor);
  const step = z.number().int().min(0).max(6).parse(input);
  if (step === 1 && !hasBootstrapSetup(actor))
    throw new AppError(
      403,
      'FORBIDDEN',
      'Initial delivery setup is only available to the bootstrap administrator.',
    );
  return mutate(binding, actor, 'onboarding.progress', step, null, actorIp);
}

export async function finishOnboarding(
  binding: D1Database,
  actor: User,
  status: 'completed' | 'skipped',
  actorIp?: string | null,
) {
  requireUser(actor);
  return mutate(binding, actor, `onboarding.${status}`, 6, status, actorIp);
}

export async function armOnboardingUpload(
  binding: D1Database,
  actor: User,
  actorIp?: string | null,
) {
  requireUser(actor);
  const event = await auditEvent(
    database(binding),
    actor.id,
    'onboarding.upload_started',
    actor.id,
    {
      actorName: actor.displayName,
      name: actor.displayName,
      before: { onboardingUploadStatus: actor.onboardingUploadStatus },
      after: { onboardingUploadStatus: 'waiting' },
      actorIp,
    },
  );
  await binding.batch([
    binding
      .prepare(
        "UPDATE users SET onboardingUploadBaseline=uploadCount,onboardingUploadStatus='waiting',onboardingUploadImageId=NULL WHERE id=? AND (onboardingUploadStatus IS NULL OR onboardingUploadStatus='skipped')",
      )
      .bind(actor.id),
    binding
      .prepare(
        'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,?,? WHERE changes()>0',
      )
      .bind(
        event.id,
        event.actorId,
        event.action,
        event.targetId,
        event.metadata,
        event.createdAt,
      ),
  ]);
  return uploadMilestone(binding, actor.id);
}

export async function skipOnboardingUpload(
  binding: D1Database,
  actor: User,
  actorIp?: string | null,
) {
  requireUser(actor);
  const event = await auditEvent(
    database(binding),
    actor.id,
    'onboarding.upload_skipped',
    actor.id,
    {
      actorName: actor.displayName,
      name: actor.displayName,
      before: { onboardingUploadStatus: actor.onboardingUploadStatus },
      after: { onboardingUploadStatus: 'skipped' },
      actorIp,
    },
  );
  await binding.batch([
    binding
      .prepare(
        "UPDATE users SET onboardingUploadStatus='skipped',onboardingUploadImageId=NULL WHERE id=? AND (onboardingUploadStatus IS NULL OR onboardingUploadStatus='waiting')",
      )
      .bind(actor.id),
    binding
      .prepare(
        'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,?,? WHERE changes()>0',
      )
      .bind(
        event.id,
        event.actorId,
        event.action,
        event.targetId,
        event.metadata,
        event.createdAt,
      ),
  ]);
  return uploadMilestone(binding, actor.id);
}

async function uploadMilestone(binding: D1Database, userId: string) {
  return binding
    .prepare(
      'SELECT onboardingUploadStatus AS status,onboardingUploadImageId AS imageId FROM users WHERE id=?',
    )
    .bind(userId)
    .first<{
      status: User['onboardingUploadStatus'];
      imageId: string | null;
    }>();
}

async function mutate(
  binding: D1Database,
  actor: User,
  action: string,
  step: number,
  status: 'completed' | 'skipped' | null,
  actorIp?: string | null,
) {
  const event = await auditEvent(
    database(binding),
    actor.id,
    action,
    actor.id,
    {
      actorName: actor.displayName,
      name: actor.displayName,
      before: {
        onboardingStatus: actor.onboardingStatus,
        onboardingStep: actor.onboardingStep,
      },
      after: status ? { onboardingStatus: status } : { onboardingStep: step },
      actorIp,
    },
  );
  await binding.batch([
    binding
      .prepare(
        status
          ? "UPDATE users SET onboardingStatus=?,onboardingStep=6,onboardingUploadStatus=CASE WHEN onboardingUploadStatus='verified' THEN 'verified' ELSE 'skipped' END WHERE id=? AND onboardingStatus='pending'"
          : "UPDATE users SET onboardingStep=? WHERE id=? AND onboardingStatus='pending' AND onboardingStep<?",
      )
      .bind(...(status ? [status, actor.id] : [step, actor.id, step])),
    binding
      .prepare(
        'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,?,? WHERE changes()>0',
      )
      .bind(
        event.id,
        event.actorId,
        event.action,
        event.targetId,
        event.metadata,
        event.createdAt,
      ),
  ]);
  return binding
    .prepare('SELECT onboardingStatus,onboardingStep FROM users WHERE id=?')
    .bind(actor.id)
    .first<Pick<User, 'onboardingStatus' | 'onboardingStep'>>();
}
