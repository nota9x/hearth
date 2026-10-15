# Manage storage and capacity

Hearth separates account quotas from an optional global capacity budget. Open
**Administration → Storage** to inspect usage, reservations, scan progress, and
issues; configure **Global storage limit** in administrator Settings.

## Understand the numbers

| Measure                | What it counts                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| User storage/quota     | Active image originals and previews attributed to that account.                                          |
| Stored global capacity | Completed physical objects tracked by Hearth, including pending deletion and discovered untracked files. |
| Reserved capacity      | Unfinished uploads and uncertain writes whose capacity cannot yet be released.                           |
| Available capacity     | Configured limit minus stored and reserved capacity, floored at zero.                                    |
| Storage history        | Daily logical image/preview usage in D1; not a physical bucket snapshot or backup.                       |

Deleting an image can reduce account usage before physical purge releases global
capacity. Removing a link changes neither. Reservations remain charged until
cleanup verifies their terminal state; timeouts alone do not free space.

User quota input is **MiB**. Global MB/GB/TB inputs use **decimal** units:
1 GB = 1,000,000,000 bytes. Neither is a Cloudflare billing cap.

## Set account quotas

Open **Administration → Users → a profile → account configuration**. A blank quota
is unlimited; zero prevents new image bytes. Lowering quota preserves existing
files and may block further uploads. Quotas apply independently of global capacity.
See [user management](user-management.md) for the session revocation on saving.

## Initialize before enabling a global limit

The global limit defaults to unlimited. Before enabling it, apply the current migrations
and deploy the current three Workers together.
Older runtimes must no longer write to the bucket. This also applies to new
installations: initial capacity readiness requires verification and a baseline scan.

1. Install [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
2. Create bucket-scoped R2 **Object Read & Write** credentials and save them in an
   AWS profile, such as `hearth-r2`, using `aws configure --profile hearth-r2`.
   Use region `auto`. Do not use your Hearth key or Wrangler token as S3 credentials.
   Follow [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).
3. Confirm the selected web production file names the intended bucket and D1.
   Notify users: initialization can pause uploads.
4. Run from the repository root, replacing the account ID with your R2 endpoint's
   account ID. Use the jurisdiction-specific endpoint if your bucket requires it:

   ```sh
   pnpm storage:initialize --endpoint https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com --config apps/web/production.local.jsonc --profile hearth-r2
   ```

5. Watch **Administration → Storage** until scheduled maintenance completes the
   queued baseline scan. Resolve actual accounting blockers after review.
6. In administrator Settings, enable the global limit, choose capacity/unit, and
   **Save limit**. Verify the displayed stored, reserved, and available values.

The command checks S3 access before pausing reservations. It inventories unfinished
multipart uploads and **aborts untracked unfinished uploads**; use a dedicated
bucket and stop independent writers first. It preserves completed objects and
tracked operations. A fresh scan then inventories completed objects.

If the command fails after pausing writes, correct access and rerun it. Do not
manually mark accounting ready. Read/delivery continues, but health validation
can need new storage. Worker R2 bindings cannot enumerate unfinished multipart
uploads, which is why this operator command needs S3 access.

## Change a capacity limit

Lowering the cap preserves files and blocks additional reservations when capacity
is insufficient. Already-reserved bytes may finish committing. Disabling the cap
restores unlimited admission while accounting and cleanup continue.

The budget includes original uploads, generated previews, and delivery-validation
objects. A full budget can block preview generation or domain validation even
while existing public images still work.

- HTTP 413 `GLOBAL_STORAGE_LIMIT_EXCEEDED`: increase capacity or delete images and
  wait for verified physical cleanup.
- HTTP 503 `STORAGE_ACCOUNTING_UNAVAILABLE`: inspect initialization or accounting
  blockers rather than assuming the bucket is simply full.

Do not lower the cap to zero or disable accounts as a substitute for a coordinated
backup maintenance window; these do not stop every writer.

## Review scans and issues

Storage scans compare R2 objects, image records, and accounting. Administrators can
start a scan or retry a failed one. Maintenance advances it in pages; observed scan
totals are not the live capacity ledger. Only one scan runs at a time.

Read each **Needs attention** issue before resolving it:

- **Untracked file:** deletion is permanent. During recovery, it might belong to
  the backup you intend to restore; do not automatically delete it.
- **Missing original:** restore bytes first if possible. Retiring the image removes
  its record from active use and disables links.
- **Missing preview or size/counter discrepancy:** Hearth verifies current state
  before repairing accounting; original images are preserved by counter repairs.

**Resolve all issues** includes listed issues across pages and can delete files or
retire images. Review its confirmation. The UI loads up to 100 unresolved issues;
follow the notice if more exist. Failures remain available for retry, and stopping
does not undo completed repairs.

Use a dedicated private bucket. Dashboard edits, S3 clients, lifecycle rules, and
other Workers can bypass Hearth's cap. Reconciliation accounts discovered files
but cannot prevent independent writes. Keep incomplete-multipart lifecycle cleanup
as a secondary safeguard; do not add independent expiry rules for live originals.

For persistent cleanup failures, see [maintenance](../operations/maintenance.md)
and [troubleshooting](../operations/troubleshooting.md#expiry-cleanup-or-storage-scans-stall).
