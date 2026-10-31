# Testing Hearth

Start with the changed behavior's tests, then run the repository checks. A test
belongs in the suite when it detects a realistic regression that matters to users,
authorization, persistence, or a supported HTTP contract. Before adding one, check
whether an existing scenario already detects that failure.
Extend that scenario when the new case exercises the same rule; add a separate
test when it has a different failure or recovery obligation. Test count and raw
coverage percentages measure neither regression detection nor test quality.

## Local feedback

```sh
pnpm test:unit
pnpm exec vitest run tests/integration/upload.test.ts
pnpm exec vitest run tests/integration/security-auth.test.ts -t "checks ownership"
pnpm verify
pnpm exec playwright test tests/browser/domains.spec.ts
```

Pure calculations, binary parsers, and client operation scheduling belong in the
unit project. It does not bundle Workers or start D1/R2 except for explicitly
tested native development processes. Integration cases use fresh Miniflare
instances, the real migration chain, and disposable D1/R2. Keep mutation isolation;
do not share a writable database between cases to make a run faster.
Vitest's shared cleanup restores spies, globals, environment stubs, and timers.
Keep local teardown only for resources the test owns, such as runtimes or stores.

Use browser tests for interaction, navigation, download gestures, browser image
decoding, and the assembled web/delivery Workers. Build first when running browser
tests directly. Do not rebuild while a browser fixture holds adapter output open
on Windows. CI runs both Vitest projects and the browser suite; there is no hidden
slow tier or reduced CI selection.
Use `signIn` for browser setup and `hearth.DB` for fixture writes. Exercise sign-in
and domain forms in their own journeys; unrelated tests should not repeat them.
Fixture disposal removes browser data, so teardown need not delete accounts or
reset settings through the application.

When a scenario immediately manipulates server-rendered controls after a full
navigation, wait for `#svelte-announcer` to be attached first. SvelteKit creates
it on mount, after client handlers are installed. A loaded page alone does not
establish hydration; keep this synchronization separate from business assertions.

## Choosing coverage

Keep separate tests for independently enforced trust boundaries: bearer versus
session authentication, privileged actions, image and alias ownership, late login
revocation, and public delivery eligibility before conditional/range handling.
The action authorization matrix deliberately checks every mutation dispatch path.
The public delivery state matrix retains independent account, domain, link, and
image restrictions in both HTML and plain responses.

Keep storage failures that differ in their recovery obligations. An R2 operation
that failed before completion, a completed object with an uncertain D1 commit, a
reservation held by a paused writer, and an unverified physical deletion cannot
share one generic failure test. Assert persisted state and accessible bytes, not
only a thrown error.
Inject failures at storage boundaries or with real D1 constraints. Do not select
an upload transaction by its number of SQL statements. Check retained bytes,
accounting, receipts, and audits after failures, and compare retry identities
with the original request for the same file.

Avoid repeating ordinary upload, settings, search, and deletion workflows at all
three levels. Metadata unit tests protect each container's lossless privacy rules;
one browser scenario independently compares decoded pixels. ZIP output is opaque
binary data, so it does not need a matrix of image codecs. Shared admin and origin
gates need representative requests rather than every route/method combination;
ownership checks that live in different operations still need their own coverage.

Do not add tests for animation geometry, icon lists, notification wording, branding
cache internals, or every ordinary sort/date/filename variation. Successful browser
screenshots are not assertions; Playwright already retains traces and screenshots
on failure. Preserve native selectors for interaction instead of testing component
structure or exact incidental text.

When a test needs pagination, use the smallest fixture that exercises the cursor.
The reconciliation test lists three real R2 objects two at a time; it still checks
overlapping scans, conservative accounting, unique findings, and one completion
event. Large data volumes are warranted only for a real boundary, such as SQL audit
retention or an atomic selection beyond D1's ordinary parameter limits.

## Measuring and challenging changes

```sh
pnpm exec vitest run --reporter=json --outputFile=artifacts/tests.json
pnpm exec playwright test --list
node scripts/security-mutations.mjs key-account-status session-absolute-expiry private-media-owner public-alias-revocation
node scripts/security-mutations.mjs --refactors
```

Use executed Vitest JSON results for expanded case counts and timing. Vitest's
static `list` output leaves parameterized cases unexpanded. Count source definitions
separately, including conditional Windows cases and tests inside parameterized
suites; browser `test.describe` declarations are groups, not tests.

Compare runs on the same machine with the same worker limit and fresh storage,
without concurrent builds or other validation. Record the reporter and whether
startup, bundling, and teardown are included. One comparison is useful evidence,
not a statistical performance guarantee.

The mutation runner works in disposable copies and requires assertion failures;
timeouts and compilation failures do not establish detection. Use a few relevant
mutations instead of repeatedly running every experiment. Harmless source and CSS
refactors should leave behavioral assertions passing.
