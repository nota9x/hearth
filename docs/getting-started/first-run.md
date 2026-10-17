# Set up Hearth after installation

Follow these steps to sign in, choose where image links appear, and upload your
first screenshot with ShareX. Have your **Hearth application address** and
**administrator key** from installation ready.

The examples below use `app.example.com` for Hearth and `images.example.com` for
shared images. Replace them with the addresses you chose during installation.

## 1. Sign in

1. Open your Hearth application address, such as `https://app.example.com`.
2. Enter the administrator key you saved during installation and complete the
   login verification.
3. On the welcome screen, choose **Get started**.

Your key is your login credential. Keep it in a password manager. If someone
created your account for you, use the key they gave you.

If the dashboard opens instead of the setup walkthrough, open **Settings →
Revisit onboarding**.

## 2. Check your image address

The **Set up delivery** screen is for the initial administrator. Other members
can go straight to choosing their personal settings in step 3.

**If you used guided installation (`pnpm run setup`):**

1. Check that the listed address matches the image address you chose during
   installation, such as `images.example.com`. Do not add it again.
2. Look for **Your delivery domain is ready for new share links**.
3. Choose **Continue setup**.

If the address is missing or is not ready, follow the manual steps below.

**If you installed manually or need to finish connecting the address:**

1. Select your image address under **Configured domains** if it is already
   listed. Otherwise, enter it in **Delivery hostname** and choose **Add delivery
   domain**. Enter only `images.example.com`, without `https://` or a path.
2. Follow any connection instructions shown. If you need help, use the
   [domain connection guide](../guides/custom-domains.md#connect-a-delivery-hostname).
3. Choose **Validate domain**. If the check fails, resolve the displayed issue
   and try again. A newly connected address may need time to become ready.
4. After validation succeeds, choose **Set as instance default**. This makes it
   the default address for new image links.
5. Choose **Continue setup**.

You can manage this later under **Administration → Domains**.

## 3. Choose your personal settings

Work through these three screens in order:

1. **Your display name:** enter the name you want shown in Hearth, then choose
   **Save & continue**.
2. **Your share links:** choose **Use instance default** to use the image address
   configured above. If you want another available address, select it instead.
   Check the example link, then choose **Save & continue**.
3. **Image lifetime:** choose how long new images should stay available, then
   choose **Save & continue**. Use one of the options offered for your account.
   Changing this setting does not change images you have already uploaded.

If no image address is available, an administrator needs to connect one before
uploads can produce public links. You can continue setting up your account, but
images will save privately until an address is ready.

To change these choices later, use **Settings → Personal preferences** for your
name and image lifetime, or **Domains** for your image address.

## 4. Connect ShareX

On the **Connect ShareX** screen:

1. Install [ShareX](https://getsharex.com/) on your computer if needed.
2. Enter your current Hearth key if the configuration form asks for it. Use the
   same key you used to sign in.
3. Download the ShareX configuration file (`.sxcu`).
4. Double-click the downloaded file. Choose **Yes** when ShareX asks to make
   Hearth the active custom uploader for images and files.
5. In ShareX, open **After capture tasks** and enable **Upload image to host**.
6. Open **After upload tasks** and enable **Copy URL to clipboard** so image
   links are copied automatically.
7. Return to Hearth and choose **Check an image**.

Keep the downloaded file private: it contains your login key. If importing does
not work, follow the [manual ShareX import steps](sharex-setup.md#2-import-and-select-hearth).

## 5. Upload your first screenshot

1. Leave Hearth's **Try your first image** screen open.
2. In ShareX, choose **Capture → Region** and take a small screenshot.
3. Wait for ShareX to finish uploading. Hearth should recognize the upload.
4. Paste the copied image link into a new browser tab. Check that it uses your
   image address and displays the screenshot.
5. Return to Hearth, choose **Continue**, review your saved settings, and choose
   **Go to dashboard**.
6. Open **Images** and confirm the screenshot is listed.

Use ShareX for this check; uploading through Hearth's browser interface does not
complete the ShareX check.

## If something does not work

| Problem                                             | What to do                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The image address fails validation                  | Read the displayed issue, check the [domain connection steps](../guides/custom-domains.md#connect-a-delivery-hostname), then choose **Validate domain** again.          |
| ShareX captures a screenshot but does not upload it | Enable **After capture tasks → Upload image to host**. Check that Hearth is the selected uploader using the [ShareX guide](sharex-setup.md#2-import-and-select-hearth). |
| ShareX says the key is invalid                      | Download and import a new configuration using your current Hearth key.                                                                                                  |
| ShareX has no link to copy                          | Enable **After upload tasks → Copy URL to clipboard**. Check ShareX's history for any upload error.                                                                     |
| The image saved without a public link               | Check your selection in **Domains**. Once an address is ready, open the saved image in Hearth and create a link. You do not need to upload it again.                    |
| Hearth does not recognize the upload                | Choose **Check again** if shown, then upload a new screenshot through ShareX. Check **Images** before retrying an upload that may already have succeeded.               |
| The image link does not open                        | Confirm your selected image address is ready. See [troubleshooting](../operations/troubleshooting.md) if it still fails.                                                |

## Finish later

Choose **Skip** to leave an individual step, or **Skip onboarding** to go to the
dashboard. Changes you already saved are kept; unsaved edits are not applied.

To return, open **Settings → Revisit onboarding**. You can also download the
uploader later from **Settings → API key → Download ShareX configuration**.

## Before adding other people

Once your first image link works:

1. Set the storage quotas and image expiry rules you want members to use. See
   [storage management](../guides/storage-management.md).
2. Create a second administrator for account recovery and save its key securely.
3. Follow [user management](../guides/user-management.md) to create member
   accounts. Give each person their own key privately.
