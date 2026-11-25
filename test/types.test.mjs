import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('TypeScript declarations resolve for both ESM and CommonJS consumers', async () => {
  await promisify(execFile)(process.execPath, [
    'node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    'test/types/consumer.mts', 'test/types/consumer.cts',
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
});
