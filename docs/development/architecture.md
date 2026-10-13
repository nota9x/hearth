# Architecture and invariants

Hearth is TypeScript with SvelteKit/Svelte 5 on Cloudflare Workers, Drizzle/D1, and
private R2. Shared domain code is independent of SvelteKit. All packages are private
and versioned together; Workers have no package manifests.

## Service boundaries

| Area                                                          | Responsibility                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/web/src/routes` and `hooks.server.ts`                   | Pages, session/origin enforcement, bearer/session upload routes, dashboard actions, and HTTP security. |
| `apps/web/src/lib/server/dashboard.ts` and `Dashboard.svelte` | Shared user/admin loader and presentation.                                                             |
| `packages/core`                                               | Schema, authentication, images/links, search, domains, storage, validation, audit, and shared errors.  |
| `workers/delivery`                                            | Authoritative public-share checks, signed health proof, conditional/range streaming.                   |
| `workers/maintenance`                                         | Cron, expiry, purges, interrupted writes, optional previews, metrics, and scans.                       |
| `drizzle`                                                     | Ordered schema/data migrations and handwritten database invariants.                                    |

All three Workers bind the same D1 and private bucket. There are no Worker service
bindings. Domain validation deliberately calls the delivery HTTPS public front door;
local validation uses only configured loopback delivery. Production web keeps
`global_fetch_strictly_public` to preserve that distinction.

Browser imports use native `#lib` subpath imports with file extensions; shared imports use `@hearth/core/<module>`. Use Svelte 5
runes and direct Lucide imports. Unix-second helpers and `AppError` live in core
`common.ts`; intentional SQL/JSON nulls should stay null.

## Authentication and delivery

Account keys are high-entropy bearer credentials; only domain-separated digests are
stored. Rotation atomically replaces the current key and revokes sessions. Sessions
use hashed random tokens, current key versions, 30-day absolute and seven-day idle
expiry, and secure production cookies.

Cookie mutations require exact `APP_ORIGIN` in the central hook. SvelteKit's
`csrf.trustedOrigins: ['*']` delegates to that enforcement so native ShareX without
Origin can reach the bearer-only endpoint. Never make either upload route fall back
to the other's authentication mechanism.

Delivery checks authoritative account/domain/link/image state before range,
conditional, or 304 handling. Keep R2 private and revalidation intact. Domain access
governs new sharing; disabling delivery suspends existing links. No usable selection
means private save, never another-domain fallback. Production probes validate public
Cloudflare DNS, HTTPS without redirects, fresh instance/hostname-bound proof, and an
R2 read. Probe secrets must not enter client data.

## Uploads

`/api/upload` uses sessions and `/api/v1/images` uses bearer authentication. Both
accept one multipart `file` and run the same bounded streaming pipeline with byte
validation, expiry policy, metadata sanitization, and D1/R2 accounting. Optional
fields are `expiry` and `expiresAt`; the current implementation also accepts
`retention`. Document supported behavior without adding compatibility mechanisms.

The browser queue runs two active requests, uploads multipart parts serially per
file, and retains stable retry identities. `Idempotency-Key` is optional for API
clients; when supplied it must be 64 lowercase hex characters, randomly generated
for one logical upload and reused only to check/retry that operation. Receipts are
namespaced by user and claimed before writes. Pending receipts return 409; completed
receipts replay the saved response without duplicating objects, links, or audit.
Do not log retry keys or expire successful receipts arbitrarily.

Browser private saves return 201 with `url: null` and `sharingWarning`; bearer private
saves return 409 `IMAGE_SAVED_WITHOUT_LINK` with saved image details. Replay preserves
the original result even after domain configuration changes. Default ShareX profiles
do not supply retry keys.

Sanitized canonical bytes become the original. Failures never fall back to the input.
Container validation is bounded, not full pixel decoding. Preserve orientation,
color, transparency, and animation exceptions and existing fixture coverage.
Request aborts cannot reverse a begun D1 commit. Uncertain commits must not delete
possibly referenced objects.

## Persistence and schema changes

Images own bytes; aliases reference images. Removing aliases keeps images and
reserves addresses while the domain exists. Image deletion tombstones D1 before
R2 purge, and failed purges retry. Global capacity tracks physical objects and
reservations independently of logical user usage. External bucket writers bypass
admission; reconciliation must not release uncertain charges from historical totals.

D1 batches and SQL triggers enforce quota/accounting, last-active-admin protection,
alias permissions/primary selection, and audit retention. D1 and R2 cannot transact
together. Preserve these invariants through migrations/table rebuilds.

```sh
pnpm db:generate
pnpm db:migrate
```

Schema changes update `packages/core/schema.ts`, add an ordered migration, and retain
Drizzle snapshots/journal. Review generated SQL: Drizzle does not generate all
handwritten triggers. Use `tests/helpers/database.ts` to apply the actual chain to
isolated fixtures. Never use schema push against production or edit applied
migrations to change an existing database.

After binding changes, run `pnpm typegen`. Do not hand-edit either generated bindings
declaration. Never edit `.svelte-kit`, `.wrangler`, or dependency/runtime output.

## Audit requirements

For a new mutation:

1. Capture safe names/before/after values using `auditEvent` before modifying or
   deleting the resource.
2. Insert the success event in the same D1 batch as its mutation. Failed batches
   must not leave success events; R2 side effects remain outside that transaction.
3. Add readable labels in audit presentation, allowlisting only reviewed fields.
4. Exercise the real action in `tests/integration/audit.test.ts`, including failures
   and any new entry point outside the dispatcher.

Never pass generic bodies/headers, credentials, hashes, tokens, or arbitrary nested
metadata. Request events may record validated Cloudflare client IP; system events
do not invent one. The retention trigger keeps the latest 10,000 events, so do not
depend on audit rows as permanent operational state.

## UI feedback and HTTP errors

Trigger temporary notifications from event handlers, not page-load effects. Keep
information required to continue inline, especially new keys and form errors. Shared
operation state must survive normal navigation and clear on account changes. Show
measured upload progress and real processing state; do not invent server progress.

Use native controls and existing Svelte/CSS motion helpers. Preserve keyed identity,
focus, inert outgoing content, and reduced-motion behavior. Avoid polling animation
loops and layout motion for collection/metric refreshes.

Shared HTTP error rendering preserves status/protocol headers and generic unexpected
errors. Public inaccessible states expose equivalent 404 responses without resource
diagnostics. HTML navigation and non-HTML image/API consumers retain appropriate
representations. Keep CSP, cache controls, asset headers, and HEAD behavior when
changing templates. See the nearest browser/integration suites for these contracts.
