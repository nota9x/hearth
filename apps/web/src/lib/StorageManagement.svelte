<script lang="ts">
  import { dateTime } from '@hearth/core/common';
  import { formatNames, storageBytes } from '@hearth/core/storage-view';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ChartNoAxesCombined from '@lucide/svelte/icons/chart-no-axes-combined';
  import Check from '@lucide/svelte/icons/check';
  import CheckCheck from '@lucide/svelte/icons/check-check';
  import CircleHelp from '@lucide/svelte/icons/circle-help';
  import CirclePause from '@lucide/svelte/icons/circle-pause';
  import HeartPulse from '@lucide/svelte/icons/heart-pulse';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import { notify } from '#lib/notifications.ts';

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
  const maintenance = $derived(data.maintenance);
  const allocated = $derived(capacity.persistedBytes + capacity.reservedBytes);
  const remaining = $derived(
    capacity.limitBytes === null
      ? null
      : Math.max(0, capacity.limitBytes - allocated),
  );
  const percent = $derived(
    capacity.limitBytes === null ? 0 : (allocated / capacity.limitBytes) * 100,
  );
  const utilization = $derived(
    `${percent.toFixed(1)}% ${capacity.reservedBytes ? 'used or reserved' : 'used'}`,
  );
  const originalBytes = $derived(
    data.types.reduce((total, type) => total + type.bytes, 0),
  );
  const scan = $derived(data.runs[0]);
  const checking = $derived(scan?.status === 'running');
  const maintenanceProblem = $derived(
    maintenance?.status === 'failed' || maintenance?.status === 'stalled',
  );
  const attention = $derived(
    !!capacity.blocked ||
      !capacity.ready ||
      data.findings.length > 0 ||
      scan?.status === 'failed' ||
      maintenanceProblem ||
      !maintenance ||
      maintenance.paused ||
      !!maintenance.backlog?.deferred,
  );
  const condition = $derived.by(() => {
    if (capacity.blocked)
      return [
        'Storage totals need repair',
        'New uploads and other storage writes are paused. Review the issues below or check storage to find the cause.',
      ];
    if (data.findings.length > 0)
      return [
        `${data.findings.length === 100 ? 'At least ' : ''}${data.findings.length} storage ${data.findings.length === 1 ? 'issue needs' : 'issues need'} attention`,
        'Review each issue below. Repairs and permanent deletion require confirmation.',
      ];
    if (!capacity.ready)
      return [
        'Storage setup is incomplete',
        'Complete initialization and a full storage check before enabling a capacity limit. Recovery steps are in Advanced diagnostics & history.',
      ];
    if (scan?.status === 'failed')
      return [
        'Storage check could not finish',
        'Retry the check to continue from saved progress. The error is available in diagnostics.',
      ];
    if (checking)
      return [
        maintenance?.paused
          ? 'Storage check paused'
          : maintenance
            ? maintenanceProblem
              ? 'Storage check needs attention'
              : maintenance.status === 'retrying'
                ? 'Storage check is waiting to retry'
                : 'Storage check in progress'
            : 'Storage check status unavailable',
        'Results are incomplete until the check finishes.',
      ];
    if (!maintenance)
      return [
        'Maintenance status unavailable',
        'Storage usage is available, but background work could not be reached. Check your maintenance setup.',
      ];
    if (maintenanceProblem)
      return [
        'Automatic maintenance needs attention',
        'Background work needs a retry. Review diagnostics if the problem continues.',
      ];
    return storage.lastSuccessful
      ? [
          'No unresolved storage issues',
          'Based on completed storage checks. Check again to look for recent changes.',
        ]
      : [
          'Storage has not been checked yet.',
          'Run a check to look for missing files and incorrect storage totals.',
        ];
  });
  const checkProgress = $derived.by(() => {
    if (
      scan?.status === 'failed' &&
      (capacity.blocked || data.findings.length > 0 || !capacity.ready)
    )
      return 'Storage check could not finish. Retry to continue from saved progress.';
    if (!checking) return '';
    if (maintenance?.paused)
      return 'Resume maintenance to continue this check.';
    if (!maintenance)
      return 'Progress is unavailable until maintenance reconnects.';
    if (maintenance.status === 'retrying')
      return 'Saved progress will retry automatically.';
    if (maintenanceProblem) return 'Retry maintenance to continue this check.';
    if (maintenance.stage === 'waiting-for-lease')
      return 'Waiting for background work to finish.';
    if (scan.routineDone < scan.attempt)
      return 'Preparing check: running routine cleanup.';
    return scan.phase === 'objects'
      ? 'Checking stored files.'
      : scan.phase === 'metadata'
        ? 'Verifying image files.'
        : 'Checking storage totals.';
  });
  const maintenanceSummary = $derived.by(() => {
    if (!maintenance) return 'Maintenance status is unavailable.';
    if (maintenance.paused)
      return maintenance.status === 'paused'
        ? 'Pausing automatic maintenance: finishing the current task.'
        : 'Automatic maintenance is paused. No maintenance task is running.';
    switch (maintenance.status) {
      case 'failed': {
        return 'Automatic maintenance could not continue.';
      }
      case 'stalled': {
        return 'Automatic maintenance has not reported recent progress.';
      }
      case 'retrying': {
        return 'A background task failed temporarily. It will retry automatically.';
      }
      case 'running': {
        return 'Background work is running.';
      }
      default: {
        return maintenance.routineAt
          ? 'Waiting for the next scheduled run.'
          : 'No automatic cleanup has completed yet.';
      }
    }
  });
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
            'A stored file has no image record. Review it before permanently deleting it, especially if you are restoring a backup.',
            'Delete file',
          ],
          missing: [
            'Missing original',
            'The original image file is missing. Restore it if possible, or retire the image to disable its broken links.',
            'Retire image',
          ],
          accounting: [
            'Account usage differs',
            'An account’s storage total does not match its images. Recalculate its usage without changing original files.',
            'Repair usage',
          ],
          ledger: [
            'Storage totals differ',
            'Recorded storage totals do not match the tracked files. New storage writes are paused until this is repaired.',
            'Repair totals',
          ],
          'physical-size': [
            'File size differs',
            'A file’s size does not match its recorded usage. Verify the file and correct the storage total.',
            'Verify size',
          ],
          'physical-missing': [
            'Stored file is missing',
            'Verify the file is absent before releasing its space. A missing preview will be removed from the image record.',
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
          ? 'Storage is full. Free space or increase the limit to allow new uploads.'
          : `Storage is ${percent.toFixed(1)}% used or reserved.`,
      );
    previousLevel = level;
  });
</script>

<CollectionHeader title="Storage" refresh={manualRefresh} {busy} />

<section class="panel capacity" aria-labelledby="capacity-title">
  <div class="section-heading">
    <h2 id="capacity-title">Overview</h2>
    <a class="subtle-link" href="/admin/settings"
      >Manage limit <ArrowRight size={15} aria-hidden="true" /></a
    >
  </div>
  <p class="capacity-total">
    {storageBytes(capacity.persistedBytes)}
    <span
      >of {capacity.limitBytes === null
        ? 'Unlimited'
        : storageBytes(capacity.limitBytes)} used</span
    >
  </p>
  {#if !capacity.ready}<p class="notice">
      Known usage only. Storage setup is incomplete; these totals may not
      include every file.
    </p>{/if}
  {#if capacity.limitBytes !== null}
    <div
      class="capacity-track"
      role="meter"
      aria-label="Used and reserved storage capacity"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.min(100, percent)}
      aria-valuetext={`${utilization}, ${storageBytes(remaining!)} available`}
    >
      <span
        class="stored"
        style:width={`${Math.min(100, (capacity.persistedBytes / capacity.limitBytes) * 100)}%`}
      ></span>
      <span
        class="reserved"
        style:width={`${Math.min(Math.max(0, 100 - (capacity.persistedBytes / capacity.limitBytes) * 100), (capacity.reservedBytes / capacity.limitBytes) * 100)}%`}
      ></span>
    </div>
    <div class="capacity-caption">
      <span>{utilization}</span><strong
        >{storageBytes(remaining!)} available</strong
      >
    </div>
    {#if capacity.reservedBytes > 0}<div
        class="capacity-legend"
        aria-hidden="true"
      >
        <span>Used</span><span>Reserved for uploads</span><span>Available</span>
      </div>{/if}
  {:else}<p class="muted capacity-caption">
      No storage limit is configured in Hearth.
    </p>{/if}
  <dl class="storage-metrics">
    <div>
      <dt>Images</dt>
      <dd>
        <strong>{storage.active.images.toLocaleString()}</strong><small
          >{storageBytes(storage.active.activeBytes)} in active images and previews</small
        >
      </dd>
    </div>
    <div>
      <dt>Stored files</dt>
      <dd>
        <strong>{storage.objects.persistedObjects.toLocaleString()}</strong
        ><small>Completed originals, previews, and other stored files</small>
      </dd>
    </div>
    <div>
      <dt>Reserved for uploads</dt>
      <dd>
        <strong>{storageBytes(capacity.reservedBytes)}</strong><small
          >Space held for unfinished uploads and recovery; counts toward the
          limit</small
        >
      </dd>
    </div>
    <div>
      <dt>Awaiting deletion</dt>
      <dd>
        <strong>{storageBytes(storage.pending.bytes)}</strong><small
          >{storage.pending.count.toLocaleString()}
          {storage.pending.count === 1 ? 'file' : 'files'} queued for cleanup; already
          counted in used or reserved space</small
        >
      </dd>
    </div>
  </dl>
  {#if capacity.limitBytes !== null && percent >= 80}<p
      class="capacity-warning"
      class:error={percent >= 100}
      role="status"
    >
      <TriangleAlert size={18} aria-hidden="true" />
      <span
        >{#if percent >= 100}Storage is full. New uploads and other operations
          needing more space are blocked.
          {allocated > capacity.limitBytes
            ? `Free at least ${storageBytes(allocated - capacity.limitBytes)} to reach the limit, then enough space for your next upload.`
            : 'Free space or increase the limit to accept another upload.'}
          Existing images remain available.
        {:else}Storage is {percent >= 95
            ? 'nearly full'
            : 'approaching its limit'}. Free space or increase the limit before
          it fills up.{/if}</span
      >
    </p>{/if}
</section>

<section class="panel storage-breakdown" aria-label="Storage breakdown">
  <section aria-labelledby="types-title">
    <h2 id="types-title">By file type</h2>
    {#if data.types.length > 0}<p class="muted">
        Active original images, excluding previews.
      </p>{/if}
    {#each data.types as type (type.mime)}<div class="distribution-row">
        <div>
          <strong>{formatNames[type.mime] ?? type.mime}</strong><small
            >{type.count.toLocaleString()}
            {type.count === 1 ? 'image' : 'images'} · {originalBytes
              ? ((type.bytes / originalBytes) * 100).toFixed(1)
              : '0'}%</small
          >
        </div>
        <strong>{storageBytes(type.bytes)}</strong>
        <div class="distribution-track" aria-hidden="true">
          <span
            style:width={`${originalBytes ? (type.bytes / originalBytes) * 100 : 0}%`}
          ></span>
        </div>
      </div>{:else}<p class="empty-breakdown">
        No images yet. File types and their storage usage will appear after an
        upload.
      </p>{/each}
  </section>
  <section aria-labelledby="people-title">
    <h2 id="people-title">By person</h2>
    {#if storage.consumers.length > 0}<p class="muted">
        Top five accounts, including image previews.
      </p>{/if}
    {#each storage.consumers as person (person.id)}<div
        class="distribution-row"
      >
        <div>
          <a class="subtle-link" href={`/admin/users/${person.id}`}
            >{person.displayName}</a
          ><small
            >{person.imageCount.toLocaleString()}
            {person.imageCount === 1 ? 'image' : 'images'} · {storage.active
              .activeBytes
              ? ((person.bytes / storage.active.activeBytes) * 100).toFixed(1)
              : '0'}%</small
          >
        </div>
        <strong>{storageBytes(person.bytes)}</strong>
        <div class="distribution-track" aria-hidden="true">
          <span
            style:width={`${storage.active.activeBytes ? Math.min(100, (person.bytes / storage.active.activeBytes) * 100) : 0}%`}
          ></span>
        </div>
      </div>{:else}<p class="empty-breakdown">
        No image storage to compare yet. Usage by person will appear after an
        upload.
      </p>{/each}
    <a class="subtle-link storage-users-link" href="/admin/users?sort=storage"
      >View all users by storage usage <ArrowRight
        size={16}
        aria-hidden="true"
      /></a
    >
  </section>
</section>

<Disclosure
  title={attention
    ? 'Storage health & maintenance — Needs attention'
    : 'Storage health & maintenance'}
  icon={HeartPulse}
>
  {#snippet header()}<span class="health-summary">
      <strong>Storage health &amp; maintenance</strong>
      {#if attention}<span
          class="nav-dot"
          title="Needs attention"
          aria-hidden="true"
        ></span>{/if}
    </span>{/snippet}
  <section class="storage-health" aria-label="Storage health & maintenance">
    <div class="health-heading">
      <div
        class="condition"
        class:needs-attention={attention}
        role="status"
        aria-atomic="true"
      >
        <span class="condition-icon">
          {#if attention}<TriangleAlert size={22} aria-hidden="true" />
          {:else if checking && maintenance?.status === 'running'}<Spinner />
          {:else if !checking && capacity.ready && storage.lastSuccessful}<Check
              size={22}
              aria-hidden="true"
            />
          {:else}<CircleHelp size={22} aria-hidden="true" />{/if}
        </span>
        <div>
          <strong>{condition[0]}</strong>
          <p>{condition[1]}</p>
          {#if checkProgress}<p class="check-progress">{checkProgress}</p>{/if}
        </div>
      </div>
      <button
        disabled={busy || checking || !maintenance || maintenance.paused}
        onclick={() =>
          run(
            'reconcile',
            scan?.status === 'failed' ? { id: scan.id } : {},
            'Storage check started.',
          )}
        ><RefreshCw size={16} aria-hidden="true" />{scan?.status === 'failed'
          ? 'Retry check'
          : 'Check storage'}</button
      >
    </div>
    <p class="muted check-description">
      A check compares stored files with image records and storage totals.
      Routine cleanup runs first and may permanently remove already deleted or
      expired images. Repairs and deletion of discovered issues require a
      separate action. You can close this page while a check runs.
    </p>
    <div class="last-checked">
      <span>Last completed storage check</span><strong
        >{storage.lastSuccessful
          ? dateTime(storage.lastSuccessful.completedAt)
          : 'Not checked yet'}</strong
      >
    </div>
    <div class="automatic-maintenance">
      <div>
        <h3>Automatic maintenance</h3>
        <p class="muted">
          Cleanup is scheduled automatically, with daily storage checks.
        </p>
        <p class="maintenance-state" role="status">
          {maintenanceSummary}{#if maintenance?.status === 'retrying' && maintenance.retryAt}
            Next retry: {dateTime(Math.floor(maintenance.retryAt / 1000))}.{/if}
        </p>
        {#if maintenance?.routineAt}<p class="muted">
            Last automatic cleanup: {dateTime(
              Math.floor(maintenance.routineAt / 1000),
            )}.
          </p>{:else if maintenance && maintenance.status !== 'completed'}<p
            class="muted"
          >
            No automatic cleanup completion recorded.
          </p>{/if}
        {#if maintenance?.paused}<p>
            Cleanup and storage checks will wait until you resume. Uploads
            continue independently.
          </p>{/if}
        {#if maintenance?.backlog?.deferred}<p class="backlog-note">
            <TriangleAlert size={16} aria-hidden="true" />Last cleanup reported {maintenance.backlog.deferred.toLocaleString()}
            delayed tasks after failures. See diagnostics for details.
          </p>{/if}
      </div>
      {#if maintenance?.paused || (maintenanceProblem && scan?.status !== 'failed')}<button
          disabled={busy}
          onclick={() =>
            run('maintenance-resume', {}, 'Background maintenance resumed.')}
          >{maintenance?.paused
            ? 'Resume maintenance'
            : 'Retry maintenance'}</button
        >{/if}
    </div>
    {#if data.findings.length > 0}<section
        class="attention-section"
        aria-labelledby="attention-title"
      >
        <div class="section-heading attention-heading">
          <div>
            <h3 id="attention-title">Needs attention</h3>
            <span class="muted"
              >{data.findings.length === 100 ? 'At least ' : ''}{data.findings
                .length}
              {data.findings.length === 1 ? 'issue' : 'issues'}</span
            >
          </div>
          <button disabled={busy} onclick={resolveAll}
            ><CheckCheck size={16} aria-hidden="true" />Resolve all</button
          >
        </div>
        {#if data.findings.length === 100}<p class="muted">
            Showing the first 100 unresolved issues. Further issues will appear
            as these are resolved.
          </p>{/if}
        <div class="findings-list">
          {#each visibleFindings as finding (finding.id)}{@const description =
              findingText(finding.kind)}
            <article class="finding-card">
              <div class="finding-heading">
                <div class="finding-description">
                  <h4>{description[0]}</h4>
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
                  {#if finding.objectKey}<div>
                      <dt>Object key</dt>
                      <dd><code>{finding.objectKey}</code></dd>
                    </div>{/if}
                  <div>
                    <dt>Diagnostic data</dt>
                    <dd><code>{finding.details}</code></dd>
                  </div>
                  <div>
                    <dt>Detected</dt>
                    <dd>{dateTime(finding.createdAt)}</dd>
                  </div>
                </dl>
              </Disclosure>
            </article>
          {/each}
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
      </section>{/if}
  </section>
</Disclosure>

<Disclosure title="Advanced diagnostics & history" icon={ChartNoAxesCombined}>
  <div class="diagnostics">
    <section>
      <h3>Storage accounting</h3>
      <dl>
        <dt>Confirmed completed files</dt>
        <dd>{storageBytes(capacity.persistedBytes)}</dd>
        <dt>Upload parts confirmed in R2</dt>
        <dd>{storageBytes(storage.objects.stagedBytes)}</dd>
        <dt>Capacity held for recovery</dt>
        <dd>{storageBytes(storage.objects.recoveryBytes)}</dd>
        <dt>Accounting initialized</dt>
        <dd>{capacity.ready ? 'Yes' : 'No'}</dd>
        <dt>Multipart uploads verified</dt>
        <dd>{capacity.multipartVerified ? 'Yes' : 'No'}</dd>
        <dt>Writes blocked by accounting</dt>
        <dd>{capacity.blocked ? 'Yes' : 'No'}</dd>
      </dl>
      {#if !capacity.ready}<p class="notice">
          For legacy accounting or recovery, run <code
            >pnpm storage:initialize</code
          >, then complete the baseline storage check before enabling a limit.
          Fresh setup initializes accounting automatically. Completed files are
          preserved.
        </p>{/if}
    </section>
    <section>
      <h3>Maintenance diagnostics</h3>
      {#if maintenance}<dl>
          <dt>Coordinator status</dt>
          <dd>{maintenance.status}</dd>
          <dt>Stage</dt>
          <dd>{maintenance.stage}</dd>
          <dt>Last progress</dt>
          <dd>
            {maintenance.progress
              ? dateTime(Math.floor(maintenance.progress / 1000))
              : 'No progress recorded'}
          </dd>
          <dt>Last routine pass</dt>
          <dd>
            {maintenance.routineAt
              ? dateTime(Math.floor(maintenance.routineAt / 1000))
              : 'Not yet completed'}
          </dd>
          <dt>Consecutive failures</dt>
          <dd>{maintenance.failures}</dd>
          {#if maintenance.error}<dt>Current error</dt>
            <dd>{maintenance.error}</dd>{/if}
          {#if maintenance.failedStage}<dt>Failed stage</dt>
            <dd>{maintenance.failedStage}</dd>{/if}
          {#if maintenance.retryAt}<dt>Next retry</dt>
            <dd>{dateTime(Math.floor(maintenance.retryAt / 1000))}</dd>{/if}
          {#if maintenance.lastFailure}<dt>Last failure</dt>
            <dd>
              {dateTime(Math.floor(maintenance.lastFailure.at / 1000))} · {maintenance
                .lastFailure.stage}: {maintenance.lastFailure.message}
            </dd>{/if}
        </dl>
        {#if maintenance.backlog}<h4>Last recorded backlog</h4>
          <p class="muted">
            Counts were sampled at the last routine pass. Missing previews
            require the optional Cloudflare Images binding and do not by
            themselves indicate a storage problem.
          </p>
          <dl>
            <dt>Images without previews</dt>
            <dd>{maintenance.backlog.previews.toLocaleString()}</dd>
            <dt>Images awaiting physical deletion</dt>
            <dd>{maintenance.backlog.purges.toLocaleString()}</dd>
            <dt>Interrupted writes awaiting recovery</dt>
            <dd>{maintenance.backlog.recovery.toLocaleString()}</dd>
            <dt>Tasks delayed after failures</dt>
            <dd>{maintenance.backlog.deferred.toLocaleString()}</dd>
          </dl>{/if}
      {:else}<p>
          Maintenance status could not be retrieved. Check the maintenance
          Worker deployment, private binding, and logs.
        </p>{/if}
    </section>
    <section>
      <h3>Maintenance controls</h3>
      <p>
        Pausing stops future automatic cleanup and storage checks after the
        current task finishes safely. It does not stop uploads, domain
        validation, or other applications writing to storage. Coordinate those
        separately for backups or recovery.
      </p>
      {#if maintenance?.paused}<p>
          Maintenance is paused. {maintenance.status === 'drained'
            ? 'No maintenance task is running (drained).'
            : 'The current task is still finishing.'} Resume it in Storage health
          &amp; maintenance.
        </p>
      {:else}<button
          disabled={busy || !maintenance}
          onclick={() =>
            run(
              'maintenance-pause',
              {},
              'Automatic maintenance paused. Uploads continue independently.',
            )}
          ><CirclePause size={16} aria-hidden="true" />Pause automatic
          maintenance</button
        >{/if}
    </section>
    <section>
      <h3>Latest storage check</h3>
      {#if scan}<dl>
          <dt>Status</dt>
          <dd>{scan.status}</dd>
          <dt>Phase</dt>
          <dd>{scan.phase}</dd>
          <dt>Started</dt>
          <dd>{dateTime(scan.startedAt)}</dd>
          {#if scan.updatedAt}<dt>Last checkpoint</dt>
            <dd>{dateTime(scan.updatedAt)}</dd>{/if}
          {#if scan.completedAt}<dt>Completed</dt>
            <dd>{dateTime(scan.completedAt)}</dd>{/if}
          <dt>Files observed</dt>
          <dd>{scan.objectCount.toLocaleString()}</dd>
          <dt>Bytes observed</dt>
          <dd>{storageBytes(scan.bytes)}</dd>
          {#if scan.error}<dt>Error</dt>
            <dd>{scan.error}</dd>{/if}
        </dl>
        <p class="muted">
          {scan.status === 'completed'
            ? 'Observations reflect the time of this check.'
            : 'These are incomplete observations, not total storage usage.'} Live
          usage and remaining space come from current storage accounting.
        </p>
      {:else}<p class="muted">No storage checks recorded yet.</p>{/if}
      {#if storage.lastSuccessful && storage.lastSuccessful.id !== scan?.id}<p
          class="muted"
        >
          Last completed check: {dateTime(storage.lastSuccessful.completedAt)} · {storage.lastSuccessful.objectCount.toLocaleString()}
          files · {storageBytes(storage.lastSuccessful.bytes)} observed at check time.
        </p>{/if}
    </section>
    {#if data.history.length > 0}<section>
        <h3>Daily active image storage</h3>
        <p class="muted">
          Historical active image and preview usage, separate from physical
          capacity.
        </p>
        {#each data.history.slice(0, 7) as item (item.day)}<div
            class="history-row"
          >
            <span>{item.day}</span><small
              >{item.images.toLocaleString()} images</small
            ><strong>{storageBytes(item.bytes)}</strong>
          </div>{/each}
      </section>{/if}
    <section>
      <h3>Recent storage checks</h3>
      {#each data.runs as item (item.id)}<div class="history-row">
          <span>{dateTime(item.startedAt)}</span><span>{item.status}</span>
        </div>{:else}<p class="muted">No check history yet.</p>{/each}
    </section>
  </div>
</Disclosure>

<style>
  h2,
  h3,
  h4,
  p,
  dd {
    margin: 0;
  }
  h2 {
    font-size: 1.1rem;
  }
  h3 {
    font-size: 1rem;
  }
  h4 {
    font-size: 0.95rem;
  }
  .section-heading,
  .capacity-caption,
  .health-heading,
  .automatic-maintenance,
  .finding-heading,
  .last-checked {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .section-heading,
  .capacity-caption {
    align-items: center;
    flex-wrap: wrap;
  }
  .section-heading {
    margin: 0;
  }
  .section-heading > a,
  .storage-users-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
  }
  .capacity .capacity-total {
    color: inherit;
    margin: 0.75rem 0 1rem;
    font-size: clamp(1.8rem, 4vw, 2.7rem);
    font-weight: 600;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
  }
  .capacity-total span {
    font-size: 0.55em;
    color: var(--muted);
    font-weight: 400;
  }
  .capacity-track,
  .distribution-track {
    display: flex;
    overflow: hidden;
    border-radius: 999px;
    background: var(--border);
    height: 10px;
  }
  .capacity-track .stored,
  .distribution-track span {
    background: var(--accent);
  }
  .capacity-track .reserved {
    background: var(--muted);
  }
  .capacity .capacity-caption {
    margin-top: 0.6rem;
    font-size: 0.85rem;
  }
  .capacity-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 0.5rem;
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
    gap: 1.25rem;
    margin: 1.25rem 0 0;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
  }
  .storage-metrics dt {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .storage-metrics strong {
    display: block;
    margin: 0.2rem 0;
    font-size: 1.45rem;
    font-weight: 550;
    font-variant-numeric: tabular-nums;
  }
  .storage-metrics small {
    display: block;
    color: var(--muted);
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .capacity-warning,
  .backlog-note {
    display: flex;
    align-items: start;
    gap: 0.6rem;
    color: #e2b598;
  }
  .capacity-warning {
    margin-top: 1rem;
  }
  .capacity-warning.error {
    margin-bottom: 0;
  }
  .capacity-warning :global(svg),
  .backlog-note :global(svg),
  .subtle-link :global(svg) {
    flex-shrink: 0;
  }
  .capacity-warning :global(svg),
  .backlog-note :global(svg) {
    margin-top: 0.2rem;
  }
  .muted,
  .empty-breakdown,
  .last-checked > span {
    color: var(--muted);
  }
  .storage-breakdown {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }
  .storage-breakdown > section {
    min-width: 0;
  }
  .storage-breakdown > section + section {
    padding-left: 1.5rem;
    border-left: 1px solid var(--border);
  }
  .storage-breakdown h2 + p {
    margin-top: 0.4rem;
  }
  .storage-users-link {
    margin-top: 0.75rem;
  }
  .distribution-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.25rem 1rem;
    padding-top: 0.85rem;
    font-size: 0.9rem;
  }
  .distribution-row > div:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .distribution-row > strong {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .distribution-row small {
    display: block;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .distribution-track {
    grid-column: 1 / -1;
    height: 4px;
    margin-top: 0.2rem;
  }
  .storage-health {
    display: grid;
    gap: 1rem;
  }
  .storage-health p {
    font-size: 0.88rem;
  }
  .health-summary {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    gap: 0.75rem;
  }
  .health-summary strong {
    font-size: 1rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .health-summary .nav-dot {
    flex-shrink: 0;
  }
  .health-heading,
  .automatic-maintenance,
  .finding-heading {
    align-items: start;
  }
  .health-heading > button,
  .automatic-maintenance > button,
  .finding-heading > button {
    flex-shrink: 0;
  }
  .condition {
    display: flex;
    gap: 0.75rem;
    min-width: 0;
  }
  .condition-icon {
    display: flex;
    padding-top: 0.2rem;
    color: var(--muted);
  }
  .needs-attention .condition-icon {
    color: #e2b598;
  }
  .condition p {
    color: var(--muted);
    margin-top: 0.25rem;
  }
  .condition .check-progress {
    color: inherit;
  }
  .check-description {
    max-width: 90ch;
  }
  .last-checked {
    flex-wrap: wrap;
    gap: 0.3rem 1rem;
    font-size: 0.85rem;
  }
  .automatic-maintenance,
  .attention-section {
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  .automatic-maintenance p {
    margin-top: 0.35rem;
  }
  .maintenance-state {
    font-weight: 550;
  }
  .attention-heading {
    margin-bottom: 1rem;
  }
  .attention-heading > div {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .attention-heading .muted {
    font-size: 0.85rem;
  }
  .findings-list {
    display: grid;
    gap: 0.75rem;
  }
  .finding-card {
    min-width: 0;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--page);
  }
  .finding-description {
    min-width: 0;
  }
  .finding-description p {
    margin-top: 0.3rem;
    color: var(--muted);
  }
  .finding-card :global(.finding-details) {
    --radius: 10px;
    margin: 0.75rem 0 0;
  }
  .finding-card :global(.finding-details summary) {
    padding: 0.65rem 0.85rem;
  }
  .finding-card :global(.finding-details .content) {
    padding: 0.85rem;
  }
  .finding-card :global(.finding-details summary strong) {
    font-size: 0.85rem;
  }
  .finding-metadata {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .finding-metadata dt,
  .diagnostics dt {
    color: var(--muted);
  }
  .finding-metadata code {
    white-space: pre-wrap;
  }
  .diagnostics {
    display: grid;
    gap: 1.5rem;
    font-size: 0.85rem;
  }
  .diagnostics h3,
  .diagnostics h4 {
    margin-bottom: 0.5rem;
  }
  .diagnostics dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem 1rem;
    margin: 0.75rem 0;
  }
  .diagnostics p + button {
    margin-top: 0.75rem;
  }
  .diagnostics dd,
  .finding-metadata dd {
    overflow-wrap: anywhere;
  }
  .history-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--border);
  }
  .history-row > span:first-child {
    flex: 1;
  }
  @media (max-width: 1000px) {
    .storage-metrics {
      grid-template-columns: 1fr 1fr;
    }
  }
  @media (max-width: 700px) {
    .storage-breakdown {
      grid-template-columns: 1fr;
      gap: 1rem;
    }
    .storage-breakdown > section + section {
      padding: 1rem 0 0;
      border-left: 0;
      border-top: 1px solid var(--border);
    }
    .health-heading,
    .automatic-maintenance,
    .finding-heading {
      flex-direction: column;
    }
    .storage-metrics {
      gap: 1rem;
    }
  }
</style>
