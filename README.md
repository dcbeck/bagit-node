# bagit-node

A TypeScript implementation of the [Library of Congress BagIt Python library](https://github.com/LibraryOfCongress/bagit-python), with ESM and CommonJS APIs. Uses Node's standard libraries for BagIt and [yazl](https://github.com/thejoshwolfe/yazl) for ZIP output: one direct runtime dependency, with its small `buffer-crc32` dependency. Requires Node.js 20.19 or newer. Python is needed only for the optional compatibility tests.

Creates and validates [RFC 8493 BagIt 1.0](https://www.rfc-editor.org/rfc/rfc8493.html) bags, reads older bags from version 0.93, and streams folders or application-provided sources into ZIP64 archives.

## Build and import

```sh
npm install
npm run build
```

```ts
// ESM / TypeScript
import { Bag, makeBag, folderToBagZip, createBagZipStream } from 'bagit-node';
```

```js
// CommonJS
const { Bag, makeBag, folderToBagZip, createBagZipStream } = require('bagit-node');
```

Both formats include TypeScript declarations. Development dependencies are TypeScript and type definitions. There is no CLI.

## Create a bag in place

```ts
const bag = await makeBag('/exports/my-folder', {
  bagInfo: {
    'Source-Organization': 'My archive',
    'Contact-Name': ['Alice', 'Bob'],
    'External-Identifier': 'collection-123',
  },
  checksums: ['sha256', 'sha512'], // defaults
  concurrency: 4,                 // default: 1 simultaneous file read
});

await bag.validate();
```

This moves the folder's existing contents into `data/`, preserves directory permissions, and writes `bagit.txt`, `bag-info.txt`, payload manifests, and tag manifests. An existing `data/` becomes `data/data/`, matching Python. Empty payloads receive empty manifests and remain valid. The function never changes the process working directory.

`Bagging-Date` defaults to the local calendar date. `Bag-Software-Agent` defaults to `bagit-node v1.1.0`. Both may be overridden. `Payload-Oxum` is always calculated from the payload. New bags use UTF-8.

## Open, inspect, validate, and save

```ts
const bag = new Bag('/exports/existing-bag');
// Opening reads declaration, metadata, and manifests synchronously.
// Hashing, validation, and saving are asynchronous.

console.log(bag.info, bag.algorithms, bag.versionInfo);
console.log([...bag.payloadFiles()]);
console.log(bag.payloadEntries()); // { 'data/file.txt': { sha256: '...', ... } }

await bag.validate();                         // structure, oxum, completeness, hashes
await bag.validate({ fast: true });           // structure and oxum; requires Payload-Oxum
await bag.validate({ completenessOnly: true }); // structure, oxum, filenames; no hashes
console.log(await bag.isValid());             // boolean for BagError failures

bag.info['Contact-Name'] = 'New contact';
await bag.save(); // preserves payload manifests, regenerates tag manifests

// After deliberately adding, removing or updating payload files:
await bag.save({ manifests: true }); // also regenerates payload manifests and oxum
```

`validate`, `isValid`, and `save` accept `concurrency` and `signal`. Cancellation and programming errors propagate; `isValid` catches only bag errors. An open `Bag` retains its loaded manifest entries, like Python; construct a new instance to reload external manifest changes.

| API | Result |
| --- | --- |
| `bag.manifestFiles()` / `bag.tagmanifestFiles()` | Iterators of absolute manifest paths |
| `bag.payloadFiles()` | Iterator of payload paths relative to the bag |
| `bag.payloadEntries()` / `bag.tagfileEntries()` | Filename → algorithm → checksum objects |
| `bag.compareManifestsWithFs()` | `[missingFiles, unexpectedFiles]` |
| `bag.missingOptionalTagfiles()` | Iterator of missing tag files listed in manifests |
| `bag.fetchEntries()` | Iterator of `[url, sizeString, filename]` tuples |
| `bag.filesToBeFetched()` | Iterator of paths listed in `fetch.txt` |
| `bag.compareFetchWithFs()` | Fetch paths not present in the payload |
| `bag.validateFetch()` | Checks fetch URLs and safe paths; does not download files |
| `bag.hasOxum()` | Whether metadata contains `Payload-Oxum` |

Python-style method aliases such as `payload_files`, `is_valid`, and `fetch_entries` are available. The exported `make_bag` alias takes the same **options object** as `makeBag`; Python positional argument conventions are not used in the Node API.

Validation errors are structured:

```ts
import { BagValidationError, ChecksumMismatch } from 'bagit-node';

try {
  await bag.validate();
} catch (error) {
  if (error instanceof BagValidationError) {
    for (const detail of error.details) {
      console.error(detail.path, detail.message);
      if (detail instanceof ChecksumMismatch) {
        console.error(detail.algorithm, detail.expected, detail.found);
      }
    }
  }
}
```

Exported error classes: `BagError`, `BagValidationError`, `ManifestErrorDetail`, `ChecksumMismatch`, `FileMissing`, `UnexpectedFile`, and `FileNormalizationConflict`.

Lower-level helpers include `makeManifests(bagRoot, options)`, `makeTagManifests(bagRoot, algorithms)`, `generateManifestLines(filename, algorithms)`, `loadTagFile`, `parseTagFile`, `serializeTagFile`, `encodeFilename`, `decodeFilename`, `normalizeUnicode`, `buildUnicodeNormalizedLookupDict`, and `getHashers`. `generateManifestLines` reads a file once and returns `[algorithm, digest, filename, byteCount]` tuples, with byte counts as `bigint`. Constants include `VERSION`, `DEFAULT_CHECKSUMS`, `CHECKSUM_ALGOS`, `HASH_BLOCK_SIZE`, and `STANDARD_BAG_INFO_HEADERS`.

## Stream a folder to a BagIt ZIP

```ts
const result = await folderToBagZip('/exports/source', '/exports/source.bag.zip', {
  bagName: 'my-bag', // optional containing directory; default: archive root
  bagInfo: { 'External-Identifier': 'collection-123' },
  checksums: ['sha256', 'sha512'],
  compressionLevel: 6, // 0–9
  onProgress({ path, totalFiles, totalBytes }) {
    console.log(path, totalFiles, totalBytes);
  },
});

console.log(result.payloadFiles, result.payloadBytes, result.bytesWritten);
```

The source directory remains intact. The output path must be outside it. File output is written to a temporary sibling and renamed after successful completion, preserving an existing destination if generation fails. A writable stream is also accepted and is ended by the method:

```ts
import { createWriteStream } from 'node:fs';

await folderToBagZip('/exports/source', createWriteStream('/exports/source.bag.zip'));
```

`folderToBagitZip` is an alias for `folderToBagZip`.

Each source file is opened once. Its bytes pass through incremental hashing, ZIP deflate compression, and the output stream with backpressure. Checksums cover the original bytes before compression. Custom tag files, when supplied, follow payload entries, then payload manifests, bag metadata, and tag manifests. ZIP64 supports files and offsets above 4 GiB and more than 65,535 entries.

Payloads, custom tag files, and the complete ZIP are never buffered or staged by the streaming APIs. Payload manifests are spooled to temporary files, removed on completion, cancellation, or failure. Memory holds stream buffers, ZIP central directory metadata, and filenames/checksums for duplicate checks and tag manifests; it grows with the number of entries, not their byte sizes. `tempDirectory` selects the spool location and must be outside a folder source. Directory exports preserve empty directories, ZIP timestamps, and Unix modes. `mtime` sets a fixed ZIP timestamp for reproducible exports. Yazl automatically uses ZIP64 when needed, so small archives remain compatible with ordinary ZIP readers.

Source changes detected while a file is read cause export to fail. Keep sources stable during export: this is not a filesystem snapshot. Symlinks resolving outside the source are rejected, and folder export rejects directory symlinks. Custom source iterables must honor cancellation during their own pending I/O.

## Pipe directly to Ceph / S3 multipart upload

`createBagZipStreamFromEntries` returns a standard Node `Readable`, suitable for your existing multipart uploader. Use `tagFiles` to keep an application's `metadata.json` at the bag root while streaming lazy payloads directly to S3 or Ceph. For example, if your application already uses the AWS SDK:

```ts
import { Readable } from 'node:stream';
import { createBagZipStreamFromEntries } from 'bagit-node';
import { Upload } from '@aws-sdk/lib-storage'; // application dependency, not a bagit-node dependency

const controller = new AbortController();
const metadata = { id: 'collection-123', description: 'Export metadata' };
const payloadEntries = [
  { path: 'images/original.tif', open: () => openOriginalImageStream() }, // application source
];
const body = createBagZipStreamFromEntries(payloadEntries, {
  signal: controller.signal,
  checksums: ['sha256', 'sha512'],
  bagInfo: { 'Contact-Name': 'Exporter' },
  tagFiles: [
    {
      path: 'metadata.json', // relative to the bag root
      open: () => Readable.from([Buffer.from(JSON.stringify(metadata), 'utf8')]),
    },
  ],
});

const upload = new Upload({
  client: s3Client, // configured by your application for S3 or Ceph
  params: {
    Bucket: 'archive',
    Key: 'collection-123.bag.zip',
    Body: body,
    ContentType: 'application/zip',
  },
  queueSize: 4,
  partSize: 8 * 1024 * 1024,
});

try {
  await upload.done();
} catch (error) {
  controller.abort(error);
  await upload.abort().catch(() => {});
  throw error;
}
```

This writes `data/images/original.tif`, root `metadata.json`, `bagit.txt`, `bag-info.txt`, payload manifests, and tag manifests. For a folder source, pass the same options to `createBagZipStream('/exports/source', options)`.

The uploader's queue adds its own multipart buffers. A content length is not known before streaming. The stream emits source, compression, and filesystem errors; use an error-aware consumer such as `pipeline` or your multipart uploader. A consumed stream cannot be replayed. To retry or generate a temporary ZIP fallback, call the export API again with fresh payload and tag-file iterables, and have every `open()` return a fresh stream or iterable. Recreate async generators for each attempt and keep sources stable across retries.

## Build a ZIP directly from application sources

`createBagZipStreamFromEntries` accepts an iterable or async iterable of lazy sources. This lets exporters produce bytes without writing ordinary payload files to a staging folder.

```ts
import { Readable } from 'node:stream';
import { createBagZipStreamFromEntries } from 'bagit-node';

async function* entries() {
  yield {
    path: 'record.json', // relative to data/; do not include the data/ prefix
    open: () => Readable.from([Buffer.from(JSON.stringify({ id: 123 }))]),
  };
  yield {
    path: 'images/original.tif',
    open: async () => openOriginalImageStream(), // supplied by your application
  };
}

const body = createBagZipStreamFromEntries(entries(), {
  bagInfo: { 'External-Identifier': 'collection-123' },
});
// Pass body to your multipart uploader or pipeline(body, destination).
```

`open()` is called lazily, once per entry, and returns a `Readable`, iterable, or async iterable of `Uint8Array`/`Buffer` chunks, or a promise for one. Payloads and custom tag files are read sequentially, one source at a time, with backpressure. Source lengths need not be known. Entries may set `mtime`, `mode`, and `directory: true` (with `open: () => []`) for empty directories. Progress callbacks are awaited after each completed payload; tag files do not trigger them.

`BagZipOptions.tagFiles?: Iterable<BagZipEntry> | AsyncIterable<BagZipEntry>` is supported by `createBagZipStreamFromEntries`, `createBagZipStream`, `folderToBagZip`, and its `folderToBagitZip` alias. Tag paths are relative to the bag root, support nested names such as `metadata/description.json`, and receive the optional `bagName` prefix in the ZIP. Every configured tagmanifest records their original-byte checksums. They are excluded from payload manifests, payload byte/file totals, and `Payload-Oxum`. Root `metadata.json` can coexist with payload `data/metadata.json`. Omitting `tagFiles` preserves the existing layout and behavior.

Archive paths must be relative POSIX paths. Absolute paths, traversal, backslashes, duplicate paths, Unicode normalization collisions, and file/directory conflicts are rejected. CR/LF filenames are encoded in manifests. Literal `%0A`/`%0D` in names and trailing whitespace that cannot round-trip through Python's manifest parser are rejected by ZIP export.

Custom tag paths follow the same rules and cannot occupy `data/`, `bagit.txt`, `bag-info.txt`, or root `manifest-*.txt` / `tagmanifest-*.txt` paths, including their descendants. Leading whitespace or `*` in a tag path is also rejected because manifest parsers strip it. Tag manifests never list themselves or other tag manifests. Cancellation or failure destroys active readable sources and removes temporary manifests. Application iterables must honor cancellation during their own pending I/O.

## Compatibility and verification

The reference is pinned at [`4bd2713`](https://github.com/LibraryOfCongress/bagit-python/tree/4bd2713cedbe1f8e634567c20ef0dded9622011d). Test-only upstream files and fixtures are included under `test/vendor/` and excluded from npm packages.

```sh
npm test               # Node API, ESM/CommonJS, validation and streaming failure tests
npm run test:upstream  # 96 unchanged upstream library cases through a Python → Node transport
npm run test:interop   # independent Python validation and byte comparisons; stdlib ZIP extraction
npm run test:stress    # actual >4 GiB file and >65,535 archive entries
npm run test:all       # all of the above
```

Compatibility/stress tests require Python 3; no Python packages need installing. Permission tests should run as a regular user, as in the upstream suite. The Python adapter only translates calls, options, and errors; creation, parsing, hashing, and validation execute in Node. Upstream CLI tests are omitted because this package deliberately has no CLI. Three Python multiprocessing implementation tests are inapplicable; Node uses bounded asynchronous file I/O and has separate cancellation/failure tests.

Supported checksum names are `md5`, `sha1`, `sha224`, `sha256`, `sha384`, `sha512`, `sha3_224`, `sha3_256`, `sha3_384`, `sha3_512`, `blake2b`, and `blake2s`, subject to the Node OpenSSL build. Unsupported requested names are skipped if another supported algorithm remains. SHAKE algorithms require a digest length and are not supported by upstream's fixed-length BagIt manifest generation either.

The implementation preserves Python's metadata formatting, manifest syntax, default SHA-256/SHA-512 algorithms, repeated tags, folded tags, mixed-case checksum acceptance, optional tags, fetch validation, Unicode-normalized filename lookup, validation modes, and error details. It intentionally identifies itself in `Bag-Software-Agent`, creates valid empty manifests for empty bags, rejects additional unsafe or ambiguous archive paths, and does not reproduce Python's process-management internals or CLI. Tag-manifest entry ordering is deterministic here; Python's ordering depends on filesystem enumeration. Supply identical metadata when comparing generated bag bytes.

Reading existing tag encodings uses Node's built-in `TextDecoder`, with strict UTF-8, ASCII and ISO-8859-1 handling. Saving supports UTF-8, UTF-16 and representable single-byte encodings. Python-specific codecs and legacy multibyte encoding output are not provided; new bags always use UTF-8.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The reference Python project declares its code public domain.
