# Run Hearth locally

Local services use loopback, local D1/R2, and persistent state separate from production.
Use Node 24 and the pnpm version pinned in `package.json`. Run commands from the repository root.

## Initialize once

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm bootstrap "Your name"
pnpm dev
```

Save the printed administrator key privately. Migrations/bootstrap are explicit;
starting development does not initialize or reset the database. Bootstrap is for
the first administrator only.

Open `http://127.0.0.1:5173` and sign in. In **Administration → Domains**, add
`127.0.0.1:8788` or `shots.localhost`, validate, and set the instance default. Upload an image and
open its port-8788 URL. Without usable delivery, images save privately.

The local configuration includes a Turnstile test site key; development falls back
to the matching test secret. Siteverify still needs network access. Optional local
secrets belong in `apps/web/.dev.vars`; see `apps/web/.dev.vars.example`. Never copy
production credentials into local settings. The launcher/adapter reject remote
storage bindings.

## Services and lifecycle

| Command                | Services                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`             | Web :5173, delivery :8788, maintenance :8789 with automatic scheduling.    |
| `pnpm dev:web`         | Web only.                                                                  |
| `pnpm dev:delivery`    | Delivery only.                                                             |
| `pnpm dev:maintenance` | Maintenance with automatic scheduling.                                     |
| `pnpm preview`         | Built web plus delivery and scheduled maintenance; run `pnpm build` first. |

Wait for readiness before opening the application. Web uses Vite HMR; Wrangler
watches delivery/maintenance sources. Shared core edits rebuild affected Workers.
Preview needs another build after web changes. Ctrl+C stops scheduling, drains
active maintenance, and shuts down owned services.

The launcher checks resource/port consistency and occupied ports. Interactive runs
may offer to stop a recognized existing Hearth server; the default is No. Other
applications and non-interactive runs are not terminated. Do not start standalone
services on ports already owned by dev/preview.

## Persistence and hostnames

All services share `apps/web/.wrangler/state/v3`, with matching local database IDs
and bucket names. Wrangler `--persist-to` takes the parent
`apps/web/.wrangler/state`; the SvelteKit platform proxy takes its `/v3` subdirectory.
Keep this distinction for ad hoc commands. Restarting preserves state; do not delete
it casually to resolve an error.

Sign in using `127.0.0.1:5173`. Session cookies belong to that hostname and exact-origin
checks reject dashboard mutations through `shots.localhost:5173`. Delivery is separate:
`http://shots.localhost:8788/<slug>`. For clients that do not resolve `.localhost`, use:

```sh
curl --resolve shots.localhost:8788:127.0.0.1 http://shots.localhost:8788/YOUR_SLUG
```

Use `curl.exe` if Windows PowerShell aliases `curl`. Local validation verifies
instance/storage identity, not production DNS or TLS. Local input may include the
configured delivery port; production hostnames may not.

Ports come from checked-in `dev.port`. Changing the web port requires matching
`APP_ORIGIN` in web and delivery; changing delivery requires matching web
`LOCAL_DELIVERY_PORT`. Restart after configuration changes.

## Trigger local maintenance

The development launcher dispatches `*/5 * * * *` on UTC boundaries through Wrangler's
real scheduled handler. Startup does not run it immediately or replay missed events.
Scheduling remains development-only; production uses Cloudflare cron.

Press **M** in a dev/preview terminal with maintenance running for an immediate
execution. In a non-interactive session, use:

```sh
curl "http://127.0.0.1:8789/cdn-cgi/local/scheduled?format=json&cron=*/5%20*%20*%20*%20*"
```

An `outcome` of `ok` means waited work completed. This is Wrangler's local endpoint,
not a production route. Manual triggering does not bypass the daily scan's wall-clock
condition. To run a scan outside that window, start one from Storage.

## Verify local work

Confirm login, signed delivery validation, upload/public URL, persistence across
restart, and cleanup of a disposable expired image. Use
[development checks](README.md#required-checks) for automated coverage.

Browser fixtures create their own state and ports; they do not use this bootstrap.
Stop preview before rebuilding on Windows. Local success does not verify live DNS,
TLS, real Turnstile/Images access, Cloudflare cron, or distributed edge limits.
