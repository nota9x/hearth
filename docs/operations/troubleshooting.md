# Troubleshoot Hearth

Identify which layer failed: ShareX, Hearth web, delivery, scheduled maintenance,
or Cloudflare before the Worker runs. Use the browser/API status and message plus
[Worker logs](maintenance.md#read-worker-logs). Redact credentials and private media
before sharing diagnostics.

## Installation or deployment fails

**Symptom:** Dependency installation, web build, `configure`, or deployment fails.

**Likely causes:** Unsupported Node/pnpm, a release-age/build policy refusal, existing
generated files, invalid placeholders, missing build output, or resource permissions.

**Diagnosis:** Check `node --version` and `pnpm --version` against the manifest.
Read the first failing command, not just the final exit status. Confirm generated
production files exist, actual UUID/site-key values replaced placeholders, and
`pnpm build` produced the web bundle. Run a deployment dry run before remote changes.

**Resolution:** Use Node 24/the pnpm version pinned in `package.json` and frozen installation. Preserve policy
settings; do not force installs or approve arbitrary build scripts. Inspect existing
`production.local.jsonc` files rather than deleting them blindly or rerunning
`configure` over edits. Build before deploying web. Check resource ownership with
the next section.

**Verification:** Installation/build and the three dry runs succeed; perform the
[deployed acceptance checks](../getting-started/installation.md#7-verify-the-instance).

## Wrangler authentication or resources fail

**Symptom:** Wrangler rejects access or cannot find D1, R2, or a zone.

**Likely causes:** Wrong account/authentication, insufficient permission, R2 not
activated, or resource IDs/names pointing at another instance.

**Diagnosis:** Run `pnpm exec wrangler whoami`. Compare the selected account with
your zone, D1, and R2 ownership in Cloudflare. Inspect all three production `DB`
UUIDs and `BUCKET` names. Confirm R2 activation and exact hostname zone ownership.
For S3 commands, distinguish R2 access credentials/profile/endpoint from Wrangler
credentials; they are not interchangeable.

**Resolution:** Reauthenticate with `pnpm exec wrangler login` or have the account
owner grant the required service permissions. Correct production bindings together.
Activate R2 if missing. For backup/initialization, use bucket-scoped credentials and
the correct account/jurisdiction endpoint.

**Verification:** Resource inspection and migration listing succeed for the intended
database; domain validation and a small upload succeed after deployment.

## D1 migrations or administrator initialization fail

**Symptom:** Missing-table/column errors, migration failure, or bootstrap refusal.

**Likely causes:** Local migrations were applied instead of remote ones, the wrong
database was selected, the ordered chain is incomplete, or an administrator exists.

**Diagnosis:** Inspect production `DB` and run:

```sh
pnpm exec wrangler d1 migrations list DB --remote --config apps/web/production.local.jsonc
pnpm exec wrangler d1 execute DB --remote --config apps/web/production.local.jsonc --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
pnpm exec wrangler d1 execute DB --remote --config apps/web/production.local.jsonc --command "SELECT role,status,COUNT(*) AS count FROM users GROUP BY role,status"
```

The last query needs the users table and reveals no keys. `pnpm db:migrate` and
plain bootstrap target local state. Read the migration error for the actual failed
statement; do not edit history or drop tables to make it pass.

**Resolution:** On a new instance, apply all remote migrations using the production
configuration, then bootstrap once with `--remote --config`. On an existing instance,
take a backup and use [updating](updating.md). If an administrator exists, use its
saved key or another administrator's reset. Bootstrap is not account recovery.

**Verification:** No pending migrations remain, and the saved administrator key
signs in to the intended application origin.

## Sign-in or key verification fails

**Symptom:** Login fails, sessions end, Turnstile rejects verification, or API uploads
return HTTP 401.

**Likely causes:** Wrong/rotated key, disabled account, expired/revoked session,
incorrect origin, or mismatched Turnstile widget/secret/allowed hostname.

**Diagnosis:** Sign in at the exact HTTPS `APP_ORIGIN`; HTTP 421 indicates a different
application hostname. Ask an active administrator to check account status. Compare
the site's public Turnstile key, allowed application hostname, and configured secret.
Check web logs without recording the submitted key. If the dashboard works but
ShareX fails, inspect whether its profile still contains the old key.

**Resolution:** Re-enable an intended suspended account or reset its active key
through an administrator. Regenerate ShareX profiles after rotation/reset. Correct
Turnstile through the secret prompt and deploy reviewed origin/site-key settings.
Account configuration saves revoke sessions; sign in again. Do not disable origin
or Turnstile validation to get around failures.

**Verification:** Fresh browser login succeeds; current-key ShareX upload succeeds
and any revoked key fails.

## Dashboard shows a Worker error

**Symptom:** An application page shows HTTP 500/503 or a Cloudflare error page.

**Likely causes:** Wrong bindings, missing migrations/assets, D1 failure, or an
upstream Cloudflare/platform error.

**Diagnosis:** Tail web while requesting the page. Compare deployed version/config
with the successful build, database migration state, and shared resources. A page
generated before Worker execution may have no application log; check Cloudflare's
request/invocation diagnostics and service status.

**Resolution:** Apply the compatible schema and deploy the web build with its
`ASSETS` binding/directory. Correct shared bindings; follow the platform diagnostic
for account/outage failures. Keep normal error/security headers intact.

**Verification:** Login and dashboard pages load and a real authenticated action
works; a static page alone is insufficient.

## Delivery domain validation fails

**Symptom:** A domain is Pending, Misconfigured, Unhealthy, or has an inconclusive check.

**Likely causes:** Wrong Worker attachment, inactive zone, conflicting DNS, TLS not
ready, redirects, mismatched D1/R2, storage capacity blocking a validation write,
or transient resolver/storage failure.

**Diagnosis:** Read **Details & diagnostics**. In Cloudflare, confirm the exact
hostname is a production Custom Domain of the delivery Worker and its zone is in
the same account. Check all returned A/AAAA addresses use Cloudflare's edge and
HTTPS does not redirect. Compare web/delivery bindings and inspect web/delivery logs.
If global storage is full or paused, inspect Storage: validation creates temporary
objects and can fail even when existing reads work.

**Resolution:** Follow [domain connection](../guides/custom-domains.md#connect-a-delivery-hostname),
remove actual conflicting records, wait for DNS/TLS, correct shared bindings/capacity,
then revalidate. Do not mark health active through SQL. An inconclusive check can
retain old health; retry once the underlying service recovers.

**Verification:** Validation conclusively passes, primary/preference can be selected,
and a newly created public URL opens.

## A public image will not open

**Symptom:** Upload succeeded but delivery returns 404, 429, 503, or a network error.

**Likely causes:** No link was created, deleted/expired link or image, suspended
account/domain, wrong hostname/path/case, missing object, binding outage, or cooldown.

**Diagnosis:** Inspect the saved image and its link in Hearth. Check the full assigned
hostname, account status, delivery enabled flag, and both expiry deadlines. Public
404s intentionally do not reveal which inaccessible state applies. Tail delivery
for 503/storage failures. Repeated unavailable-link requests can trigger a temporary
cooldown that also affects valid links from that identity.

**Resolution:** Create a link for a privately saved image after fixing selection.
Restore intentionally suspended account/delivery state. Use the exact case-sensitive
URL. Restore missing media from a matching backup before retiring records. Wait for
429 cooldown instead of repeatedly guessing paths. Do not make R2 public or disable
authoritative delivery checks.

**Verification:** Open the assigned URL in a fresh request and confirm image bytes;
expired/deleted links should remain unavailable.

## Uploads fail

**Symptom:** Dashboard or ShareX reports an upload error or unexpected response.

**Diagnosis and resolution:** Read the actual JSON code/message or inline error:

| Status/code                                                         | Action                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 401 / `INVALID_KEY`                                                 | Check active account/current key and regenerate the uploader.                                                              |
| 400 / `EXPIRY_REQUIRED`, `EXPIRY_TOO_LONG`, `INVALID_EXPIRATION`    | Save a compliant default in Settings or supply valid explicit expiry; policy changes do not repair defaults automatically. |
| 400 / `INVALID_FILE_TYPE`                                           | Export a valid supported image; changing the extension/MIME does not change its bytes.                                     |
| 422 / `METADATA_STRIPPING_UNSUPPORTED`, `METADATA_STRIPPING_FAILED` | Use a supported layout/export; Hearth will not fall back to unsanitized bytes.                                             |
| 413 / `UPLOAD_TOO_LARGE`                                            | Reduce input size or review the configured upload limit and platform limits.                                               |
| 413 / `QUOTA_EXCEEDED`                                              | Check account usage/quota; delete images or adjust quota.                                                                  |
| 413 / `GLOBAL_STORAGE_LIMIT_EXCEEDED`                               | Free physical capacity or raise the cap; pending purge/reservations still count.                                           |
| 503 / `STORAGE_ACCOUNTING_UNAVAILABLE`                              | Inspect initialization and unresolved ledger issues in Storage.                                                            |
| 409 / `IMAGE_SAVED_WITHOUT_LINK`                                    | Find the saved image, fix delivery selection, then create its link.                                                        |
| 429                                                                 | Observe `Retry-After`; avoid repeated concurrent retries.                                                                  |
| 503 / storage or persistence failure                                | Inspect web logs and D1/R2 access; verify state before retrying an uncertain upload.                                       |

An HTML/challenge response instead of JSON usually needs endpoint/proxy diagnosis.
Use Hearth's exact generated `/api/v1/images` URL, not a delivery hostname or a
manually appended slash. See [ShareX task/destination checks](../getting-started/sharex-setup.md#troubleshooting-sharex).

**Verification:** Upload a small supported image using a compliant default, find
it in Images, and open its resulting URL. After a lost response, check for an
already-saved image first; native ShareX has no default idempotency key.

## Expiry cleanup or storage scans stall

**Symptom:** Expired images remain physically charged, reservations persist, or a
scan fails/stops advancing.

**Likely causes:** Maintenance missing/still paused, cron propagation delay, wrong
bindings, a batch backlog, failed purge/recovery, active lease, or accounting issues.

**Diagnosis:** Verify the deployed maintenance cron and resources, then inspect
scheduled invocations and `maintenance.purge_failed` events. Compare Storage's scan
progress/error and Needs attention before and after several runs. If capacity is
not initialized, normal scans alone cannot verify untracked multipart uploads.

**Resolution:** Restore the recorded cron after a maintenance window, deploy the
compatible Worker, and allow propagation. Fix storage access and let retries run.
Retry a failed scan from Storage when appropriate. Use the
[initialization command](../guides/storage-management.md#initialize-before-enabling-a-global-limit)
for a missing baseline, and review issues before repairs. Do not clear reservations,
delete leases, reset counters, or mass-delete orphans merely to hide a warning.

**Verification:** Scheduled runs complete, progress advances, and verified physical
cleanup releases capacity. Expired image delivery must remain blocked throughout.
