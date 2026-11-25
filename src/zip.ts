import { Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readdir, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ZipFile } from 'yazl';
import { BagError, FileNormalizationConflict } from './errors.js';
import type { BagInfo, BagInfoInput, Checksums } from './types.js';
import {
  algorithmsFor, assertSafePath, BAG_DECLARATION, digestBytes, encodeFilename, getHashers,
  compareNames, HASH_BLOCK_SIZE, isDirectory, makeBagInfo, normalizeUnicode, serializeTagFile,
} from './util.js';

export interface BagZipOptions {
  bagInfo?: BagInfoInput;
  checksums?: readonly string[];
  /** An optional directory containing the entire bag inside the archive. Default: archive root. */
  bagName?: string;
  /** Lazy custom tag files, with paths relative to the bag root. Use fresh iterables and sources for retries. */
  tagFiles?: Iterable<BagZipEntry> | AsyncIterable<BagZipEntry>;
  /** Deflate level 0–9; default 6. */
  compressionLevel?: number;
  /** Temporary directory for payload manifests; payloads and custom tag files are never staged. */
  tempDirectory?: string;
  signal?: AbortSignal;
  /** Fixed ZIP modification time for reproducible archives. */
  mtime?: Date;
  /** Called after a payload file has been completely read into the ZIP compressor. */
  onProgress?: (progress: BagZipProgress) => void | Promise<void>;
}
export interface BagZipProgress {
  path: string;
  bytes: bigint;
  hashes: Checksums;
  totalBytes: bigint;
  totalFiles: number;
}
export interface BagZipResult { bytesWritten: bigint; payloadBytes: bigint; payloadFiles: number; bagInfo: BagInfo; }

/** Sources are opened lazily, one at a time. Payload paths are relative to data/; tagFiles paths are relative to the bag root. */
export interface BagZipEntry {
  path: string;
  /** Preserve an empty directory. Its open() function is ignored. */
  directory?: boolean;
  open: () => Readable | AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Promise<Readable | AsyncIterable<Uint8Array> | Iterable<Uint8Array>>;
  mtime?: Date;
  mode?: number;
}

function validateOptions(options: BagZipOptions): string[] {
  const level = options.compressionLevel ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > 9) throw new RangeError('compressionLevel must be an integer from 0 to 9');
  if (options.bagName !== undefined) validateEntryPath(options.bagName);
  if (options.mtime && !Number.isFinite(options.mtime.getTime())) throw new BagError('Invalid ZIP modification time');
  return algorithmsFor(options.checksums);
}
function validateEntryPath(path: string): void {
  if (!path || path.includes('\\') || /[\0\r\n]/.test(path) || path.startsWith('~') || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new BagError(`Unsafe ZIP entry path: ${JSON.stringify(path)}`);
  }
}
// CR/LF are legal BagIt payload names: manifests encode them, ZIP headers store their original bytes.
function validatePayloadPath(path: string): void {
  validateEntryPath(path.replace(/[\r\n]/g, '_'));
  if (/%0[ad]/i.test(path)) throw new BagError(`Ambiguous BagIt filename contains a literal encoded newline: ${path}`);
  if (/\s$/.test(encodeFilename(path))) throw new BagError(`BagIt cannot represent trailing whitespace unambiguously: ${JSON.stringify(path)}`);
}

function entryRegistry(kind: string, reservedFiles: readonly string[] = []): (entry: BagZipEntry) => void {
  const seen = new Map<string, string>();
  const directories = new Set<string>();
  const files = new Set(reservedFiles);
  return entry => {
    validatePayloadPath(entry.path);
    const normalized = normalizeUnicode(entry.path);
    const previous = seen.get(normalized);
    if (previous !== undefined) throw new FileNormalizationConflict(entry.path, previous);
    if (files.has(normalized) || (!entry.directory && directories.has(normalized))) throw new BagError(`Conflicting ${kind} file and directory: ${entry.path}`);
    const parts = normalized.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (files.has(parent)) throw new BagError(`Conflicting ${kind} paths: ${parent} and ${entry.path}`);
      directories.add(parent);
    }
    seen.set(normalized, entry.path);
    if (entry.directory) directories.add(normalized);
    else files.add(normalized);
  };
}

async function* folderEntries(directory: string, options: BagZipOptions): AsyncGenerator<BagZipEntry> {
  const root = resolve(directory);
  if (!isDirectory(root)) throw new BagError(`Bag directory ${root} does not exist`);
  const temporaryRoot = await realpath(options.tempDirectory ?? tmpdir());
  const relTemp = relative(await realpath(root), temporaryRoot);
  if (!relTemp || (!isAbsolute(relTemp) && relTemp !== '..' && !relTemp.startsWith(`..${sep}`))) throw new BagError('Manifest temporary directory must be outside the source directory');
  async function* walk(path = ''): AsyncGenerator<BagZipEntry> {
    const entries = (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => compareNames(a.name, b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const filename = path + entry.name;
      assertSafePath(root, filename, 'source directory');
      if (entry.isSymbolicLink() && isDirectory(join(root, filename))) throw new BagError(`Directory symlinks cannot be exported: ${filename}`);
      yield await fileEntry(filename);
    }
    for (const entry of entries) if (entry.isDirectory()) {
      const filename = path + entry.name;
      const metadata = await stat(join(root, filename));
      yield { path: filename, directory: true, mtime: metadata.mtime, mode: metadata.mode, open: () => [] };
      yield* walk(filename + '/');
    }
  }
  async function fileEntry(path: string): Promise<BagZipEntry> {
    options.signal?.throwIfAborted();
    assertSafePath(root, path, 'source directory');
    const fullPath = join(root, path);
    const before = await stat(fullPath, { bigint: true });
    if (!before.isFile()) throw new BagError(`Payload is not a regular file: ${path}`);
    return {
      path, mtime: new Date(Number(before.mtimeMs)), mode: Number(before.mode),
      async *open() {
        // Check the opened file, rather than just the preceding path stat.
        assertSafePath(root, path, 'source directory');
        const handle = await open(fullPath, 'r');
        try {
          const opened = await handle.stat({ bigint: true });
          if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) throw new BagError(`Source file changed before reading: ${path}`);
          const stream = handle.createReadStream({ autoClose: false, highWaterMark: HASH_BLOCK_SIZE, signal: options.signal });
          try {
            yield* stream;
            const after = await handle.stat({ bigint: true });
            if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw new BagError(`Source file changed while reading: ${path}`);
          } finally { stream.destroy(); }
        } finally { await handle.close(); }
      },
    };
  }
  yield* walk();
}

interface ExportState { result?: BagZipResult; cleanup?: Promise<void>; }
async function* archive(entries: AsyncIterable<BagZipEntry> | Iterable<BagZipEntry>, options: BagZipOptions, state: ExportState): AsyncGenerator<Buffer> {
  let complete!: () => void;
  state.cleanup = new Promise<void>(resolve => { complete = resolve; });
  try { yield* archiveContent(entries, options, state); }
  finally { complete(); }
}
async function* archiveContent(entries: AsyncIterable<BagZipEntry> | Iterable<BagZipEntry>, options: BagZipOptions, state: ExportState): AsyncGenerator<Buffer> {
  const algorithms = validateOptions(options);
  options.signal?.throwIfAborted();
  const temp = await mkdtemp(join(options.tempDirectory ?? tmpdir(), 'bagit-zip-'));
  const handles: FileHandle[] = [];
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let active: Readable | undefined;
  let failure: unknown;
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    failure = error;
    controller.abort(error);
    active?.destroy(error instanceof Error ? error : new Error(String(error)));
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  };
  zip.on('error', fail);
  // Install an error listener before producer I/O can fail, even before iteration starts.
  output.on('error', fail);
  const onAbort = (): void => fail(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });

  async function addEntry(name: string, input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, mtime?: Date, mode?: number): Promise<void> {
    signal.throwIfAborted();
    const source = Readable.from(input, { objectMode: false, highWaterMark: HASH_BLOCK_SIZE, signal });
    active = source;
    const done = finished(source, { cleanup: true });
    // Register rejection handling immediately; addReadStreamLazy can throw synchronously.
    void done.catch(fail);
    try {
      zip.addReadStreamLazy(name, {
        mtime: options.mtime ?? mtime ?? new Date(), mode: mode ?? 0o100644,
        compressionLevel: options.compressionLevel ?? 6,
      }, cb => cb(null, source));
      await done;
    } finally {
      source.destroy();
      await done.catch(() => {});
      active = undefined;
    }
  }
  function addDirectory(name: string, mtime?: Date, mode = 0o40755): void {
    signal.throwIfAborted();
    zip.addEmptyDirectory(name, { mtime: options.mtime ?? mtime ?? new Date(), mode });
  }

  async function addSource(entry: BagZipEntry, name: string): Promise<{ bytes: bigint; hashes: Checksums }> {
    const hashers = getHashers(algorithms);
    let bytes = 0n;
    async function* hashed(): AsyncGenerator<Uint8Array> {
      signal.throwIfAborted();
      const source = await entry.open();
      const destroy = (): void => {
        if (source instanceof Readable) source.destroy();
      };
      signal.addEventListener('abort', destroy, { once: true });
      try {
        signal.throwIfAborted();
        for await (const chunk of source) {
          signal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new TypeError('ZIP sources must produce Uint8Array or Buffer chunks');
          bytes += BigInt(chunk.length);
          for (const h of Object.values(hashers)) h.update(chunk);
          yield chunk;
        }
      } finally {
        signal.removeEventListener('abort', destroy);
        destroy();
      }
    }
    await addEntry(name, hashed(), entry.mtime, entry.mode);
    return { bytes, hashes: Object.fromEntries(Object.entries(hashers).map(([a, h]) => [a, h.digest('hex')])) };
  }

  const produce = async (): Promise<Omit<BagZipResult, 'bytesWritten'>> => {
    const manifests = new Map<string, { path: string; handle: FileHandle }>();
    for (const a of algorithms) {
      const path = join(temp, `manifest-${a}.txt`);
      const handle = await open(path, 'w');
      handles.push(handle);
      manifests.set(a, { path, handle });
    }
    const prefix = options.bagName ? `${options.bagName}/` : '';
    const registerPayload = entryRegistry('payload');
    let totalBytes = 0n;
    let totalFiles = 0;
    addDirectory(`${prefix}data/`);
    for await (const entry of entries) {
      signal.throwIfAborted();
      registerPayload(entry);
      if (entry.directory) {
        addDirectory(`${prefix}data/${entry.path}/`, entry.mtime, entry.mode);
        continue;
      }
      const { bytes, hashes } = await addSource(entry, `${prefix}data/${entry.path}`);
      for (const a of algorithms) await manifests.get(a)!.handle.writeFile(`${hashes[a]}  ${encodeFilename(`data/${entry.path}`)}\n`);
      totalBytes += bytes;
      totalFiles++;
      await options.onProgress?.({ path: entry.path, bytes, hashes, totalBytes, totalFiles });
    }
    const tags: { name: string; hashes: Checksums }[] = [];
    const registerTag = entryRegistry('tag', ['bagit.txt', 'bag-info.txt', 'data']);
    for await (const entry of options.tagFiles ?? []) {
      signal.throwIfAborted();
      // Unlike payload paths (which start with data/), root tags can begin with
      // whitespace or checksum-tool binary markers that manifest parsers strip.
      if (/^[\s*]/.test(encodeFilename(entry.path))) throw new BagError(`Ambiguous BagIt tag filename: ${JSON.stringify(entry.path)}`);
      // Reserve manifest namespaces, including algorithms not selected for this export.
      const root = normalizeUnicode(entry.path).split('/')[0]!;
      if (/^(?:tagmanifest|manifest)-.*\.txt$/.test(root)) throw new BagError(`Reserved tag-file path: ${entry.path}`);
      registerTag(entry);
      if (entry.directory) addDirectory(`${prefix}${entry.path}/`, entry.mtime, entry.mode);
      else {
        const { hashes } = await addSource(entry, prefix + entry.path);
        tags.push({ name: entry.path, hashes });
      }
    }
    for (const a of algorithms) {
      const manifest = manifests.get(a)!;
      await manifest.handle.close();
      const hashers = getHashers(algorithms);
      async function* content(): AsyncGenerator<Buffer> {
        for await (const chunk of createReadStream(manifest.path, { signal })) {
          for (const h of Object.values(hashers)) h.update(chunk);
          yield chunk as Buffer;
        }
      }
      const name = `manifest-${a}.txt`;
      await addEntry(prefix + name, content());
      tags.push({ name, hashes: Object.fromEntries(Object.entries(hashers).map(([alg, h]) => [alg, h.digest('hex')])) });
    }
    const bagInfo = makeBagInfo(options.bagInfo, totalBytes, totalFiles);
    for (const [name, text] of [['bagit.txt', BAG_DECLARATION], ['bag-info.txt', serializeTagFile(bagInfo)]]) {
      const bytes = Buffer.from(text!, 'utf8');
      await addEntry(prefix + name!, [bytes]);
      tags.push({ name: name!, hashes: digestBytes(bytes, algorithms) });
    }
    for (const a of algorithms) {
      const text = tags.map(t => `${t.hashes[a]} ${encodeFilename(t.name)}\n`).join('');
      await addEntry(`${prefix}tagmanifest-${a}.txt`, [Buffer.from(text)]);
    }
    zip.end();
    return { payloadBytes: totalBytes, payloadFiles: totalFiles, bagInfo };
  };
  const done = produce().catch(error => { fail(error); return undefined; });
  try {
    if (signal.aborted) fail(signal.reason);
    let bytesWritten = 0n;
    for await (const chunk of output) {
      bytesWritten += BigInt(chunk.length);
      yield chunk as Buffer;
    }
    const result = await done;
    if (failed) throw failure;
    state.result = { ...result!, bytesWritten };
  } finally {
    signal.removeEventListener('abort', onAbort);
    controller.abort();
    active?.destroy();
    output.destroy();
    await done;
    await Promise.allSettled(handles.map(h => h.close()));
    await rm(temp, { recursive: true, force: true });
  }
}

/** Pipe directly into an S3/Ceph multipart upload Body. Errors are emitted on the stream. */
export function createBagZipStream(directory: string, options: BagZipOptions = {}): Readable {
  validateOptions(options);
  return Readable.from(archive(folderEntries(directory, options), options, {}), { objectMode: false, highWaterMark: HASH_BLOCK_SIZE, signal: options.signal });
}

/** Stream a bag from lazy application-provided sources, without first creating a payload directory. */
export function createBagZipStreamFromEntries(entries: AsyncIterable<BagZipEntry> | Iterable<BagZipEntry>, options: BagZipOptions = {}): Readable {
  validateOptions(options);
  return Readable.from(archive(entries, options, {}), { objectMode: false, highWaterMark: HASH_BLOCK_SIZE, signal: options.signal });
}

/** Write an archive to a Writable, or atomically replace a path after successful completion. Ends the destination. */
export async function folderToBagZip(directory: string, destination: string | Writable, options: BagZipOptions = {}): Promise<BagZipResult> {
  validateOptions(options);
  options.signal?.throwIfAborted();
  if (!isDirectory(resolve(directory))) throw new BagError(`Bag directory ${resolve(directory)} does not exist`);
  const state: ExportState = {};
  let temp: string | undefined;
  try {
    let output: Writable;
    const outputPath = typeof destination === 'string' ? destination : 'path' in destination && typeof destination.path === 'string' ? destination.path : undefined;
    if (outputPath !== undefined) {
      const target = resolve(outputPath);
      // Resolve existing parent symlinks before checking containment.
      const actual = join(await realpath(dirname(target)), basename(target));
      const rel = relative(await realpath(directory), actual);
      if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new BagError('ZIP destination must be outside the source directory');
    }
    if (typeof destination === 'string') {
      const target = resolve(destination);
      temp = await mkdtemp(join(dirname(target), '.bagit-output-'));
      output = createWriteStream(join(temp, 'archive.zip'), { flags: 'wx' });
    } else output = destination;
    const source = Readable.from(archive(folderEntries(directory, options), options, state), { objectMode: false, highWaterMark: HASH_BLOCK_SIZE });
    try { await pipeline(source, output, { signal: options.signal }); }
    finally { await state.cleanup; }
    if (typeof destination === 'string') await rename(join(temp!, 'archive.zip'), resolve(destination));
    return state.result!;
  } finally { if (temp) await rm(temp, { recursive: true, force: true }); }
}

export const folderToBagitZip = folderToBagZip;
