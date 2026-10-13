ALTER TABLE users ADD COLUMN onboardingStatus TEXT NOT NULL DEFAULT 'pending' CONSTRAINT valid_onboarding_status CHECK(onboardingStatus IN ('pending','completed','skipped','exempt'));
--> statement-breakpoint
ALTER TABLE users ADD COLUMN onboardingStep INTEGER NOT NULL DEFAULT 0 CONSTRAINT valid_onboarding_step CHECK(onboardingStep BETWEEN 0 AND 6);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN bootstrapAdministrator INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE users SET onboardingStatus='exempt';
--> statement-breakpoint
UPDATE users SET bootstrapAdministrator=1 WHERE id IN (SELECT targetId FROM audit_log WHERE action='admin.bootstrapped');
