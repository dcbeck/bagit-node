import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Bag, makeBag, makeTagManifests, BagError, BagValidationError, ChecksumMismatch, FileMissing,
  UnexpectedFile, FileNormalizationConflict, CHECKSUM_ALGOS, BAG_DECLARATION,
  parseTagFile, serializeTagFile, buildUnicodeNormalizedLookupDict, encodeFilename, decodeFilename,
} from '../dist/esm/index.js';
import { fixture } from './helpers.mjs';

test('ESM and CommonJS expose the same public API', async t => {
  const commonjs = createRequire(import.meta.url)('bagit-node');
  assert.equal(typeof commonjs.makeBag, 'function');
  const dir = await fixture(t);
  const bag = await commonjs.makeBag(dir);
  assert(await bag.isValid());
  assert.deepEqual(Object.keys(commonjs).sort(), Object.keys(await import('bagit-node')).sort());
});

for (const algorithms of [...CHECKSUM_ALGOS.map(a => [a]), ['sha256', 'sha512'], ['md5', 'sha1', 'sha256']]) {
  test(`create, reopen and validate: ${algorithms.join(', ')}`, async t => {
    const dir = await fixture(t);
    const before = process.cwd();
    const bag = await makeBag(dir, { checksums: algorithms, concurrency: 2, bagInfo: { 'Contact-Name': 'Alice' } });
    assert.equal(process.cwd(), before);
    assert.equal(bag.toString(), dir);
    assert.equal(bag.info['Contact-Name'], 'Alice');
    assert.equal(bag.info['Payload-Oxum'], '25.3');
    assert.equal(await readFile(join(dir, 'bagit.txt'), 'utf8'), BAG_DECLARATION);
    assert.equal(Object.keys(bag.payloadEntries()).length, 3);
    for (const algorithm of algorithms) {
      const manifest = await readFile(join(dir, `manifest-${algorithm}.txt`), 'utf8');
      assert.equal(manifest.split('\n').filter(Boolean).length, 3);
      assert(manifest.includes('  data/nested/unicode-ü.txt\n'));
    }
    assert(await bag.validate({ concurrency: 2 }));
    assert(await new Bag(`${dir}/`).validate({ fast: true }));
    assert(await new Bag(dir).validate({ completenessOnly: true }));
  });
}

test('known upstream checksum and tag serialization', async t => {
  const dir = await fixture(t, { README: 'hello' });
  const bag = await makeBag(dir, { checksums: ['md5'], bagInfo: { 'Bagging-Date': '1970-01-01', 'Bag-Software-Agent': 'test', 'Contact-Email': 'a@b.c' } });
  assert.equal(await readFile(join(dir, 'manifest-md5.txt'), 'utf8'), '5d41402abc4b2a76b9719d911017c592  data/README\n');
  assert.equal(bag.entries['bagit.txt'].md5, 'eaa2c609ff6371712f623f5531945b44');
  assert(await bag.validate());
});

test('same-size corruption is detected only by full validation', async t => {
  const dir = await fixture(t, { x: 'hello' });
  const bag = await makeBag(dir, { checksums: ['md5'] });
  await writeFile(join(dir, 'data/x'), 'jello');
  assert(await bag.validate({ fast: true }));
  assert(await bag.validate({ completenessOnly: true }));
  await assert.rejects(bag.validate(), error => {
    assert(error instanceof BagValidationError);
    assert.equal(error.details.length, 1);
    const detail = error.details[0];
    assert(detail instanceof ChecksumMismatch);
    assert.equal(detail.path, 'data/x');
    assert.equal(detail.algorithm, 'md5');
    assert.equal(detail.expected, '5d41402abc4b2a76b9719d911017c592');
    assert.equal(detail.found, createHash('md5').update('jello').digest('hex'));
    assert(error.message.includes(detail.toString()));
    return true;
  });
  assert.equal(await bag.isValid(), false);
});

test('renames preserve oxum but fail completeness with structured details', async t => {
  const dir = await fixture(t, { a: 'abc' });
  const bag = await makeBag(dir);
  await rename(join(dir, 'data/a'), join(dir, 'data/b'));
  assert(await bag.validate({ fast: true }));
  await assert.rejects(bag.validate({ completenessOnly: true }), error => {
    assert(error.details.some(e => e instanceof FileMissing && e.path === 'data/a'));
    assert(error.details.some(e => e instanceof UnexpectedFile && e.path === 'data/b'));
    return true;
  });
});

for (const target of ['data', 'bagit.txt', 'manifest-sha256.txt', 'bag-info.txt']) {
  test(`missing ${target} is detected`, async t => {
    const dir = await fixture(t);
    const bag = await makeBag(dir, { checksums: ['sha256'] });
    await rm(join(dir, target), { recursive: true });
    await assert.rejects(bag.validate(), BagValidationError);
  });
}

test('missing oxum disables fast validation; extra root files are permitted', async t => {
  const dir = await fixture(t);
  const bag = await makeBag(dir);
  delete bag.info['Payload-Oxum'];
  await bag.save();
  await writeFile(join(dir, 'extra-tag'), 'permitted');
  await mkdir(join(dir, 'extra-dir'));
  assert(await bag.validate());
  await assert.rejects(bag.validate({ fast: true }), /Fast validation requires/);
});

test('save metadata preserves manifests and corruption evidence', async t => {
  const dir = await fixture(t, { a: 'abc' });
  const bag = await makeBag(dir);
  const manifest = await readFile(join(dir, 'manifest-sha256.txt'));
  await writeFile(join(dir, 'data/a'), 'bad');
  bag.info['Contact-Name'] = ['Alice', 'Bob'];
  await bag.save();
  assert.deepEqual(await readFile(join(dir, 'manifest-sha256.txt')), manifest);
  assert.deepEqual(new Bag(dir).info['Contact-Name'], ['Alice', 'Bob']);
  assert.equal(await bag.isValid(), false);
  await bag.save({ manifests: true });
  assert(await bag.validate());
  await writeFile(join(dir, 'data/new'), 'new');
  await rm(join(dir, 'data/a'));
  await bag.save({ manifests: true });
  assert.equal(bag.info['Payload-Oxum'], '3.1');
  assert.deepEqual(Object.keys(bag.payloadEntries()), ['data/new']);
  assert(await bag.validate());
});

test('metadata repeated values, Unicode, sanitization, unusual separators and folded lines', async t => {
  const dir = await fixture(t);
  const bag = await makeBag(dir, { bagInfo: { Multi: [7, 4, 8], Unicode: '♡ ü 𐀀', Test: 'foo\r\nbar' } });
  assert.deepEqual(bag.info.Multi, ['7', '4', '8']);
  assert.equal(bag.info.Unicode, '♡ ü 𐀀');
  assert.equal(bag.info.Test, 'foobar');
  const tags = parseTagFile('A: 1\r\nA:\t2\r\nA\t : 3\nFold: first\n second\n\tthird\n\n');
  assert.deepEqual(tags.A, ['1', '2', '3']);
  assert.equal(tags.Fold, 'first\n second\n\tthird');
  assert.equal(serializeTagFile({ B: 'b', A: ['x', 'y'] }), 'A: x\nA: y\nB: b\n');
  assert.throws(() => serializeTagFile({ 'Bad\nField': 'x' }), BagError);
});

for (const name of ['newline\n.txt', 'return\r.txt', 'space in name.txt', 'é.txt', '😀.txt', 'star*.txt']) {
  test(`special payload name ${JSON.stringify(name)}`, async t => {
    const dir = await fixture(t, { [name]: 'special' });
    const bag = await makeBag(dir);
    assert(await new Bag(dir).validate());
    assert(bag.entries[`data/${name}`]);
    assert.equal(decodeFilename(encodeFilename(name)), name);
  });
}

test('NFC manifests validate against NFD filesystem names', async t => {
  const name = 'Núñez Papers.txt'.normalize('NFD');
  const dir = await fixture(t, { [name]: 'unicode' });
  const bag = await makeBag(dir);
  for (const path of bag.manifestFiles()) await writeFile(path, (await readFile(path, 'utf8')).normalize('NFC'));
  await makeTagManifests(dir);
  assert(await new Bag(dir).validate());
  assert.throws(() => buildUnicodeNormalizedLookupDict(['é', 'e\u0301']), FileNormalizationConflict);
});

test('empty payloads and existing data directories are valid', async t => {
  const dir = await fixture(t, {});
  await mkdir(join(dir, 'data/empty/nested'), { recursive: true });
  const bag = await makeBag(dir);
  assert.equal(bag.info['Payload-Oxum'], '0.0');
  assert((await stat(join(dir, 'data/data/empty/nested'))).isDirectory());
  assert(await bag.validate());
});

test('case-insensitive checksums, comments and binary-mode manifest entries', async t => {
  const dir = await fixture(t, { x: 'hello' });
  await makeBag(dir, { checksums: ['md5'] });
  await writeFile(join(dir, 'manifest-md5.txt'), '\ufeff# comment\n\n5D41402ABC4B2A76B9719D911017C592 *data/x\nmalformed\n');
  await rm(join(dir, 'tagmanifest-md5.txt'));
  assert(await new Bag(dir).validate());
});

test('duplicate manifest entries are rejected in 1.0 and accepted in 0.97 if identical', async t => {
  const dir = await fixture(t, { x: 'hello' });
  await makeBag(dir, { checksums: ['md5'] });
  const line = await readFile(join(dir, 'manifest-md5.txt'), 'utf8');
  await writeFile(join(dir, 'manifest-md5.txt'), line + line);
  await rm(join(dir, 'tagmanifest-md5.txt'));
  assert.throws(() => new Bag(dir), /multiple times with the same value/);
  await writeFile(join(dir, 'bagit.txt'), BAG_DECLARATION.replace('1.0', '0.97'));
  assert(await new Bag(dir).validate());
  await writeFile(join(dir, 'manifest-md5.txt'), line + `0000  data/x\n`);
  assert.throws(() => new Bag(dir), /conflicting values/);
});

for (const path of ['../../../secrets.json', '~/.pgp/id_rsa', '/dev/null', 'data/../../../secrets.json', 'C:\\Windows\\cmd.exe', 'data/%0A/../../../outside']) {
  test(`unsafe manifest path ${JSON.stringify(path)} is rejected`, async t => {
    const dir = await fixture(t);
    await makeBag(dir, { checksums: ['md5'] });
    await writeFile(join(dir, 'manifest-md5.txt'), `abc ${path}\n`);
    assert.throws(() => new Bag(dir), BagError);
  });
}

test('external symlinks cannot be hashed via a manifest', async t => {
  const outside = await fixture(t, { secret: 'secret' });
  const dir = await fixture(t, { x: 'hello' });
  await makeBag(dir, { checksums: ['md5'] });
  await symlink(join(outside, 'secret'), join(dir, 'data/link'));
  await writeFile(join(dir, 'manifest-md5.txt'), 'abc data/link\n');
  assert.throws(() => new Bag(dir), /unsafe/);
});

test('fetch entries preserve filenames with spaces and identify missing payload', async t => {
  const dir = await fixture(t, { x: 'hello' });
  const bag = await makeBag(dir);
  await writeFile(join(dir, 'fetch.txt'), 'https://example.org/a - data/missing file\nfile:///tmp/a 5 data/x\n');
  await bag.save();
  assert.deepEqual([...bag.fetchEntries()], [['https://example.org/a', '-', 'data/missing file'], ['file:///tmp/a', '5', 'data/x']]);
  assert.deepEqual(bag.compareFetchWithFs(), ['data/missing file']);
  assert(await bag.validate());
  await writeFile(join(dir, 'fetch.txt'), '//example.org/a - data/a\n');
  assert.throws(() => bag.validateFetch(), /Malformed URL/);
  await writeFile(join(dir, 'fetch.txt'), 'https://example.org/a - /etc/passwd\n');
  assert.throws(() => [...bag.fetchEntries()], /unsafe/);
});

for (const version of ['0.93', '0.94', '0.95', '0.96', '0.97', '1.0']) {
  test(`read legacy BagIt ${version}`, async t => {
    const dir = await fixture(t, { x: 'hello' });
    await makeBag(dir);
    await writeFile(join(dir, 'bagit.txt'), BAG_DECLARATION.replace('1.0', version));
    await rm(join(dir, 'tagmanifest-sha256.txt'));
    await rm(join(dir, 'tagmanifest-sha512.txt'));
    if (Number(version) <= 0.95) await rename(join(dir, 'bag-info.txt'), join(dir, 'package-info.txt'));
    assert(await new Bag(dir).validate());
  });
}

for (const version of ['a.b', '2.', '0.1.2', '1.2.3', '2.0', '0.92']) {
  test(`reject invalid or unsupported version ${version}`, async t => {
    const dir = await fixture(t, { 'bagit.txt': BAG_DECLARATION.replace('1.0', version) });
    assert.throws(() => new Bag(dir), BagError);
  });
}

test('bad declarations and encodings report useful errors', async t => {
  const dir = await fixture(t, {});
  assert.throws(() => new Bag(dir), /Expected bagit.txt does not exist/);
  await writeFile(join(dir, 'bagit.txt'), '');
  assert.throws(() => new Bag(dir), /Missing required tag/);
  await writeFile(join(dir, 'bagit.txt'), BAG_DECLARATION + 'garbage\n');
  assert.throws(() => new Bag(dir), /contains invalid tag/);
  await writeFile(join(dir, 'bagit.txt'), BAG_DECLARATION.replace('UTF-8', 'WTF-8'));
  assert.throws(() => new Bag(dir), /Unsupported encoding: WTF-8/);
});

for (const encoding of ['ISO-8859-1', 'UTF-16', 'UTF-16-LE', 'UTF-16-BE']) {
  test(`read and save legacy ${encoding} tag files`, async t => {
    const dir = await fixture(t, { 'ü.txt': 'hello' });
    const bag = await makeBag(dir, { checksums: ['sha256'], bagInfo: { Name: 'Grüße' } });
    const encode = text => {
      if (encoding === 'ISO-8859-1') return Buffer.from(text, 'latin1');
      const bytes = Buffer.from(text, 'utf16le');
      if (encoding === 'UTF-16') return Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
      return encoding === 'UTF-16-BE' ? bytes.swap16() : bytes;
    };
    for (const path of [join(dir, 'bag-info.txt'), ...bag.manifestFiles()]) await writeFile(path, encode(await readFile(path, 'utf8')));
    await writeFile(join(dir, 'bagit.txt'), BAG_DECLARATION.replace('UTF-8', encoding));
    await rm(join(dir, 'tagmanifest-sha256.txt'));
    const reopened = new Bag(dir);
    assert.equal(reopened.info.Name, 'Grüße');
    assert(await reopened.validate());
    reopened.info.Name = 'Bücher';
    await reopened.save({ manifests: true });
    assert.equal(new Bag(dir).info.Name, 'Bücher');
    assert(await new Bag(dir).validate());
  });
}

test('bagit.txt BOM is readable but invalid', async t => {
  const dir = await fixture(t);
  await makeBag(dir);
  await writeFile(join(dir, 'bagit.txt'), '\ufeff' + BAG_DECLARATION);
  await assert.rejects(new Bag(dir).validate(), /must not contain a byte-order mark/);
});

test('multiple oxums use the first value, malformed oxums are rejected', async t => {
  const dir = await fixture(t);
  const bag = await makeBag(dir);
  bag.info['Payload-Oxum'] = [bag.info['Payload-Oxum'], '7.7'];
  assert(await bag.validate({ fast: true }));
  bag.info['Payload-Oxum'] = 'bad';
  await assert.rejects(bag.validate(), /Malformed Payload-Oxum/);
});

test('optional nested tags are hashed, missing tags are detected', async t => {
  const dir = await fixture(t);
  const bag = await makeBag(dir);
  await mkdir(join(dir, 'tags/nested'), { recursive: true });
  await writeFile(join(dir, 'tags/nested/tag'), 'metadata');
  await bag.save();
  assert(bag.tagfileEntries()['tags/nested/tag']);
  assert(await bag.validate());
  await writeFile(join(dir, 'tags/nested/tag'), 'corrupt!');
  await assert.rejects(bag.validate(), /Bag validation failed/);
  await rm(join(dir, 'tags/nested/tag'));
  await assert.rejects(bag.validate(), /exists in manifest but was not found/);
});

test('unsupported algorithm errors before changing source', async t => {
  const dir = await fixture(t, { a: 'safe' });
  await assert.rejects(makeBag(dir, { checksums: ['nonexistent'] }), BagError);
  assert.equal(await readFile(join(dir, 'a'), 'utf8'), 'safe');
  const bag = await makeBag(dir, { checksums: ['nonexistent', 'sha256'] });
  assert.deepEqual(bag.algorithms, ['sha256']);
});

test('abort propagates and invalid concurrency is rejected', async t => {
  const dir = await fixture(t);
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(makeBag(dir, { signal }), /cancelled/);
  await assert.rejects(makeBag(dir, { concurrency: 0 }), RangeError);
  const bag = await makeBag(dir);
  await assert.rejects(bag.validate({ signal }), /cancelled/);
  await assert.rejects(bag.save({ signal }), /cancelled/);
});

test('directory mode is preserved and unreadable files fail validation', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const dir = await fixture(t);
  await chmod(dir, 0o751);
  const bag = await makeBag(dir);
  assert.equal((await stat(join(dir, 'data'))).mode & 0o777, 0o751);
  const file = join(dir, 'data/hello.txt');
  await chmod(file, 0);
  await assert.rejects(bag.validate(), BagValidationError);
});
