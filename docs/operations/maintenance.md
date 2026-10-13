# Maintain and monitor Hearth

The maintenance Worker performs scheduled cleanup and storage scans. Deploy it
alongside web and delivery; a functioning dashboard does not prove cron is running.

## Automatic work

The production configuration uses `*/5 * * * *`, every five minutes in UTC.
Cloudflare invokes `scheduled()`; no public URL or external cron service is needed.

Each execution removes expired sessions/consumed deletion capabilities, processes
bounded batches of expired images and failed purges, recovers interrupted storage
operations, optionally generates previews, records daily logical usage, and advances
a running storage scan. Backlogs can take several invocations to clear.

A lease prevents overlapping maintenance. The daily scan starts during the 03:00
UTC hour if no run has started that UTC day; an outage during that window can miss
automatic initiation. An administrator can start a scan from Storage. This is not
continuous reconciliation or automatic domain-health checking.

Expiry blocks delivery before physical cleanup. Global capacity remains charged
until physical absence/cleanup is verified. Existing image reads need not stop when
an upload, preview, or cleanup operation fails. See [storage management](../guides/storage-management.md).

## Verify scheduled maintenance

1. Confirm the deployed maintenance Worker has the correct D1/R2 bindings and the
   expected cron trigger in Cloudflare.
2. Inspect scheduled invocations and errors around a five-minute boundary. Trigger
   changes can take up to 15 minutes to propagate.
3. Start a scan from **Administration → Storage** and refresh after an invocation.
   Expect its progress to advance, complete, or display a diagnostic failure.
4. If safe for your instance, give a disposable image a short expiry. Its link
   should become unavailable at expiry, followed by cleanup and capacity reclamation.

Do not delete important data to test maintenance. There is no public production
endpoint for forcing a run; the local scheduled endpoint is for development only.
See [Cloudflare cron behavior](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Read Worker logs

Cloudflare's [logging tools](https://developers.cloudflare.com/workers/observability/logs/)
include stored Workers Logs and real-time logs. Select the affected Worker in
Workers & Pages and inspect its logs/invocations. Generated production configurations
enable observability with 10% head sampling; absence from sampled stored logs does
not prove an operation never ran.

For a live diagnostic, run the relevant command from the repository root and
reproduce one operation. Use separate terminals for multiple Workers:

```sh
pnpm exec wrangler tail --config apps/web/production.local.jsonc --format pretty
pnpm exec wrangler tail --config workers/delivery/production.local.jsonc --format pretty
pnpm exec wrangler tail --config workers/maintenance/production.local.jsonc --format pretty
```

| Worker      | Start here for                                                 |
| ----------- | -------------------------------------------------------------- |
| Web         | Sign-in, uploads, dashboard actions, and domain validation.    |
| Delivery    | Public image reads, unavailable storage, and share protection. |
| Maintenance | Cron, purges, previews, storage recovery, and scan progress.   |

Relevant structured event names include `upload.cleanup_failed`,
`maintenance.purge_failed`, `preview.failed`, `delivery.unavailable`, and
`delivery.protection_unavailable`. Correlate timestamps with the user-visible error
and domain/storage diagnostics. Do not log or publish bodies, Authorization headers,
cookies, `.sxcu` contents, or deletion tokens.

## Optional previews

To generate WebP dashboard previews, enable the required Cloudflare Images product
and add `"images": {"binding": "IMAGES"}` to the maintenance production configuration,
then deploy maintenance. Originals and public image delivery remain unchanged.
Without the binding, the dashboard uses originals.

Generation is best-effort and can retry after failures. GIFs are excluded; the
current generator processes eligible originals smaller than 20 MiB in small batches.
Preview bytes count toward user usage and global capacity. Repeated `preview.failed`
events warrant checking Images access and capacity; remove the optional binding
if you do not need previews. No AVIF delivery transformation mode is implemented.

For stalled cleanup/scans, use [troubleshooting](troubleshooting.md#expiry-cleanup-or-storage-scans-stall).
For data safety, establish [backups](backups-and-recovery.md) separately.
