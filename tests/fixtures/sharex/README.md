# ShareX 21 request fixture

`sharex21-multipart.bin` is the unmodified 262-byte body captured from the locally installed ShareX 21.0.0 using Upload → Upload file. It contains a clean 1×1 PNG named `PNG spaces café 🎉.PNG`. The boundary is `--------------------8df2247211d47b0`; the part is named `file`, has UTF-8 filename bytes and `Content-Type: image/png`.

The native request used POST, `User-Agent: ShareX/21.0.0`, multipart/form-data and a Bearer Authorization header, with no Origin or cookies. No credentials or deletion capabilities are included in this fixture. [The ShareX integration suite](../../integration/sharex.test.ts) replays it exactly and uses its observed multipart layout for negative and format cases.
