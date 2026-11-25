import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { createBagZipStreamFromEntries } from '../../dist/esm/index.js';
import { fixture } from '../helpers.mjs';

async function inspectZip(path) {
  const script = `import sys,zipfile,json
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps({"count":len(z.infolist()), "first":z.infolist()[1].file_size, "last":z.infolist()[-1].filename}))
`;
  const child = spawn('python3', ['-c', script, path]);
  let out = '', err = '';
  child.stdout.on('data', s => out += s);
  child.stderr.on('data', s => err += s);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
  });
  return JSON.parse(out);
}

test('ZIP64 supports a payload file larger than 4 GiB without staging its bytes', { timeout: 180000 }, async t => {
  const dir = await fixture(t, {});
  const spool = await fixture(t, {});
  const chunk = Buffer.alloc(1024 * 1024);
  const size = 4096n * BigInt(chunk.length) + 7n;
  const entries = [{ path: 'huge.bin', open: () => (async function* () {
    for (let i = 0; i < 4096; i++) yield chunk;
    yield Buffer.alloc(7);
  })() }];
  const path = join(dir, 'large.zip');
  let reported;
  await pipeline(createBagZipStreamFromEntries(entries, { checksums: ['sha256'], compressionLevel: 1, tempDirectory: spool, onProgress: p => { reported = p.bytes; } }), createWriteStream(path));
  assert.equal(reported, size);
  const result = await inspectZip(path);
  assert.equal(result.first, Number(size));
  assert.deepEqual(await readdir(spool), []);
});

test('ZIP64 supports more than 65,535 entries', { timeout: 180000 }, async t => {
  const dir = await fixture(t, {});
  async function* entries() {
    for (let i = 0; i < 65536; i++) yield { path: `empty-${i}`, open: () => [] };
  }
  const path = join(dir, 'many.zip');
  await pipeline(createBagZipStreamFromEntries(entries(), { checksums: ['sha256'] }), createWriteStream(path));
  const result = await inspectZip(path);
  assert.equal(result.count, 65541);
  assert.equal(result.last, 'tagmanifest-sha256.txt');
});
