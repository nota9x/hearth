# Metadata fixtures

These are real 48×32 images with red, green, blue, and partially transparent yellow quadrants, encoded with Pillow 12.3. They contain synthetic private information only.

JPEG fixtures cover EXIF orientations 1–8. EXIF includes GPS coordinates, camera make/model, capture dates, author/copyright, camera serial and lens information. PNG includes plain/compressed comments and XMP; WebP and AVIF include XMP. GIF includes comments and two frames with 100/200 ms delays, disposal 2 and loop count 3. Animated PNG/WebP use the same timing and looping. JPEG/PNG/WebP/AVIF contain an sRGB ICC profile; AVIF also contains an alpha auxiliary image and native CICP color information.

`clean.png` is a valid 1×1 white RGBA PNG. Sanitizer tests construct additional malformed, big-endian EXIF, progressive-marker, and oversized text cases in memory. Fixtures and tests need no additional runtime dependencies.

AVIF orientation fixtures 2–8 contain native rotation/mirroring properties written from the corresponding EXIF orientations, with synthetic private EXIF and ICC retained in their inputs.

PNG and WebP orientation-7 fixtures exercise mirrored/rotated EXIF rendering through independent browser pixel comparisons.
