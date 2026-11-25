import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

export async function fixture(t, files = { 'hello.txt': 'Hello, world!\n', 'nested/unicode-ü.txt': 'Grüße ♡', 'empty.bin': '' }) {
  const dir = await mkdtemp(join(tmpdir(), 'bagit-node-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}
export async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
// Independent decoder uses the central directory, not the writer's data descriptors.
export function unzip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let count = bytes.readUInt16LE(end + 10);
  let position = bytes.readUInt32LE(end + 16);
  if (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50) {
    const zip64 = Number(bytes.readBigUInt64LE(end - 12));
    assert.equal(bytes.readUInt32LE(zip64), 0x06064b50);
    count = Number(bytes.readBigUInt64LE(zip64 + 32));
    position = Number(bytes.readBigUInt64LE(zip64 + 48));
  }
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const name = bytes.subarray(position + 46, position + 46 + nameLength).toString();
    let size = bytes.readUInt32LE(position + 24);
    let compressed = bytes.readUInt32LE(position + 20);
    let offset = bytes.readUInt32LE(position + 42);
    for (let extra = position + 46 + nameLength; extra < position + 46 + nameLength + extraLength;) {
      const tag = bytes.readUInt16LE(extra);
      const length = bytes.readUInt16LE(extra + 2);
      if (tag === 1) {
        let p = extra + 4;
        if (size === 0xffffffff) { size = Number(bytes.readBigUInt64LE(p)); p += 8; }
        if (compressed === 0xffffffff) { compressed = Number(bytes.readBigUInt64LE(p)); p += 8; }
        if (offset === 0xffffffff) offset = Number(bytes.readBigUInt64LE(p));
      }
      extra += 4 + length;
    }
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const dataStart = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(dataStart, dataStart + compressed);
    const method = bytes.readUInt16LE(position + 10);
    assert([0, 8].includes(method));
    const content = method === 8 ? inflateRawSync(data) : data;
    assert.equal(content.length, size);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32LE(position + 16), `CRC mismatch: ${name}`);
    assert(!entries.has(name), `duplicate ZIP entry: ${name}`);
    entries.set(name, content);
    position += 46 + nameLength + extraLength + bytes.readUInt16LE(position + 32);
  }
  return entries;
}
export async function extract(bytes, directory) {
  for (const [path, content] of unzip(bytes)) {
    if (path.endsWith('/')) await mkdir(join(directory, path), { recursive: true });
    else {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), content);
    }
  }
}
