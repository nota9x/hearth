CREATE INDEX `audit_actor_date` ON `audit_log` (`actorId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `users_date` ON `users` (`createdAt`,`id`);