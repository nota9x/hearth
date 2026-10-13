<script lang="ts">
  import { dateTime } from '@hearth/core/common';
  import { formatNames, storageBytes } from '@hearth/core/storage-view';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ChartNoAxesCombined from '@lucide/svelte/icons/chart-no-axes-combined';
  import Check from '@lucide/svelte/icons/check';
  import CheckCheck from '@lucide/svelte/icons/check-check';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';

  import { notify } from '$lib/notifications';

  import type { PageData } from '../routes/[...path]/$types';
  import type { AdminActions } from './admin-types';
  import CollectionHeader from './CollectionHeader.svelte';
  import Disclosure from './Disclosure.svelte';
  import Pagination from './Pagination.svelte';
  import Spinner from './Spinner.svelte';

  const {
    data,
    busy,
    run,
    manualRefresh,
    resolve,
    resolveAll,
  }: AdminActions & {
    data: PageData;
    busy: boolean;
    resolve: (id: string) => void;
    resolveAll: () => void;
  } = $props();
  const storage = $derived(data.storage!);
  const capacity = $derived(storage.capacity);
  const allocated = $derived(capacity.persistedBytes + capacity.reservedBytes);
  const remaining = $derived(
    capacity.limitBytes === null
      ? null
      : Math.max(0, capacity.limitBytes - allocated),
  );
  const percent = $derived(
    capacity.limitBytes === null ? 0 : (allocated / capacity.limitBytes) * 100,
  );
  const scan = $derived(data.runs[0]);
  const health = $derived(
    scan?.status === 'running'
      ? 'Scan in progress'
      : scan?.status === 'failed'
        ? 'Scan failed'
        : capacity.blocked || !capacity.ready
          ? 'Reconciliation required'
          : data.findings.length > 0
            ? 'Issues detected'
            : 'Healthy',
  );
  let findingPage = $state(1);
  const findingPages = $derived(
    Math.max(1, Math.ceil(data.findings.length / 10)),
  );
  const currentFindingPage = $derived(Math.min(findingPage, findingPages));
  const visibleFindings = $derived(
    data.findings.slice((currentFindingPage - 1) * 10, currentFindingPage * 10),
  );
  function findingText(kind: string) {
    return (
      (
        {
          orphan: [
            'Untracked file',
            'A file has no image record. It consumes capacity and can be permanently deleted after review.',
            'Delete file',
          ],
          missing: [
            'Missing original',
            'The original is absent from R2. Retire its image record to remove broken links.',
            'Retire image',
          ],
          accounting: [
            'Account usage differs',
            'Visible image usage differs from the account counter. Recalculate its usage.',
            'Repair usage',
          ],
          ledger: [
            'Capacity accounting differs',
            'The capacity counters differ from the object ledger. New writes are paused until repaired.',
            'Repair accounting',
          ],
          'physical-size': [
            'File size differs',
            'Verify the current physical size and correct its capacity charge.',
            'Verify size',
          ],
          'physical-missing': [
            'Tracked file is absent',
            'Verify its absence and release retained capacity. A missing preview will be detached.',
            'Verify absence',
          ],
        } as Record<string, string[]>
      )[kind] ?? [
        'Storage issue',
        'Review the diagnostic details before taking action.',
        'Review',
      ]
    );
  }
  let previousLevel = $state<string | null>(null);
  $effect(() => {
    const level =
      capacity.limitBytes === null
        ? 'unlimited'
        : percent >= 100
          ? 'full'
          : percent >= 95
            ? 'critical'
            : percent >= 80
              ? 'approaching'
              : 'normal';
    if (
      previousLevel !== null &&
      previousLevel !== level &&
      ['full', 'critical', 'approaching'].includes(level)
    )
      notify.warning(
        level === 'full'
          ? 'Global storage is full. New capacity-consuming writes are blocked.'
          : `Storage is ${percent.toFixed(1)}% allocated.`,
      );
    previousLevel = level;
  });
</script>

<CollectionHeader title="Storage" refresh={manualRefresh} {busy} />

<section class="panel capacity" aria-label="Storage capacity">
  <div class="capacity-heading">
    <span class="eyebrow"
      >{capacity.ready
        ? 'Instance capacity'
        : 'Known storage · baseline incomplete'}</span
    ><span class="badge" class:attention={capacity.blocked || percent >= 95}
      >{capacity.limitBytes === null
        ? 'Unlimited'
        : percent >= 100
          ? 'Full'
          : percent >= 95
            ? 'Critical'
            : percent >= 80
              ? 'Approaching capacity'
              : 'Available'}</span
    >
  </div>
  <h2>
    {storageBytes(capacity.persistedBytes)}
    <span
      >{capacity.limitBytes === null
        ? 'stored'
        : `of ${storageBytes(capacity.limitBytes)} stored`}</span
    >
  </h2>
  {#if capacity.limitBytes !== null}
    <div
      class="capacity-track"
      role="meter"
      aria-label="Allocated storage capacity"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.min(100, percent)}
      aria-valuetext={`${percent.toFixed(1)}% allocated, ${storageBytes(remaining!)} available`}
    >
      <span
        class="stored"
        style:width={`${Math.min(100, (capacity.persistedBytes / capacity.limitBytes) * 100)}%`}
      ></span><span
        class="reserved"
        style:width={`${Math.min(Math.max(0, 100 - (capacity.persistedBytes / capacity.limitBytes) * 100), (capacity.reservedBytes / capacity.limitBytes) * 100)}%`}
      ></span>
    </div>
    {#if capacity.reservedBytes > 0}<div class="capacity-legend">
        <span>Persisted files</span><span>Uploads &amp; recovery</span><span
          >Available</span
        >
      </div>{/if}
    <div class="capacity-caption">
      <strong>{percent.toFixed(1)}% allocated</strong><span
        >{storageBytes(remaining!)} available</span
      >
    </div>
  {:else}<p>Storage has no configured capacity limit.</p>{/if}
  <div class="storage-metrics">
    <div>
      <strong>{storage.active.images.toLocaleString()}</strong><span
        >Images</span
      >
    </div>
    <div>
      <strong>{storage.objects.persistedObjects.toLocaleString()}</strong><span
        >Persisted objects</span
      >
    </div>
    <div>
      <strong>{storageBytes(capacity.reservedBytes)}</strong><span
        >Uploads &amp; recovery</span
      >
    </div>
    <div>
      <strong>{storageBytes(storage.pending.bytes)}</strong><span
        >{storage.pending.count} objects awaiting deletion</span
      >
    </div>
  </div>
  {#if capacity.reservedBytes}<p class="muted">
      Reserved capacity includes unfinished uploads and uncertain writes. {storageBytes(
        storage.objects.stagedBytes,
      )} of upload parts are confirmed stored. Reserved bytes are already included
      in available-capacity calculations.
    </p>{/if}
  {#if capacity.limitBytes !== null && allocated >= capacity.limitBytes}<p
      class="notice"
      role="status"
    >
      New capacity-consuming writes are blocked. {allocated >
      capacity.limitBytes
        ? `Free at least ${storageBytes(allocated - capacity.limitBytes)} to reach the configured limit, then enough space for the next upload.`
        : 'Free space or increase the limit to accept another upload.'} Existing images
      remain available.
    </p>{/if}
  {#if capacity.blocked}<p class="error" role="status">
      New writes are paused because storage accounting needs repair. Review the
      findings below.
    </p>{/if}
  {#if !capacity.ready}<p class="notice">
      Physical accounting is being established. Run <code
        >pnpm storage:initialize</code
      > using the deployment instructions, then complete the baseline scan before
      enabling a limit. Completed files are preserved.
    </p>{/if}
</section>

<div class="storage-split">
  <section class="panel">
    <h2>By file type</h2>
    <p class="muted">Active original images, ordered by storage used.</p>
    {#each data.types as type (type.mime)}<div class="distribution-row">
        <div>
          <strong>{formatNames[type.mime] ?? type.mime}</strong><small
            >{type.count.toLocaleString()} images</small
          >
        </div>
        <strong>{storageBytes(type.bytes)}</strong>
        <div class="distribution-track" aria-hidden="true">
          <span
            style:width={`${data.types[0]?.bytes ? (type.bytes / data.types[0].bytes) * 100 : 0}%`}
          ></span>
        </div>
      </div>{:else}<p class="muted">
        Upload an image to see your format breakdown.
      </p>{/each}
  </section>
  <section class="panel">
    <h2>Storage by person</h2>
    <p class="muted">Largest consumers of active image and preview storage.</p>
    {#each storage.consumers as person (person.id)}<div
        class="distribution-row"
      >
        <div>
          <a class="subtle-link" href={`/admin/users/${person.id}`}
            >{person.displayName}</a
          ><small
            >{person.imageCount.toLocaleString()} images · {storage.active
              .activeBytes
              ? ((person.bytes / storage.active.activeBytes) * 100).toFixed(1)
              : '0'}%</small
          >
        </div>
        <strong>{storageBytes(person.bytes)}</strong>
      </div>{:else}<p class="muted">
        No account storage to compare yet.
      </p>{/each}<a
      class="subtle-link storage-users-link"
      href="/admin/users?sort=storage"
      >View all users by storage usage <ArrowRight
        size={16}
        aria-hidden="true"
      /></a
    >
  </section>
</div>

<section class="panel storage-health" aria-labelledby="health-title">
  <div class="health-heading">
    <h2 id="health-title">Storage health</h2>
    <span class="badge">{health}</span>
  </div>
  <p class="muted">
    A scan compares R2 files with image records and capacity accounting.
    Scanning preserves files; repairs and permanent deletions require a separate
    action.
  </p>
  {#if scan?.status === 'running'}<div class="scan-progress" role="status">
      <Spinner /><span
        >{scan.phase === 'objects'
          ? `Examining stored files: ${scan.objectCount.toLocaleString()} objects observed so far.`
          : 'Checking tracked files and account usage.'}</span
      >
    </div>
    <small
      >Started {dateTime(scan.startedAt)}. These are incomplete observations,
      not bucket totals. Scheduled maintenance advances the scan every five
      minutes.</small
    >{/if}
  {#if scan?.status === 'failed'}<p class="error" role="status">
      {scan.error ??
        'The scan did not finish. Retry to continue from its saved progress.'}
    </p>{/if}
  {#if storage.lastSuccessful}<p>
      Last successful scan: {dateTime(storage.lastSuccessful.completedAt)}
      <span class="muted"
        >· {storage.lastSuccessful.objectCount.toLocaleString()} objects · {storageBytes(
          storage.lastSuccessful.bytes,
        )}</span
      >
    </p>
    <small
      >Observed at scan time; live capacity comes from the ledger above.</small
    >{:else}<p class="muted">No completed scan yet.</p>{/if}
  <div class="scan-actions">
    <button
      disabled={busy || scan?.status === 'running'}
      onclick={() =>
        run(
          'reconcile',
          scan?.status === 'failed' ? { id: scan.id } : {},
          'Storage scan queued. Scheduled maintenance will advance it.',
        )}
      ><RefreshCw size={16} />{scan?.status === 'failed'
        ? 'Retry scan'
        : 'Scan storage'}</button
    >
  </div>
</section>

<section class="panel attention-panel" aria-labelledby="attention-title">
  <div class="attention-heading">
    <div class="attention-title">
      <h2 id="attention-title">Needs attention</h2>
      {#if data.findings.length}<span class="badge"
          >{data.findings.length}
          {data.findings.length === 1 ? 'issue' : 'issues'}</span
        >{/if}
    </div>
    {#if data.findings.length}<button disabled={busy} onclick={resolveAll}
        ><CheckCheck size={16} aria-hidden="true" />Resolve all</button
      >{/if}
  </div>
  {#if data.findings.length === 100}<p class="muted">
      Showing the first 100 unresolved issues. Further issues will appear as
      these are resolved.
    </p>{/if}
  <div class="findings-list">
    {#each visibleFindings as finding (finding.id)}{@const description =
        findingText(finding.kind)}
      <article class="finding-card">
        <div class="finding-heading">
          <div class="finding-description">
            <h3>{description[0]}</h3>
            <p>{description[1]}</p>
          </div>
          <button
            class:danger={['orphan', 'missing'].includes(finding.kind)}
            disabled={busy}
            onclick={() => resolve(finding.id)}>{description[2]}</button
          >
        </div>
        <Disclosure title="Details" class="finding-details">
          <dl class="finding-metadata">
            <div>
              <dt>{finding.objectKey ? 'Object key' : 'Diagnostic data'}</dt>
              <dd><code>{finding.objectKey ?? finding.details}</code></dd>
            </div>
            <div>
              <dt>Detected</dt>
              <dd>{dateTime(finding.createdAt)}</dd>
            </div>
          </dl>
        </Disclosure>
      </article>
    {:else}<div class="healthy-empty">
        <Check size={22} />
        <p>
          {storage.lastSuccessful
            ? 'No storage problems need attention.'
            : 'Findings will appear here after a scan.'}
        </p>
      </div>{/each}
  </div>
  {#if findingPages > 1}<Pagination
      current={currentFindingPage}
      pages={findingPages}
      total={data.findings.length}
      size={10}
      {busy}
      onchange={(value: number) => {
        findingPage = value;
      }}
    />{/if}
</section>

<Disclosure title="Advanced diagnostics & history" icon={ChartNoAxesCombined}>
  <div class="diagnostics">
    <dl>
      <dt>Confirmed completed objects</dt>
      <dd>{storageBytes(capacity.persistedBytes)}</dd>
      <dt>Upload parts confirmed in R2</dt>
      <dd>{storageBytes(storage.objects.stagedBytes)}</dd>
      <dt>Capacity held for recovery</dt>
      <dd>{storageBytes(storage.objects.recoveryBytes)}</dd>
    </dl>
    {#if data.history.length}<h3>Daily active image storage</h3>
      <p class="muted">
        Historical visible image and preview usage, separate from physical
        capacity.
      </p>
      {#each data.history.slice(0, 7) as item (item.day)}<div class="row">
          <span class="row-content">{item.day}</span><small
            >{item.images} images</small
          ><span>{storageBytes(item.bytes)}</span>
        </div>{/each}{/if}
    <h3>Recent scans</h3>
    {#each data.runs as item (item.id)}<div class="row">
        <span class="row-content">{dateTime(item.startedAt)}</span><span
          >{item.status}</span
        >
      </div>{/each}
  </div>
</Disclosure>

<style>
  .capacity-heading,
  .capacity-caption,
  .health-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
  .health-heading {
    flex-wrap: wrap;
  }
  .health-heading h2 {
    margin: 0;
  }
  .storage-health {
    display: grid;
    gap: 1rem;
  }
  .storage-health p,
  .storage-health .scan-progress {
    margin: 0;
  }
  .scan-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .storage-users-link :global(svg) {
    flex-shrink: 0;
  }
  .storage-users-link {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .storage-split > .panel {
    min-width: 0;
    margin-bottom: 0;
  }
  .distribution-row > div:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .distribution-row > strong {
    white-space: nowrap;
  }
  .diagnostics dl {
    margin: 0 0 1.5rem;
  }
  .diagnostics h3:not(:first-child) {
    margin-top: 1.5rem;
  }
  .eyebrow {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .capacity h2 {
    font-size: clamp(1.7rem, 4vw, 2.5rem);
    margin: 1rem 0;
  }
  .capacity h2 span {
    font-size: 0.6em;
    font-weight: 400;
  }
  .capacity-track,
  .distribution-track {
    display: flex;
    overflow: hidden;
    border-radius: 999px;
    background: var(--border);
    height: 12px;
  }
  .capacity-track .stored,
  .distribution-track span {
    background: var(--accent);
  }
  .capacity-track .reserved {
    background: var(--muted);
  }
  .capacity-caption {
    margin-top: 0.65rem;
    font-size: 0.9rem;
  }
  .capacity-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 0.75rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .capacity-legend span::before {
    content: '';
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    margin-right: 0.4rem;
    background: var(--accent);
  }
  .capacity-legend span:nth-child(2)::before {
    background: var(--muted);
  }
  .capacity-legend span:nth-child(3)::before {
    background: var(--border);
  }
  .storage-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1.5rem;
    margin: 1.5rem 0;
  }
  .storage-metrics div {
    display: grid;
    gap: 0.35rem;
  }
  .storage-metrics strong {
    font-size: 1.2rem;
  }
  .storage-metrics span,
  .muted {
    color: var(--muted);
  }
  .storage-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 24px;
  }
  .distribution-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.35rem 1rem;
    padding: 0.9rem 0;
  }
  .distribution-row small {
    display: block;
    margin-top: 0.25rem;
    color: var(--muted);
  }
  .distribution-track {
    grid-column: 1/-1;
    height: 4px;
  }
  .scan-progress,
  .healthy-empty {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }
  .scan-progress {
    margin: 1rem 0;
  }
  .attention-heading,
  .attention-title,
  .finding-heading {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .attention-heading {
    justify-content: space-between;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }
  .attention-title {
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .attention-title h2 {
    margin: 0;
  }
  .findings-list {
    display: grid;
    gap: 1rem;
  }
  .finding-card {
    min-width: 0;
    padding: 1.25rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 6px);
    background: var(--page);
  }
  .finding-heading {
    justify-content: space-between;
    align-items: start;
  }
  .finding-description {
    min-width: 0;
  }
  .finding-description h3 {
    margin-bottom: 0.4rem;
  }
  .finding-description p {
    margin: 0;
  }
  .finding-heading > button {
    flex-shrink: 0;
  }
  .finding-card :global(.finding-details) {
    --radius: 10px;
    margin: 1rem 0 0;
  }
  .finding-card :global(.finding-details summary) {
    padding: 0.75rem 1rem;
  }
  .finding-card :global(.finding-details .content) {
    padding: 1rem;
  }
  .finding-card :global(.finding-details summary strong) {
    font-size: 0.85rem;
  }
  .finding-metadata {
    display: grid;
    gap: 1rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .finding-metadata dt {
    color: var(--muted);
    margin-bottom: 0.35rem;
  }
  .finding-metadata dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .finding-metadata code {
    white-space: pre-wrap;
  }
  .healthy-empty p {
    margin: 0;
  }
  .diagnostics dl {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.75rem;
  }
  .diagnostics dd {
    margin: 0;
  }
  @media (max-width: 700px) {
    .storage-split {
      grid-template-columns: 1fr;
    }
    .storage-metrics {
      grid-template-columns: 1fr 1fr;
    }
    .finding-heading {
      flex-direction: column;
    }
    .finding-card {
      padding: 1rem;
    }
    .capacity-caption {
      flex-wrap: wrap;
    }
  }
</style>
