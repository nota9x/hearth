# Secure your instance

Hearth is private for uploading and administration. Public image links require no
viewer login. Do not share material that needs authenticated readers through
public links, even with a long slug.

## Protect credentials

- Store account keys in a password manager and maintain two active administrators.
  There is no email recovery or bootstrap reset for an established instance.
- Protect generated `.sxcu` files: they contain the plaintext account key.
  Protect ShareX history and deletion URLs, which can authorize image deletion.
- Rotate/reset a compromised account key, regenerate every uploader, and verify
  the old key fails. Rotation revokes all sessions but does not delete images.
- Keep Cloudflare, Turnstile, and S3 credentials out of Git, commands, and support
  logs. Worker secrets and local `.dev.vars` files have different roles.
- Encrypt backups and restrict their access. D1 exports include account/session
  digests, private metadata, and validation keys; R2 backups contain the images.

## Keep storage private and delivery authoritative

Leave R2 public access disabled. Only the delivery Worker should expose public
image URLs. It consults authoritative D1 account, domain, image, link, and expiry
state on every request, including conditional and range requests.

Do not apply Cache Everything, proxy caching, or other rules that serve an image
without executing those checks. Public responses require revalidation; dashboard
responses must remain private. Disabling an account or delivery domain should
block the next public request. An already downloaded copy or an authorized
response in flight cannot be recalled.

Access restrictions on a domain control creation of new shares. To suspend existing
links, disable delivery or the owner account. Removing a link/domain or deleting
an image is a different, permanent action; see [domains](custom-domains.md).

## Configure the public front door

Use the canonical HTTPS application origin in production. Alternate application
hosts receive HTTP 421. Cookie mutations require its exact Origin; native ShareX
uploads use the bearer endpoint without requiring Origin.

Use a real Turnstile widget restricted to the application hostname. Avoid proxy
challenges on `/api/v1/images` that native ShareX cannot complete. Retain all
rate-limit bindings and the web Worker's `global_fetch_strictly_public` flag.

Keep `CF-Connecting-IP` intact and Cloudflare Pseudo IPv4 **Overwrite Headers**
disabled. Delivery's failure limiter and edge cooldown use trusted client identity.
Repeated failed lookups can temporarily block valid links too, including for users
behind the same public address. Limits/cooldown are best-effort per edge location,
not a global guarantee. Do not disable delivery's Cache API or override its
error-response cache controls.

## Understand image and sharing limits

Generated links default to five case-sensitive Base62 characters. Short IDs can be
guessed. Choose a longer default under **Administration → Settings → Share-link
IDs** when useful, but treat it as guess resistance rather than viewer authorization.
Automatic length growth maintains allocation reliability.

Metadata stripping defaults to enabled, retains rendering information and ICC
profiles, and never falls back to unsanitized bytes on failure. It does not fully
decode all pixels, detect all corrupt image data, or scan for malware. See
[metadata privacy](images-and-links.md#understand-metadata-privacy).

D1 and R2 do not share a transaction. Uncertain writes stay charged and may leave
objects for recovery instead of deleting possibly referenced data. Scheduled
cleanup and reconciliation assist recovery; they are not backups.

## Respond to an incident safely

Use [Worker logs](../operations/maintenance.md#read-worker-logs) and the application's
domain/storage diagnostics. Redact Authorization headers, cookies, account keys,
deletion fragments, exported data, and private image contents before sharing.

Preserve evidence privately and revoke exposed credentials. Review
[backups and recovery](../operations/backups-and-recovery.md) before taking
destructive corrective actions.

For suspected vulnerabilities in Hearth, follow the
[Security Policy](../../SECURITY.md#reporting-a-vulnerability). It covers private
reporting, supported versions, coordinated disclosure, and responsible research.
Do not publish credentials or exploit details in a public issue.
