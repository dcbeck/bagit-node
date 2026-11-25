// JSON-lines transport for the unmodified upstream Python tests. All bag operations run in Node.
import { createInterface } from 'node:readline';
import { Bag, makeBag, makeTagManifests } from '../../dist/esm/index.js';

const bags = new Map();
let next = 0;
function snapshot(bag, id) {
  return { id, path: bag.path, tags: bag.tags, info: bag.info, entries: bag.entries,
    algorithms: bag.algorithms, encoding: bag.encoding, tag_file_name: bag.tagFileName,
    version: bag.version, version_info: bag.versionInfo };
}
function errorData(error) {
  return { name: error.name, message: error.message, path: error.path, algorithm: error.algorithm,
    expected: error.expected, found: error.found, details: error.details?.map(errorData) };
}
for await (const line of createInterface({ input: process.stdin, terminal: false })) {
  try {
    const request = JSON.parse(line);
    let result;
    if (request.action === 'open' || request.action === 'make') {
      const bag = request.action === 'open' ? new Bag(request.path) : await makeBag(request.path, request.options);
      const id = next++;
      bags.set(id, bag);
      result = snapshot(bag, id);
    } else if (request.action === 'tagmanifests') {
      await makeTagManifests(request.path, request.algorithms, request.encoding);
      result = null;
    } else {
      const bag = bags.get(request.id);
      if (request.info) bag.info = request.info;
      if (request.entries) bag.entries = request.entries;
      if (request.method === 'save') {
        await bag.save(request.options);
        result = snapshot(bag, request.id);
      } else {
        result = await bag[request.method](...(request.args ?? []));
        if (result && typeof result.next === 'function') result = [...result];
      }
    }
    process.stdout.write(JSON.stringify({ result: result ?? null }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: errorData(error) }) + '\n'); }
}
