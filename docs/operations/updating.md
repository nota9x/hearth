# Update Hearth

An update changes three Workers and may change D1. Back up first and review pending
migrations; rolling back Worker code does not roll back the database.

## 1. Prepare the update

1. Identify your current source revision, deployed Worker versions, and applied
   migrations. Save your three production configurations and secret records.
2. Read the target release notes and pending SQL, including handwritten migrations.
   Do not assume all migrations are additive.
3. Take a [coordinated backup](backups-and-recovery.md) and retain the source revision
   that matches it. Arrange downtime when migrations and runtime versions differ.
4. Preserve local source changes. Obtain the intended revision from your actual
   repository or release source; this checkout does not declare a canonical remote.

For a Git checkout, these commands inspect and fetch without choosing your target:

```sh
git status --short
git fetch --tags origin
```

`origin` must be your actual remote. Select the reviewed target tag/commit using
your normal Git workflow; do not reset or discard local work to force an update.
Keep an accessible copy of ignored production configuration when using a fresh checkout.

## 2. Install, build, and review configuration

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec wrangler d1 migrations list DB --remote --config apps/web/production.local.jsonc
```

Use the Node/pnpm versions required by the target manifest. Compare checked-in
Wrangler changes with your production files: `configure` does not overwrite or
refresh them. Carry over required bindings, flags, cron changes, and variables
without replacing resource IDs or losing delivery hostnames.

Keep local development files separate. Never run `pnpm db:generate` or a schema
push as part of updating an instance; apply the repository's ordered SQL.

## Migration baseline

`0000_initial.sql` creates the current schema on an empty database. The previous
migration history has been removed; databases using that history require a fresh
installation rather than applying this baseline over existing tables.

## 3. Migrate and deploy together

For pending schema/runtime changes, stop writers using the
[maintenance window](backups-and-recovery.md#establish-a-maintenance-window).
Keep maintenance's cron temporarily empty until the updated runtime is compatible
with the applied schema. Do not run old maintenance against a newly changed schema.

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config apps/web/production.local.jsonc
pnpm exec wrangler deploy --dry-run --config workers/delivery/production.local.jsonc
pnpm exec wrangler deploy --dry-run --config workers/maintenance/production.local.jsonc
pnpm exec wrangler deploy --dry-run --config apps/web/production.local.jsonc
pnpm exec wrangler deploy --config workers/delivery/production.local.jsonc
```

Review the migration target and prompt. If a migration fails, keep ingress closed,
inspect its error and migration status, and stop before deploying incompatible code.
Do not edit migration history or retry destructive SQL manually.

Once schema and current code are ready, restore the normal cron in the production
maintenance file and deploy maintenance, then web:

```sh
pnpm exec wrangler deploy --config workers/maintenance/production.local.jsonc
pnpm exec wrangler deploy --config apps/web/production.local.jsonc
```

Deploying the normal web configuration reconnects its application Custom Domain.
Do not run bootstrap again. Existing secrets persist; only change them if the update
actually requires it. A `secret put` command itself deploys a version.

## 4. Verify and recover if necessary

Sign in, upload a small image through ShareX, open its returned URL, and find it in
Images. Check delivery validation, storage health, and the next scheduled invocation.

Inspect all three Workers' [logs](maintenance.md#read-worker-logs). Confirm no pending
migrations remain and retain the backup until the update is stable.

Rollback only to code compatible with the current schema. For a data/schema problem,
use [recovery](backups-and-recovery.md), including matching R2 objects and runtime
versions; do not blindly reverse SQL or move published release tags.
