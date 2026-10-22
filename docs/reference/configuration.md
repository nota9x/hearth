# Configuration reference

Production settings live in three ignored `production.local.jsonc` files generated
by `pnpm run setup` or manual `pnpm configure`. Dashboard preferences/policies live in D1. Changing a file
requires deploying its Worker; changing a dashboard setting does not require deployment.

Use [installation](../getting-started/installation.md) for the ordered setup procedure.
The checked-in `wrangler.jsonc` files are local-development settings.

## Configuration generator

Guided setup adds an explicit `account_id`, uses the actual D1 name, and allocates
separate rate-limit namespaces for a new instance. Existing namespaces and
unrelated settings are retained during adoption. New configurations enable sampled
logs and traces. Secrets are supplied through Wrangler stdin; production files
and `artifacts/setup/state.json` contain no plaintext credentials. Reruns reconcile
remote state and request review before replacing files. `pnpm run cli --help`
lists commands. The following manual generator remains configuration-only:

```sh
pnpm configure --application app.example.com --delivery images.example.com --database YOUR_D1_UUID --bucket YOUR_BUCKET_NAME --turnstile YOUR_TURNSTILE_SITE_KEY
```

| Option          | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `--application` | Required public application hostname, without protocol/path/port.                                           |
| `--delivery`    | Repeatable public delivery hostname, distinct from application. May be omitted to configure delivery later. |
| `--database`    | Required D1 UUID; the generated database name is `hearth-production`.                                       |
| `--bucket`      | Required dedicated R2 bucket name.                                                                          |
| `--turnstile`   | Required real Turnstile site key; production test keys are rejected.                                        |

The script copies local binding/flag structure, removes `dev`, disables `workers_dev`
and `preview_urls`, supplies production variables/routes, and enables sampled
observability. It creates each file exclusively; it cannot refresh existing files
and does not provision/deploy resources. Existing installations edit their reviewed
production files directly. Back them up outside Git.

## Variables and secrets

| Name                   | Worker                | Production value/purpose                                                                                                               |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`          | Web, delivery         | `production`; development permits local-only behavior.                                                                                 |
| `APP_ORIGIN`           | Web, delivery         | Same canonical HTTPS origin, e.g. `https://app.example.com`, without trailing slash. Used for application URLs and origin enforcement. |
| `TURNSTILE_SITE_KEY`   | Web                   | Public widget site key allowed on the application hostname.                                                                            |
| `TURNSTILE_SECRET_KEY` | Web secret            | Matching private Siteverify secret, set with `wrangler secret put`.                                                                    |
| `MAX_UPLOAD_BYTES`     | Web                   | String containing allowed input bytes; generated default `26214400` (25 MiB). Platform/body/format limits still apply.                 |
| `LOCAL_DELIVERY_PORT`  | Web, development only | Local delivery port, default `8788`; omitted from generated production variables.                                                      |

Maintenance has no required application variables or secret. Do not invent a session
secret, database connection URL, delivery API key, or S3 key binding: this application
does not use them. Domain validation keys are managed privately in D1.

Use the secret prompt for production credentials. `.dev.vars`/`.env` are local
development mechanisms, not an automatic production-secret upload. See
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and
[local variables](https://developers.cloudflare.com/workers/local-development/environment-variables/).

## Required bindings

| Binding               | Worker                | Requirement                                                                                             |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| `DB`                  | All three             | Same D1 `database_id`; web retains `migrations_dir: "../../drizzle"`.                                   |
| `BUCKET`              | All three             | Same dedicated private R2 bucket.                                                                       |
| `ASSETS`              | Web                   | Directory `.svelte-kit/cloudflare` generated by `pnpm build`.                                           |
| `LOGIN_LIMIT`         | Web                   | 10 attempts per 60 seconds.                                                                             |
| `UPLOAD_LIMIT`        | Web                   | 30 requests per 60 seconds.                                                                             |
| `MUTATION_LIMIT`      | Web                   | 60 requests per 60 seconds.                                                                             |
| `SENSITIVE_LIMIT`     | Web                   | 10 requests per 60 seconds.                                                                             |
| `SHARE_FAILURE_LIMIT` | Delivery              | 60 failed lookups per 60 seconds.                                                                       |
| `MAINTENANCE`         | Web and maintenance   | Private Durable Object namespace for `MaintenanceJob`; web uses the maintenance Worker's `script_name`. |
| `IMAGES`              | Maintenance, optional | `"images": {"binding": "IMAGES"}` plus the required Images product.                                     |

Rate limits are best-effort per Cloudflare location, not global counters. Their key
scope is chosen by the application. Keep namespaces separate for independent instances.
Local/manual templates use namespaces `4101`–`4105`; guided setup generates distinct
stable identifiers for new instances and preserves existing identifiers on adoption.
All three Workers share D1/R2 directly. Web also binds privately to maintenance's
`MaintenanceJob` class through `durable_objects.bindings`. The maintenance Worker
declares `exports.MaintenanceJob` with `type: "durable-object"` and `storage: "sqlite"`.
Keep web's `script_name` aligned with the maintenance Worker, including custom prefixes.
No service binding, public maintenance URL, or additional secret is required.

## Worker routing and runtime

| Setting                      | Current configuration                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Worker names                 | `hearth-web`, `hearth-delivery`, `hearth-maintenance`                                  |
| Web entry                    | `.svelte-kit/cloudflare/_worker.js`                                                    |
| Delivery/maintenance entries | `src/index.ts` relative to each configuration                                          |
| Compatibility date           | `2026-09-17` in checked-in files and initial generated copies                          |
| Shared flag                  | `nodejs_compat`                                                                        |
| Web additional flags         | `enable_request_signal`, `global_fetch_strictly_public`                                |
| Production routes            | Exact application/delivery hostnames with `custom_domain: true`; maintenance has none. |
| Maintenance schedule         | `triggers.crons: ["*/5 * * * *"]`, UTC                                                 |
| Generated observability      | Enabled, `head_sampling_rate: 0.1` for each Worker                                     |
| Production alternative URLs  | `workers_dev: false`, `preview_urls: false`                                            |

Retain compatibility flags and bundled asset configuration. Review runtime changes
when updating rather than changing compatibility dates arbitrarily. The local
maintenance template samples all invocations, but the production generator uses 10%.
See [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Settings managed in Hearth

| Setting                           | Location and behavior                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace name                    | Administration → Settings; affects branding.                                                                                                  |
| Delivery domains/instance default | Administration → Domains; validation and explicit instance default selection required.                                                        |
| Personal delivery selection       | Domains; follows the instance default unless a personal selection is saved. No automatic fallback from an unusable selection.                 |
| Display name/default expiry       | Settings → Personal preferences; default expiry initially permanent unless explicitly changed.                                                |
| Strip image metadata              | Personal preferences; enabled by default, future uploads only.                                                                                |
| API key                           | Settings → API key; one current key, rotation revokes all sessions.                                                                           |
| User quota                        | Administration → Users → profile; MiB, blank unlimited.                                                                                       |
| Instance/user expiry policy       | Administrator Settings/user profile; initially unrestricted, administrators exempt.                                                           |
| Share-link ID length              | Administrator Settings; default 5, allowed 3–64, automatic allocation floor may increase.                                                     |
| Global storage limit              | Administrator Settings; initially unlimited, decimal units; fresh setup initializes accounting automatically; recovery requires verification. |

See [domains](../guides/custom-domains.md), [users](../guides/user-management.md),
[images](../guides/images-and-links.md), and [storage](../guides/storage-management.md)
for workflows and their effects.

## Independent instances and staging

Use separate Worker names, D1 databases, buckets, rate-limit namespaces, hostnames,
and Turnstile credentials for staging. The generator's filenames are not named
Wrangler environments; the documented commands use `--config`, not `--env production`.
Keep bindings consistent within an instance and keep production credentials out of
local test state. There is no supported shared-bucket admission guarantee across
independent writers.

Fresh installations must run `pnpm run setup` (or `--advanced`) to create new,
dedicated D1/R2 resources. Configuration generation alone does not establish an
empty-storage baseline. Existing instances retain their resources and accounting.
The private maintenance binding always addresses the `instance` coordinator; cron
only wakes it. Durable pause covers both alarms and cron; see
[maintenance controls](../operations/maintenance.md).
