# Manage delivery domains

Hearth uses one application origin for the dashboard, API, and deletion pages.
Image links use separate full delivery hostnames. They may belong to different
Cloudflare zones in the same account; no shared suffix or wildcard is required.

## Connect a delivery hostname

For a first deployment, [installation](../getting-started/installation.md) configures
the Custom Domain through Wrangler. For an additional hostname:

1. Confirm its root domain is active in the Cloudflare account running Hearth.
2. Add the exact hostname to `routes` in
   `workers/delivery/production.local.jsonc`, keeping existing entries:

   ```jsonc
   { "pattern": "images.example.com", "custom_domain": true }
   ```

   This is one entry in the `routes` array, not a complete configuration file.
   Do not attach the hostname to the R2 bucket or the web Worker.

3. Check for conflicting DNS records, especially a CNAME, before deploying:

   ```sh
   pnpm exec wrangler deploy --config workers/delivery/production.local.jsonc
   ```

4. In Hearth, open **Administration → Domains**, add that hostname and choose its
   sharing access. Wait for DNS/TLS, then use **Validate domain** from the row menu
   or **Details & diagnostics**.
5. After validation succeeds, explicitly set it as the instance default if it should be the
   default for new links. Test by uploading an image and opening its new URL.

Alternatively, Cloudflare's Worker **Domains** tab provides **Custom Domains and
Routes → Add Domain**. Keep the same hostname in your production configuration
so subsequent deployments retain it. The dedicated Domains tab replaced the
older Settings navigation; see the [dashboard change](https://developers.cloudflare.com/changelog/post/2026-05-14-domains-tab/)
and [Custom Domain requirements](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

Enter hostnames without `https://`, paths, ports, or wildcards. Production rejects
IP addresses, private/local names, and the application hostname.

## Choose who can create links

Domains allow **Everyone**, **Administrators only**, or **Selected members**.
Administrators always have sharing access. These permissions govern new links;
they do not add viewer authentication to existing public URLs.

For new sharing, Hearth uses the explicitly chosen domain, otherwise the user's
saved personal selection, otherwise the instance default. The selected domain
must be enabled, validated, and accessible to the image owner. An unavailable
personal selection does not fall back to the instance default. Users can choose
**Use instance default** or **Use for my new links** in Domains.

If no usable selection exists, browser uploads save privately with a warning.
ShareX/API uploads return HTTP 409 `IMAGE_SAVED_WITHOUT_LINK` while retaining the
image. Fix the selection, open the saved image, and create its link. Replaying an
idempotent upload does not generate a replacement link.

## Understand status and validation

| Status        | Meaning and action                                                                 |
| ------------- | ---------------------------------------------------------------------------------- |
| Pending       | No successful check yet; finish Cloudflare setup and validate.                     |
| Active        | Last conclusive check passed; eligible for new sharing when enabled and permitted. |
| Misconfigured | Failed before any successful check; follow the diagnostic and revalidate.          |
| Unhealthy     | A previously working domain failed a later check; repair and revalidate.           |
| Disabled      | An administrator suspended delivery; enable it to restore eligible links.          |

Validation checks Cloudflare DNS, HTTPS without redirects, an instance-bound proof,
and an actual R2 read. Web and delivery must bind the same D1 and R2 resources.
An inconclusive resolver or local-storage failure can retain the previous health;
read the diagnostic rather than treating retained Active status as a fresh pass.

Checks run on demand, not on every page refresh or an automatic health schedule.
Active is the last verified state, not an uptime guarantee. A later unhealthy
check blocks new sharing; existing links continue to depend on actual delivery,
account state, expiry, and whether delivery is enabled.

## Change, disable, or remove a domain

- **Change instance default:** affects future links for users following the
  instance default. Existing links keep their hostname.
- **Restrict sharing access:** changes who may create new links. Existing public
  links remain readable.
- **Disable delivery:** suspends all assigned links. Re-enabling restores those
  whose images/accounts are active and whose deadlines have not passed.
- **Remove a domain:** revokes its links and clears its personal selections while
  retaining images. It does not move links to another hostname.

Hostnames are immutable. Add and validate a replacement first. Removing or
disabling the instance default requires a healthy replacement or an explicit
choice to clear the instance default. Review the confirmation's affected links
and personal selections.

Removing a row does not detach its Cloudflare Custom Domain. Update the delivery
production routes and deploy after the application change. If you are replacing
links, create and verify the new links before removing the old domain.

For DNS, TLS, routing, and proof failures, follow
[delivery troubleshooting](../operations/troubleshooting.md#delivery-domain-validation-fails).
