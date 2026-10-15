# Complete first-run setup

After [installation](installation.md), sign in at your configured application
hostname with the API key printed by bootstrap. New accounts enter onboarding.

## Connect delivery

The bootstrap administrator's walkthrough includes initial delivery setup.
Other accounts choose from domains an administrator has already configured.

1. Add the exact deployed delivery hostname, such as `images.example.com`.
2. Complete its Cloudflare connection if needed, then choose **Validate domain**.
3. Wait for a successful check and explicitly set it as the instance default.

Adding a domain in Hearth does not provision it in Cloudflare. The check confirms
DNS, HTTPS, this instance, and storage connectivity. Follow
[custom domains](../guides/custom-domains.md) if it fails.

Users following the instance default use it for new links, or can save an allowed
personal selection. Hearth never silently selects another domain when a selection
becomes unusable. Without one, uploads save privately; ShareX reports an
already-saved image without a public link.

## Choose account preferences

Save a display name, delivery selection, and default image lifetime. Every step
is optional. These remain available in **Settings → Personal preferences** and
**Domains** afterward.

Expiry must comply with your account policy. Administrators can set instance and
user policies afterward. A policy change does not rewrite a saved default; save a
new valid default if uploads later reject it.

New accounts strip metadata by default. Onboarding does not change this;
**Strip image metadata** is available in Settings. See
[images and links](../guides/images-and-links.md) for details.

## Connect ShareX and verify an upload

Onboarding uses the same configuration generator as Settings. It may prefill your
key from the login page's short-lived browser memory. Refreshing, another tab, or
revisiting requires entering the key again. The database cannot recover it.

Follow [ShareX setup](sharex-setup.md), then keep the **First image** step open while
uploading a screenshot. Hearth recognizes a new completed bearer upload for your
account while the step is armed. A browser upload alone does not establish this
milestone.

Recognition confirms receipt, including an image saved without a link. Open the
public URL separately to verify delivery. If watching stops, use the page's check
controls or inspect Images; a missing preview does not mean the upload failed.

## Skip or return later

Skip individual steps or choose **Skip onboarding**. Saved preferences remain;
unsaved drafts are not applied. Pending walkthroughs resume saved progress after
login or refresh. Finishing or skipping stops the first-login redirect.

Open **Settings → Revisit onboarding** to return. This optional visit can save
preferences but does not reset lifecycle status. The summary reports saved
configuration and upload progress; downloading does not prove ShareX imported it.

## Before inviting members

- Confirm a public image opens on the expected delivery hostname.
- Set appropriate [quotas](../guides/storage-management.md) and expiry policy.
- Create a second administrator and save both keys securely for account recovery.
- Use [user management](../guides/user-management.md) to create accounts and deliver
  credentials privately to their intended owners.
