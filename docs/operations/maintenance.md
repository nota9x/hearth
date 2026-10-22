# Maintain and monitor Hearth

The maintenance Worker performs scheduled and on-demand cleanup and storage scans. Deploy it
alongside web and delivery; a functioning dashboard does not prove cron is running.

## Automatic work

The production configuration uses `*/5 * * * *`, every five minutes in UTC.
Cloudflare invokes `scheduled()`; no public URL or external cron service is needed.

Cron wakes one private, instance-scoped `MaintenanceJob` Durable Object. Only its
serialized alarm executor performs maintenance. D1 owns scans, cursors, findings,
accounting and audit records; coordinator storage owns scheduling, retry timing,
routine checkpoints and pause intent. All scan origins, including recovery
initialization, are discovered from D1. The previous per-run objects forward old
jobs to the coordinator. The D1 lease remains during this transition. Its holder
is the coordinator's stable identity, so that serialized actor can reclaim a lease
after a failed release; different legacy holders still block execution.

Each alarm performs one bounded routine stage or scan slice. Routine stages cycle
through session/capability cleanup, image expiry, pending purges, interrupted writes,
optional previews and daily usage snapshots. Backlogs continue promptly across
alarms; scans and routine stages alternate. A full-maintenance attempt first finishes
its bounded routine pass, then resumes its scan. `attempt`/`routineDone` in D1
prevent duplicate requests from starting another associated pass. Daily scans catch
up after downtime, based on the most recent 03:00 UTC boundary.

**Scan storage** starts a full maintenance attempt. **Retry scan** preserves saved
cursors and starts an intentional new attempt. Findings remain informational until
a separately authorized repair/deletion. The job continues after closing the page.

Temporary failures preserve progress and use application-owned exponential backoff
(from two seconds to one hour). After 24 consecutive slice failures, or a terminal
schema/constraint error, maintenance exposes an actionable failure. The coordinator
pre-arms a watchdog alarm before D1 work, retains retry metadata independently of
D1, and cron repairs missing wakeups. Terminal publication retries until D1 is
reachable. Operator retry or resume recovers failed work. Successful slices clear
consecutive executor failures; per-item failures remain visible as deferred backlog.

Failed previews, purges and storage recovery use deterministic persisted eligibility
with exponential delays from one minute to one day. Eligible later items keep moving.
Capacity is only released after the existing physical-absence checks succeed.

## Pause, drain, resume and diagnose

In **Administration → Storage**, choose **Pause and drain**. The pause flag commits
before waiting for the current bounded slice. A recorded pause is displayed as
`paused` while a slice finishes; **drained** means there is no active maintenance
slice. Pending alarms and cron honor this flag. **Resume maintenance** continues
saved work. Control audit intents survive a D1 outage in a small durable outbox.

The panel shows the active stage, last progress, last completed routine pass,
retry diagnostics and backlog counts sampled at routine boundaries. Scan completion
is separate from preview/purge health. Active work uses existing dashboard polling.
A stale progress timestamp is a reason to check the private binding and Worker logs.
Pausing maintenance does **not** stop uploads, external R2 writers, domain validation,
or all other storage mutations. Coordinate those writers independently for backups.

## Execution budgets

The executor meters at most 40 D1 statements (including batch contents) and 40 R2
operations per alarm, reserving headroom below D1 Free's 50-query limit (Paid: 1,000).
Work units are sized before execution; an unexpected operation overrun fails visibly.
An eight-second elapsed checkpoint target prevents starting additional work after
slow I/O; individual in-flight binding calls finish before checkpointing. The normal
DO CPU limit is 30 seconds and alarm wall time is 15 minutes. Operations are serial,
remaining below the six simultaneous connection limit. Preview input/output remain
bounded at 20 MiB/5 MiB.

The comparable 100-orphan listing page uses **7 SQL statements**, down from **402**:
one run lookup and six set-based transactional statements. Page-level JSON joins
replace per-object image lookups, redundant ledger insert attempts and ledger reads.
Existing ledger entries are not inserted again. R2 listings retain 100 entries;
metadata HEAD checks checkpoint up to 20 entries, and account checks page 100 users.
The listing cursor never advances without its complete page transaction.
See the statement-count regression in `tests/integration/global-storage.test.ts`.

Platform references: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

Expiry blocks delivery before physical cleanup. Global capacity remains charged
until physical absence/cleanup is verified. Existing image reads need not stop when
an upload, preview, or cleanup operation fails. See [storage management](../guides/storage-management.md).

## Verify scheduled maintenance

1. Confirm the deployed maintenance Worker has the correct D1/R2 bindings and the
   expected cron trigger in Cloudflare.
2. Inspect scheduled invocations and errors around a five-minute boundary. Trigger
   changes can take up to 15 minutes to propagate.
3. Inspect cron invocations to verify scheduled work independently of manual work.
   **Scan storage** should start immediately and progress automatically. Closing
   the page must not stop it; reopen Storage to inspect completion or errors.
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
`maintenance.purge_failed`, `maintenance.dispatch_failed`, `maintenance.job_failed`, `preview.failed`, `delivery.unavailable`, and
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
