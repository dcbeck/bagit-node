import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Bag, makeBag, makeTagManifests, folderToBagZip, createBagZipStreamFromEntries, CHECKSUM_ALGOS } from '../../dist/esm/index.js';
import { collect, fixture } from '../helpers.mjs';

const oracleScript = fileURLToPath(new URL('./oracle.py', import.meta.url));
export async function oracle(request) {
  const process = spawn('python3', [oracleScript], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.setEncoding('utf8').on('data', s => { stdout += s; });
  process.stderr.setEncoding('utf8').on('data', s => { stderr += s; });
  process.stdin.end(JSON.stringify(request));
  await new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  return JSON.parse(stdout);
}

const info = { 'Bagging-Date': '1970-01-01', 'Bag-Software-Agent': 'interop test', 'Contact-Name': ['Alice', 'Bob'], Unicode: 'ü ♡ 𐀀' };

for (const algorithms of [...CHECKSUM_ALGOS.map(a => [a]), ['sha256', 'sha512']]) {
  test(`byte-identical payload manifests and metadata with Python: ${algorithms}`, async t => {
    const nodeDir = await fixture(t, { 'z.bin': Buffer.from([0, 128, 255]), 'a.txt': 'hello', 'nested/ü\n.txt': 'unicode', ['Núñez.txt'.normalize('NFD')]: 'normalization' });
    const pythonDir = await fixture(t, {});
    await cp(nodeDir, pythonDir, { recursive: true });
    const bag = await makeBag(nodeDir, { bagInfo: info, checksums: algorithms });
    const reference = await oracle({ action: 'make', path: pythonDir, info, checksums: algorithms });
    assert(reference.valid);
    for (const path of ['bagit.txt', 'bag-info.txt', ...algorithms.map(a => `manifest-${a}.txt`)]) {
      assert.deepEqual(await readFile(join(nodeDir, path)), await readFile(join(pythonDir, path)), path);
    }
    // Tag-manifest line order depends on filesystem enumeration in Python.
    for (const a of algorithms) {
      const lines = async dir => (await readFile(join(dir, `tagmanifest-${a}.txt`), 'utf8')).trim().split('\n').sort();
      assert.deepEqual(await lines(nodeDir), await lines(pythonDir));
    }
    assert(await new Bag(pythonDir).validate());
    assert((await oracle({ action: 'validate', path: nodeDir })).valid);
    assert.deepEqual(JSON.parse(JSON.stringify(bag.entries)), reference.entries);
  });
}

test('stdlib zipfile extracts and Python validates a streaming ZIP64 bag', async t => {
  const source = await fixture(t);
  const output = await fixture(t, {});
  const extracted = await fixture(t, {});
  await folderToBagZip(source, join(output, 'bag.zip'), { bagName: 'export', bagInfo: info });
  const result = await oracle({ action: 'zip', path: join(output, 'bag.zip'), destination: extracted, bagName: 'export' });
  assert(result.valid);
  assert.equal(result.info['Payload-Oxum'], '25.3');
});

test('Python validates lazy root and nested tags with independent checksums', async t => {
  const output = await fixture(t, {});
  const extracted = await fixture(t, {});
  const tags = {
    'metadata.json': Buffer.from('{"id":123}'),
    'metadata/description.json': Buffer.from('{"description":"Grüße ♡"}'),
  };
  async function* tagFiles() {
    for (const [path, content] of Object.entries(tags)) yield { path, open: async () => [content] };
  }
  const path = join(output, 'bag.zip');
  await writeFile(path, await collect(createBagZipStreamFromEntries([
    { path: 'metadata.json', open: () => [Buffer.from('payload')] },
  ], { bagName: 'export/bag', bagInfo: info, tagFiles: tagFiles() })));
  const result = await oracle({ action: 'zip', path, destination: extracted, bagName: 'export/bag' });
  assert(result.valid);
  assert.equal(result.info['Payload-Oxum'], '7.1');
  for (const [name, bytes] of Object.entries(tags)) assert.deepEqual(await readFile(join(extracted, 'export/bag', name)), bytes);
  assert(await new Bag(join(extracted, 'export/bag')).validate());
});

test('Python and Node report the same checksum mismatch details', async t => {
  const source = await fixture(t, { a: 'hello' });
  const bag = await makeBag(source, { checksums: ['md5'] });
  await writeFile(join(source, 'data/a'), 'jello');
  const result = await oracle({ action: 'validate', path: source });
  assert.equal(result.valid, false);
  await assert.rejects(bag.validate(), error => {
    assert.equal(error.message, result.error);
    assert.deepEqual(error.details.map(e => e.toString()), result.details);
    return true;
  });
});

test('Python and Node agree on missing/unexpected payload and missing tags', async t => {
  const source = await fixture(t, { a: 'hello' });
  await makeBag(source, { checksums: ['md5'] });
  await rm(join(source, 'data/a'));
  await writeFile(join(source, 'data/b'), 'hello');
  await rm(join(source, 'bag-info.txt'));
  const result = await oracle({ action: 'validate', path: source });
  assert.equal(result.valid, false);
  await assert.rejects(new Bag(source).validate(), error => {
    assert.deepEqual(error.details.map(e => e.toString()).sort(), result.details.sort());
    return true;
  });
});
