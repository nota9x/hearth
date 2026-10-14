import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
const output = path.join(root, 'artifacts', 'adversarial-mutation', runId);
const checkout = path.join(output, 'checkout');
const excluded = new Set([
  '.git',
  'node_modules',
  '.svelte-kit',
  '.wrangler',
  'artifacts',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.env',
]);
const auth = 'packages/core/auth.ts';
const hook = 'apps/web/src/hooks.server.ts';
const bearer = 'apps/web/src/routes/api/v1/images/+server.ts';
const actions = 'apps/web/src/routes/api/actions/[action]/+server.ts';
const publicShare = 'packages/core/public-share.ts';
const authTests = 'tests/integration/security-auth.test.ts';
const webTests = 'tests/integration/security-web.test.ts';
const shareTests = 'tests/integration/public-share.test.ts';
const mutations = [
  {
    id: 'key-verifier',
    file: auth,
    before: '!row || !valid ||',
    after: '!row ||',
    tests: [authTests],
    pattern: 'stores only a purpose-separated verifier',
  },
  {
    id: 'key-rotation-revocation',
    file: auth,
    before: 'keyId: key.keyId,\n        secretHash: key.secretHash,',
    after:
      'keyId: sql`${apiKeys.keyId}`,\n        secretHash: sql`${apiKeys.secretHash}`,',
    tests: [authTests],
    pattern: 'revokes the previous key',
  },
  {
    id: 'key-account-status',
    file: auth,
    before: " || row.user.status !== 'active'",
    after: '',
    tests: ['tests/integration/security-stateful.test.ts'],
    pattern: 'does not revive sessions after administrator disable',
  },
  {
    id: 'session-key-version',
    file: auth,
    before:
      'and(eq(apiKeys.userId, users.id), eq(apiKeys.version, sessions.version))',
    after: 'eq(apiKeys.userId, users.id)',
    tests: [authTests],
    pattern: 'revokes the previous key',
  },
  {
    id: 'session-absolute-expiry',
    file: auth,
    before: '        gt(sessions.expiresAt, timestamp),\n',
    after: '',
    tests: ['tests/integration/security-stateful.test.ts'],
    pattern: 'enforces expiry at the exact idle and absolute deadline',
  },
  {
    id: 'session-account-status',
    file: auth,
    before: "        eq(users.status, 'active'),\n",
    after: '',
    tests: ['tests/integration/security-stateful.test.ts'],
    pattern: 'rejects disabled and deleted users',
  },
  {
    id: 'private-media-owner',
    file: 'packages/core/images.ts',
    before: '  authorizeOwner(user, image.userId);\n  return image;',
    after: '  return image;',
    tests: [authTests],
    pattern: 'checks ownership before conditional/range',
  },
  {
    id: 'administrator-role',
    file: auth,
    before: "if (u.role !== 'admin')",
    after: 'if (false)',
    tests: [authTests],
    pattern: 'denies member access to privileged action settings',
  },
  {
    id: 'browser-mutation-origin',
    file: hook,
    before:
      "event.request.headers.get('origin') !== event.locals.env.APP_ORIGIN",
    after: 'false',
    tests: [webTests],
    pattern: 'rejects untrusted origins',
  },
  {
    id: 'production-application-host',
    file: hook,
    before: 'event.url.origin !== appOrigin(event.locals.env)',
    after: 'false',
    tests: [webTests],
    pattern: 'rejects alternate production application hosts',
  },
  {
    id: 'bearer-cookie-fallback',
    file: bearer,
    before: 'authenticated = await authenticateKey(locals.env.DB, key);',
    after:
      'authenticated = !key && locals.user ? { user: locals.user } : await authenticateKey(locals.env.DB, key);',
    tests: [authTests],
    pattern: 'never falls back to a browser session',
  },
  {
    id: 'bearer-conflicting-browser-identity',
    file: bearer,
    before: 'upload(request, authenticated.user, locals.env)',
    after: 'upload(request, locals.user || authenticated.user, locals.env)',
    tests: [authTests],
    pattern: 'uses the bearer owner rather than a conflicting browser identity',
  },
  {
    id: 'deletion-capability-secret',
    file: actions,
    before: "!(await verify(token, stored.hash, 'delete'))",
    after: 'false',
    tests: [authTests],
    pattern: 'keeps anonymous deletion capabilities bound',
  },
  {
    id: 'bulk-image-deletion-owner',
    file: 'packages/core/images.ts',
    before: 'ownedImage(binding, user, imageId, true)',
    after: "ownedImage(binding, { ...user, role: 'admin' }, imageId, true)",
    tests: [authTests],
    pattern: 'rejects mixed-owner image mutations',
  },
  {
    id: 'selected-alias-owner',
    file: 'packages/core/links.ts',
    before: '  for (const row of rows) authorizeOwner(actor, row.owner.id);\n',
    after: '',
    tests: [authTests],
    pattern: 'checks image ownership for new aliases',
  },
  {
    id: 'public-alias-revocation',
    file: publicShare,
    before: ' AND a.disabledAt IS NULL',
    after: '',
    tests: [shareTests],
    pattern: 'makes unavailable states indistinguishable for plain',
  },
  {
    id: 'public-alias-expiration',
    file: publicShare,
    before: '(a.expiresAt IS NULL OR a.expiresAt>?)',
    after: '(? IS NOT NULL)',
    tests: [shareTests],
    pattern: 'makes unavailable states indistinguishable for plain',
  },
  {
    id: 'public-account-status',
    file: publicShare,
    before: " AND u.status='active'",
    after: '',
    tests: [shareTests],
    pattern: 'makes unavailable states indistinguishable for plain',
  },
  {
    id: 'upload-rollback',
    file: 'packages/core/upload.ts',
    before: 'if (!referenced) await environment.BUCKET.delete(objectKey);',
    after: 'if (false) await environment.BUCKET.delete(objectKey);',
    tests: ['tests/integration/upload.test.ts'],
    pattern: 'protects D1 writes when failure occurs after commit=false',
  },
  {
    id: 'maintenance-purge-retry',
    file: 'workers/maintenance/src/index.ts',
    before: 'and(isNotNull(images.deletedAt), isNull(images.purgedAt))',
    after: 'and(isNotNull(images.deletedAt), isNotNull(images.purgedAt))',
    tests: ['tests/integration/maintenance.test.ts'],
    pattern: 'keeps failed purges unavailable',
  },
];

await mkdir(output, { recursive: true });
await mkdir(checkout);
const entries = await readdir(root);
for (const entry of entries) {
  if (
    excluded.has(entry) ||
    entry.startsWith('.dev.vars') ||
    entry.startsWith('.env.') ||
    entry.endsWith('.local.jsonc')
  )
    continue;
  await cp(path.join(root, entry), path.join(checkout, entry), {
    recursive: true,
    filter: (source) =>
      path
        .relative(root, source)
        .split(path.sep)
        .every(
          (part) =>
            !(
              excluded.has(part) ||
              part.startsWith('.dev.vars') ||
              part.startsWith('.env.') ||
              part.endsWith('.local.jsonc')
            ),
        ),
  });
}
await symlink(
  path.join(root, 'node_modules'),
  path.join(checkout, 'node_modules'),
  'junction',
);
await symlink(
  path.join(root, 'apps/web/node_modules'),
  path.join(checkout, 'apps/web/node_modules'),
  'junction',
);
const sync = spawnSync(
  process.execPath,
  [
    path.join(root, 'apps/web/node_modules/@sveltejs/kit/svelte-kit.js'),
    'sync',
  ],
  { cwd: path.join(checkout, 'apps/web'), encoding: 'utf8', windowsHide: true },
);
await writeFile(
  path.join(output, 'svelte-kit-sync.log'),
  sync.stdout + sync.stderr,
);
assert.equal(sync.status, 0, 'Isolated SvelteKit configuration must generate');
// Explicit local core resolution prevents workspace package links escaping isolation.
await writeFile(
  path.join(checkout, 'vitest.config.ts'),
  String.raw`import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: [
    { find: /^@hearth\/core\/(.+)$/, replacement: fileURLToPath(new URL('./packages/core/', import.meta.url)) + '$1.ts' },
  ] },
  test: { include: ['tests/unit/**/*.test.ts','tests/integration/**/*.test.ts'], setupFiles: ['tests/helpers/cleanup.ts'], globalSetup: ['tests/helpers/build-workers.ts'], sequence: {hooks: 'list'}, testTimeout: 30000, hookTimeout: 30000, maxWorkers: 2 },
});
`,
);

const originals = new Map();
for (const { file } of mutations)
  if (!originals.has(file))
    originals.set(file, await readFile(path.join(root, file), 'utf8'));
const hash = (source) => createHash('sha256').update(source).digest('hex');

async function execute(name, tests, pattern) {
  const reportPath = path.join(output, `${name}.json`);
  const arguments_ = [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    ...tests,
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ];
  if (pattern) arguments_.push('-t', pattern);
  const log = [];
  const child = spawn(process.execPath, arguments_, {
    cwd: checkout,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (data) => {
    log.push(data);
  });
  child.stderr.on('data', (data) => {
    log.push(data);
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await writeFile(path.join(output, `${name}.log`), Buffer.concat(log));
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    return { code, status: 'invalid', reason: 'No JSON test report' };
  }
  const failures = report.testResults.flatMap((suite) =>
    suite.assertionResults
      .filter((test) => test.status === 'failed')
      .map((test) => ({
        test: test.fullName,
        messages: test.failureMessages,
      })),
  );
  return {
    code,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    failures,
    status:
      code === 0 && report.numPassedTests > 0
        ? 'passed'
        : failures.length > 0 &&
            failures.every(({ messages }) =>
              messages.some((message) =>
                /AssertionError|__VITEST_REJECTS__/.test(message),
              ),
            )
          ? 'assertion-failed'
          : 'invalid',
  };
}

if (process.argv.includes('--refactors')) {
  const targets = [
    [
      'apps/web/src/routes/api/actions/[action]/+server.ts',
      (source) => source.replace("case 'preferences':", 'case "preferences":'),
    ],
    [
      'apps/web/src/lib/NotificationDeck.svelte',
      (source) => source.replace('padding: 14px;', 'padding: 16px;'),
    ],
  ];
  const sources = new Map(
    await Promise.all(
      targets.map(async ([file]) => [
        file,
        await readFile(path.join(root, file), 'utf8'),
      ]),
    ),
  );
  const tests = [
    'tests/integration/audit.test.ts',
    'tests/unit/upload-progress.test.ts',
    'tests/unit/image-deletion.test.ts',
  ];
  const evidence = {
    baseline: null,
    changed: null,
    build: null,
    browser: null,
    hashes: {},
  };
  try {
    evidence.baseline = await execute('refactors-baseline', tests);
    assert.equal(evidence.baseline.status, 'passed');
    for (const [file, change] of targets) {
      const original = sources.get(file),
        changed = change(original);
      assert.notEqual(changed, original);
      await writeFile(path.join(checkout, file), changed);
    }
    evidence.changed = await execute('refactors-changed', tests);
    assert.equal(evidence.changed.status, 'passed');
    const build = spawnSync(
      process.execPath,
      [path.join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'build'],
      {
        cwd: path.join(checkout, 'apps/web'),
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    await writeFile(
      path.join(output, 'refactors-build.log'),
      build.stdout + build.stderr,
    );
    evidence.build = build.status;
    assert.equal(build.status, 0);
    const browser = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        'tests/browser/browser.spec.ts',
        '-g',
        'image actions download|upload queue stays bounded',
      ],
      { cwd: checkout, encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    );
    await writeFile(
      path.join(output, 'refactors-browser.log'),
      browser.stdout + browser.stderr,
    );
    evidence.browser = browser.status;
    assert.equal(browser.status, 0);
  } finally {
    for (const [file, original] of sources) {
      await writeFile(path.join(checkout, file), original);
      assert.equal(await readFile(path.join(root, file), 'utf8'), original);
      evidence.hashes[file] = hash(original);
    }
    await writeFile(
      path.join(output, 'refactors.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    process.stdout.write(`Refactor evidence: ${output}\n`);
  }
} else {
  const results = {
    output,
    baseline: null,
    mutations: [],
    restored: null,
    originalHashes: {},
  };
  const selected = process.argv.slice(2);
  const cases =
    selected.length > 0
      ? mutations.filter((mutation) => selected.includes(mutation.id))
      : mutations;
  assert.ok(cases.length > 0, 'No mutation IDs selected');
  const tests = [...new Set(cases.flatMap((mutation) => mutation.tests))];
  const save = () =>
    writeFile(
      path.join(output, 'results.json'),
      JSON.stringify(results, null, 2) + '\n',
    );
  try {
    results.baseline = await execute('baseline', tests);
    assert.equal(
      results.baseline.status,
      'passed',
      'Isolated baseline must pass',
    );
    await save();
    for (const mutation of cases) {
      const original = originals.get(mutation.file);
      const before = original.includes(mutation.before)
        ? mutation.before
        : mutation.before.replaceAll('\n', '\r\n');
      const after =
        before === mutation.before
          ? mutation.after
          : mutation.after.replaceAll('\n', '\r\n');
      assert.equal(
        original.split(before).length - 1,
        1,
        `${mutation.id}: replacement must occur exactly once`,
      );
      const changed = original.replace(before, () => after);
      assert.notEqual(changed, original);
      const target = path.join(checkout, mutation.file);
      try {
        await writeFile(target, changed);
        const result = await execute(
          mutation.id,
          mutation.tests,
          mutation.pattern,
        );
        const outcome =
          result.status === 'assertion-failed'
            ? 'killed'
            : result.status === 'passed'
              ? 'survived'
              : 'invalid';
        const record = { ...mutation, activated: true, outcome, result };
        results.mutations.push(record);
        process.stdout.write(`${mutation.id}: ${outcome}\n`);
      } finally {
        await writeFile(target, original);
        assert.equal(await readFile(target, 'utf8'), original);
        await save();
      }
    }
    results.restored = await execute('restored', tests);
    assert.equal(
      results.restored.status,
      'passed',
      'Restored baseline must pass',
    );
    assert.ok(
      results.mutations.every(({ outcome }) => outcome === 'killed'),
      'Each selected mutation must fail a behavioral assertion',
    );
  } finally {
    for (const [file, original] of originals) {
      await writeFile(path.join(checkout, file), original);
      assert.equal(
        await readFile(path.join(root, file), 'utf8'),
        original,
        `Original source changed: ${file}`,
      );
      results.originalHashes[file] = hash(original);
    }
    await save();
    process.stdout.write(`Evidence: ${output}\n`);
  }
}
