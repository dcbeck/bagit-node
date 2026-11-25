import { createHash, type Hash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, realpathSync, statSync, constants, accessSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { BagError, BagValidationError, FileNormalizationConflict } from './errors.js';
import type { BagInfo, BagInfoInput, Checksums } from './types.js';

export const VERSION = '1.1.0';
export const DEFAULT_CHECKSUMS: readonly string[] = Object.freeze(['sha256', 'sha512']);
export const HASH_BLOCK_SIZE = 512 * 1024;
export const BAG_DECLARATION = 'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n';
export const STANDARD_BAG_INFO_HEADERS: readonly string[] = Object.freeze([
  'Source-Organization', 'Organization-Address', 'Contact-Name', 'Contact-Phone', 'Contact-Email',
  'External-Description', 'External-Identifier', 'Bag-Size', 'Bag-Group-Identifier', 'Bag-Count',
  'Internal-Sender-Identifier', 'Internal-Sender-Description', 'BagIt-Profile-Identifier',
]);
// Python's guaranteed fixed-length algorithms, mapped to OpenSSL names where necessary.
const HASH_NAMES: Record<string, string> = {
  blake2b: 'blake2b512', blake2s: 'blake2s256',
  sha3_224: 'sha3-224', sha3_256: 'sha3-256', sha3_384: 'sha3-384', sha3_512: 'sha3-512',
};
export const CHECKSUM_ALGOS: readonly string[] = Object.freeze([
  'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
  'sha3_224', 'sha3_256', 'sha3_384', 'sha3_512', 'blake2b', 'blake2s',
]);
export function getHashers(algorithms: readonly string[]): Record<string, Hash> {
  const result: Record<string, Hash> = Object.create(null);
  for (const alg of algorithms) {
    if (!CHECKSUM_ALGOS.includes(alg)) continue;
    try { result[alg] = createHash(HASH_NAMES[alg] ?? alg); } catch { /* unavailable in this OpenSSL build */ }
  }
  if (!Object.keys(result).length) throw new BagError('Unable to continue: no supported checksum algorithms were requested');
  return result;
}
export function algorithmsFor(algorithms: readonly string[] = DEFAULT_CHECKSUMS): string[] {
  return Object.keys(getHashers(algorithms));
}
export function digestBytes(bytes: Uint8Array, algorithms: readonly string[]): Checksums {
  return Object.fromEntries(Object.entries(getHashers(algorithms)).map(([a, h]) => [a, h.update(bytes).digest('hex')]));
}
export async function hashFile(path: string, algorithms: readonly string[], signal?: AbortSignal): Promise<{ hashes: Checksums; bytes: bigint }> {
  const hashers = getHashers(algorithms);
  let bytes = 0n;
  try {
    for await (const block of createReadStream(path, { highWaterMark: HASH_BLOCK_SIZE, signal })) {
      bytes += BigInt(block.length);
      for (const hash of Object.values(hashers)) hash.update(block);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw new BagValidationError(`Could not read ${path}: ${String(error)}`, [], { cause: error });
  }
  return { hashes: Object.fromEntries(Object.entries(hashers).map(([a, h]) => [a, h.digest('hex')])), bytes };
}
export async function generateManifestLines(filename: string, algorithms: readonly string[] = DEFAULT_CHECKSUMS, signal?: AbortSignal): Promise<[algorithm: string, digest: string, filename: string, bytes: bigint][]> {
  const { hashes, bytes } = await hashFile(filename, algorithms, signal);
  return Object.entries(hashes).map(([algorithm, digest]) => [algorithm, digest, filename, bytes]);
}
export const normalizeUnicode = (s: string): string => s.normalize('NFC');
export function buildUnicodeNormalizedLookupDict(filenames: Iterable<string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const filename of filenames) {
    const normalized = normalizeUnicode(filename);
    if (Object.hasOwn(result, normalized)) throw new FileNormalizationConflict(filename, result[normalized]!);
    result[normalized] = filename;
  }
  return result;
}
export const encodeFilename = (s: string): string => s.replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const decodeFilename = (s: string): string => s.replace(/%0d/gi, '\r').replace(/%0a/gi, '\n');
export const posixPath = (s: string): string => s.split(sep).join('/');
export const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDirectory = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Match os.walk: sorted files at each level, then sorted directories; do not follow directory symlinks. */
export function* walkFiles(root: string, prefix = ''): Generator<string> {
  if (!isDirectory(root)) return;
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name));
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isFile() || (e.isSymbolicLink() && !isDirectory(p))) yield prefix + e.name;
  }
  for (const e of entries) if (e.isDirectory()) yield* walkFiles(join(root, e.name), `${prefix}${e.name}/`);
}
export function compareNames(a: string, b: string): number {
  // Python sorts Unicode code points, whereas JavaScript's default sort uses UTF-16 code units.
  const ac = Array.from(a, c => c.codePointAt(0)!);
  const bc = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(ac.length, bc.length); i++) if (ac[i] !== bc[i]) return ac[i]! - bc[i]!;
  return ac.length - bc.length;
}
function canonicalMissingPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  // realpath still detects symlinks in the existing part of an absent fetch target.
  return join(canonicalMissingPath(parent), relative(parent, path));
}
export function pathIsDangerous(root: string, filename: string): boolean {
  if (!filename || filename.includes('\0') || isAbsolute(filename) || win32.isAbsolute(filename) || filename.startsWith('~')) return true;
  const actual = canonicalMissingPath(resolve(root, filename));
  const rel = relative(realpathSync(root), actual);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
export function assertSafePath(root: string, filename: string, context = 'manifest'): void {
  if (pathIsDangerous(root, filename)) throw new BagError(`Path "${filename}" in ${context} is unsafe`);
}
export function decodeText(bytes: Uint8Array, encoding = 'utf-8'): string {
  let label = encodingLabel(encoding);
  if (label === 'utf-16') {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
    else if (bytes.length) throw new BagValidationError('UTF-16 tag file must begin with a byte-order mark');
  }
  if (label === 'utf-8-sig') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (label === 'ascii' || label === 'us-ascii') {
    if (bytes.some(b => b > 127)) throw new BagValidationError('Non-ASCII byte in ASCII tag file');
    return Buffer.from(bytes).toString('ascii');
  }
  // TextDecoder maps ISO-8859-1 to Windows-1252; Python uses the actual ISO mapping.
  if (['latin-1', 'latin1', 'iso-8859-1'].includes(label)) return Buffer.from(bytes).toString('latin1');
  try { return new TextDecoder(label, { fatal: true }).decode(bytes); }
  catch (e) { throw new BagValidationError(`Cannot decode tag file as ${encoding}`, [], { cause: e }); }
}
export function checkEncoding(encoding: string): void {
  const label = encodingLabel(encoding);
  if (['utf-8-sig', 'latin-1'].includes(label)) return;
  try { new TextDecoder(label); }
  catch { throw new BagValidationError(`Unsupported encoding: ${encoding}`); }
}
export function encodeText(text: string, encoding = 'utf-8'): Buffer {
  const label = encodingLabel(encoding);
  if (['utf-8', 'utf8', 'utf-8-sig'].includes(label)) {
    const bytes = Buffer.from(text, 'utf8');
    return label === 'utf-8-sig' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
  }
  if (['utf-16', 'utf-16le', 'utf-16-le', 'utf16le'].includes(label)) {
    const bytes = Buffer.from(text, 'utf16le');
    return label === 'utf-16' ? Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]) : bytes;
  }
  if (['utf-16be', 'utf-16-be'].includes(label)) return Buffer.from(text, 'utf16le').swap16();
  const table = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    try { const c = decodeText(Uint8Array.of(b), encoding); if (c.length === 1 && !table.has(c)) table.set(c, b); } catch { /* invalid single byte */ }
  }
  const bytes: number[] = [];
  for (const c of text) {
    const b = table.get(c);
    if (b === undefined) throw new BagError(`Cannot encode character ${JSON.stringify(c)} as ${encoding}`);
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
function encodingLabel(encoding: string): string {
  const label = encoding.toLowerCase().replace(/_/g, '-');
  return ({ utf8: 'utf-8', utf16: 'utf-16', utf16le: 'utf-16le', utf16be: 'utf-16be', 'utf-16-le': 'utf-16le', 'utf-16-be': 'utf-16be' } as Record<string, string>)[label] ?? label;
}
export function parseTagFile(text: string, filename = 'tag file'): BagInfo {
  const result: BagInfo = Object.create(null);
  let key: string | undefined;
  let value = '';
  const emit = (): void => {
    if (!key) return;
    const v = value.trim();
    const prev = result[key];
    result[key] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  };
  for (const line of text.replace(/\r\n?/g, '\n').match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && key !== undefined) value += line;
    else {
      emit();
      const colon = line.indexOf(':');
      if (colon < 0) throw new BagValidationError(`${filename} contains invalid tag: ${line.trim()}`);
      key = line.slice(0, colon).trim();
      value = line.slice(colon + 1);
    }
  }
  emit();
  return result;
}
export function serializeTagFile(info: BagInfoInput): string {
  let result = '';
  for (const key of Object.keys(info).sort(compareNames)) {
    if (!key || /[\r\n:]/.test(key)) throw new BagError(`Invalid metadata field name: ${key}`);
    const values = Array.isArray(info[key]) ? info[key] : [info[key]];
    for (const value of values!) result += `${key}: ${String(value).replace(/[\r\n]/g, '')}\n`;
  }
  return result;
}
export function makeBagInfo(info: BagInfoInput | undefined, bytes: bigint, files: number): BagInfo {
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return parseTagFile(serializeTagFile({
    'Bagging-Date': today,
    'Bag-Software-Agent': `bagit-node v${VERSION}`,
    ...info,
    'Payload-Oxum': `${bytes}.${files}`,
  }));
}
export async function loadTagFile(path: string, encoding = 'utf-8'): Promise<BagInfo> {
  return parseTagFile(decodeText(await readFile(path), encoding), path);
}
export function checkPermissions(root: string, saving = false): void {
  try { accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK); }
  catch {
    throw new BagError(saving ? `Cannot save bag to non-existent or inaccessible directory ${root}` : 'Missing permissions to move all files and directories');
  }
  const dirs = [root];
  const files: string[] = [];
  // Finish the write check before reporting unreadable descendants, matching Python.
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    try { accessSync(dir, constants.W_OK); }
    catch { throw new BagError('Missing permissions to move all files and directories'); }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { throw new BagError('Read permissions are required to calculate file fixities'); }
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(join(dir, e.name));
      else files.push(join(dir, e.name));
    }
  }
  for (const p of [...dirs, ...files]) {
    try { accessSync(p, constants.R_OK); }
    catch { throw new BagError('Read permissions are required to calculate file fixities'); }
  }
}
export function checkConcurrency(concurrency = 1): number {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  return concurrency;
}
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(checkConcurrency(concurrency), items.length) }, async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try { result[i] = await fn(items[i]!); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure;
  return result;
}
