# Manage users and credentials

Hearth has no public signup. Administrators create accounts and supply the new key
privately to the intended owner. An API key is also that account's login credential.

## Create an account

1. Open **Administration → Users** and choose **Invite someone**.
2. Enter a display name and choose **Member** or **Administrator**.
3. Complete the verification and choose **Create invitation**.
4. Save the key shown once and deliver it privately, along with your application
   URL and [ShareX setup guide](../getting-started/sharex-setup.md).
5. Open the user profile to set quota and expiry policy if needed. Have the user
   sign in and verify a small upload.

An invitation creates an account immediately; it is not an emailed registration
link. New accounts enter onboarding. The account editor changes name, status, and
quota; it does not offer role editing after creation. Create accounts with the
intended role.

Members manage their own images, links, preferences, and key. Administrators can
manage the workspace, other accounts and images, domains, storage, policies, and
audit log. Keep at least two active administrators with separately saved keys.
The database prevents disabling or deleting the last active administrator.

## Edit account settings

Search or filter Users, then open a profile. It shows status, role, image count,
storage, quota, last API use, recent images, and retained activity. Open its account
configuration to change display name, status, or quota and save.

The quota input uses MiB; blank means unlimited and zero admits no new image bytes.
Usage includes active originals and previews. Reducing quota preserves existing
images but can block future uploads. Saving account configuration revokes that
account's sessions even if you only changed its name or quota; it must sign in again.
See [storage management](storage-management.md) for global capacity.

Under **Administration → Settings**, enable **Restrict display name changes** to
lock member names in Settings and onboarding. It is disabled by default. Under a
user's **Account configuration → Display name changes**, choose **Inherit instance
policy**, **Allow display name changes**, or **Restrict display name changes**.
An explicit allow or restrict overrides the instance setting. Administrators are
always exempt and can rename accounts through the account editor.

Use **Save display name policy** to save an override without revoking sessions.
Policy changes take effect on the next request without signing out, and the
controls reflect them when the page refreshes. Changes are recorded in the audit
log with the responsible administrator and old/new policy values. Restricted
members can still finish onboarding and update other preferences.

In **Expiry policy**, inherit instance defaults or set individual overrides.
Each field can inherit independently. An unlimited maximum removes the inherited
maximum; making expiry optional alone does not override a finite maximum.
Administrators are exempt from expiry policy. Changes affect future uploads,
new links, and expiry edits, not existing resources or saved defaults.

## Reset or rotate a key

Users rotate their own key under **Settings → API key**. Administrators can reset
an **active** account's key from its profile/action menu after verification.
Re-enable a disabled account before resetting it.

Save the newly displayed key before closing. The old key stops working and all
sessions are revoked. The owner must sign in with the replacement and regenerate
every ShareX configuration. Key changes do not delete images or change their links.
Verify that the replacement signs in and uploads, and that the old key is rejected.

The server stores only key digests and cannot display a lost key. There is no email
recovery or special recovery credential. If every administrator loses access,
bootstrap is not a reset command; recovery requires a previously retained key or
carefully reviewed database recovery by the operator. See
[backups and recovery](../operations/backups-and-recovery.md).

## Suspend or delete an account

**Disable** to suspend sign-in, uploads, and public delivery without deleting its
images. Re-enable to restore the unchanged API key and eligible public links;
old browser sessions stay revoked.

**Delete** is permanent: access and public links are revoked, images are tombstoned,
and physical cleanup follows. It cannot be reversed by selecting Active. Deleted
profiles retain identity/activity for administration and are read-only. Inspect
the confirmation and take backups if you might need the data.

## Review activity

**Administration → Audit Log** supports actor, action, date, and text filtering.
User profiles link to their scoped image and activity views. Request events may
include validated client IPs, so treat audit data as private administrative data.

Only the latest 10,000 events are retained. A successful delete event means logical
deletion happened; R2 purge can still be pending. Background metrics, previews,
and cleanup retries are not comprehensive audit events. Direct Cloudflare/SQL
changes are not automatically captured as application mutations.

For access problems, follow [authentication troubleshooting](../operations/troubleshooting.md#sign-in-or-key-verification-fails).
