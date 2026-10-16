# Hearth repository guide

Private ShareX image host: TypeScript, SvelteKit/Svelte 5 on Cloudflare Workers,
D1/Drizzle, private R2. One pnpm workspace/release stream; Workers have no package
manifests. Use Node 24 (CI) and the pnpm version pinned in `package.json`; dependency installs enforce engines,
24-hour release age, and the build allowlist in `pnpm-workspace.yaml`.

## Commands (repository root)

- Install: `pnpm install --frozen-lockfile`.
- Guided Cloudflare installation/resume: `pnpm run setup` (`--advanced` exposes
  resource choices). `pnpm run setup --uninstall` (alias `--remove`) discovers,
  reviews, and removes a selected Hearth instance; never test it on live accounts.
  Always include `run`: `pnpm setup` configures pnpm itself.
  Installer progress/diagnostics are ignored under `artifacts/setup`; credentials
  stay in memory. Do not use live accounts for ordinary automated tests.
- Local setup: `pnpm db:migrate`, then `pnpm bootstrap "Your name"` **once** on an
  empty database; save the printed administrator key privately.
- Develop: `pnpm dev` starts web :5173, delivery :8788, and scheduled maintenance
  :8789. `pnpm dev:web`, `pnpm dev:delivery`, `pnpm dev:maintenance` isolate services.
- Build web: `pnpm build`; preview built web, delivery, and scheduled maintenance: `pnpm preview`.
- Types: `pnpm check` (Svelte check plus root TypeScript); lint: `pnpm lint`
  (generates SvelteKit types; warnings fail).
- Format touched files: `pnpm exec prettier --write AGENTS.md` (substitute paths).
  `pnpm format:check` checks all; `pnpm format` rewrites all.
- Focused test: `pnpm exec vitest run tests/unit/core.test.ts`; add
  `-t "normalizes custom addresses"` to select a case. All unit/integration
  tests: `pnpm test`.
- Browser: install Chromium (`pnpm exec playwright install chromium`), run
  `pnpm build`, then `pnpm exec playwright test tests/browser/domains.spec.ts`
  or the full `pnpm test:browser`. The harness allocates ports and disposable D1/R2
  per case, controls Turnstile and blocks external traffic; no bootstrap or local
  migrations are needed. Avoid concurrent rebuilds of the generated web output.
- CI baseline: `pnpm verify` = formatting, lint, types, unit/integration tests,
  web build. Browser tests and delivery/maintenance deploy dry runs are additional
  CI steps in `.github/workflows/ci.yml`.
- Schema generation: `pnpm db:generate`; apply local SQL: `pnpm db:migrate`.
- Worker bundle checks: `pnpm exec wrangler deploy --dry-run --config workers/delivery/wrangler.jsonc`
  and `pnpm exec wrangler deploy --dry-run --config workers/maintenance/wrangler.jsonc`.

## Find the implementation

- `apps/web/src/routes`: HTTP/page entry points. `hooks.server.ts` owns sessions,
  origin enforcement, and response security. Dashboard mutations dispatch through
  `routes/api/actions/[action]/+server.ts`; `lib/client.ts` calls them.
- `apps/web/src/lib/server/dashboard.ts`: user/admin catch-all page loader;
  `lib/Dashboard.svelte` renders it. `src/app.css` holds shared styling.
  Browser imports use native `#lib` subpath imports with file extensions, core imports
  `@hearth/core/<module>`; use Svelte 5 runes and direct Lucide icon imports.
- `packages/core`: shared domain operations, authorization, search/collections,
  storage, and validation; independent of SvelteKit. `schema.ts` defines Drizzle
  tables; `db.ts` adapts D1. `common.ts` owns `AppError` and Unix-second time helpers;
  SQL/JSON `null` is intentional. Web API errors use `lib/server/http.ts`.
- `workers/delivery/src/index.ts` delegates to `packages/core/public-share.ts`;
  `serve.ts` implements object/range/conditional responses.
- `workers/maintenance/src/index.ts`: cron, expiry/purge, optional Images previews,
  snapshots, reconciliation. `cli/development` launches/schedules local
  services; production maintenance logic stays in the Worker.
- `drizzle/*.sql`: ordered migrations **and handwritten database invariants**.
  `tests/helpers/database.ts` applies migrations to isolated D1 fixtures.

## Boundaries and change rules

- Preserve unrelated staged, unstaged, and untracked work. Prefer native features
  and minimal dependencies; avoid compatibility wrappers unless requested.
- Prioritize performance and resource efficiency when choosing algorithms, data
  structures, and native platform capabilities. Minimize CPU work, allocations,
  I/O, network requests, database queries, and bundle size where practical.
- Keep runtime and maintenance overhead low: avoid unnecessary abstractions,
  intermediate operations, redundant work, and architectural complexity. Reuse
  existing functionality when efficient; do not sacrifice performance for reuse.
- Consider efficiency during implementation, especially in frequently executed or
  resource-intensive paths. Keep optimized code readable; justify added complexity
  with meaningful, measurable benefits. Avoid speculative micro-optimizations.
- Schema changes update `packages/core/schema.ts` and add an ordered migration. Review
  generated SQL: quota/accounting, last-active-admin protection, alias permissions
  and primary selection, and audit retention rely on SQL triggers/unique indexes,
  not only application checks. Preserve them through table rebuilds.
- Images own bytes; aliases reference images. Removing a link keeps the image;
  removed addresses stay reserved while their domain exists. Image deletion
  tombstones D1 before R2 purge; maintenance retries. D1/R2 cannot transact together:
  uncertain upload commits must not delete possibly referenced objects.
- Delivery must check authoritative D1 account/domain/link/image state on every
  request **before** range/conditional/304 handling. Keep R2 private and delivery
  revalidation intact. Domain access restrictions govern new shares; disabling
  delivery suspends existing links. No usable selected domain means private upload,
  never silently select another domain.
- `hooks.server.ts` enforces exact `APP_ORIGIN` for cookie mutations. SvelteKit's
  `csrf.trustedOrigins: ['*']` intentionally delegates to that hook.
  `/api/v1/images` uses bearer authentication and accepts native ShareX without
  Origin; `/api/upload` uses sessions. Both call the same bounded streaming upload
  pipeline. Sanitization failures must not fall back to unsanitized originals.
- New mutations: capture safe audit data before modifying/deleting resources,
  insert success events in the same D1 batch, add presentation labels, and exercise
  the action in `tests/integration/audit.test.ts`; see
  `docs/development/architecture.md#audit-requirements`.
- Local runtime creates shared state at `apps/web/.wrangler/state`: Wrangler `--persist-to` takes
  that parent; the SvelteKit platform proxy takes its `/v3` subdirectory. Keep
  local D1/R2 identifiers aligned. Sign in at `http://127.0.0.1:5173`.
- Checked-in `wrangler.jsonc` files are local settings. Production setup uses
  `pnpm configure` and ignored `production.local.jsonc`; consult deployment docs.
  Keep `.dev.vars`, `.env`, `.sxcu`, and `artifacts/test-key` credentials out of Git.
- After binding changes, regenerate `packages/core/bindings.d.ts` and
  `packages/core/delivery-bindings.d.ts` with `pnpm typegen`; do not hand-edit.
  Do not edit build/runtime output in
  `.svelte-kit`, `.wrangler`, or `node_modules`. Drizzle snapshots/journal in
  `drizzle/meta` accompany migrations; `CHANGELOG.md` is Release Please output.

## Validation by scope

- Scale testing to the change's risk and complexity. Focus on important behaviors,
  regressions, edge cases, and critical functionality; avoid redundant, brittle,
  or implementation-specific tests and disproportionate coverage for trivial
  changes or one-off fixes.
- Docs-only: formatting and referenced paths/commands. Code: start with the affected
  `tests/unit` or `tests/integration`, then applicable lint/types. Broaden to `pnpm verify` for shared
  behavior, schema, toolchain, cross-Worker changes, or unresolved failures.
- Vitest runs `tests/unit` and `tests/integration` with two bounded workers.
  Mutating integration cases use fresh real Miniflare/workerd D1/R2; preserve
  storage, concurrency and authorization protection. `pnpm test:unit` and
  `pnpm test:integration` select a level; optional measurements use `pnpm test:benchmark`.
- Playwright includes `*.spec.ts`, one worker, and starts built web/delivery Workers.
  Run relevant browser cases for UI/route/auth changes. Never rebuild while preview
  runs on Windows: Wrangler holds the adapter output directory open.
- Browser fixtures create synthetic accounts and temporary isolated D1/R2 for
  every case. `tests/helpers/browser.ts` owns runtime/state/proxy setup;
  `playwright.config.ts` selects the suite. Import its `test`/`expect`, and pass
  the fixture proxy when creating additional contexts. CI needs no database
  bootstrap or generated configuration workaround.
- Commits and PR titles use Conventional Commits. Lefthook formats/re-stages
  matching staged files, then lints; inspect both index and worktree after failures.
  For partial staging, hook recovery, or version/release edits, read
  `docs/development/releasing.md`.

## Read on demand

- Documentation navigation and self-hosting journeys: `docs/README.md`.
- Local ports, state, cron, lifecycle: `docs/development/local-setup.md`;
  resources and deployment: `docs/getting-started/installation.md`;
  bindings and variables: `docs/reference/configuration.md`.
- Authentication, delivery, upload retries, canonical-byte sanitization,
  database invariants, audit, UI feedback, and HTTP boundaries:
  `docs/development/architecture.md` and `docs/guides/security.md`.
- Domains and link workflows: `docs/guides/custom-domains.md` and
  `docs/guides/images-and-links.md`; account administration:
  `docs/guides/user-management.md`; capacity: `docs/guides/storage-management.md`.
- Updates, recovery, scheduled maintenance, and diagnosis: `docs/operations/`.
