import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { BagError, BagValidationError, ChecksumMismatch, FileMissing, UnexpectedFile, type ManifestErrorDetail } from './errors.js';
import type { BagInfo, Checksums, Entries, FetchEntry, MakeBagOptions, SaveOptions, ValidationOptions } from './types.js';
import {
  algorithmsFor, assertSafePath, BAG_DECLARATION, buildUnicodeNormalizedLookupDict, checkConcurrency,
  checkEncoding, checkPermissions, CHECKSUM_ALGOS, decodeFilename, decodeText, DEFAULT_CHECKSUMS,
  encodeFilename, encodeText, hashFile, isDirectory, isFile, makeBagInfo, mapConcurrent, normalizeUnicode,
  parseTagFile, serializeTagFile, walkFiles,
} from './util.js';

export class Bag {
  readonly path: string;
  tags: BagInfo = Object.create(null);
  info: BagInfo = Object.create(null);
  entries: Entries = Object.create(null);
  algorithms: string[] = [];
  versionInfo!: readonly [number, number];
  version!: string;
  encoding!: string;
  tagFileName!: string;
  normalizedFilesystemNames: Record<string, string> = Object.create(null);
  normalizedManifestNames: Record<string, string> = Object.create(null);

  /** Reads declaration, metadata and manifests synchronously; file hashing is asynchronous. */
  constructor(path: string) {
    this.path = resolve(path);
    const declaration = join(this.path, 'bagit.txt');
    if (!isFile(declaration)) throw new BagError(`Expected bagit.txt does not exist: ${declaration}`);
    this.tags = parseTagFile(decodeText(readFileSync(declaration)), 'bagit.txt');
    const missing = ['BagIt-Version', 'Tag-File-Character-Encoding'].filter(k => !(k in this.tags));
    if (missing.length) throw new BagError(`Missing required tag in bagit.txt: ${missing.join(', ')}`);
    const version = this.tags['BagIt-Version'];
    if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
      throw new BagError(`Bag version numbers must be MAJOR.MINOR numbers, not ${String(version)}`);
    }
    this.version = version;
    const [major, minor] = version.split('.').map(Number) as [number, number];
    this.versionInfo = [major, minor];
    if (major === 0 && minor >= 93 && minor <= 95) this.tagFileName = 'package-info.txt';
    else if ((major === 0 && minor >= 96) || major === 1) this.tagFileName = 'bag-info.txt';
    else throw new BagError(`Unsupported bag version: ${version}`);
    const encoding = this.tags['Tag-File-Character-Encoding'];
    if (typeof encoding !== 'string') throw new BagValidationError('Tag-File-Character-Encoding must occur once');
    this.encoding = encoding;
    checkEncoding(encoding);
    const infoPath = join(this.path, this.tagFileName);
    if (isFile(infoPath)) this.info = parseTagFile(decodeText(readFileSync(infoPath), encoding), this.tagFileName);
    this.loadManifests();
  }

  toString(): string { return this.path; }
  get algs(): string[] { return this.algorithms; }
  get version_info(): readonly [number, number] { return this.versionInfo; }
  get tag_file_name(): string { return this.tagFileName; }
  private get verifiesTagFiles(): boolean { return this.versionInfo[0] >= 1 || this.versionInfo[1] >= 97; }

  *manifestFiles(): Generator<string> {
    for (const a of CHECKSUM_ALGOS) if (isFile(join(this.path, `manifest-${a}.txt`))) yield join(this.path, `manifest-${a}.txt`);
  }
  *tagmanifestFiles(): Generator<string> {
    for (const a of CHECKSUM_ALGOS) if (isFile(join(this.path, `tagmanifest-${a}.txt`))) yield join(this.path, `tagmanifest-${a}.txt`);
  }
  private loadManifests(): void {
    this.entries = Object.create(null);
    this.algorithms = [];
    const manifests = [...this.manifestFiles(), ...(this.verifiesTagFiles ? this.tagmanifestFiles() : [])];
    for (const manifest of manifests) {
      const algorithm = basename(manifest).replace(/^(?:tag)?manifest-/, '').replace(/\.txt$/, '');
      if (!this.algorithms.includes(algorithm)) this.algorithms.push(algorithm);
      const text = decodeText(readFileSync(manifest), this.encoding);
      for (const raw of text.split(/\r\n|\n|\r/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const entry = /^(\S+)\s+(.+)$/.exec(line);
        if (!entry) continue; // Python logs and skips malformed lines.
        const digest = entry[1]!;
        const filename = decodeFilename(posix.normalize(entry[2]!.replace(/^\*+/, '')));
        assertSafePath(this.path, filename, `manifest "${manifest}"`);
        const hashes = this.entries[filename] ??= Object.create(null) as Checksums;
        if (Object.hasOwn(hashes, algorithm)) {
          const same = hashes[algorithm] === digest;
          if (!same || this.versionInfo[0] >= 1) {
            throw new BagError(`${this.path}: ${algorithm} manifest lists ${filename} multiple times with ${same ? 'the same value' : 'conflicting values'}`);
          }
        }
        hashes[algorithm] = digest;
      }
    }
    this.normalizedManifestNames = buildUnicodeNormalizedLookupDict(Object.keys(this.entries));
  }
  *payloadFiles(): Generator<string> {
    this.normalizedFilesystemNames = Object.create(null);
    for (const filename of walkFiles(join(this.path, 'data'), 'data/')) {
      this.normalizedFilesystemNames[normalizeUnicode(filename)] = filename;
      yield filename;
    }
  }
  payloadEntries(): Entries { return Object.fromEntries(Object.entries(this.entries).filter(([p]) => p.startsWith('data/'))); }
  tagfileEntries(): Entries { return Object.fromEntries(Object.entries(this.entries).filter(([p]) => !p.startsWith('data/'))); }
  *missingOptionalTagfiles(): Generator<string> {
    for (const filename of Object.keys(this.tagfileEntries())) if (!isFile(join(this.path, filename))) yield filename;
  }
  compareManifestsWithFs(): [string[], string[]] {
    const files = [...this.payloadFiles()];
    this.normalizedFilesystemNames = buildUnicodeNormalizedLookupDict(files);
    const onFs = new Set(files.map(normalizeUnicode));
    const inManifest = new Set(Object.keys(this.payloadEntries()).map(normalizeUnicode));
    if (this.verifiesTagFiles) for (const f of this.missingOptionalTagfiles()) inManifest.add(normalizeUnicode(f));
    return [
      [...inManifest].filter(p => !onFs.has(p)).map(p => this.normalizedManifestNames[p]!),
      [...onFs].filter(p => !inManifest.has(p)).map(p => this.normalizedFilesystemNames[p]!),
    ];
  }
  *fetchEntries(): Generator<FetchEntry> {
    const path = join(this.path, 'fetch.txt');
    if (!isFile(path)) return;
    for (const line of decodeText(readFileSync(path), this.encoding).split(/\r\n|\n|\r/)) {
      if (!line.trim()) continue;
      const parts = /^(\S+)\s+(\S+)\s+(.+)$/.exec(line.trim());
      if (!parts) throw new BagError(`Malformed entry in fetch.txt: ${line}`);
      const filename = parts[3]!;
      assertSafePath(this.path, filename, `"${path}"`);
      yield [parts[1]!, parts[2]!, filename];
    }
  }
  *filesToBeFetched(): Generator<string> { for (const [, , filename] of this.fetchEntries()) yield filename; }
  compareFetchWithFs(): string[] {
    const files = new Set(this.payloadFiles());
    return [...new Set(this.filesToBeFetched())].filter(f => !files.has(f));
  }
  validateFetch(): void {
    for (const [url] of this.fetchEntries()) {
      // Like urllib.urlparse: permit any scheme with an authority, or file: URLs.
      if (!/^file:/i.test(url) && !/^[a-z][a-z\d+.-]*:\/\/[^/\s?#]+/i.test(url)) throw new BagError(`Malformed URL in fetch.txt: ${url}`);
    }
  }
  hasOxum(): boolean { return Object.hasOwn(this.info, 'Payload-Oxum'); }

  async validate(options: ValidationOptions = {}): Promise<true> {
    const concurrency = checkConcurrency(options.concurrency);
    options.signal?.throwIfAborted();
    if (!isDirectory(join(this.path, 'data'))) throw new BagValidationError(`Expected data directory ${join(this.path, 'data')} does not exist`);
    if (![...this.manifestFiles()].length) throw new BagValidationError('No manifest files found');
    const declaration = join(this.path, 'bagit.txt');
    if (!isFile(declaration)) throw new BagValidationError(`Expected ${this.path} to contain "bagit.txt"`);
    if (readFileSync(declaration).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new BagValidationError('bagit.txt must not contain a byte-order mark');
    this.validateFetch();
    if (options.fast && !this.hasOxum()) throw new BagValidationError('Fast validation requires bag-info.txt to include Payload-Oxum');
    this.validateOxum();
    if (options.fast) return true;
    const [missing, unexpected] = this.compareManifestsWithFs();
    const errors: ManifestErrorDetail[] = [...missing.map(p => new FileMissing(p)), ...unexpected.map(p => new UnexpectedFile(p))];
    if (errors.length) throw new BagValidationError('Bag is incomplete', errors);
    if (options.completenessOnly || options.completeness_only) return true;
    const results = await mapConcurrent(Object.entries(this.entries), concurrency, async ([filename, expected]) => {
      options.signal?.throwIfAborted();
      const actualName = this.normalizedFilesystemNames[normalizeUnicode(filename)] ?? filename;
      assertSafePath(this.path, actualName);
      let hashes: Checksums;
      try { ({ hashes } = await hashFile(join(this.path, actualName), Object.keys(expected), options.signal)); }
      catch (error) {
        if (!(error instanceof BagValidationError)) throw error;
        hashes = Object.fromEntries(Object.keys(expected).map(a => [a, error.message]));
      }
      return Object.entries(expected).filter(([a, h]) => h.toLowerCase() !== hashes[a]).map(([a, h]) => new ChecksumMismatch(filename, a, h.toLowerCase(), hashes[a]!));
    });
    errors.push(...results.flat());
    if (errors.length) throw new BagValidationError('Bag validation failed', errors);
    return true;
  }
  private validateOxum(): void {
    let oxum = this.info['Payload-Oxum'];
    if (oxum === undefined) return;
    if (Array.isArray(oxum)) oxum = oxum[0]!;
    if (!/^\d+\.\d+$/.test(oxum)) throw new BagError(`Malformed Payload-Oxum value: ${oxum}`);
    const [expectedBytes, expectedFiles] = oxum.split('.').map(BigInt);
    const files = [...this.payloadFiles()];
    let bytes = 0n;
    for (const f of files) {
      assertSafePath(this.path, f);
      bytes += statSync(join(this.path, f), { bigint: true }).size;
    }
    if (bytes !== expectedBytes || BigInt(files.length) !== expectedFiles) {
      throw new BagValidationError(`Payload-Oxum validation failed. Expected ${expectedFiles} files and ${expectedBytes} bytes but found ${files.length} files and ${bytes} bytes`);
    }
  }
  async isValid(options: ValidationOptions = {}): Promise<boolean> {
    try { await this.validate(options); return true; }
    catch (error) { if (error instanceof BagError) return false; throw error; }
  }
  async save(options: SaveOptions = {}): Promise<void> {
    checkConcurrency(options.concurrency);
    options.signal?.throwIfAborted();
    checkPermissions(this.path, true);
    if (options.manifests) {
      const { bytes, files } = await makeManifests(this.path, { checksums: this.algorithms, concurrency: options.concurrency, signal: options.signal }, this.encoding);
      this.info['Payload-Oxum'] = `${bytes}.${files}`;
    }
    await writeFile(join(this.path, this.tagFileName), encodeText(serializeTagFile(this.info), this.encoding));
    await makeTagManifests(this.path, this.algorithms, this.encoding, options.signal);
    this.loadManifests();
  }

  // Python-style method aliases ease migration while the primary API uses Node naming conventions.
  manifest_files = this.manifestFiles;
  tagmanifest_files = this.tagmanifestFiles;
  payload_files = this.payloadFiles;
  payload_entries = this.payloadEntries;
  tagfile_entries = this.tagfileEntries;
  missing_optional_tagfiles = this.missingOptionalTagfiles;
  compare_manifests_with_fs = this.compareManifestsWithFs;
  compare_fetch_with_fs = this.compareFetchWithFs;
  fetch_entries = this.fetchEntries;
  files_to_be_fetched = this.filesToBeFetched;
  validate_fetch = this.validateFetch;
  has_oxum = this.hasOxum;
  is_valid = this.isValid;
}

/** Convert a directory in place. Existing contents, including an existing data/, become payload. */
export async function makeBag(directory: string, options: MakeBagOptions = {}): Promise<Bag> {
  const root = resolve(directory);
  const algorithms = algorithmsFor(options.checksums);
  checkConcurrency(options.concurrency);
  if (options.encoding && options.encoding.toLowerCase() !== 'utf-8') throw new BagError('New bags must use UTF-8');
  options.signal?.throwIfAborted();
  if (!isDirectory(root)) throw new BagError(`Bag directory ${root} does not exist`);
  const cwdRelative = relative(root, process.cwd());
  if (cwdRelative && !cwdRelative.startsWith(`..${sep}`) && cwdRelative !== '..' && !isAbsolute(cwdRelative)) {
    throw new BagError('Bagging a parent of the current directory is not supported');
  }
  checkPermissions(root);
  const sourceFiles = [...walkFiles(root)];
  buildUnicodeNormalizedLookupDict(sourceFiles);
  for (const f of sourceFiles) assertSafePath(root, f, 'source directory');
  const originalMode = (await stat(root)).mode;
  const children = await readdir(root);
  const staging = await mkdtemp(join(root, '.bagit-'));
  const moved: string[] = [];
  try {
    for (const name of children) { await rename(join(root, name), join(staging, name)); moved.push(name); }
    await rename(staging, join(root, 'data'));
  } catch (error) {
    for (const name of moved.reverse()) await rename(join(staging, name), join(root, name));
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await chmod(join(root, 'data'), originalMode);
  const { bytes, files } = await makeManifests(root, { ...options, checksums: algorithms });
  await writeFile(join(root, 'bagit.txt'), BAG_DECLARATION);
  await writeFile(join(root, 'bag-info.txt'), serializeTagFile(makeBagInfo(options.bagInfo, bytes, files)));
  await makeTagManifests(root, algorithms, 'utf-8', options.signal);
  return new Bag(root);
}

export async function makeManifests(root: string, options: Pick<MakeBagOptions, 'checksums' | 'concurrency' | 'signal'> = {}, encoding = 'utf-8'): Promise<{ bytes: bigint; files: number }> {
  const algorithms = algorithmsFor(options.checksums);
  const filenames = [...walkFiles(join(root, 'data'), 'data/')];
  buildUnicodeNormalizedLookupDict(filenames);
  const records = await mapConcurrent(filenames, options.concurrency ?? 1, async filename => {
    assertSafePath(root, filename);
    return { filename, ...await hashFile(join(root, filename), algorithms, options.signal) };
  });
  for (const a of algorithms) {
    const text = records.map(r => `${r.hashes[a]}  ${encodeFilename(r.filename)}\n`).join('');
    await writeFile(join(root, `manifest-${a}.txt`), encodeText(text, encoding));
  }
  return { bytes: records.reduce((sum, r) => sum + r.bytes, 0n), files: records.length };
}

export async function makeTagManifests(root: string, algorithms: readonly string[] = DEFAULT_CHECKSUMS, encoding = 'utf-8', signal?: AbortSignal): Promise<void> {
  const tagFiles = [...walkFiles(root)].filter(f => !f.startsWith('data/') && !basename(f).startsWith('tagmanifest-'));
  const records = [];
  for (const filename of tagFiles) {
    assertSafePath(root, filename);
    records.push({ filename, ...await hashFile(join(root, filename), algorithms, signal) });
  }
  for (const a of algorithmsFor(algorithms)) {
    await writeFile(join(root, `tagmanifest-${a}.txt`), encodeText(records.map(r => `${r.hashes[a]} ${encodeFilename(r.filename)}\n`).join(''), encoding));
  }
}
