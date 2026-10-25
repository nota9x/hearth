<script lang="ts">
  import type { PresentedAudit } from '@hearth/core/audit-collection';

  import { auditIcon } from './audit-icons';
  import Disclosure from './Disclosure.svelte';

  const { log }: { log: PresentedAudit } = $props();
</script>

<Disclosure class="audit-entry" title={log.title} icon={auditIcon(log.action)}>
  {#snippet header()}<div class="audit-heading">
      <div class="row-content">
        <strong>{log.title}</strong>
        <small
          >{#if log.actorHref}<a class="audit-link" href={log.actorHref}
              >{log.actor}</a
            >{:else}{log.actor}{/if}&nbsp;·&nbsp;{#if log.targetHref}<a
              class="audit-link"
              href={log.targetHref}>{log.target}</a
            >{:else}{log.target}{/if}</small
        >
        {#if log.summary}<small>{log.summary}</small>{/if}
      </div>
      <time datetime={new Date(log.createdAt * 1000).toISOString()}
        >{new Date(log.createdAt * 1000).toLocaleString()}</time
      >
    </div>{/snippet}
  <div class="audit-details">
    {#if log.details.length > 0}<div class="audit-changes" aria-label="Changes">
        {#each log.details as detail (detail)}<p>{detail}</p>{/each}
      </div>{/if}
    <dl>
      <dt>Actor</dt>
      <dd>
        {#if log.actorHref}<a class="audit-link" href={log.actorHref}
            >{log.actor}</a
          >{:else}{log.actor}{/if}{#if log.actorId}
          <code>{log.actorId}</code
          >{/if}{#if log.actorIp && log.actorIp !== log.actor}
          <code>IP: {log.actorIp}</code>{/if}
      </dd>
      <dt>Affected resource</dt>
      <dd>
        {#if log.targetHref}<a class="audit-link" href={log.targetHref}
            >{log.target}</a
          >{:else}{log.target}{/if}{#if log.targetId}
          <code>{log.targetId}</code>{/if}
      </dd>
      <dt>Action</dt>
      <dd><code>{log.action}</code></dd>
      <dt>Timestamp (UTC)</dt>
      <dd>{new Date(log.createdAt * 1000).toISOString()}</dd>
      {#each log.context as detail (detail.label)}<dt>{detail.label}</dt>
        <dd>{detail.value}</dd>{/each}
      <dt>Event ID</dt>
      <dd><code>{log.id}</code></dd>
    </dl>
  </div>
</Disclosure>

<style>
  .audit-link {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  :global(details.disclosure.audit-entry) {
    margin-bottom: 0;
  }
  .audit-heading {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    min-width: 0;
  }
  .audit-heading strong {
    font-size: 1rem;
    font-weight: 600;
  }
  .audit-heading time {
    font-size: 0.8rem;
  }
  .audit-details {
    overflow-wrap: anywhere;
  }
  .audit-changes {
    display: grid;
    gap: 0.4rem;
    margin: 0 0 1.25rem;
    padding: 0.75rem 1rem;
    border-left: 3px solid var(--accent);
    border-radius: 0 8px 8px 0;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .audit-changes p {
    margin: 0;
    line-height: 1.45;
  }
  .audit-details dl {
    margin: 0;
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) 4fr;
    gap: 0.5rem 1rem;
  }
  .audit-details dd {
    margin: 0;
  }
  .audit-details dt {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .row-content small {
    overflow-wrap: anywhere;
  }
  .audit-details code {
    display: block;
    color: var(--muted);
    font-size: 0.8rem;
  }
  @media (max-width: 640px) {
    .audit-heading {
      flex-wrap: wrap;
    }
    .audit-details dl {
      grid-template-columns: 1fr;
    }
  }
</style>
