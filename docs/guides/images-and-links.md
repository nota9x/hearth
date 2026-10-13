# Manage images and share links

An image owns its stored bytes. A share link is an address pointing to that image.
Images can have no links, one link, or several. Removing a link keeps the image;
deleting an image removes access through all of its links.

## Upload and find images

Use **Upload image**, drag images onto the dashboard, or use
[ShareX](../getting-started/sharex-setup.md). Supported formats are PNG, JPEG, GIF,
WebP, and supported still AVIF. SVG, HTML, and arbitrary files are rejected. The
default input limit is 25 MiB; operators can change it in
[deployment configuration](../reference/configuration.md).

Dashboard uploads use your saved expiry without prompting. Progress distinguishes
uploading from server processing; sending all bytes is not final confirmation.
Read the completed result or failure before retrying. Cancellation stops queued
or active work when possible but cannot undo an upload that already committed;
check Images before assuming it was removed.

Use Images search, filters, sorting, and pagination to find resources. Selection
can span pages; changing search/filter/sort clears it. Bulk copying, expiry changes,
downloads, and deletion operate on the selected items. Review per-item failures;
stopping a batched operation does not undo completed items.

Private images remain visible and downloadable to their owner and administrators.
If an upload has no usable delivery domain, it remains private with a warning.

## Create and manage links

Open an image and choose its share-link creation action. Choose an allowed delivery
domain and optionally a custom slug. Without a custom slug, Hearth generates a
case-sensitive Base62 ID. The default is five characters; administrators can
choose 3–64 under **Administration → Settings → Share-link IDs**. Automatic
length increases address allocation collisions, not viewer privacy.

The first link becomes the image's primary link, displayed on its card. You can
choose another primary. Removing primary promotes the oldest remaining link; an
expired or unavailable link can still hold that designation, so inspect availability.

Use **Links** or an image's link list to copy addresses, change expiry, or remove
links. Search supports filenames, slugs, delivery URLs, and domains. Removed
addresses remain reserved while their domain exists. A new link does not duplicate
image bytes or increase image storage usage.

Anyone with an active public URL can view it. Domain sharing restrictions determine
who can create links, not who may read them. See [security](security.md).

## Set image and link expiry

Image expiry and link expiry are independent. Public delivery stops at the earlier
deadline. An expired link does not delete its image; image expiry makes the image
unavailable and scheduled maintenance deletes its bytes.

Save a default under **Settings → Personal preferences**. Presets include 1 hour,
6 hours, 1 day, 7 days, 30 days, 90 days, and 1 year (365 days); supported custom
durations use positive whole units. API clients can supply an explicit expiry.

Administrators configure an optional required expiry and maximum lifetime under
**Administration → Settings → Expiry policy**, with per-user overrides. A finite
maximum also forbids permanent images/links. Image lifetime is measured from
upload; link lifetime from link creation. Editing expiry does not restart those
maximum-lifetime clocks. Administrators are exempt.

Policy changes preserve existing images, links, and defaults. If a saved default
becomes invalid, save a compliant one before uploading. Hearth does not clamp it.
A link cannot extend the life of an expired image.

## Understand metadata privacy

**Settings → Personal preferences → Strip image metadata** applies to future web,
API, and ShareX uploads. It defaults to enabled. Changing it does not rewrite old
images or restore discarded metadata.

Hearth removes unnecessary EXIF, GPS, capture/device details, comments, and other
embedded descriptors while retaining required orientation, color, transparency,
and animation information. Pixels are not recompressed. ICC color profiles remain
intact and may contain descriptive information; this is not a guarantee of zero
metadata or a malware scan.

The sanitized file is the stored original used by downloads and delivery. Animated
AVIF and some complex AVIF layouts cannot be sanitized. Rejection never silently
stores the unsanitized original. Try exporting a supported PNG/JPEG/still AVIF;
only disable stripping if you intentionally accept the file's embedded metadata.
See [metadata failures](../operations/troubleshooting.md#uploads-fail).

## Delete an image

Review the image or selected batch, then confirm deletion. Public links stop working
when D1 records are tombstoned. R2 cleanup may take longer or retry after an outage.
Deletion is permanent and cannot be undone from the dashboard.

Removing a link does not reclaim bytes. Logical account usage and physical global
capacity can decrease at different times; see [storage management](storage-management.md).
Copies already downloaded by viewers cannot be recalled.
