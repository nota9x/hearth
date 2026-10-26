import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import { execa } from 'execa';

import { renderProduction } from '../cli/production-config';
import { projects, root } from '../cli/project';

const [tag, sha] = process.argv.slice(2);
if (!tag || !sha)
  throw new Error(
    'Usage: pnpm exec tsx scripts/release-bundles.ts vX.Y.Z COMMIT_SHA',
  );
const manifest = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
) as {
  version: string;
  devDependencies: { wrangler: string };
};
const versions = await Promise.all([
  readFile(path.join(root, 'apps/web/package.json'), 'utf8'),
  readFile(path.join(root, 'packages/core/package.json'), 'utf8'),
]);
const released = JSON.parse(
  await readFile(path.join(root, '.release-please-manifest.json'), 'utf8'),
) as Record<string, string>;
if (
  tag !== `v${manifest.version}` ||
  released['.'] !== manifest.version ||
  versions.some(
    (value) =>
      (JSON.parse(value) as { version: string }).version !== manifest.version,
  )
) {
  throw new Error(
    'Release tag, package versions, and release manifest must agree.',
  );
}
const head = await execa('git', ['rev-parse', 'HEAD'], { cwd: root });
if (
  sha !== head.stdout ||
  (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha)
) {
  throw new Error('Release commit, checkout, and workflow source must agree.');
}

const output = path.join(root, 'artifacts/releases');
await mkdir(path.dirname(output), { recursive: true });
// Refuse stale output from an earlier or interrupted build.
await mkdir(output);
const temporary = await mkdtemp(path.join(tmpdir(), 'hearth-release-'));
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const environment = { NODE_ENV: 'production', WRANGLER_SEND_METRICS: 'false' };
async function runWrangler(arguments_: string[], cwd = root) {
  await execa(process.execPath, [wrangler, ...arguments_], {
    cwd,
    env: environment,
    stdio: 'inherit',
  });
}

try {
  await execa('pnpm', ['build'], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  const configurations = await renderProduction({
    application: 'app.example.com',
    delivery: ['images.example.com'],
    databaseId: '00000000-0000-0000-0000-000000000000',
    databaseName: 'replace-with-d1-database-name',
    bucket: 'replace-with-r2-bucket-name',
    turnstile: 'REPLACE_WITH_TURNSTILE_SITE_KEY',
  });
  const checksums: string[] = [];
  for (const { component, config } of configurations) {
    const directory = path.join(temporary, component);
    const worker = path.join(directory, 'worker');
    await mkdir(worker, { recursive: true });
    await runWrangler([
      'deploy',
      '--dry-run',
      '--config',
      path.join(root, projects[component], 'wrangler.jsonc'),
      '--outdir',
      worker,
    ]);
    await rm(path.join(worker, 'README.md'));
    const entry = `${path.parse(config.main).name}.js`;
    const entryStats = await stat(path.join(worker, entry));
    if (entryStats.size === 0)
      throw new Error(`Empty ${component} Worker bundle.`);

    if (component === 'web') {
      const assets = config.assets as { binding: string; directory: string };
      const originalMain = path.resolve(root, projects.web, config.main);
      await cp(
        path.resolve(root, projects.web, assets.directory),
        path.join(directory, 'assets'),
        {
          recursive: true,
          filter: (source) =>
            source !== originalMain && source !== `${originalMain}.map`,
        },
      );
      assets.directory = './assets';
      const drizzleFiles = await readdir(path.join(root, 'drizzle'));
      const migrations = drizzleFiles
        .filter((name) => name.endsWith('.sql'))
        .toSorted((a, b) => a.localeCompare(b));
      if (migrations.length === 0)
        throw new Error('Missing database migrations.');
      await mkdir(path.join(directory, 'migrations'));
      for (const name of migrations)
        await cp(
          path.join(root, 'drizzle', name),
          path.join(directory, 'migrations', name),
        );
      config.d1_databases.find(
        (binding) => binding.binding === 'DB',
      )!.migrations_dir = './migrations';
    }
    delete config.$schema;
    config.main = `./worker/${entry}`;
    config.no_bundle = true;
    await writeFile(
      path.join(directory, 'wrangler.jsonc'),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    await cp(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE'));
    await writeFile(
      path.join(directory, 'README.md'),
      `# Hearth ${component} ${tag}

Source commit: ${sha}
Built with Wrangler ${manifest.devDependencies.wrangler} on Node 24.

This ZIP contains prebuilt Worker code. No Hearth checkout, dependency installation,
or application build is needed. Use Node 24 and Wrangler ${manifest.devDependencies.wrangler}:

    npx wrangler@${manifest.devDependencies.wrangler} deploy --dry-run --config wrangler.jsonc
    npx wrangler@${manifest.devDependencies.wrangler} deploy --config wrangler.jsonc

Before deploying, edit wrangler.jsonc. Its example settings are NOT your installation:

- Replace the all-zero D1 database_id, database_name, and R2 bucket_name with your
  existing resources. All three Workers must use the same D1 database and private R2 bucket.
- Set account_id (or CLOUDFLARE_ACCOUNT_ID), Worker names, and application/delivery
  Custom Domains. Replace app.example.com and images.example.com everywhere.
- Keep ENVIRONMENT set to production, use your canonical HTTPS APP_ORIGIN, and
  replace REPLACE_WITH_TURNSTILE_SITE_KEY with your real public Turnstile site key.
- Preserve existing rate-limit namespace IDs when updating; use distinct namespaces
  for separate installations. Keep web's MAINTENANCE script_name aligned with the
  maintenance Worker name. Preserve optional bindings such as maintenance IMAGES.
- Keep main, no_bundle, assets.directory, and migrations_dir pointing at this ZIP's
  files. Transfer reviewed instance settings into this template rather than replacing
  it with an old configuration containing source paths.

Verify ZIP checksums and provenance BEFORE extraction or editing. See the release's
SHA256SUMS and provenance assets. Changing configuration changes extracted files,
not the ZIP covered by the attestation.

Review release notes and ordered SQL, back up your installation, and coordinate
migrations with deployment. The web ZIP includes migrations; from its directory run:

    npx wrangler@${manifest.devDependencies.wrangler} d1 migrations list DB --remote --config wrangler.jsonc
    npx wrangler@${manifest.devDependencies.wrangler} d1 migrations apply DB --remote --config wrangler.jsonc

Deploy delivery, then maintenance, then web. Keep existing secrets when updating.
New web installations need TURNSTILE_SECRET_KEY supplied through Wrangler's secret
prompt. These bundles do not provision resources, initialize R2, or bootstrap an
administrator. Follow the matching release's installation and update documentation
for those operations; do not bootstrap an existing database again.
`,
    );

    const name = `hearth-${component}-${tag}.zip`;
    const archivePath = path.join(output, name);
    const archive = new ZipWriter(
      Writable.toWeb(createWriteStream(archivePath)),
      { useWebWorkers: false },
    );
    const entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
    const files = entries
      .filter((file) => file.isFile())
      .map((file) =>
        path
          .relative(directory, path.join(file.parentPath, file.name))
          .split(path.sep)
          .join('/'),
      )
      .toSorted((a, b) => a.localeCompare(b));
    for (const file of files)
      await archive.add(
        file,
        new Uint8ArrayReader(await readFile(path.join(directory, file))),
      );
    await archive.close();

    const bytes = await readFile(archivePath);
    const extracted = path.join(temporary, `extracted-${component}`);
    const reader = new ZipReader(new Uint8ArrayReader(bytes), {
      useWebWorkers: false,
      checkSignature: true,
    });
    try {
      const archivedFiles = await reader.getEntries();
      for (const file of archivedFiles) {
        if (file.directory) continue;
        const destination = path.join(extracted, file.filename);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(
          destination,
          await file.getData(new Uint8ArrayWriter()),
        );
      }
    } finally {
      await reader.close();
    }
    await runWrangler(
      [
        'deploy',
        '--dry-run',
        '--no-bundle',
        '--config',
        path.join(extracted, 'wrangler.jsonc'),
        '--outdir',
        path.join(temporary, `validated-${component}`),
      ],
      extracted,
    );
    checksums.push(
      `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`,
    );
  }
  await writeFile(
    path.join(output, `hearth-${tag}-SHA256SUMS.txt`),
    checksums.join(''),
  );
  console.log(`Validated release ZIPs: ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
