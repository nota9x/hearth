# Releases and Git hooks

Hearth has one release stream for root, web, core, and both Workers. All packages
remain private. Release Please publishes GitHub releases; it does not publish npm
packages or deploy Cloudflare resources.

## Contributor commits and hooks

Use Conventional Commits for commits and PR titles, for example
`docs: improve installation guidance` or `fix(upload): handle interrupted writes`.
Use `!` in a breaking PR title so squash merging preserves that signal, or preserve
a `BREAKING CHANGE:` footer in a commit body.

`pnpm install --frozen-lockfile` installs Lefthook through its allowed postinstall
script. Pre-commit runs a Windows path guard, formats supported staged files with
Prettier and re-stages matching changes, then generates SvelteKit types and lints
staged source. Commit-msg checks the actual Git message using commitlint. Generated,
secret, runtime, and changelog files are excluded.

After a failure, inspect both `git diff` and `git diff --cached`: formatting may
already have changed the index. With partial staging, Lefthook hides unstaged
changes, formats staged content, and restores them. If restoration conflicts,
inspect diagnostics and `git stash list` for `lefthook auto backup` before deleting
backups. Do not bypass a hook to commit uncertain content. Format before `git add -p`
when practical. On an unborn branch, fully stage the initial commit; Git cannot
make the backup stash required for partial staging.

The Windows guard rejects apostrophes/newlines in staged formatter paths; rename
such paths before committing. Spaces, brackets, and dollar signs use native hook
escaping. Preserve existing custom hooks before installing into another checkout.

```sh
pnpm exec lefthook validate
pnpm exec lefthook dump
pnpm exec lefthook install
pnpm exec lefthook run pre-commit
pnpm exec commitlint --edit .git/COMMIT_EDITMSG --verbose
pnpm verify
```

Reinstall hooks after `--ignore-scripts` or an installation with CI settings.
Check `core.hooksPath`, existing hooks, and tool availability rather than forcing
installation over unrelated configuration. `LEFTHOOK_VERBOSE=1` enables diagnostics.

## Maintainer repository setup

The workflows target `main`. For a new hosted repository:

1. Allow the actions declared in `.github/workflows`. Keep the default workflow
   token read-only.
2. Create a GitHub App for releases, without webhooks. Give it repository **Contents**,
   **Issues**, and **Pull requests** read/write permissions and install it only on
   the intended repository.
3. Set the Actions variable `RELEASE_PLEASE_APP_CLIENT_ID` to the App Client ID and
   secret `RELEASE_PLEASE_APP_PRIVATE_KEY` to its PEM private key. The release workflow
   obtains a short-lived installation token. Do not replace it with `GITHUB_TOKEN`:
   App-created release PRs can trigger the required PR workflows.
4. Enable squash merging, disable merge/rebase merging, and use the PR title as
   the default squash message. Preserve the checked title in the merge dialog.
5. After checks have run, require the actual `validate` and `pr-title` status
   contexts, normal review requirements, and current branch status for `main`.
   Block force pushes/deletion and unauthorized direct pushes, including administrator
   bypass. Do not grant the release App a bypass; it creates PRs for maintainers to merge.
6. Enable release immutability before publication if your repository supports it.
   Never move published tags or replace immutable assets; issue a new release.

Inspect an existing repository's tags/releases and protections before configuring
it; do not delete history to fit the initial configuration. Workflow files must
exist on the base branch before ordinary PR checks can use them. These setup steps
are maintainer operations, not self-hosting prerequisites.

The PR-title workflow uses `pull_request_target` and checks out only the base SHA;
do not change it to execute untrusted PR code with credentials. Required title checks
cannot prevent a maintainer editing the final squash message. Preserve the title;
metadata rules may add enforcement where available. Workflows do not set up a merge queue.

See [Release Please authentication](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs)
and [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

## Continuous integration

`Validate` runs on every pull request and push to `main`, without path exclusions.
Five work jobs start independently:

| Job                    | Validation                                                               |
| ---------------------- | ------------------------------------------------------------------------ |
| Quality and unit tests | Formatting, lint, web/root types, all unit tests                         |
| Integration (1/2, 2/2) | All integration tests, divided by Vitest's native file sharding          |
| Browser (1/2, 2/2)     | Web build and all browser tests, divided by Playwright's native sharding |

Vitest retains two workers per runner; Playwright retains one. Browser jobs use
`--fully-parallel` to distribute individual tests across shards, while each test
still receives fresh isolated D1/R2 and synthetic credentials. Each browser job
builds web locally, then its global setup bundles web, delivery, and maintenance with Wrangler.
Integration global setup also bundles delivery and its upload fixture. These
cover the Worker dry runs; the browser fixture also runs the maintenance Worker.
Each integration runner runs `svelte-kit sync` before Vitest: tests import web
routes whose TypeScript configuration extends the generated `$app/tsconfig`.
Generated configuration is local to each runner; it cannot come from another job.
`pnpm verify` remains the complete local baseline.

The required `validate` job waits for all five jobs and accepts only successful
results. Failures, cancellations, and skipped dependencies cannot produce a passing
gate. Matrices do not cancel sibling shards on failure. Quality checks continue
after other check failures, provided installation succeeded. New commits cancel
obsolete validation runs; title edits and new commits cancel obsolete `pr-title`
runs. Release Please remains independently serialized.

Every work job installs dependencies with `--frozen-lockfile` and the manifest's
exact pnpm version on Node 24. The pnpm store cache hashes `pnpm-lock.yaml`,
`package.json`, and `pnpm-workspace.yaml`, in addition to setup-node's OS and
architecture identity. Restoring the cache never skips installation or dependency
security policies. Cache misses use a normal install. GitHub scopes PR caches to
their merge refs, so they cannot replace caches consumed by `main` or other PRs.
Generated builds, test state, and browser binaries are not cached. Headless
Chromium uses `playwright install --with-deps --only-shell chromium`.

CI browser runs reject focused tests and stop after ten minutes, leaving time for
reporting within the fifteen-minute job timeout. Failed browser jobs upload HTML
reports, failure traces, and screenshots from only `playwright-report/` and
`test-results/`, retained for seven days under shard/attempt-specific names. Do
not broaden those paths to fixture state or `artifacts/`: they may contain keys
and local configuration. Reports contain only the synthetic test environment.

### Performance baseline and verification

The three successful pre-refactor runs below used a single sequential job:

| Run                                                                      | Elapsed | Install | `pnpm verify` | Browser install | Browser tests |
| ------------------------------------------------------------------------ | ------- | ------- | ------------- | --------------- | ------------- |
| [38985607520](https://github.com/nota9x/hearth/actions/runs/38985607520) | 8m34s   | 7s      | 4m20s         | 20s             | 3m21s         |
| [38985583362](https://github.com/nota9x/hearth/actions/runs/38985583362) | 8m34s   | 8s      | 4m23s         | 19s             | 3m24s         |
| [38984834301](https://github.com/nota9x/hearth/actions/runs/38984834301) | 9m12s   | 8s      | 4m36s         | 28s             | 3m28s         |

Elapsed time includes queue/runner startup and post-job work. In run 38985607520,
formatting took about 7s, lint 55s, types 19s, Vitest 172s, and the web build 7s.
Moving the independent work into parallel jobs targets roughly 2.5–3.5 minutes;
this is a projection, not a measured result of the new workflow. The tradeoff is
four additional dependency setups, two web builds instead of one, and the small
aggregate job, so elapsed-time savings do not imply runner-minute savings.

After a hosted run, compare run creation/start/completion times, each job's setup,
cache restore/save, install and test steps, and the sum of job durations. Include
both cache hits and misses and account for billing rounding per job. Local tests
and actionlint do not verify GitHub cache service behavior, scheduling, artifact
uploads, permissions, or hosted execution of the new graph.

## Release lifecycle and versions

Pushes to `main` run Release Please. It reads Conventional Commits and updates a
release PR. Review it and wait for required checks/reviews, then squash merge without
changing generated release title, body, or labels. The next workflow run publishes
the version tag/release at the merged commit. Runs are serialized.

| Change                               | Before 1.0.0     | From 1.0.0       |
| ------------------------------------ | ---------------- | ---------------- |
| `feat`                               | Minor            | Minor            |
| `fix`, `perf`                        | Patch            | Patch            |
| Breaking change                      | Minor            | Major            |
| Other non-breaking maintenance types | No release alone | No release alone |

The largest applicable bump wins; conventional reverts are supported. The checked-in
package versions begin at `0.1.0`, while the release manifest begins at `0.0.0`, the
last-released marker. `initial-version: "0.1.0"` selects the first proposal. Do not
pre-create that tag or manually advance the manifest. A qualifying first application
commit is needed; maintenance-only history does not create a release.

Release Please updates root/web/core package versions, `.release-please-manifest.json`,
and `CHANGELOG.md` together. Workers have no independent manifests. The lockfile
does not contain the application's own release version, so a version bump does not
require dependency changes. Credential, schema, protocol, and audit format versions
are separate and must not be synchronized with a release number.

Do not edit the generated changelog or leave a permanent version override. For an
intentional transition to 1.0.0, a reviewed `Release-As: 1.0.0` footer is supported.
If assets are introduced, attach them before publishing an immutable release.

## Verify and troubleshoot releases

Check that invalid PR titles fail and title edits refresh the check, ordinary and
App-created PRs run required CI, and the release/tag SHA matches the merged release
commit. The local test suite cannot prove hosted permissions or publication behavior.

If a release PR is missing, inspect qualifying commits, App permissions/credentials,
and pending/tagged release labels. If publication fails, preserve generated metadata
and rerun the failed workflow after correcting access; do not manually tag or create
a duplicate release. Unexpected first-version proposals require checking existing
release state and `Release-As` footers before merging.
