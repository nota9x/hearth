# Troubleshoot Hearth

Find your symptom below, or search this page for the exact error code, such as
`INVALID_KEY` or `IMAGE_SAVED_WITHOUT_LINK`. If you only see an HTTP status like
403 or 503, use the section for the task you were trying to complete.

## Find your problem

| What went wrong?                                                              | Start here                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Setup stopped, dependencies will not install, or deployment failed            | [Installation and deployment](#installation-or-deployment-fails)                        |
| Cloudflare denies access or cannot find a resource                            | [Cloudflare login and permissions](#wrangler-authentication-or-resources-fail)          |
| Missing database tables, failed migrations, or administrator creation refused | [Database and administrator setup](#d1-migrations-or-administrator-initialization-fail) |
| Cannot sign in, verification fails, or your key is rejected                   | [Sign-in and keys](#sign-in-or-key-verification-fails)                                  |
| The dashboard shows a server or Cloudflare error                              | [Dashboard errors](#dashboard-shows-a-worker-error)                                     |
| An image address is Pending, Misconfigured, or Unhealthy                      | [Domain validation](#delivery-domain-validation-fails)                                  |
| A shared image link does not open                                             | [Public image links](#a-public-image-will-not-open)                                     |
| An upload returns an error code or unexpected response                        | [Upload errors](#uploads-fail)                                                          |
| ShareX does not upload or copy the link                                       | [ShareX troubleshooting](../getting-started/sharex-setup.md#troubleshooting-sharex)     |
| Deleted or expired images still use space; a storage scan is stuck            | [Cleanup and storage scans](#expiry-cleanup-or-storage-scans-stall)                     |
| Your error is not listed, or the fix did not help                             | [Collect useful diagnostics](#collect-useful-diagnostics)                               |

## Installation or deployment fails

### Guided setup messages

| Message or symptom                                      | What to do                                                                                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup stopped or was interrupted                        | Run `pnpm run setup` again. Keep the production configuration files and `artifacts/setup/`; setup uses them to resume.                                                                                |
| A step failed and offers **Retry**                      | Fix the reported issue, then choose **Retry**. Choose **Save progress and exit** if you need to return later.                                                                                         |
| The wrong Cloudflare account is selected                | Choose **Change account**, then select the account that owns your domain and installation.                                                                                                            |
| The configured D1 database is “missing or inaccessible” | Check the account, database name, and UUID shown in the message. Restore access or recover the intended database from backup. **Retry** keeps the same database ID; it does not create a replacement. |
| The configured bucket is “missing or inaccessible”      | Restore access to the intended bucket, or follow [recovery](backups-and-recovery.md). Setup will not replace existing image storage with an empty bucket.                                             |
| The Turnstile widget is “missing or inaccessible”       | Restore access to the widget, or select a replacement through advanced setup.                                                                                                                         |
| “This live instance requires pending migrations”        | Follow [updating](updating.md), then rerun setup.                                                                                                                                                     |
| R2 checkout, billing approval, or a quota blocks setup  | Open the Cloudflare link shown by setup. Complete the requested action or ask the account owner, then retry.                                                                                          |
| An image or application address is not ready            | Allow time for the address and HTTPS certificate to become ready, then retry validation. Do not recreate the installation.                                                                            |
| “An uninstall is pending”                               | Run `pnpm run setup --uninstall` to finish removal before installing again.                                                                                                                           |
| Uninstall failed or was interrupted                     | Resolve its reported issue and rerun `pnpm run setup --uninstall`. Keep `artifacts/setup/uninstall.json` so removal can resume.                                                                       |
| The verification upload is pending or uncertain         | Let scheduled maintenance reconcile the upload, then retry setup. Keep the saved progress and original administrator key; do not force another upload.                                                |

For more detail about a failed step, read `artifacts/setup/diagnostics.log`.

### You want a fresh installation instead of resuming

- **Only a setup checkpoint exists:** choose **Show advanced resource choices**
  and change **D1 database name** to a new, unused name. Review the Worker prefix
  and bucket too, then confirm the installation review.
- **Production configuration files already exist:** use a separate clean checkout
  with distinct Worker, database, and bucket names. Review any existing hostname
  assignments before moving them.

Do not delete migration history or remove `state.json` to force a restart. Use the
setup choices above; deleting progress loses information needed for recovery.

### Dependency, build, and manual deployment errors

| Failing step                                                      | Check and fix                                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` rejects Node or pnpm                               | Run `node --version` and `pnpm --version`. Use Node 24 and the pnpm version in `package.json` under `packageManager`, then run `pnpm install --frozen-lockfile`. |
| Installation reports a release-age or build-script policy refusal | Read the named package and policy in the error. Keep the repository's policy settings; do not force installation or approve arbitrary build scripts.             |
| `pnpm configure` refuses to overwrite files                       | Inspect and back up the existing `production.local.jsonc` files before deciding how to proceed. They may describe an existing installation.                      |
| Configuration still contains `YOUR_...` placeholders              | Replace them with the actual database UUID, bucket name, and Turnstile site key from installation.                                                               |
| Deployment cannot find the web build                              | Run `pnpm build` before deploying the web application.                                                                                                           |
| Deployment reports access denied or a missing resource            | Follow [Cloudflare login and permissions](#wrangler-authentication-or-resources-fail).                                                                           |

After fixing a manual deployment, repeat the failed build or deployment check,
then follow [installation verification](../getting-started/installation.md#7-verify-the-instance).

## Wrangler authentication or resources fail

Use this section for Cloudflare permission errors or resources that cannot be found.

1. From the Hearth directory, run:

   ```sh
   pnpm exec wrangler whoami
   ```

2. Confirm that the account owns your domain, database, and image bucket.
3. Use the matching fix below.

| What you find                                                   | What to do                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong account or expired login                                  | In guided setup, choose **Change account** or **Add account**. For manual commands, run `pnpm exec wrangler login` and check `whoami` again.       |
| Browser login works, but setup still denies access              | Ask the account owner to check permissions for Workers, domains, D1, R2, and Turnstile. Being signed in does not grant access to every service.    |
| An environment API token is overriding browser login            | Use guided setup's browser-login option. It switches authentication within setup without changing your shell.                                      |
| R2 is not enabled                                               | Complete R2 checkout in the intended Cloudflare account, then retry.                                                                               |
| Manual deployment points at the wrong database or bucket        | Compare the `DB` IDs and `BUCKET` names in all three production configuration files. Correct them together to reference the intended installation. |
| Backup or storage initialization reports an S3 credential error | Check the R2 credentials, profile, and account/jurisdiction endpoint used by that command. A Wrangler login does not supply S3 credentials.        |

**Check the fix:** retry the failed operation against the intended account.

## D1 migrations or administrator initialization fail

| Error or symptom                                       | What to do                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing table or column                                | Check that the production database has all required migrations. Local migrations do not update production.                                                                                                              |
| A migration fails                                      | Read the first failed SQL statement. Confirm the intended database is selected. For an existing installation, back up and follow [updating](updating.md). Do not drop tables or edit migration history to make it pass. |
| Bootstrap refuses to create an administrator           | An administrator may already exist. Sign in with its saved key or ask another administrator to reset it. Bootstrap is not a recovery tool.                                                                              |
| Local setup works, but production has no administrator | Check that bootstrap used `--remote --config apps/web/production.local.jsonc`. Plain bootstrap uses local development data.                                                                                             |

### Check pending production migrations

Run from the Hearth directory:

```sh
pnpm exec wrangler d1 migrations list DB --remote --config apps/web/production.local.jsonc
```

For a **new installation**, confirm the production configuration targets your new
database, then finish initialization:

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config apps/web/production.local.jsonc
pnpm bootstrap "Your administrator name" --remote --config apps/web/production.local.jsonc
```

Save the printed administrator key privately. For an **existing installation**,
use [updating](updating.md) or [recovery](backups-and-recovery.md) instead.

**Check the fix:** no pending migrations remain, and your saved key signs in to
the intended Hearth address.

## Sign-in or key verification fails

| Error or symptom                                              | What to do                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 401 / `INVALID_KEY` / “The API key is invalid”                | Use your current key. Ask an administrator to check account status or reset a lost key. After a reset or rotation, download and import a new ShareX configuration. |
| 401 / `UNAUTHENTICATED` / “Please sign in to continue”        | Sign in again. Your session may have expired or been revoked.                                                                                                      |
| 403 / `ACCOUNT_DISABLED`                                      | Ask an administrator to check and, if appropriate, re-enable your account.                                                                                         |
| 403 / `FORBIDDEN` / “Administrator access is required”        | Sign in with an administrator account for this action.                                                                                                             |
| 403 / `INVALID_ORIGIN` or HTTP 421                            | Open the exact application address chosen during installation, using HTTPS. For a manual deployment, check `APP_ORIGIN` in the web production configuration.       |
| 400 / `INVALID_TURNSTILE` / “Verification expired or failed”  | Refresh the page and complete verification again. If it keeps failing, check the widget's allowed hostname and keys as described below.                            |
| 503 / `TURNSTILE_UNAVAILABLE` / “Verification is unavailable” | Wait and try again. If it persists, inspect the web logs for verification failures.                                                                                |
| 503 / `CONFIGURATION` / “Authentication is unavailable”       | Check the production Turnstile secret. It must be present and must not be a local test key.                                                                        |
| 429 / `RATE_LIMITED` / “Too many attempts”                    | Wait for the stated delay before trying again.                                                                                                                     |
| The dashboard works but ShareX rejects your key               | Replace the old ShareX profile with a configuration generated using your current key.                                                                              |
| You were signed out after an account change                   | Sign in again; account configuration changes can revoke sessions.                                                                                                  |

### Check Turnstile settings

1. In Cloudflare, open the Turnstile widget for Hearth.
2. Confirm that its allowed hostname matches your application address, such as
   `app.example.com`.
3. Check that the web configuration uses that widget's site key.
4. If its secret needs correcting, run:

   ```sh
   pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --config apps/web/production.local.jsonc
   ```

5. Enter the widget's secret at the prompt. Deploy any reviewed changes to the
   web configuration, then try signing in again.

**Check the fix:** a fresh browser login and an upload using the current ShareX
configuration both succeed.

## Dashboard shows a Worker error

For HTTP 500/503 or a Cloudflare error page:

1. Open the [web Worker logs](maintenance.md#read-worker-logs).
2. Reload the failing page once and find the corresponding error.
3. Use the matching fix below.

| Log or symptom                                         | What to do                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing table or column                                | Follow [database troubleshooting](#d1-migrations-or-administrator-initialization-fail).                                                           |
| Database or bucket access failure                      | Follow [Cloudflare login and permissions](#wrangler-authentication-or-resources-fail).                                                            |
| Missing assets or incomplete web deployment            | Run `pnpm build`, then redeploy using `apps/web/production.local.jsonc`. Check that the generated assets configuration is present.                |
| Cloudflare error page with no matching application log | Check Cloudflare's request/invocation diagnostics and service status. A request may fail before reaching Hearth. Stored logs may also be sampled. |

**Check the fix:** sign in, load the dashboard, and try the action that failed.

## Delivery domain validation fails

Open **Administration → Domains**, select the affected image address, and read
**Details & diagnostics**.

| Status or diagnostic                       | What to do                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pending**                                | Finish connecting the address, then choose **Validate domain**.                                                                                                                                  |
| **Misconfigured**                          | The address has not passed validation. Follow its displayed diagnostic and the checks below.                                                                                                     |
| **Unhealthy**                              | A previously working address failed a later check. Fix the reported issue, then validate again.                                                                                                  |
| **Disabled**                               | An administrator must enable delivery for the address before it can be used.                                                                                                                     |
| DNS, hostname assignment, or HTTPS failure | Follow the [domain connection steps](../guides/custom-domains.md#connect-a-delivery-hostname). Check the exact hostname, resolve actual DNS conflicts, and allow time for HTTPS to become ready. |
| The address redirects elsewhere            | Check that it is attached to Hearth's delivery Worker and has no redirect rule sending it elsewhere.                                                                                             |
| Database or storage mismatch               | Check that the web and delivery production configurations use the same database and bucket. Redeploy corrected configurations.                                                                   |
| Storage is full or paused                  | Open **Administration → Storage** and resolve the capacity or accounting issue. Validation needs to write a temporary test image, even when existing images still open.                          |
| The check is inconclusive                  | Read the diagnostic, resolve any temporary DNS or storage issue, then retry. An older **Active** status does not prove this check passed.                                                        |

**Check the fix:** validation succeeds. Choose **Set as instance default** if
needed, upload a new image, and open its link. Do not change health status through
SQL to bypass a failed check.

## A public image will not open

First, find the image in Hearth and open its saved link. Use the exact address,
including capitalization in the path.

| Error or symptom             | What to do                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The image has no link        | Fix the selected address in **Domains**, then create a link for the saved image. You do not need to upload it again.                                                                                              |
| 404 / not found              | Check that the image and link still exist and have not expired. Ask an administrator to check that the owner's account and the domain's delivery are enabled. Public 404s do not identify which condition failed. |
| 429 / too many requests      | Wait for the stated retry delay. Repeated requests for unavailable links can temporarily affect valid links too.                                                                                                  |
| 503 / storage unavailable    | Inspect the delivery Worker logs and check access to the intended bucket and database. If an image object is missing, recover it from a matching backup.                                                          |
| DNS, HTTPS, or network error | Check the exact image address using [domain validation](#delivery-domain-validation-fails).                                                                                                                       |

**Check the fix:** open the saved link in a new request and confirm the image
appears. Keep R2 private; making the bucket public is not a fix for link failures.

## Uploads fail

Find the exact code in the upload error or ShareX response. After a timeout or
lost response, check **Images** before uploading again; the image may already
have been saved.

| Status / error code                                                   | What to do                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 / `INVALID_KEY`                                                   | Use the current key for an active account. Download and import a replacement ShareX configuration.                                                                                                              |
| 403 / `ACCOUNT_DISABLED`                                              | Ask an administrator to check your account status.                                                                                                                                                              |
| 400 / `EXPIRY_REQUIRED`                                               | Open **Settings → Personal preferences**, choose an allowed **Default image expiry**, and save.                                                                                                                 |
| 400 / `EXPIRY_TOO_LONG`                                               | Choose a shorter lifetime within your account's limit and save. Check any expiry override in your uploader too.                                                                                                 |
| 400 / `INVALID_EXPIRATION`                                            | Choose a valid duration or a future expiration date. Correct any expiry override in your uploader.                                                                                                              |
| 400 / `INVALID_FILE_TYPE`                                             | Export the image in a supported format. Renaming the extension does not convert it.                                                                                                                             |
| 400 / `MISSING_FILE`                                                  | Select an image. For ShareX, import Hearth's generated configuration instead of constructing the request manually.                                                                                              |
| 400 / `UPLOAD_FAILED`                                                 | Check the file and connection, then try a small supported image. If the response was uncertain, check Images first.                                                                                             |
| 422 / `METADATA_STRIPPING_UNSUPPORTED`                                | Re-export the image in a supported layout or format, then upload that copy.                                                                                                                                     |
| 422 / `METADATA_STRIPPING_FAILED`                                     | Re-export the image and try again. Hearth does not upload the original as a fallback when metadata removal fails.                                                                                               |
| 413 / `UPLOAD_TOO_LARGE`                                              | Reduce the image size. An administrator can review the configured upload limit and platform limits.                                                                                                             |
| 413 / `QUOTA_EXCEEDED`                                                | Delete images you no longer need, or ask an administrator to adjust your account quota. Deleting only a link does not free image storage.                                                                       |
| 413 / `GLOBAL_STORAGE_LIMIT_EXCEEDED`                                 | An administrator must free storage or raise the global limit. Space awaiting physical cleanup still counts.                                                                                                     |
| 503 / `STORAGE_ACCOUNTING_UNAVAILABLE`                                | Open **Administration → Storage** and inspect initialization status and unresolved issues. See [storage management](../guides/storage-management.md).                                                           |
| 409 / `IMAGE_SAVED_WITHOUT_LINK`                                      | The image is already saved. Fix your address selection in **Domains**, then open the saved image and create its link. Do not upload it again.                                                                   |
| 429 / `RATE_LIMITED`                                                  | Wait for the stated delay or `Retry-After` value. Avoid repeated simultaneous retries.                                                                                                                          |
| 503 / `SHARE_LINK_UNAVAILABLE` or another storage/persistence failure | Check Images before retrying. An administrator should inspect web logs and database/bucket access.                                                                                                              |
| HTML or a challenge page instead of an upload response                | Use the generated ShareX configuration. Its upload address must be the application address ending in `/api/v1/images`, without an extra trailing slash. Check proxy or challenge rules affecting that endpoint. |

**Check the fix:** upload a small supported image, find it in **Images**, and open
its public link. For capture tasks, uploader selection, and clipboard problems,
use [ShareX troubleshooting](../getting-started/sharex-setup.md#troubleshooting-sharex).

## Expiry cleanup or storage scans stall

| Symptom                                                     | What to do                                                                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expired or deleted images still count toward global storage | Allow scheduled cleanup to run. Capacity is released after physical cleanup is verified; a backlog can take several runs.                                                                             |
| Maintenance has no recent scheduled runs                    | Follow [maintenance verification](maintenance.md#verify-scheduled-maintenance). Check the deployed cron and database/bucket settings. After a trigger change, allow up to 15 minutes for it to start. |
| `maintenance.purge_failed` appears in logs                  | Check bucket access and the logged failure, fix it, then let maintenance retry.                                                                                                                       |
| A storage scan is stuck or failed                           | Open **Administration → Storage**, read the scan error and **Needs attention** items, and check maintenance logs. Fix the reported issue, then retry the scan when appropriate.                       |
| Storage has no initialized baseline                         | Follow [storage initialization](../guides/storage-management.md#initialize-before-enabling-a-global-limit). A normal scan alone cannot verify untracked multipart uploads.                            |
| Reservations or warnings remain after several runs          | Review the reported storage issues before repairing them. Do not clear reservations, delete leases, or reset counters just to remove a warning.                                                       |

**Check the fix:** scheduled runs complete, scan progress advances, and storage
usage drops after cleanup. Expired image links should remain unavailable while
cleanup catches up.

## Collect useful diagnostics

If the problem continues:

1. Note the exact error message/code, the time it happened, and the action you
   were trying to complete.
2. For guided setup, check `artifacts/setup/diagnostics.log`. For a running
   installation, open the matching [Worker logs](maintenance.md#read-worker-logs):

   | Problem                                          | Logs to check |
   | ------------------------------------------------ | ------------- |
   | Sign-in, dashboard, upload, or domain validation | Web           |
   | Public image link                                | Delivery      |
   | Scheduled cleanup or storage scan                | Maintenance   |

3. Reproduce the problem once while viewing the logs and save the relevant error.
4. Before sharing diagnostics, remove API keys, secrets, cookies, private images,
   and credentials from configuration files or ShareX profiles.
