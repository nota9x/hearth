# Develop Hearth

Hearth is one pnpm workspace and release stream. Use Node 24 and the pnpm version pinned in `package.json`.
Start with [local setup](local-setup.md), then read
[architecture and invariants](architecture.md) before changing persistence or security.
See [releases and Git hooks](releasing.md) for contributor and maintainer workflows.
See [testing](testing.md) for choosing regression coverage and measuring the suite.
See [installer verification](setup-installer.md) for CLI tests and disposable-account acceptance checks.
Self-hosting instructions begin at the [documentation index](../README.md).

## Required checks

Run commands from the repository root:

| Command                                    | Coverage                                                       |
| ------------------------------------------ | -------------------------------------------------------------- |
| `pnpm exec prettier --write PATH`          | Format touched files.                                          |
| `pnpm format:check`                        | Check repository formatting.                                   |
| `pnpm lint`                                | Generate SvelteKit types and lint; warnings fail.              |
| `pnpm check`                               | Svelte/SvelteKit checks plus root TypeScript.                  |
| `pnpm test:unit` / `pnpm test:integration` | Unit or isolated D1/R2 integration suites.                     |
| `pnpm test`                                | Both Vitest projects with bounded workers.                     |
| `pnpm verify`                              | Formatting, lint, types, tests, and web build.                 |
| `pnpm test:benchmark`                      | Optional measurements; not a production performance guarantee. |

Start with affected tests, then applicable lint/types. Shared behavior, schema,
toolchain, or cross-Worker changes require `pnpm verify`. Docs-only changes need
formatting and referenced command/path/link checks. Use the nearest existing
integration/browser suite for mutations, authentication, and routes.

```sh
pnpm exec vitest run tests/unit/core.test.ts
pnpm exec vitest run tests/unit/core.test.ts -t "normalizes custom addresses"
pnpm exec playwright install chromium
pnpm build
pnpm exec playwright test tests/browser/domains.spec.ts
pnpm exec wrangler deploy --dry-run --config workers/delivery/wrangler.jsonc
pnpm exec wrangler deploy --dry-run --config workers/maintenance/wrangler.jsonc
```

Browser tests import `test`/`expect` from `tests/helpers/browser.ts`, allocate ports,
and create disposable D1/R2 per case. They control Turnstile and block external
traffic. Use the fixture proxy for extra browser contexts. No local bootstrap,
migrations, or generated configuration workaround is needed. The suite runs one
worker against built web/delivery; never rebuild while preview holds adapter output
open on Windows. CI also runs browser tests and both Worker dry runs.

## Regression sensitivity

The retained security suites exercise current authentication, authorization,
delivery, storage, and concurrency behavior. Captured ShareX and real metadata
fixtures remain in `tests/fixtures`; their READMEs explain provenance.

For representative mutation checks in disposable copies:

```sh
node scripts/security-mutations.mjs
node scripts/security-mutations.mjs session-account-status
node scripts/security-mutations.mjs --refactors
```

The runner copies source under ignored artifacts and restores copied mutations.
Inspect assertion failures; compile errors/timeouts are not detections. Its flags
select test experiments, not production operations. Passing finite local cases
does not establish complete security, live edge behavior, or production performance.

## Contribution boundaries

Follow the root [repository instructions](../../AGENTS.md). Preserve unrelated work
and prefer native features with minimal dependencies. Do not edit generated output,
credential files, or Release Please's changelog by hand. New mutations need atomic
audit events and real integration coverage. Database changes need ordered migrations
that preserve handwritten triggers/indexes.

Keep operational guidance in self-hosting pages. Update relevant docs alongside
behavior changes, use Conventional Commits/PR titles, and follow the
[code of conduct](../../CODE_OF_CONDUCT.md).
