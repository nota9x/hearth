# Connect ShareX

Use Hearth's generated uploader rather than building a profile manually. These
instructions are verified against ShareX 21.0.0, matching Hearth's generated
configuration and captured native multipart test fixture.
The [versioned ShareX source](https://github.com/ShareX/ShareX/tree/v21.0.0)
defines the import prompts, destination selection, and task overrides described here.

## 1. Download your uploader

1. Sign in to Hearth.
2. Confirm **Domains** shows a usable instance default or allowed personal selection.
   Ask an administrator to [connect delivery](../guides/custom-domains.md) if needed.
3. Open **Settings → API key → Download ShareX configuration**, or onboarding's
   ShareX step.
4. Enter your current API key and download the `.sxcu` file.

The file already contains your key in its `Authorization` header. Treat it as a
login credential: keep it private, exclude it from Git, and redact it from support
reports. Downloading does not issue or rotate a key. It is available without a
working delivery domain, but public uploads need one.

## 2. Import and select Hearth

Install ShareX from [getsharex.com](https://getsharex.com/), then double-click your
`.sxcu`. Choose **Yes** when asked to make Hearth the active custom uploader for
images and files. See [ShareX's import documentation](https://getsharex.com/docs/custom-uploader).

If you import manually or declined the prompt:

1. Open **Destinations → Custom uploader settings**.
2. Choose **Import → From file** and select the `.sxcu`.
3. Select **Hearth** in both **Image uploader** and **File uploader** selectors.
4. In **Destinations**, choose **Image uploader → Custom image uploader** and
   **File uploader → Custom file uploader**.

ShareX 21 routes WebP and AVIF file uploads as files, so selecting only the image
destination can send them elsewhere. Hearth still accepts only supported images;
the file destination does not enable arbitrary uploads.

## 3. Enable automatic screenshots

Enable **After capture tasks → Upload image to host**. For clipboard copying, also
enable **After upload tasks → Copy URL to clipboard**. Importing the uploader does
not guarantee the clipboard task is enabled.

If one shortcut behaves differently, open **Hotkey settings**. Its task settings
can override global capture/upload tasks, destinations, or the custom uploader.
Remove an unintended override or configure it to use Hearth.

## 4. Verify the first screenshot

1. Use **Capture → Region** or your capture hotkey. Alternatively use
   **Upload → Upload file** with a supported image.
2. Confirm ShareX reports success. With URL copying enabled, paste the clipboard
   into your browser's address bar.
3. Confirm the URL uses your selected delivery hostname and displays the image.
4. Confirm it appears in Hearth's **Images**. If onboarding is watching, it should
   recognize the completed upload.

Image URLs use the delivery domain. Upload and deletion URLs use the application
domain. Changing your delivery selection affects new links without regenerating
the uploader.

## Credentials and deletion links

Your account has one current key for login and bearer uploads. It does not expire
automatically. Rotation revokes the old key and every session. Save the new key,
sign in again, download a replacement, and replace every old profile. A lost key
requires another administrator's reset; see [user management](../guides/user-management.md).

In ShareX **History**, right-click an item and choose **Open → Deletion URL**.
Confirm the image in Hearth, complete Turnstile, and choose **Delete image**.
This removes the image and all its links. ShareX's **Delete item** removes only the
local history entry.

Deletion URLs are image-specific capabilities. Keep them and history private.
Opening the URL alone does not delete; browser confirmation is required.

## Upload settings and responses

The generator supplies these fields; normally do not edit them:

| Field                          | Generated behavior                                   |
| ------------------------------ | ---------------------------------------------------- |
| `Version`                      | `21.0.0`                                             |
| `DestinationType`              | `ImageUploader, FileUploader`                        |
| `RequestMethod` / `RequestURL` | `POST` to your application origin's `/api/v1/images` |
| `Headers.Authorization`        | `Bearer` followed by your account key                |
| `Body` / `FileFormName`        | `MultipartFormData` / `file`                         |
| `URL`                          | `{json:url}`                                         |
| `DeletionURL`                  | `{json:deleteUrl}`                                   |
| `ErrorMessage`                 | `{json:error.message}`                               |

Success is HTTP 201 with `id`, `url`, `deleteUrl`, `size`, `expiresAt`, and
`sharingWarning`. Errors expose `error.code` and `error.message`. Uploads use bearer
authentication, not browser cookies or Turnstile.

Saved expiry and metadata preferences apply. For a separate fixed-expiry profile,
duplicate the uploader and add `expiry` = `1h` in multipart **Arguments**. Presets
are `never`, `1h`, `6h`, `24h`, `7d`, `30d`, `90d`, and `1y`; positive seconds tokens
such as `1800s` also work. An absolute date uses `expiry` = `custom` and `expiresAt`
with an ISO timestamp including its timezone. The account policy still applies;
URL query parameters do not set expiry. Public thumbnails are omitted because
dashboard previews require authentication.

## Troubleshooting ShareX

| Symptom                               | Check and resolution                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Captures remain local                 | Enable **Upload image to host** and check hotkey overrides.                                                          |
| Images or WebP/AVIF go elsewhere      | Select Hearth for both uploader types and both destinations.                                                         |
| Clipboard has no URL                  | Enable **Copy URL to clipboard** and check after-upload overrides.                                                   |
| HTTP 401 / invalid key                | Confirm an active account; replace profiles after a reset or rotation.                                               |
| `IMAGE_SAVED_WITHOUT_LINK` / HTTP 409 | The image exists. Fix domain selection and create its link in Hearth; do not blindly upload again.                   |
| Wrong delivery hostname               | Check personal selection and instance default; existing links keep their hostname.                                   |
| HTTP 400 or 422                       | Read the image, expiry, or metadata message; see [upload diagnosis](../operations/troubleshooting.md#uploads-fail).  |
| HTTP 413                              | Check file size, account quota, and global capacity. Deleting a link frees no bytes.                                 |
| HTTP 429                              | Wait for the reported retry interval.                                                                                |
| HTML response or network error        | Check the generated endpoint, TLS, proxy/challenge rules, and [logs](../operations/maintenance.md#read-worker-logs). |

Use the custom uploader settings' test controls with a small image and inspect the
status/message. ShareX HTTP exception text is a client diagnostic, not a server
stack trace. Redact credentials before sharing it.

The generated profile sends no idempotency key. After a lost response, check Images
before retrying: a retry can duplicate the upload. Custom clients can use the
[safe retry contract](../development/architecture.md#uploads).
