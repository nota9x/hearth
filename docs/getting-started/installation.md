# Install Hearth on Cloudflare

Use guided setup for a new installation or to resume an interrupted setup.
To upgrade an existing installation, follow [updating](../operations/updating.md).

## Before you start

You need:

- **Node 26 LTS** (26.13.0 or newer in 26.x), **Git**, and **pnpm**. Use the pnpm version listed in
  `package.json` under `packageManager`.
- **A Cloudflare account** with an active domain and permission to create and
  manage services. If someone else owns the account, you may need their help.
- **R2 enabled** in your Cloudflare account. Complete its checkout if prompted.
- **Two available addresses on your domain**, such as `app.example.com` for
  Hearth and `images.example.com` for shared images.

If your domain is not active yet, follow Cloudflare's
[domain setup guide](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
Review existing website and email records before changing nameservers.
Cloudflare usage can incur charges; review your account's pricing and billing.

Node 26 does not bundle Corepack. If pnpm is not installed, install the pinned
version with `npm install --global pnpm@12.16.1`, then check `node --version`
and `pnpm --version`. Linux installations of the official Node binaries also
require `libatomic` (usually provided by the distribution's `libatomic1` package).

## Guided installation (recommended)

### 1. Download Hearth

Open a terminal and run:

```sh
git clone https://github.com/nota9x/hearth.git
cd hearth
pnpm install --frozen-lockfile
```

Run the remaining commands from this directory.

### 2. Start setup

```sh
pnpm run setup
```

Always include **run**: `pnpm setup` is a different command that configures pnpm.

### 3. Follow the prompts

1. Sign in to Cloudflare if asked. Choose **Log in with Wrangler** to sign in
   through your browser. Setup can reuse an existing login.
2. Select the Cloudflare account that owns your domain. To use another login,
   choose **Add account** below the account list.
3. Enter your application and image addresses when prompted.
4. Review the proposed settings and confirm to begin installation. Setup creates
   the services Hearth needs and deploys the application for you.
5. **Save the administrator key in a password manager when shown.** This is your
   Hearth login credential.

If Cloudflare requires an account change, such as enabling R2, setup shows where
to complete it. Return to the terminal afterward and retry. Setup does not
purchase upgrades for you.

### 4. Sign in and finish

Open your application address, such as `https://app.example.com`, and sign in
with the administrator key. Confirm the login verification works, then follow
[first-run setup](first-run.md) and [ShareX setup](sharex-setup.md) to upload your
first screenshot and open its image link.

Setup checks the installation automatically and lists any checks still needing
attention. Follow any remaining instructions, including checking the first
scheduled maintenance run; Cloudflare may take up to 15 minutes to start it.

Keep a backup of the generated `production.local.jsonc` files in `apps/web`,
`workers/delivery`, and `workers/maintenance`. These files are not saved in Git.
See [backups and recovery](../operations/backups-and-recovery.md) before relying
on the installation.

### If setup stops or fails

Run the same command again to resume:

```sh
pnpm run setup
```

Setup rechecks your progress and reuses the work already completed. Do not delete
Cloudflare resources or the `artifacts/setup` folder to force a retry.

| Problem                                      | What to do                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A setup step fails                           | Read the reported issue, fix it, then choose **Retry**. Use **Save progress and exit** if you need to return later.                                |
| The wrong account is selected                | Choose **Change account** and select the account that owns your domain.                                                                            |
| Login or permission errors                   | Sign in again. If access is still denied, ask the account owner to grant the required access. For token-based login, use **Advanced API options**. |
| R2, billing, or account approval is required | Open the Cloudflare link shown by setup and complete the requested action, then retry.                                                             |
| An address is already in use                 | Choose an unused address, or inspect the existing Cloudflare assignment before changing it.                                                        |
| The site or image address is not ready       | Allow time for Cloudflare to finish connecting the address and enabling HTTPS, then retry.                                                         |
| Browser login verification fails             | Check that the Turnstile widget allows your application hostname. See [troubleshooting](../operations/troubleshooting.md).                         |
| An uninstall is pending                      | Rerun `pnpm run setup --uninstall` to finish removing the previous installation before installing again.                                           |

For more help, see [installation and deployment troubleshooting](../operations/troubleshooting.md#installation-or-deployment-fails).
Setup diagnostics are saved in `artifacts/setup/`.

### Optional settings

Use `pnpm run setup --advanced` if you need custom resource names, an existing
Turnstile widget, or multiple image addresses. Use a separate checkout for each
production installation.

Cloudflare Images and a global storage limit are optional and are not needed to
get started. See [storage management](../guides/storage-management.md) to configure
them later.

## Uninstall Hearth

Back up anything you want to keep, then run:

```sh
pnpm run setup --uninstall
```

Select the account and installation. Review the resources and inspection links
shown before confirming. **Uninstall permanently deletes the installation's
images, accounts, and keys.** It also removes its Cloudflare services and matching
local production files.

If setup flags a resource that may be shared with another service, inspect it
before approving deletion. Choose **No** to stop if you are unsure.

If removal fails or is interrupted, resolve the reported issue and rerun the same
command. Keep `artifacts/setup/uninstall.json` until removal finishes; it saves
the progress needed to resume.

## Advanced installation and resource ownership

Use `pnpm run setup --advanced` for custom instance prefixes, database and bucket
names, hostnames, and Turnstile choices. Every new instance must provision a new
D1 database and a new private R2 bucket through setup. Existing buckets, including
apparently empty buckets, cannot be adopted by a new instance.

Setup records successful creation identities in `artifacts/setup/state.json` and
initializes zero-based accounting before administrator/domain initialization or
Worker deployment. Save this local resume state privately with your configuration.
If creation succeeded but its checkpoint was lost, setup fails safely: use new
unused resource names and review the abandoned resources separately. Do not mark
accounting ready by hand or delete resources without verifying their ownership.

After successful setup, the global physical limit can be enabled immediately in
administrator Settings. Normal installation needs no AWS CLI or S3 credentials.
Direct R2 writers bypass reservations; reconcile after any out-of-band changes.

`pnpm configure` remains available for configuration management and explicit
migration/recovery. It does not prove fresh storage creation or initialize
accounting. Upgrades preserve their database, bucket, readiness, and usage; use
[updating](../operations/updating.md). Restore database and storage together using
[backup and recovery](../operations/backups-and-recovery.md), including multipart
verification where necessary.
