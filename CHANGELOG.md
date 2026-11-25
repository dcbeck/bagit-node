# Changelog

## 1.1.0

- Add `BagZipOptions.tagFiles` for lazy root and nested tag files across all streaming ZIP APIs. Accepts synchronous or asynchronous iterables of `BagZipEntry`.
- Stream and hash tag bytes with backpressure, include checksums in every configured tagmanifest, and preserve payload counts and progress semantics.
- Reject unsafe paths, duplicates, Unicode normalization conflicts, generated-file conflicts, and file/directory collisions.
- Destroy active readable sources on cancellation, including sources waiting for bytes; preserve manifest cleanup and atomic file output.
- Document direct S3/Ceph streaming with root `metadata.json` and fresh sources for retries. Preserve ESM, CommonJS, and TypeScript support.
