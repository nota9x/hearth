# Hearth documentation

These guides help you deploy, configure, and maintain your own Hearth instance.
All terminal commands run from the repository root unless a guide says otherwise.

## Start here

1. [Install Hearth](getting-started/installation.md): check prerequisites, create
   Cloudflare resources, and deploy the three Workers.
2. [Complete first-run setup](getting-started/first-run.md): sign in, validate a
   delivery domain, and choose upload defaults.
3. [Connect ShareX](getting-started/sharex-setup.md): import your generated uploader,
   enable automatic uploads, and verify your first screenshot and public URL.

## Browse by task

| Task                                                   | Guide                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| Add or change delivery hostnames                       | [Custom domains](guides/custom-domains.md)                 |
| Invite members, reset keys, or suspend accounts        | [User management](guides/user-management.md)               |
| Upload, organize, share, expire, or delete images      | [Images and links](guides/images-and-links.md)             |
| Configure quotas, global capacity, and storage repairs | [Storage management](guides/storage-management.md)         |
| Protect credentials and understand public sharing      | [Security](guides/security.md)                             |
| Look up variables, bindings, and deployment settings   | [Configuration reference](reference/configuration.md)      |
| Deploy an application update                           | [Updating](operations/updating.md)                         |
| Back up data or recover an instance                    | [Backups and recovery](operations/backups-and-recovery.md) |
| Check cleanup, scheduled tasks, and Worker logs        | [Maintenance and monitoring](operations/maintenance.md)    |
| Diagnose a failed workflow                             | [Troubleshooting](operations/troubleshooting.md)           |

## Common questions

- **How do I report a security vulnerability?** Follow the [Security Policy](../SECURITY.md#reporting-a-vulnerability) to report it privately.
- **How do I deploy Hearth?** Follow [installation](getting-started/installation.md).
- **How do I configure a delivery domain?** Follow [domain connection](guides/custom-domains.md#connect-a-delivery-hostname).
- **How do I connect ShareX?** Use the [generated uploader](getting-started/sharex-setup.md).
- **Why are uploads failing?** Start with [upload troubleshooting](operations/troubleshooting.md#uploads-fail).
- **How do I update an instance?** Use the [update procedure](operations/updating.md).
- **How do I back up my data?** Back up [D1, R2, configuration, and secrets](operations/backups-and-recovery.md).
- **How do I diagnose Cloudflare errors?** Identify the Worker using
  [logs](operations/maintenance.md#read-worker-logs), then follow [troubleshooting](operations/troubleshooting.md).

## Development

Contributor material is separate: [development overview](development/README.md),
[local setup](development/local-setup.md), [architecture and invariants](development/architecture.md),
and [releases and Git hooks](development/releasing.md).
