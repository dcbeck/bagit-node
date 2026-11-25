import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import {
  Bag, BagError, createBagZipStream, createBagZipStreamFromEntries,
  folderToBagZip, folderToBagitZip,
} from '../dist/esm/index.js';
import { collect, extract, fixture, unzip } from './helpers.mjs';

const lazy = (path, bytes = Buffer.from('tag')) => ({ path, open: () => [bytes] });
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
function manifest(bytes) {
  return Object.fromEntries(bytes.toString().trim().split('\n').filter(Boolean).map(line => {
    const [, hash, path] = /^(\S+) +(.+)$/.exec(line);
    return [path.replace(/%0A/g, '\n').replace(/%0D/g, '\r'), hash];
  }));
}

for (const bagName of [undefined, 'export/my-bag']) {
  for (const checksums of [['sha256', 'sha512'], ['md5', 'sha1']]) {
    test(`custom root and nested tags validate with ${checksums}, prefix ${bagName}`, async t => {
      const tempDirectory = await fixture(t, {});
      const destination = await fixture(t, {});
      const payload = Buffer.from('payload');
      const custom = new Map([
        ['metadata.json', Buffer.from('{"id":123}')],
        ['metadata/description.json', Buffer.from('{"description":"Grüße ♡"}')],
        ['metadata/ü\n.bin', Buffer.from([0, 1, 128, 255])],
        ['metadata/empty', Buffer.alloc(0)],
      ]);
      const progress = [];
      const bytes = await collect(createBagZipStreamFromEntries([lazy('metadata.json', payload)], {
        bagName, checksums, tempDirectory,
        tagFiles: [...custom].map(([path, bytes]) => lazy(path, bytes)),
        onProgress: p => progress.push(p),
      }));
      const prefix = bagName ? `${bagName}/` : '';
      const entries = new Map([...unzip(bytes)].map(([path, bytes]) => {
        assert(path.startsWith(prefix));
        return [path.slice(prefix.length), bytes];
      }));
      for (const [path, content] of custom) assert.deepEqual(entries.get(path), content);
      assert.deepEqual(entries.get('data/metadata.json'), payload);
      const expectedTags = [...custom.keys(), 'bagit.txt', 'bag-info.txt', ...checksums.map(a => `manifest-${a}.txt`)];
      for (const a of checksums) {
        assert.deepEqual(manifest(entries.get(`manifest-${a}.txt`)), { 'data/metadata.json': digest(a, payload) });
        const tags = manifest(entries.get(`tagmanifest-${a}.txt`));
        assert.deepEqual(Object.keys(tags).sort(), expectedTags.sort());
        for (const path of expectedTags) assert.equal(tags[path], digest(a, entries.get(path)), `${a}: ${path}`);
      }
      assert.equal(progress.length, 1);
      assert.equal(progress[0].path, 'metadata.json');
      assert.equal(progress[0].bytes, 7n);
      assert.equal(progress[0].totalBytes, 7n);
      assert.equal(progress[0].totalFiles, 1);
      await extract(bytes, destination);
      const bag = new Bag(bagName ? join(destination, bagName) : destination);
      assert.equal(bag.info['Payload-Oxum'], '7.1');
      assert(await bag.validate());
      assert.deepEqual(await readdir(tempDirectory), []);
    });
  }
}

test('all folder exports and their CommonJS equivalents accept tagFiles', async t => {
  const source = await fixture(t, { file: 'hello' });
  const cjs = createRequire(import.meta.url)('bagit-node');
  for (const api of [{ createBagZipStream, createBagZipStreamFromEntries, folderToBagZip, folderToBagitZip }, cjs]) {
    const options = () => ({ tagFiles: [lazy('metadata.json')] });
    assert.equal(unzip(await collect(api.createBagZipStream(source, options()))).get('metadata.json').toString(), 'tag');
    assert.equal(unzip(await collect(api.createBagZipStreamFromEntries([], options()))).get('metadata.json').toString(), 'tag');
    for (const write of [api.folderToBagZip, api.folderToBagitZip]) {
      const dest = await fixture(t, {});
      const path = join(dest, 'bag.zip');
      const result = await write(source, path, options());
      assert.equal(result.payloadBytes, 5n);
      assert.equal(result.payloadFiles, 1);
      assert.equal(result.bagInfo['Payload-Oxum'], '5.1');
      assert.equal(unzip(await readFile(path)).get('metadata.json').toString(), 'tag');
    }
  }
});

for (const path of [
  '', '../escape', '/absolute', 'a/../b', 'C:/Windows/a', 'a\\b', 'a//b', '~user/a',
  'nul\0', 'name%0A.txt', 'name%0d.txt', 'trailing ', ' leading', '\tleading', '*metadata.json', '**metadata.json', 'data', 'data/file',
  'bagit.txt', 'bag-info.txt', 'bagit.txt/child', 'bag-info.txt/child',
  'manifest-sha256.txt', 'manifest-sha512.txt/child', 'tagmanifest-sha256.txt',
  'tagmanifest-sha512.txt/child', 'tagmanifest-md5.txt', 'manifest-md5.txt',
]) {
  test(`reject unsafe or reserved tag path ${JSON.stringify(path)} before opening`, async t => {
    const tempDirectory = await fixture(t, {});
    let opened = false;
    await assert.rejects(collect(createBagZipStreamFromEntries([], {
      tempDirectory, tagFiles: [{ path, open() { opened = true; return []; } }],
    })), BagError);
    assert.equal(opened, false);
    assert.deepEqual(await readdir(tempDirectory), []);
  });
}

test('tag duplicates, Unicode equivalents and file/directory collisions fail', async () => {
  for (const entries of [
    [lazy('a'), lazy('a')], [lazy('é'), lazy('e\u0301')],
    [lazy('a'), lazy('a/b')], [lazy('a/b'), lazy('a')],
    [lazy('é'), lazy('e\u0301/b')], [lazy('é/b'), lazy('e\u0301')],
    [{ ...lazy('a'), directory: true }, lazy('a')],
    [lazy('a'), { ...lazy('a'), directory: true }],
    [{ ...lazy('data'), directory: true }], [{ ...lazy('bagit.txt'), directory: true }],
  ]) {
    await assert.rejects(collect(createBagZipStreamFromEntries([], { tagFiles: entries })), BagError);
  }
});

test('tag directories preserve empty paths without opening sources or adding hashes', async t => {
  const directory = { path: 'metadata', directory: true, open() { throw new Error('directory opened'); } };
  const bytes = await collect(createBagZipStreamFromEntries([], { tagFiles: [directory, lazy('metadata/description.json')] }));
  const entries = unzip(bytes);
  assert(entries.has('metadata/'));
  assert(!('metadata' in manifest(entries.get('tagmanifest-sha256.txt'))));
  assert.equal(entries.get('manifest-sha256.txt').length, 0);
  const dest = await fixture(t, {});
  await extract(bytes, dest);
  assert.equal(new Bag(dest).info['Payload-Oxum'], '0.0');
  assert(await new Bag(dest).validate());
});

test('async tag iterables and sources open lazily and sequentially after payload progress', async () => {
  const events = [];
  let active = 0;
  async function* tags() {
    events.push('tags');
    for (const path of ['metadata.json', 'metadata/description.json']) {
      yield { path, async open() {
        assert.equal(active++, 0);
        events.push(`open:${path}`);
        return (async function* () {
          try { yield new Uint8Array([0, 255]); await setTimeout(1); yield Buffer.from('end'); }
          finally { active--; events.push(`close:${path}`); }
        })();
      } };
    }
  }
  const stream = createBagZipStreamFromEntries([lazy('payload')], {
    tagFiles: tags(), onProgress() { events.push('payload'); },
  });
  assert.deepEqual(events, []);
  await collect(stream);
  assert.deepEqual(events, ['payload', 'tags', 'open:metadata.json', 'close:metadata.json', 'open:metadata/description.json', 'close:metadata/description.json']);
});

test('tag streaming bounds read-ahead under backpressure and cleans up on consumer cancellation', async t => {
  const tempDirectory = await fixture(t, {});
  let reads = 0;
  let closed = false;
  let opened = false;
  const stream = createBagZipStreamFromEntries([], { tempDirectory, tagFiles: [
    { path: 'large', open: () => (async function* () {
      try { for (let i = 0; i < 2000; i++) { reads++; yield randomBytes(65536); } }
      finally { closed = true; }
    })() },
    { path: 'later', open() { opened = true; return []; } },
  ] });
  assert.equal(reads, 0);
  stream.read(1);
  await setTimeout(100);
  assert(reads > 0);
  assert(reads < 100, `tag source read ahead ${reads} chunks without a consumer`);
  assert.equal(opened, false);
  const spools = await readdir(tempDirectory);
  assert.equal(spools.length, 1);
  assert.deepEqual((await readdir(join(tempDirectory, spools[0]))).sort(), ['manifest-sha256.txt', 'manifest-sha512.txt']);
  await stream[Symbol.asyncDispose]();
  assert(closed);
  assert.deepEqual(await readdir(tempDirectory), []);
});

for (const cancel of ['signal', 'consumer']) {
  test(`${cancel} cancellation destroys a tag Readable waiting for bytes`, { timeout: 5000 }, async t => {
    const tempDirectory = await fixture(t, {});
    const controller = new AbortController();
    let notify;
    const opened = new Promise(resolve => { notify = resolve; });
    const source = new Readable({ read() {} });
    let laterOpened = false;
    const stream = createBagZipStreamFromEntries([], {
      signal: controller.signal, tempDirectory, tagFiles: [
        { path: 'stalled', open() { notify(); return source; } },
        { path: 'later', open() { laterOpened = true; return []; } },
      ],
    });
    const done = collect(stream);
    const rejected = assert.rejects(done, /abort|premature close/i);
    await opened;
    if (cancel === 'signal') controller.abort();
    else stream.destroy();
    await rejected;
    await stream[Symbol.asyncDispose]().catch(() => {});
    assert(source.destroyed);
    assert.equal(laterOpened, false);
    assert.deepEqual(await readdir(tempDirectory), []);
  });
}

for (const failure of ['open throws', 'open rejects', 'Readable error', 'iterator error', 'invalid chunk']) {
  test(`tag ${failure} propagates and removes spool files`, async t => {
    const tempDirectory = await fixture(t, {});
    let source;
    const entry = { path: 'bad', open() {
      if (failure === 'open throws') throw new Error('tag failed');
      if (failure === 'open rejects') return Promise.reject(new Error('tag failed'));
      if (failure === 'Readable error') {
        source = new Readable({ read() { this.push(Buffer.from('start')); this.destroy(new Error('tag failed')); } });
        return source;
      }
      return (async function* () {
        yield Buffer.from('start');
        if (failure === 'invalid chunk') yield 'invalid';
        else throw new Error('tag failed');
      })();
    } };
    let laterOpened = false;
    await assert.rejects(collect(createBagZipStreamFromEntries([], {
      tempDirectory, tagFiles: [entry, { path: 'later', open() { laterOpened = true; return []; } }],
    })), failure === 'invalid chunk' ? /Uint8Array/ : /tag failed/);
    if (source) assert(source.destroyed);
    assert.equal(laterOpened, false);
    assert.deepEqual(await readdir(tempDirectory), []);
  });
}

test('destination failure during a tag closes its source and removes spools', async t => {
  const source = await fixture(t, {});
  const tempDirectory = await fixture(t, {});
  let input;
  const output = new Writable({ write(chunk, encoding, callback) {
    callback(input ? new Error('destination failed') : undefined);
  } });
  await assert.rejects(folderToBagZip(source, output, { tempDirectory, tagFiles: [{ path: 'large', open() {
    input = new Readable({ read() { this.push(randomBytes(65536)); } });
    return input;
  } }] }), /destination failed/);
  assert(input.destroyed);
  assert.deepEqual(await readdir(tempDirectory), []);
});

test('tag failures preserve an existing atomic file destination', async t => {
  const source = await fixture(t, {});
  const dest = await fixture(t, { 'bag.zip': 'previous' });
  const tempDirectory = await fixture(t, {});
  await assert.rejects(folderToBagitZip(source, join(dest, 'bag.zip'), {
    tempDirectory, tagFiles: [{ path: 'bad', open() { throw new Error('tag failed'); } }],
  }), /tag failed/);
  assert.equal(await readFile(join(dest, 'bag.zip'), 'utf8'), 'previous');
  assert.deepEqual(await readdir(dest), ['bag.zip']);
  assert.deepEqual(await readdir(tempDirectory), []);
});
