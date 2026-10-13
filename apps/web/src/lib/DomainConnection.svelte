<script lang="ts">
  import type { DeliveryDomain } from '@hearth/core/delivery-domains';
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';

  import Disclosure from '$lib/Disclosure.svelte';
  import { fadeMotion } from '$lib/motion';

  const { domain }: { domain: DeliveryDomain } = $props();
</script>

{#if domain.diagnostics}<div
    in:fadeMotion={{ kind: 'content' }}
    class="notice diagnostic-notice"
    role="status"
  >
    {#if domain.diagnostics.outcome === 'passed'}<Check
        size={18}
      />{:else}<CircleAlert size={18} />{/if}
    <div>
      <strong
        >{domain.diagnostics.outcome === 'passed'
          ? 'Validation passed'
          : domain.diagnostics.outcome === 'inconclusive'
            ? 'Check inconclusive'
            : 'Setup needs attention'}</strong
      >
      <p>
        {domain.diagnostics
          .message}{#if domain.diagnostics.outcome === 'inconclusive'}
          The displayed status is from the last conclusive check.{/if}
      </p>
    </div>
  </div>{/if}
<div class="setup-guide">
  <h3>Connect this domain</h3>
  {#if domain.hostname === '127.0.0.1' || domain.hostname.endsWith('.localhost')}<p
    >
      Run the local delivery Worker on the configured delivery port and share
      the web Worker’s local D1 and R2 state. Local checks do not validate
      production DNS or TLS.
    </p>
  {:else}<p class="setup-intro">
      Connect <strong>{domain.hostname}</strong> to your delivery Worker, then validate
      it here. Adding it in Hearth does not configure Cloudflare.
    </p>
    <ol>
      <li>
        <h4>Add the domain to your Cloudflare account</h4>
        <p>
          In the <a
            href="https://dash.cloudflare.com/"
            target="_blank"
            rel="noreferrer">Cloudflare dashboard</a
          >, choose the account that owns your delivery Worker. Open
          <strong>Domains → Onboard a domain</strong>, enter the root domain
          (for example, <code>example.com</code> for
          <code>images.example.com</code>), and choose a plan.
        </p>
        <p>
          Review the imported DNS records, including website and email records.
          At your registrar, replace the nameservers with those assigned by
          Cloudflare and wait until the domain is <strong>Active</strong>. If
          DNSSEC is enabled, turn it off at your registrar before changing
          nameservers, then re-enable it through Cloudflare after activation.
        </p>
        <p class="step-hint">
          Already active in this account? Continue to step 2. <a
            href="https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/"
            target="_blank"
            rel="noreferrer">Domain onboarding guide ↗</a
          >
        </p>
      </li>
      <li>
        <h4>Connect it to the delivery Worker</h4>
        <p>
          Open <strong>Compute → Workers & Pages</strong>, select your Hearth
          delivery Worker, and open the <strong>Domains</strong>
          tab. Under <strong>Custom Domains and Routes</strong>, choose
          <strong>Add Domain</strong>.
        </p>
        <p>
          Select the domain you added to this account, configure the exact
          hostname <strong>{domain.hostname}</strong>, and confirm the
          connection for <strong>Production</strong> traffic. If the domain is missing
          from the list, complete step 1 in the same account first.
        </p>
        <p class="step-hint">
          Remove conflicting DNS records for this hostname, including an
          existing CNAME, before connecting. Cloudflare creates the DNS record
          and manages the TLS certificate.
        </p>
      </li>
      <li>
        <h4>Validate the connection</h4>
        <p>
          Wait for DNS and the TLS certificate to be ready, then choose <strong
            >Validate domain</strong
          > below. If the check fails, follow the diagnostic message and try again
          after the changes take effect.
        </p>
      </li>
    </ol>
    <Disclosure title="Keep the domain connected after deployments" icon={Info}>
      <p>
        In <code>workers/delivery/wrangler.jsonc</code>, keep this exact
        hostname in <code>routes</code> with
        <code>custom_domain: true</code>. The delivery Worker must use the same
        D1 database and R2 bucket as the application.
      </p>
      <a
        href="https://developers.cloudflare.com/workers/configuration/routing/custom-domains/"
        target="_blank"
        rel="noreferrer">Cloudflare Custom Domains documentation ↗</a
      >
    </Disclosure>
  {/if}
  <p class="validation-note">
    Validation checks DNS, instance identity, and an R2 read. Checks run only
    when requested; this is not continuous uptime monitoring.
  </p>
</div>

<style>
  .setup-guide {
    font-size: 0.9rem;
    line-height: 1.6;
  }
  .diagnostic-notice {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    margin: 0;
  }
  .diagnostic-notice :global(svg) {
    flex-shrink: 0;
    margin-top: 0.15rem;
  }
  .diagnostic-notice p {
    margin: 0.3rem 0 0;
    line-height: 1.6;
  }
  .setup-guide h3 {
    margin: 0 0 0.6rem;
  }
  .setup-guide ol {
    margin: 1rem 0;
    padding-left: 1.5rem;
  }
  .setup-guide li {
    padding-left: 0.35rem;
    margin: 0 0 1rem;
  }
  .setup-guide li::marker {
    color: var(--muted);
    font-weight: 600;
  }
  .setup-guide h4 {
    margin: 0;
    font-size: 0.9rem;
  }
  .setup-guide p {
    margin: 0.45rem 0 0;
  }
  .setup-intro,
  .step-hint,
  .validation-note {
    color: var(--muted);
  }
  .step-hint,
  .validation-note {
    font-size: 0.82rem;
  }
  .setup-guide a {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .setup-guide code,
  .setup-guide strong {
    overflow-wrap: anywhere;
  }
</style>
