# Install Hearth on Cloudflare

This guide deploys a new instance. For an existing installation, use
[updating](../operations/updating.md); do not bootstrap it again.

## Prerequisites

You need:

- **Node 24 and the pnpm version pinned in `package.json`**, the versions used by CI. Check `node --version` and
  `pnpm --version`. The declared Node range also accepts 26 and later but excludes 25. Use Node 24 for the documented path.
- **Git** and the Hearth repository URL supplied by the project or your own fork.
- **A Cloudflare account** with permission to deploy Workers, manage D1 and R2,
  attach Worker Custom Domains in your zones, and create a Turnstile widget.
- **An active domain in that account**, with two different available hostnames:
  for example, `app.example.com` for the dashboard/API and `images.example.com`
  for public images. Multiple delivery hostnames are optional.
- **R2 enabled** through the account's R2 checkout flow. Review service usage
  and billing; an application storage cap does not cap your Cloudflare bill.
- **Real Turnstile site and secret keys** for your application hostname. Create
  the widget in step 3 if you do not already have one.

If your domain is not active, follow Cloudflare's
[zone setup guide](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
Review website/email records before changing nameservers.
[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
require an active zone you own and manage DNS and TLS for each exact hostname.

Consult current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) rather than assuming
your workload will remain within included usage.

Cloudflare Images is optional; without it Hearth uses originals for dashboard
previews. AWS CLI is needed only for object backups and storage initialization
before enabling a global capacity limit.

## 1. Get the source and install dependencies

Clone the Hearth repository:

```sh
git clone https://github.com/nota9x/hearth.git
cd hearth
pnpm install --frozen-lockfile
```

Stay in this directory for the commands below. Installation enforces engine,
dependency release-age, and build-script policies; do not bypass them to force an
unsupported toolchain. See [installation failures](../operations/troubleshooting.md#installation-or-deployment-fails).

## 2. Authenticate and create storage

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create hearth-production
pnpm exec wrangler r2 bucket create YOUR_BUCKET_NAME
```

Wrangler opens a browser for login. Confirm the account reported by `whoami` owns
your zones and resources. Save the UUID returned for the new D1 database.
Replace `YOUR_BUCKET_NAME` with a unique name using lowercase letters, digits,
and hyphens: 3–63 characters, with a letter or digit at each end.

Use a dedicated private R2 bucket. Keep **Public Development URL** (`r2.dev`) and
R2 **Custom Domains** disabled. The delivery hostname belongs to the delivery
Worker, not the bucket. Normal operation uses a binding and needs no S3 keys.
See [R2 setup](https://developers.cloudflare.com/r2/get-started/) and
[Workers bindings](https://developers.cloudflare.com/r2/get-started/workers-api/).

## 3. Create a Turnstile widget

Create a **Managed** Turnstile widget in Cloudflare and allow your application
hostname, such as `app.example.com`. Save the site key and secret key separately.
Follow [Cloudflare's widget setup](https://developers.cloudflare.com/turnstile/get-started/).

The site key goes in deployment configuration. Supply the secret through
Wrangler's prompt below. Local test keys are not valid in production. Turnstile
protects browser login and sensitive confirmations; ShareX bearer uploads do not
require a challenge.

## 4. Generate and review production configuration

Substitute the two hostnames, D1 UUID, bucket name, and Turnstile site key:

```sh
pnpm configure --application app.example.com --delivery images.example.com --database YOUR_D1_UUID --bucket YOUR_BUCKET_NAME --turnstile YOUR_TURNSTILE_SITE_KEY
```

Repeat `--delivery` for additional hostnames. The script writes ignored files:

- `apps/web/production.local.jsonc`
- `workers/delivery/production.local.jsonc`
- `workers/maintenance/production.local.jsonc`

It does not create resources, attach domains, deploy Workers, or set secrets.
It refuses to overwrite existing files. If a partial run created only some files,
inspect them and preserve intentional edits before retrying.

Review all three against the [configuration reference](../reference/configuration.md).
Their `DB` bindings must reference the same database and their `BUCKET` bindings
the same bucket. The generated database name is `hearth-production`. Keep the web
`migrations_dir`, compatibility flags, rate-limit bindings, and maintenance cron.
Worker names default to `hearth-web`, `hearth-delivery`, and `hearth-maintenance`.
Another instance in the same account needs distinct names and resources.

The web configuration attaches the application hostname; delivery attaches each
image hostname using `custom_domain: true`. Remove conflicting records for those
exact hostnames, especially CNAMEs, after checking what currently uses them.
Do not substitute wildcard Routes or R2 public access.

## 5. Build, migrate, and bootstrap

```sh
pnpm build
pnpm exec wrangler d1 migrations list DB --remote --config apps/web/production.local.jsonc
pnpm exec wrangler d1 migrations apply DB --remote --config apps/web/production.local.jsonc
pnpm bootstrap "Your administrator name" --remote --config apps/web/production.local.jsonc
```

Confirm the prompt targets the new database. Apply all ordered migrations in `drizzle/`, starting with `0000_initial.sql`.
`pnpm db:migrate` operates **locally**, not on your production database.

Bootstrap prints your initial administrator API key once. Save it in a password
manager before closing the terminal; it is also your login credential. Bootstrap
refuses a second administrator. Create subsequent accounts through the dashboard.
There is no public signup or email-password setup.

## 6. Set the secret and deploy

```sh
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --config apps/web/production.local.jsonc
```

Enter the widget secret at the prompt, not as a command argument. For a new Worker,
accept Wrangler's offer to create it if prompted. Secret changes can deploy a
Worker version; this is an infrastructure change, not a validation check. See
[production secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Check the bundles, then deploy:

```sh
pnpm exec wrangler deploy --dry-run --config workers/delivery/production.local.jsonc
pnpm exec wrangler deploy --dry-run --config workers/maintenance/production.local.jsonc
pnpm exec wrangler deploy --dry-run --config apps/web/production.local.jsonc
pnpm exec wrangler deploy --config workers/delivery/production.local.jsonc
pnpm exec wrangler deploy --config workers/maintenance/production.local.jsonc
pnpm exec wrangler deploy --config apps/web/production.local.jsonc
```

This order makes delivery and cleanup available before the dashboard. The web
build supplies code and static assets. Maintenance has no public URL; cron invokes
it every five minutes. Keep R2 private and avoid cache rules that bypass delivery
checks. Allow time for Custom Domain DNS and certificates to become ready.

## 7. Verify the instance

1. Open `https://app.example.com/login` over HTTPS and confirm Turnstile works.
2. Sign in with the administrator key. New accounts enter onboarding.
3. Follow [first-run setup](first-run.md) to validate `images.example.com` and
   explicitly make it primary. A successful check verifies delivery and an R2 read.
4. Follow [ShareX setup](sharex-setup.md), upload a screenshot, open its returned
   URL, and confirm the image appears in Hearth.
5. Confirm maintenance has `*/5 * * * *` configured and inspect a scheduled
   execution using [maintenance and monitoring](../operations/maintenance.md).

A dry run verifies a bundle, not live DNS, TLS, permissions, Turnstile, or cron.
Use [troubleshooting](../operations/troubleshooting.md) for failures and establish
[backups](../operations/backups-and-recovery.md) before relying on the instance.
