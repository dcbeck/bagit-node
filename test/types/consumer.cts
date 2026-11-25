import bagit = require('bagit-node');
import { Readable, Writable } from 'node:stream';

const options: bagit.MakeBagOptions = { bagInfo: { Multi: ['one', 'two'] }, concurrency: 2 };
const instance: bagit.Bag = new bagit.Bag('existing-bag');
const made: Promise<bagit.Bag> = bagit.makeBag('source', options);
const stream: Readable = bagit.createBagZipStream('source');
const saved: Promise<bagit.BagZipResult> = bagit.folderToBagZip('source', new Writable());
void [instance, made, stream, saved];
