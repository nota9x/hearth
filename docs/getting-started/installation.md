# Install Hearth on Cloudflare

Use guided setup for a new installation or to resume an interrupted setup.
To upgrade an existing installation, follow [updating](../operations/updating.md).

## Before you start

You need:

- **Node 24**, **Git**, and **pnpm**. Use the pnpm version listed in
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

## Manual installation

Use this alternative if you want to create and deploy the services yourself.
Otherwise, use guided installation above.

### 1. Get the source and install dependencies

Complete [Before you start](#before-you-start), then run:

```sh
git clone https://github.com/nota9x/hearth.git
cd hearth
pnpm install --frozen-lockfile
```

### 2. Authenticate and create storage

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create hearth-production
pnpm exec wrangler r2 bucket create YOUR_BUCKET_NAME
```

Confirm that `whoami` shows the account that owns your domain. Save the database
UUID printed by the D1 command. Replace `YOUR_BUCKET_NAME` with a unique name of
3–63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.

Use a dedicated R2 bucket and keep its **Public Development URL** and **Custom
Domains** disabled. You will connect the image address during deployment.

### 3. Create a Turnstile widget

Follow [Cloudflare's widget setup](https://developers.cloudflare.com/turnstile/get-started/)
to create a **Managed** widget. Allow your application hostname, such as
`app.example.com`, and save the site key and secret key. Use production keys,
not local test keys.

### 4. Generate and review production configuration

Replace the example addresses and `YOUR_...` values with your own:

```sh
pnpm configure --application app.example.com --delivery images.example.com --database YOUR_D1_UUID --bucket YOUR_BUCKET_NAME --turnstile YOUR_TURNSTILE_SITE_KEY
```

This creates three local configuration files:

- `apps/web/production.local.jsonc`
- `workers/delivery/production.local.jsonc`
- `workers/maintenance/production.local.jsonc`

Review the addresses, database, and bucket in each file. If files already exist,
inspect and back them up before retrying. For custom settings or additional
instances, see the [configuration reference](../reference/configuration.md).

### 5. Build, migrate, and bootstrap

```sh
pnpm build
pnpm exec wrangler d1 migrations list DB --remote --config apps/web/production.local.jsonc
pnpm exec wrangler d1 migrations apply DB --remote --config apps/web/production.local.jsonc
pnpm bootstrap "Your administrator name" --remote --config apps/web/production.local.jsonc
```

Confirm that the migration prompt targets your new production database.
`pnpm db:migrate` is for local development; use the commands above for production.

**Save the administrator key in a password manager.** It is printed once and is
also your login credential. Run bootstrap only for a new installation; create
additional accounts in the dashboard.

### 6. Set the secret and deploy

```sh
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --config apps/web/production.local.jsonc
```

Enter the Turnstile secret key at the prompt. Accept the offer to create the
Worker if prompted.

Check and deploy in this order:

```sh
pnpm exec wrangler deploy --dry-run --config workers/delivery/production.local.jsonc
pnpm exec wrangler deploy --dry-run --config workers/maintenance/production.local.jsonc
pnpm exec wrangler deploy --dry-run --config apps/web/production.local.jsonc
pnpm exec wrangler deploy --config workers/delivery/production.local.jsonc
pnpm exec wrangler deploy --config workers/maintenance/production.local.jsonc
pnpm exec wrangler deploy --config apps/web/production.local.jsonc
```

Review any address conflicts before accepting changes. Allow time for Cloudflare
to connect your addresses and enable HTTPS.

### 7. Verify the instance

1. Open `https://app.example.com/login` and confirm login verification works.
2. Sign in with the administrator key.
3. Follow [first-run setup](first-run.md) to validate your image address and make
   it the default.
4. Follow [ShareX setup](sharex-setup.md), upload a screenshot, and open its image
   link.
5. Confirm a scheduled maintenance run using
   [maintenance and monitoring](../operations/maintenance.md).

For failures, see [troubleshooting](../operations/troubleshooting.md). Set up
[backups](../operations/backups-and-recovery.md) before relying on the installation.
