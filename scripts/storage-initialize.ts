import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import ts from 'typescript';
import { z } from 'zod';

import { id, now } from '../packages/core/common';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'apps/web/production.local.jsonc' },
    endpoint: { type: 'string' },
    profile: { type: 'string' },
  },
});
if (!values.endpoint)
  throw new Error(
    'Usage: pnpm storage:initialize --endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com [--config apps/web/production.local.jsonc] [--profile PROFILE]. Requires AWS CLI and bucket-scoped R2 credentials in its environment/profile.',
  );
const endpoint = new URL(values.endpoint);
if (
  endpoint.protocol !== 'https:' ||
  !endpoint.hostname.endsWith('.r2.cloudflarestorage.com') ||
  endpoint.pathname !== '/'
)
  throw new Error(
    'Use the HTTPS R2 S3 endpoint for the account holding this bucket.',
  );
const parsed = ts.parseConfigFileTextToJson(
  values.config,
  await readFile(values.config, 'utf8'),
);
const bucket = z
  .object({
    r2_buckets: z.array(
      z.object({ binding: z.string(), bucket_name: z.string() }),
    ),
  })
  .parse(parsed.config)
  .r2_buckets.find((entry) => entry.binding === 'BUCKET')?.bucket_name;
if (!bucket)
  throw new Error('The selected configuration has no BUCKET binding.');

function aws(arguments_: string[], missingAllowed = false): unknown {
  const result = spawnSync(
    'aws',
    [
      '--endpoint-url',
      endpoint.origin,
      '--region',
      'auto',
      '--no-cli-pager',
      ...(values.profile ? ['--profile', values.profile] : []),
      's3api',
      ...arguments_,
      '--bucket',
      bucket!,
      '--output',
      'json',
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    if (missingAllowed && result.stderr.includes('NoSuchUpload')) return null;
    throw new Error(
      'R2 multipart inventory failed. Verify AWS CLI, endpoint, and bucket credentials. Accounting remains paused; rerun this command after fixing access.',
    );
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
const sqlResult = z.array(
  z.object({ results: z.array(z.record(z.string(), z.unknown())) }),
);
function sql(command: string) {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'execute',
      'DB',
      '--remote',
      '--config',
      values.config,
      '--command',
      command,
      '--json',
      '--yes',
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(
      'D1 initialization failed. Verify Wrangler access and applied migrations; rerun this command after fixing access.',
    );
  return sqlResult
    .parse(JSON.parse(result.stdout))
    .flatMap((entry) => entry.results);
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
// Validate S3 access before pausing writers. A failed initialization never claims readiness.
aws(['list-multipart-uploads', '--max-uploads', '1', '--no-paginate']);
sql(
  'UPDATE storage_capacity SET ready=0,multipartVerified=0,blocked=1 WHERE id=1',
);
const pageSchema = z.object({
  Uploads: z
    .array(z.object({ Key: z.string(), UploadId: z.string() }))
    .optional(),
  IsTruncated: z.boolean().optional(),
  NextKeyMarker: z.string().optional(),
  NextUploadIdMarker: z.string().optional(),
});
let markers: string[] = [];
let cleaned = 0;
while (true) {
  const page = pageSchema.parse(
    aws([
      'list-multipart-uploads',
      '--max-uploads',
      '1000',
      '--no-paginate',
      ...markers,
    ]),
  );
  const uploads = page.Uploads ?? [];
  for (const upload of uploads) {
    const tracked = sql(
      `SELECT key FROM storage_objects WHERE key=${quote(upload.Key)} AND uploadId=${quote(upload.UploadId)}`,
    );
    if (tracked.length > 0) continue;
    aws(
      [
        'abort-multipart-upload',
        '--key',
        upload.Key,
        '--upload-id',
        upload.UploadId,
      ],
      true,
    );
    const parts = aws(
      ['list-parts', '--key', upload.Key, '--upload-id', upload.UploadId],
      true,
    );
    if (parts !== null)
      throw new Error(
        'An unfinished upload is still present after abort. Capacity remains paused; rerun initialization.',
      );
    cleaned++;
  }
  if (!page.IsTruncated) break;
  if (!page.NextKeyMarker || !page.NextUploadIdMarker)
    throw new Error(
      'R2 returned an incomplete pagination cursor; initialization remains paused.',
    );
  markers = [
    '--key-marker',
    page.NextKeyMarker,
    '--upload-id-marker',
    page.NextUploadIdMarker,
  ];
}
const runId = id('rec');
sql(`UPDATE storage_capacity SET multipartVerified=1,blocked=EXISTS(SELECT 1 FROM reconciliation_findings WHERE resolvedAt IS NULL AND kind IN ('ledger','physical-size')) WHERE id=1;
UPDATE reconciliation_runs SET status='superseded' WHERE status='running';
INSERT INTO reconciliation_runs(id,status,startedAt,updatedAt) VALUES(${quote(runId)},'running',${now()},${now()});
INSERT INTO audit_log(id,action,targetId,metadata,createdAt) VALUES(${quote(id('evt'))},'storage.initialized',${quote(runId)},'{"version":1,"actorName":"Operator","targetName":"Storage initialization","changes":[],"context":{}}',${now()});`);
console.log(
  `Removed ${cleaned} untracked unfinished multipart uploads. Completed objects were preserved. A fresh baseline scan is queued; scheduled maintenance will advance it. Enable the global limit after the scan completes.`,
);
