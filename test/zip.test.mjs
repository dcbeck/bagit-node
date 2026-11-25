import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { Bag, createBagZipStream, createBagZipStreamFromEntries, folderToBagZip, BagError } from '../dist/esm/index.js';
import { collect, extract, fixture, unzip } from './helpers.mjs';

test('ZIP payloads, CRCs, hashes, oxum and append order round-trip', async t => {
  const source = await fixture(t, { 'hello.txt': 'hello', 'sub/ü\n.txt': randomBytes(250000), empty: '' });
  const dest = await fixture(t, {});
  const progress = [];
  const zip = await collect(createBagZipStream(source, { onProgress: p => progress.push(p) }));
  const entries = unzip(zip);
  assert.equal(entries.get('data/hello.txt').toString(), 'hello');
  assert.deepEqual(entries.get('data/sub/ü\n.txt'), await readFile(join(source, 'sub/ü\n.txt')));
  const names = [...entries.keys()];
  assert(names.indexOf('manifest-sha256.txt') > names.indexOf('data/sub/ü\n.txt'));
  assert(names.indexOf('bagit.txt') > names.indexOf('manifest-sha256.txt'));
  assert(names.indexOf('tagmanifest-sha256.txt') > names.indexOf('bag-info.txt'));
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1).totalBytes, 250005n);
  assert.equal(progress.find(p => p.path === 'hello.txt').hashes.sha256, createHash('sha256').update('hello').digest('hex'));
  await extract(zip, dest);
  const bag = new Bag(dest);
  assert.equal(bag.info['Payload-Oxum'], '250005.3');
  assert(await bag.validate());
  assert.equal(await readFile(join(source, 'hello.txt'), 'utf8'), 'hello');
});

for (const level of [0, 1, 6, 9]) {
  test(`ZIP deflate level ${level} and nested bag name`, async t => {
    const dir = await fixture(t);
    const dest = await fixture(t, {});
    const bytes = await collect(createBagZipStream(dir, { compressionLevel: level, bagName: 'export/bag' }));
    assert([...unzip(bytes).keys()].every(p => p.startsWith('export/bag/')));
    await extract(bytes, dest);
    assert(await new Bag(join(dest, 'export/bag')).validate());
  });
}

test('folderToBagZip writes an atomic file and reports exact counts', async t => {
  const source = await fixture(t);
  const dest = await fixture(t, { 'out.zip': 'previous' });
  const path = join(dest, 'out.zip');
  const result = await folderToBagZip(source, path);
  const bytes = await readFile(path);
  assert.equal(result.bytesWritten, BigInt(bytes.length));
  assert.equal(result.payloadFiles, 3);
  assert.equal(result.payloadBytes, 25n);
  assert.equal(result.bagInfo['Payload-Oxum'], '25.3');
  assert.equal(unzip(bytes).size, 11);
  assert.deepEqual(await readdir(dest), ['out.zip']);
});

test('folderToBagZip supports slow writable destinations', async t => {
  const source = await fixture(t, { bytes: randomBytes(1024 * 1024) });
  const chunks = [];
  const output = new Writable({ highWaterMark: 1000, write(chunk, encoding, callback) {
    chunks.push(Buffer.from(chunk));
    setImmediate(callback);
  } });
  const result = await folderToBagZip(source, output);
  assert.equal(result.bytesWritten, BigInt(Buffer.concat(chunks).length));
  assert(output.writableFinished);
  assert.deepEqual(unzip(Buffer.concat(chunks)).get('data/bytes'), await readFile(join(source, 'bytes')));
});

test('lazy source API opens each payload once, supports unknown lengths and binary chunks', async t => {
  let opens = 0;
  let active = 0;
  async function* entries() {
    for (const name of ['a', 'sub/b']) yield { path: name, async open() {
      opens++;
      assert.equal(active++, 0);
      return (async function* () {
        try { yield Buffer.from('abc'); yield new Uint8Array([0, 1, 255]); }
        finally { active--; }
      })();
    } };
  }
  const bytes = await collect(createBagZipStreamFromEntries(entries()));
  assert.equal(opens, 2);
  assert.equal(active, 0);
  const dest = await fixture(t, {});
  await extract(bytes, dest);
  assert(await new Bag(dest).validate());
  assert.equal(new Bag(dest).info['Payload-Oxum'], '12.2');
});

test('empty ZIP bag has data directory and empty payload manifests', async t => {
  const source = await fixture(t, {});
  const dest = await fixture(t, {});
  const bytes = await collect(createBagZipStream(source));
  assert(unzip(bytes).has('data/'));
  await extract(bytes, dest);
  assert(await new Bag(dest).validate());
});

test('empty directory trees survive folder export', async t => {
  const source = await fixture(t, {});
  await mkdir(join(source, 'empty/nested'), { recursive: true });
  const entries = unzip(await collect(createBagZipStream(source)));
  assert(entries.has('data/empty/'));
  assert(entries.has('data/empty/nested/'));
});

test('ZIP preserves payload filenames ending in encoded CR/LF', async t => {
  const source = await fixture(t, { 'return\r': 'one', 'line\n': 'two' });
  const dest = await fixture(t, {});
  await extract(await collect(createBagZipStream(source)), dest);
  assert(await new Bag(dest).validate());
});

test('temporary manifests cannot be placed within the payload', async t => {
  const source = await fixture(t);
  await assert.rejects(collect(createBagZipStream(source, { tempDirectory: source })), /outside the source/);
  assert(!(await readdir(source)).some(p => p.startsWith('bagit-zip-')));
});

test('folder export rejects directory symlinks instead of silently omitting content', async t => {
  const source = await fixture(t);
  await symlink(join(source, 'nested'), join(source, 'alias'), 'dir');
  await assert.rejects(collect(createBagZipStream(source)), /Directory symlinks/);
});

test('manifest spool files are cleaned on success', async t => {
  const source = await fixture(t);
  const tempDirectory = await fixture(t, {});
  await collect(createBagZipStream(source, { tempDirectory }));
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('source errors propagate and remove spool files', async t => {
  const tempDirectory = await fixture(t, {});
  let closed = false;
  const entries = [{ path: 'bad', open: () => (async function* () {
    try { yield Buffer.from('start'); throw new Error('source failed'); }
    finally { closed = true; }
  })() }];
  await assert.rejects(collect(createBagZipStreamFromEntries(entries, { tempDirectory })), /source failed/);
  assert(closed);
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('destination failure closes input and cleans temporary files', async t => {
  const source = await fixture(t, { a: randomBytes(1024 * 1024) });
  const tempDirectory = await fixture(t, {});
  const output = new Writable({ write(chunk, encoding, callback) { callback(new Error('destination failed')); } });
  await assert.rejects(folderToBagZip(source, output, { tempDirectory }), /destination failed/);
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('abort during export closes payload and removes temporary files', async t => {
  const tempDirectory = await fixture(t, {});
  const controller = new AbortController();
  let closed = false;
  const entries = [{ path: 'large', open: () => (async function* () {
    try {
      for (let i = 0; i < 2000; i++) { yield randomBytes(65536); await setTimeout(1); }
    } finally { closed = true; }
  })() }];
  const stream = createBagZipStreamFromEntries(entries, { tempDirectory, signal: controller.signal });
  const done = collect(stream);
  const timer = globalThis.setTimeout(() => controller.abort(), 30);
  t.after(() => clearTimeout(timer));
  await assert.rejects(done, { name: 'AbortError' });
  // Readable emits AbortError before async-generator finalization completes.
  await stream[Symbol.asyncDispose]().catch(() => {});
  assert(closed);
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('a failed file export preserves an existing destination', async t => {
  const source = await fixture(t);
  const dest = await fixture(t, { 'out.zip': 'preserve me' });
  await assert.rejects(folderToBagZip(source, join(dest, 'out.zip'), { onProgress() { throw new Error('stop'); } }), /stop/);
  assert.equal(await readFile(join(dest, 'out.zip'), 'utf8'), 'preserve me');
  assert.deepEqual(await readdir(dest), ['out.zip']);
});

test('ZIP stream preserves backpressure with a bounded number of input chunks', async t => {
  let reads = 0;
  let closed = false;
  const entries = [{ path: 'large', open: () => (async function* () {
    try { for (let i = 0; i < 2000; i++) { reads++; yield randomBytes(65536); } }
    finally { closed = true; }
  })() }];
  const stream = createBagZipStreamFromEntries(entries);
  stream.read(1);
  await setTimeout(100);
  assert(reads < 100, `source read ahead ${reads} chunks without a consumer`);
  await stream[Symbol.asyncDispose]();
  assert(closed);
});

test('fixed timestamps and metadata produce reproducible ZIPs', async t => {
  const source = await fixture(t);
  const options = { mtime: new Date('2000-01-01T00:00:00Z'), bagInfo: { 'Bagging-Date': '2000-01-01' } };
  assert.deepEqual(await collect(createBagZipStream(source, options)), await collect(createBagZipStream(source, options)));
});

for (const path of ['../escape', '/absolute', 'data/../x', 'C:/Windows/a', 'a\\b', 'a//b', '~user/a', 'name%0A.txt', 'trailing ']) {
  test(`reject unsafe or ambiguous ZIP payload ${JSON.stringify(path)}`, async () => {
    await assert.rejects(collect(createBagZipStreamFromEntries([{ path, open: () => [] }])), BagError);
  });
}

test('duplicate, Unicode-equivalent and file/directory conflicts are rejected', async () => {
  for (const paths of [['a', 'a'], ['é', 'e\u0301'], ['a', 'a/b'], ['a/b', 'a']]) {
    await assert.rejects(collect(createBagZipStreamFromEntries(paths.map(path => ({ path, open: () => [] })))), BagError);
  }
});

test('ZIP destination inside payload is rejected, including symlink aliases', async t => {
  const source = await fixture(t);
  await assert.rejects(folderToBagZip(source, join(source, 'out.zip')), /outside the source/);
  const other = await fixture(t, {});
  await symlink(source, join(other, 'alias'), 'dir');
  await assert.rejects(folderToBagZip(source, join(other, 'alias/out.zip')), /outside the source/);
});

test('invalid ZIP options and source paths report errors', async t => {
  const dir = await fixture(t);
  assert.throws(() => createBagZipStream(dir, { compressionLevel: 10 }), RangeError);
  assert.throws(() => createBagZipStream(dir, { bagName: '../escape' }), BagError);
  assert.throws(() => createBagZipStream(dir, { checksums: [] }), BagError);
  await assert.rejects(collect(createBagZipStream(join(dir, 'absent'))), /does not exist/);
  await assert.rejects(folderToBagZip(dir, join(dir, '..', 'unused.zip'), { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
