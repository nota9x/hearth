# Contributing to Hearth

Hearth is an invitation-only ShareX image host with a browser dashboard and three
Cloudflare Workers. Contributions that improve usability, accessibility,
documentation, reliability, and self-hosting are welcome. This guide covers the
contribution workflow; detailed technical guidance lives in the
[development docs](docs/development/README.md).

## Report a problem or propose a change

Read the relevant [guide](docs/README.md) and search
[existing issues](https://github.com/nota9x/hearth/issues) before opening a report.

- [Bug report](https://github.com/nota9x/hearth/issues/new?template=bug-report.yml):
  describe what happened, what you expected, and how to reproduce it. Include the
  running version or commit and the environment relevant to the failure.
- [Feature request](https://github.com/nota9x/hearth/issues/new?template=feature-request.yml):
  explain the problem and the experience you want, including current workarounds.
- [Documentation feedback](https://github.com/nota9x/hearth/issues/new?template=documentation.yml):
  identify the page or section and what would make it clearer or more accurate.

For setup questions, start with [troubleshooting](docs/operations/troubleshooting.md).
If you still need help, use the appropriate
[issue template](https://github.com/nota9x/hearth/issues/new/choose) and include the
failing step and redacted error. For a substantial feature or architecture change,
discuss the approach in an issue before investing in a large implementation.

Keep account keys, Authorization headers, cookies, `.sxcu` files, deletion URLs,
private images, and production secrets out of reports and pull requests. Follow
the [Security Policy](SECURITY.md#reporting-a-vulnerability)
for suspected vulnerabilities. Submit a
[private vulnerability report](https://github.com/nota9x/hearth/security/advisories/new)
and keep exploit details out of public issues.

## Set up locally

Use **Git**, **Node 24** (the CI version), and **pnpm 12.10.1**. Check
`node --version` and `pnpm --version` before installing. The workspace enforces
engine versions, a 24-hour dependency release age, and an explicit build-script
allowlist; preserve those policies.

Fork [nota9x/hearth](https://github.com/nota9x/hearth), clone your fork, and create
a focused branch. Run all commands below from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm bootstrap "Your name"
pnpm dev
```

Run bootstrap **once**, on an empty local database, and save the printed
administrator key privately. Starting development does not migrate or reset the
database. Production credentials and resources are not needed for local setup.

Open **http://127.0.0.1:5173** and sign in with that key. In
**Administration → Domains**, add `127.0.0.1:8788`, validate it, and set it as the
instance default. Upload an image and open its delivery URL. Without a usable
delivery domain, uploads save privately.

`pnpm dev` runs the web app on **5173**, delivery on **8788**, and scheduled
maintenance on **8789**. Ctrl+C stops the services. Local D1/R2 state persists
across restarts. The Turnstile test configuration still needs network access for
verification.

See [local setup](docs/development/local-setup.md) for individual service commands,
optional local secrets, hostnames, state paths, and manual maintenance. To preview
the built application, run `pnpm build` followed by `pnpm preview`.

## Find the code

| Path                                                           | Responsibility                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`apps/web/src/routes`](apps/web/src/routes)                   | Page and HTTP entry points, including uploads and dashboard actions. |
| [`apps/web/src/hooks.server.ts`](apps/web/src/hooks.server.ts) | Sessions, origin enforcement, and response security.                 |
| [`apps/web/src/lib`](apps/web/src/lib)                         | Dashboard components, client operations, and server page loading.    |
| [`packages/core`](packages/core)                               | Shared domain operations, schema, authorization, storage, and audit. |
| [`workers/delivery`](workers/delivery)                         | Public image delivery through authoritative D1 checks.               |
| [`workers/maintenance`](workers/maintenance)                   | Scheduled expiry, cleanup, previews, and reconciliation.             |
| [`drizzle`](drizzle)                                           | Ordered migrations, handwritten triggers, and schema snapshots.      |
| [`tests`](tests)                                               | Unit, integration, browser, and fixture coverage.                    |
| [`scripts`](scripts)                                           | Local service launchers and setup/operations tooling.                |

## Make a focused change

Follow the [repository instructions](AGENTS.md) and existing conventions. Prefer
native platform features, minimal dependencies, and straightforward code. Shared
domain logic belongs in core; HTTP/page behavior belongs in the web app. Use Svelte
5 runes, native `#lib` subpath imports with file extensions for browser imports, and `@hearth/core/<module>` for shared imports.

Read [architecture and invariants](docs/development/architecture.md) before changing
authentication, uploads, delivery, persistence, or audit. In particular:

- **Schema:** update `packages/core/schema.ts`, add an ordered migration and its
  Drizzle metadata, and review generated SQL to preserve handwritten triggers and
  indexes. Do not rewrite applied migrations.
- **Mutations:** capture safe audit data before changing resources, insert success
  events in the same D1 batch, add presentation labels, and cover the action in
  `tests/integration/audit.test.ts`.
- **Storage and delivery:** preserve private R2, delivery checks on every request,
  and safe recovery when D1/R2 writes cannot be committed together. Images own
  bytes; removing a link keeps its image.
- **Bindings:** run `pnpm typegen` after binding changes; do not hand-edit generated
  declarations.
- **UI:** use existing components/styles and native controls. Check keyboard use,
  narrow and wide layouts, and reduced-motion behavior for visual changes.

Keep implementation, tests, and the relevant documentation consistent. Do not
commit credentials or edit runtime output in `.svelte-kit`, `.wrangler`, or
`node_modules`. Release Please owns `CHANGELOG.md` and release version updates;
ordinary contributions should not change those manually.

## Verify your work

Start with the affected tests and expand checks according to the change. Format
only the files you touched with `pnpm exec prettier --write` followed by their
paths.

| Change                                                  | Validation                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Documentation/community files                           | Prettier, referenced commands/paths/links, and issue form YAML when applicable. |
| Code in one area                                        | Affected unit/integration tests, then `pnpm lint` and `pnpm check`.             |
| Shared behavior, schema, toolchain, or multiple Workers | `pnpm verify`.                                                                  |
| UI, routes, or authentication                           | Relevant Playwright cases against a current web build.                          |
| Delivery or maintenance Worker bundles                  | The corresponding Wrangler deploy dry run.                                      |

`pnpm verify` checks formatting, lint, Svelte/TypeScript, unit/integration tests, and
the web build. It does **not** include browser tests or Worker deploy dry runs; CI
runs those separately. Lint warnings fail.

For a focused test:

```sh
pnpm exec vitest run tests/unit/core.test.ts
pnpm exec vitest run tests/unit/core.test.ts -t "generates multipart bearer request"
```

Use `pnpm test:unit`, `pnpm test:integration`, or `pnpm test` for broader Vitest
coverage. Integration tests use isolated real Miniflare/workerd D1/R2 fixtures.

For browser changes:

```sh
pnpm exec playwright install chromium
pnpm build
pnpm exec playwright test tests/browser/domains.spec.ts
```

Choose the case relevant to your change, or use `pnpm test:browser` for the suite.
Browser fixtures allocate their own ports and disposable D1/R2, control Turnstile,
and block external traffic. They need no manual bootstrap or local migrations.
Import their `test`/`expect` from `tests/helpers/browser.ts` and use the fixture
proxy for additional contexts. On Windows, stop preview before rebuilding: Wrangler
holds the adapter output directory open. Avoid concurrent web builds.

For Worker bundle checks:

```sh
pnpm exec wrangler deploy --dry-run --config workers/delivery/wrangler.jsonc
pnpm exec wrangler deploy --dry-run --config workers/maintenance/wrangler.jsonc
```

The [development overview](docs/development/README.md#required-checks) has the full
check reference. Local tests and dry runs do not verify live DNS, TLS, production
Turnstile, or Cloudflare cron.

## Submit a pull request

Keep the change focused and submit against `main`. Use the
[pull request template](.github/pull_request_template.md) to explain the problem,
resulting behavior, verification results, and any configuration, migration, or
documentation impact. Link related issues with `Closes #123` when applicable.
Include screenshots for visual changes, using synthetic data. State checks you
could not run and why.

Commits and PR titles use Conventional Commits:

```text
docs: clarify ShareX setup
fix(upload): handle interrupted writes
feat(domains): add a delivery control
```

Use `!` for a breaking PR title and explain the impact and upgrade steps. CI checks
PR titles; local commit-msg hooks check commit messages. Release Please uses the
merged Conventional Commits to prepare release notes and version changes.

Dependency installation sets up Lefthook. Pre-commit formats and re-stages matching
staged files before linting. After a hook failure, inspect both `git diff` and
`git diff --cached` before retrying. For partial staging, hook recovery, and release
work, follow [releases and Git hooks](docs/development/releasing.md).

Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are
licensed under Hearth's [GPL-3.0-or-later license](LICENSE).
