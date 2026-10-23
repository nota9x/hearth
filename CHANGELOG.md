# Changelog

## [0.3.0](https://github.com/nota9x/hearth/compare/v0.2.0...v0.3.0) (2026-10-23)

### ⚠ BREAKING CHANGES

- **Database installation:** Replace the 16 historical migrations with `0000_initial.sql`, which creates the schema directly while retaining its integrity triggers and initial settings. Databases using the removed migration history require a fresh installation; the new baseline cannot be applied over their existing tables. ([#29](https://github.com/nota9x/hearth/pull/29), [9bc0af0](https://github.com/nota9x/hearth/commit/9bc0af0587d9cde58c30fb5a3781015f148b6fe8))

### Features

- **Guided Cloudflare installation:** Add `pnpm run setup` to provision resources, generate production configuration, deploy web, delivery, and maintenance Workers, and verify sign-in and image delivery. Saved progress lets interrupted installations resume. ([#32](https://github.com/nota9x/hearth/pull/32), [524729f](https://github.com/nota9x/hearth/commit/524729f3b3a47311733590199e803eb5a5f801fc))
- **Instance removal:** Add a resumable `pnpm run setup --uninstall` flow that discovers an instance and presents its resource deletion plan for explicit confirmation before removing Workers, D1 data, R2 contents, and Turnstile widgets. ([#32](https://github.com/nota9x/hearth/pull/32))
- **Display name policies:** Let administrators restrict member name changes instance-wide or override the policy per account with Inherit, Allow, or Restrict. Enforce the policy in Settings and onboarding, exempt administrators, and audit policy changes. Saving an override takes effect on the next request without revoking sessions. ([#40](https://github.com/nota9x/hearth/pull/40), [c9f3a37](https://github.com/nota9x/hearth/commit/c9f3a37e90ac62c6f57cb7fa4da44e864d8aa516))
- **Background storage checks:** Make **Check storage** run cleanup followed by a storage scan immediately, with saved progress that continues after the page closes. A private Durable Object coordinates bounded maintenance work, retries temporary failures, and catches up daily scans after downtime. ([#51](https://github.com/nota9x/hearth/pull/51), [fad556f](https://github.com/nota9x/hearth/commit/fad556ff25f4a9e5965a5baa38aed95f0ba0c13e))
- **Maintenance controls:** Add pause, drain status, resume, and retry actions, with diagnostics for the active stage, last progress, cleanup backlog, and failures. Resume and retry continue saved work; repairing or deleting discovered files still requires separate confirmation. ([#51](https://github.com/nota9x/hearth/pull/51))
- **Storage dashboard:** Separate capacity, unresolved issues, and maintenance health. Show stored bytes, upload reservations, and files awaiting deletion, distinguish completed storage checks from automatic cleanup, and move detailed diagnostics and usage history into expandable sections. ([#51](https://github.com/nota9x/hearth/pull/51))
- **Storage initialization and local recovery:** Initialize accounting automatically for fresh guided installations so administrators can enable a global limit immediately. Preserve accounting on resume and upgrades. Local bootstrap now prompts for a name and offers a confirmed database reset when an administrator already exists, retaining local R2 files. ([#51](https://github.com/nota9x/hearth/pull/51))

### Performance Improvements

- **Storage reconciliation:** Batch object lookups and accounting writes instead of processing each file with separate D1 queries. A 100-orphan listing page now uses 7 SQL statements instead of 402, and maintenance checkpoints work within bounded D1 and R2 operation budgets. ([#51](https://github.com/nota9x/hearth/pull/51))
- **Cleanup retries:** Persist retry timing for previews, image purges, and interrupted storage operations so repeated failures back off while other eligible files continue processing. ([#51](https://github.com/nota9x/hearth/pull/51))

### Bug Fixes

- **Setup version check:** Read the required pnpm version from `package.json` instead of hard-coding an older release, so dependency updates no longer cause setup to reject the project's declared version. Include detected-version details and installation guidance on mismatch. ([5d41093](https://github.com/nota9x/hearth/commit/5d41093b9358a3e31216e4afd3315b2ef3cc1a21))
- **ShareX banner:** Use the official ShareX SVG, vertically center it beside the banner copy, and place mobile actions below the text with right alignment. Remove the unused `@thesvg/svelte` dependency. ([#41](https://github.com/nota9x/hearth/pull/41), [6463874](https://github.com/nota9x/hearth/commit/6463874f499e6c9d32e1dbc50ded5ebfcb99576f))
- **Upload overlay:** Remove the image-expiry summary from the drag-and-drop overlay while retaining the warning when the saved default expiry needs correction. ([#51](https://github.com/nota9x/hearth/pull/51))

### Development and Dependencies

- **Unified CLI:** Route development, preview, configuration, bootstrap, setup, and storage initialization through one CLI, preserving existing script entry points and forwarding native Vite/Wrangler arguments. ([#32](https://github.com/nota9x/hearth/pull/32))
- **Continuous integration:** Run quality/unit checks, two integration shards, and two browser shards independently, with `validate` requiring every job to pass. Retain browser failure reports, traces, and screenshots, generate SvelteKit types in integration jobs, and cancel obsolete validation runs. ([#34](https://github.com/nota9x/hearth/pull/34))
- **ZIP downloads:** Update `@zip.js/zip.js` from 2.23.0 to 2.24.0, bringing upstream archive-writing improvements to the library used for bulk image downloads. ([#5](https://github.com/nota9x/hearth/pull/5), [af3a0a2](https://github.com/nota9x/hearth/commit/af3a0a23740a938a722620e166697d7b2728e855))

## [0.2.0](https://github.com/nota9x/hearth/compare/v0.1.0...v0.2.0) (2026-10-14)


### Features

* **ui:** update ShareX banner and replace unicode icons with Lucide icons ([9f3129e](https://github.com/nota9x/hearth/commit/9f3129ea9cbc9061aa0019dc2ba7e60bb50a3af8))
* **web:** add deployment update notice and adopt Kit 3 conventions ([0dae14b](https://github.com/nota9x/hearth/commit/0dae14bb103999ed92f0a40d27d83617338ef369))

## 0.1.0 (2026-10-13)


### Features

* introduce Hearth image host ([28d20b0](https://github.com/nota9x/hearth/commit/28d20b0897bb3a42c0c2753407636a467df3b57c))


### Bug Fixes

* migrate SvelteKit and restore dependency CI ([#11](https://github.com/nota9x/hearth/issues/11)) ([dba8d8e](https://github.com/nota9x/hearth/commit/dba8d8eca049c0192f971d2376eb5aab0389b6d9))

## Changelog

Release Please maintains this file when preparing release pull requests.
