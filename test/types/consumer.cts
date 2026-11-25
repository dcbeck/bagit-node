import bagit = require('bagit-node');
import { Readable, Writable } from 'node:stream';

const options: bagit.MakeBagOptions = { bagInfo: { Multi: ['one', 'two'] }, concurrency: 2 };
const instance: bagit.Bag = new bagit.Bag('existing-bag');
const made: Promise<bagit.Bag> = bagit.makeBag('source', options);
const stream: Readable = bagit.createBagZipStream('source');
const saved: Promise<bagit.BagZipResult> = bagit.folderToBagZip('source', new Writable());
const tags: bagit.BagZipEntry[] = [{ path: 'metadata.json', open: () => [Buffer.from('{}')] }];
const zipOptions: bagit.BagZipOptions = { tagFiles: tags };
const lazy: Readable = bagit.createBagZipStreamFromEntries([], zipOptions);
const folder: Readable = bagit.createBagZipStream('source', zipOptions);
const asyncOptions: bagit.BagZipOptions = { tagFiles: (async function* () { yield* tags; })() };
const alias: Promise<bagit.BagZipResult> = bagit.folderToBagitZip('source', new Writable(), asyncOptions);
const tagged: Promise<bagit.BagZipResult> = bagit.folderToBagZip('source', new Writable(), zipOptions);
void [instance, made, stream, saved, lazy, folder, alias, tagged];
