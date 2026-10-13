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
