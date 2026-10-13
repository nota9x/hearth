<div align="center">

<h1><img src="docs/assets/hearth-logo.svg" alt="hearth" width="320" /></h1>

**Your screenshots, your domains, your image host.**

A self-hosted, invitation-only image host for ShareX, built on Cloudflare Workers.

[![CI](https://github.com/nota9x/hearth/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nota9x/hearth/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)

[Get started](docs/getting-started/installation.md) ·
[Documentation](docs/README.md) ·
[Contribute](CONTRIBUTING.md) ·
[Report an issue](https://github.com/nota9x/hearth/issues/new/choose)

</div>

Hearth gives you and your invited members a place to upload screenshots, organize
images, and share them through your own domains. Upload directly from ShareX or
use the browser dashboard to manage images, links, and account preferences.
Administrators control accounts, expiry policies, delivery domains, and storage.

**Accounts protect uploading and administration. Active public image links are
viewable by anyone who has the URL.** Images without a share link stay private to
their owner and administrators; public links do not require viewer login.

## Highlights

- **ShareX integration.** Download a ready-to-import custom uploader with your
  account key and deletion links, or upload through the dashboard.
- **Flexible sharing.** Give an image multiple links across allowed delivery
  domains, choose custom slugs, and set image and link expiry independently.
- **Image management.** Search, filter, sort, and select across pages, with bulk
  copying, downloads, expiry changes, and deletion.
- **Metadata privacy.** Strip unnecessary embedded metadata by default without
  recompressing pixels, while retaining rendering information and color profiles.
- **Account and storage controls.** Create accounts, rotate keys, suspend access,
  set quotas and expiry policies, and inspect audit events. An optional global
  capacity limit tracks stored objects and upload reservations.
- **Private storage with controlled delivery.** R2 stays private. Every public
  request checks current account, domain, link, image, and expiry state before
  serving bytes. Scheduled maintenance handles expiry and retries cleanup.

Supported uploads are **PNG, JPEG, GIF, WebP, and supported still AVIF images**.
See [images and links](docs/guides/images-and-links.md) for format, expiry, and
metadata details.

## Self-host Hearth

The documented setup uses **Node 24**, **pnpm 12.10.1**, and a Cloudflare account
with Workers, D1, R2, and Turnstile. You need an active Cloudflare domain with
separate hostnames for the dashboard/API and image delivery. Cloudflare Images is
optional for dashboard previews.

1. **[Install on Cloudflare](docs/getting-started/installation.md).** Create the
   resources, generate production configuration, migrate the database, bootstrap
   the first administrator, and deploy the three Workers.
2. **[Complete first-run setup](docs/getting-started/first-run.md).** Sign in,
   validate a delivery domain, and choose your upload defaults.
3. **[Connect ShareX](docs/getting-started/sharex-setup.md).** Import your generated
   uploader and verify your first screenshot and public URL.

Production setup uses `pnpm configure` and ignored `production.local.jsonc` files;
the checked-in Wrangler configurations are for local development. Follow the
installation guide before deploying. Review Cloudflare service limits and billing
for your workload; Hearth's capacity limit is not a billing cap.

## Documentation

The [documentation index](docs/README.md) is the starting point for all guides.

| Task                                                 | Guide                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Look up variables, bindings, and deployment settings | [Configuration reference](docs/reference/configuration.md)                                            |
| Connect delivery hostnames and control new sharing   | [Custom domains](docs/guides/custom-domains.md)                                                       |
| Manage images, share links, and expiry               | [Images and links](docs/guides/images-and-links.md)                                                   |
| Invite members and manage account access             | [User management](docs/guides/user-management.md)                                                     |
| Configure quotas and reconcile storage               | [Storage management](docs/guides/storage-management.md)                                               |
| Protect credentials and understand public sharing    | [Security guide](docs/guides/security.md)                                                             |
| Update an existing instance                          | [Updating](docs/operations/updating.md)                                                               |
| Back up and recover your data                        | [Backups and recovery](docs/operations/backups-and-recovery.md)                                       |
| Monitor scheduled tasks and diagnose failures        | [Maintenance](docs/operations/maintenance.md) · [Troubleshooting](docs/operations/troubleshooting.md) |

## How it works

Hearth is a TypeScript pnpm workspace using **SvelteKit / Svelte 5**, **Drizzle /
D1**, and **R2**. Three Cloudflare Workers share one D1 database and one private
bucket:

| Worker                             | Responsibility                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| [Web](apps/web)                    | Dashboard, sessions, administration, and browser/bearer uploads.                |
| [Delivery](workers/delivery)       | Public image links, access checks, and range/conditional responses.             |
| [Maintenance](workers/maintenance) | Scheduled expiry, object purges, optional previews, and storage reconciliation. |

Domain operations live in [shared core code](packages/core). See
[architecture and invariants](docs/development/architecture.md) for persistence,
authentication, delivery, and audit boundaries.

## Contributing and support

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, relevant checks, and
pull request expectations. Documentation fixes, reproducible bug reports,
accessibility improvements, and focused code changes are welcome.

For help, read [troubleshooting](docs/operations/troubleshooting.md) and search
[existing issues](https://github.com/nota9x/hearth/issues). Use the
[issue chooser](https://github.com/nota9x/hearth/issues/new/choose) for bugs,
features, and documentation feedback.

Remove account keys, `.sxcu` contents, cookies, deletion URLs, and private images
from public reports. For suspected vulnerabilities, follow the
[Security Policy](SECURITY.md#reporting-a-vulnerability)
and keep exploit details private.

## License

Hearth is licensed under [GPL-3.0-or-later](LICENSE). Participation is governed by
the [Code of Conduct](CODE_OF_CONDUCT.md).
