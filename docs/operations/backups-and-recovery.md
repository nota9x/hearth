# Back up and recover Hearth

Hearth has no built-in coordinated backup or restore command. D1 and R2 cannot be
snapshotted atomically together. Plan a maintenance window for a consistent backup
and rehearse recovery before you need it.

## What to retain

| Data                     | Backup requirement                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1                       | Accounts, key digests, sessions, image/link records, settings, audit data, and storage ledger. Retain an SQL export and a Time Travel bookmark where available.                |
| R2                       | Completed original/preview objects with their exact keys and bytes. D1 does not contain image bytes.                                                                           |
| Deployment configuration | All three production configurations, Worker names/bindings, domain routing, cron, Turnstile hostname settings, and relevant zone rules.                                        |
| Secrets and credentials  | Separately protected Turnstile secret, administrator keys, Cloudflare access, and backup S3 credentials. Worker secret values cannot be recovered from Wrangler configuration. |
| Application revision     | Source/release matching the database, including every SQL migration and the lockfile.                                                                                          |

Encrypt exports and media backups, restrict access, and store a copy outside the
Cloudflare account's failure boundary. A daily Storage history entry is a usage
metric, not a backup. Time Travel restores D1 only and has plan-dependent retention;
check [Cloudflare's current recovery documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

## Establish a maintenance window

These actions intentionally interrupt the application. Record normal settings
before changing them. Account suspension and a low global cap do not stop every
writer or create a consistent backup.

1. Notify users and stop independent S3/dashboard/Worker jobs touching the bucket.
2. Open **Administration → Storage → Advanced diagnostics & history**, choose
   **Pause automatic maintenance**, and verify **drained** in diagnostics before
   disconnecting administrator access. This acknowledges that
   the active bounded slice has checkpointed and no maintenance slice remains
   active. A recorded pause alone is not a completed drain. Cron and pending
   Durable Object alarms honor the durable pause without changing triggers.
3. In Cloudflare **Workers & Pages → the web Worker → Domains**, detach the
   application Custom Domain temporarily. Verify the application origin no longer
   serves Hearth. Disable any additional application routes you added; keep
   `workers.dev` and preview URLs disabled. Do not deploy the normal web
   configuration while the window is in progress, because it reconnects the
   hostname. Wait for in-flight uploads, domain validation and other writers;
   maintenance pause does not stop them or external R2 modifications.

4. Before taking a clean backup, check there are no pending storage operations or
   uncertain writes requiring recovery. If there are, reconcile them under the
   current application first, then re-establish the window. An unfinished multipart
   upload is not captured by an object copy.
5. For restoration, also detach delivery Custom Domains so readers cannot observe
   a partially restored state. Keep originals and the pre-recovery backup intact.

The application has no read-only maintenance switch or public production maintenance
endpoint. This procedure combines Cloudflare routing with durable maintenance pause/drain.

## Export D1 and copy R2

Create a new private backup directory outside the repository, such as `../hearth-backup`.
Use a fresh directory for each snapshot and replace paths below if necessary.
During the maintenance window, record a bookmark and export:

```sh
pnpm exec wrangler d1 time-travel info DB --config apps/web/production.local.jsonc
pnpm exec wrangler d1 export DB --remote --config apps/web/production.local.jsonc --output ../hearth-backup/database.sql
pnpm exec wrangler d1 execute DB --remote --config apps/web/production.local.jsonc --command "SELECT type,name,sql FROM sqlite_schema WHERE type IN ('trigger','index') AND sql IS NOT NULL ORDER BY type,name" --json > ../hearth-backup/invariants.json
```

Save the bookmark, UTC backup time, database/bucket identity, and application
revision privately beside the export. D1 exports block other database requests
while running; read [import/export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
Keep the invariant inventory to verify handwritten triggers and indexes after
an import; the JSON inventory is not itself executable SQL.

Install AWS CLI and configure a bucket-scoped **Object Read only** profile called
`hearth-backup` using `aws configure --profile hearth-backup`, with region `auto`.
Use your R2 Access Key ID and Secret Access Key, not a Hearth key. For restore you
need a separate bucket-scoped **Object Read & Write** profile, such as `hearth-r2`.
See [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/) and
[AWS CLI with R2](https://developers.cloudflare.com/r2/examples/aws/aws-cli/).

Replace the account ID and bucket name with your actual values:

```sh
aws s3 sync s3://YOUR_BUCKET_NAME ../hearth-backup/objects --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com --region auto --profile hearth-backup --dryrun
aws s3 sync s3://YOUR_BUCKET_NAME ../hearth-backup/objects --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com --region auto --profile hearth-backup
aws s3api list-objects-v2 --bucket YOUR_BUCKET_NAME --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com --region auto --profile hearth-backup --output json > ../hearth-backup/objects.json
```

Use the bucket's jurisdiction-specific endpoint if applicable. Keep the default
AWS CLI pagination enabled. Review command success and the inventory's keys/sizes,
then compare local files and hashes for verification. Repeated `sync` is not a
versioned backup; keep each snapshot separate. Never add `--delete` to routine
backup or recovery commands. Refer to [AWS sync behavior](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html).

The copy preserves bytes and key paths, not all R2 object metadata, original ETags,
or unfinished parts. Hearth's delivery MIME/name comes from D1, but do not treat this
as a universal R2 configuration backup. Ensure your local filesystem can represent
all keys without case/path collisions; investigate independent/non-Hearth keys
before claiming the backup complete.

Resume by restoring administrator access, choosing **Resume maintenance**, and deploying maintenance before web when deployments are needed. If
delivery was detached, deploy delivery first. Verify login, delivery, and the next
maintenance invocation. Store the backup securely.

## Recover the same database with Time Travel

> Warning: Time Travel overwrites D1 in place and cancels in-flight queries. Restoring
> D1 can also restore old credential/session state. Make a separate backup of the
> current state and stop writers/readers first.

1. Establish the maintenance window for restoration.
2. Choose a bookmark from a coordinated backup and its matching object snapshot.
   Check the bookmark is still within your account's recovery retention.
3. Record the current bookmark before restoring. Use the chosen backup bookmark:

   ```sh
   pnpm exec wrangler d1 time-travel restore DB --bookmark YOUR_BACKUP_BOOKMARK --config apps/web/production.local.jsonc
   ```

   Review the target and confirmation. Time Travel is always remote; do not add
   `--remote`. Retain the previous bookmark returned for undoing this D1 operation.

4. Restore the matching media before exposing the application. With a verified
   local snapshot, preview and then copy it to the intended private bucket:

   ```sh
   aws s3 sync ../hearth-backup/objects s3://YOUR_BUCKET_NAME --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com --region auto --profile hearth-r2 --dryrun
   aws s3 sync ../hearth-backup/objects s3://YOUR_BUCKET_NAME --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com --region auto --profile hearth-r2
   ```

   These commands may overwrite matching keys but retain extra objects. Preserve
   extras until their ownership is understood; do not run automatic orphan deletion
   during a partial restore.

5. Use Worker code and configurations compatible with the restored schema. Do not
   apply current migrations before verifying a restore of an older backup.
6. Inspect migration history, trigger/index inventory, image records, and restored
   objects. Original hashes recorded in D1 can be compared with recovered bytes.
   An R2 ETag may change after re-upload; it is not universally a content hash.
7. Re-establish storage accounting with the supported
   [initialization procedure](../guides/storage-management.md#initialize-before-enabling-a-global-limit)
   when recovered bucket/ledger state differs. It aborts untracked unfinished uploads;
   keep independent writers stopped and use schema-compatible code.
8. Deploy compatible delivery, restore/deploy maintenance, resume it after verification, then restore general web access. Check
   login, several retained images/links, a new upload, and the storage scan. Resolve
   missing/orphan findings only after matching records and objects are verified.

If returning to an old credential state could reinstate a compromised key, reset
affected keys and revoke their sessions before reopening general access. Undoing
a D1 restore does not undo R2 changes.

## Recover from an SQL export

Cloudflare supports importing SQL with `d1 execute --file`. A new-database recovery
must be rehearsed on isolated resources with your actual export before production
use. Hearth has no portable restore helper that reconciles its triggers, migration
history, and R2 ledger automatically.

A disposable local rehearsal with Wrangler 4.149.0 applied migrations and
bootstrapped an account successfully, but importing its unmodified SQL export into
an empty local database failed: a trigger referenced `users` before that table
existed. This does not establish remote export behavior. Review the actual dump's
ordering and test any adjustments on disposable resources; do not assume that
`export` followed by `execute --file` is a turnkey Hearth restore.

Use an **empty recovery database**, an isolated private bucket, and separate Worker
names/configurations. After reviewing the dump and successfully rehearsing any
required ordering/invariant adjustments, import the approved full dump without
applying migrations first:

```sh
pnpm exec wrangler d1 execute DB --remote --config apps/web/recovery.local.jsonc --file ../hearth-backup/database.sql
```

`recovery.local.jsonc` is an operator-created copy pointing to the recovery database,
not a shipped file. Keep all three recovery bindings aligned and application/cron
ingress closed. Do not import into a populated production database or run bootstrap.

Compare imported triggers/indexes to the saved inventory, migration rows to the
backup, and stored counters/references to the recovered objects. Do not blindly
apply the initial migration over restored tables. Repair any incomplete
export/import under review before
cutover. Preserve the original instance until recovery validation passes.

This guide provides procedures and constraints, not a claim of a live account
recovery test. A database-only backup cannot recover originals missing from R2.
