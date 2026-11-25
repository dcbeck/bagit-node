import {
  Bag, makeBag, createBagZipStream, createBagZipStreamFromEntries, folderToBagZip, folderToBagitZip,
  type BagZipEntry, type BagZipOptions, type MakeBagOptions,
} from 'bagit-node';
import { Readable, Writable } from 'node:stream';

const makeOptions: MakeBagOptions = { checksums: ['sha256'], bagInfo: { Count: 7 } };
const entries: BagZipEntry[] = [{ path: 'hello.txt', open: async () => Readable.from([Buffer.from('hello')]) }];
const zipOptions: BagZipOptions = {
  tagFiles: entries,
  onProgress(progress) { const count: bigint = progress.totalBytes; void count; },
};
const asyncOptions: BagZipOptions = { tagFiles: (async function* () { yield* entries; })() };
const a: Readable = createBagZipStream('source', zipOptions);
const b: Readable = createBagZipStreamFromEntries(entries, zipOptions);
const bag: Promise<Bag> = makeBag('source', makeOptions);
const write: Promise<bigint> = folderToBagZip('source', new Writable(), zipOptions).then(r => r.bytesWritten);
const alias: Promise<bigint> = folderToBagitZip('source', new Writable(), asyncOptions).then(r => r.bytesWritten);
void [a, b, bag, write, alias];
