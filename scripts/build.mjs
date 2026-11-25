import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--module', 'CommonJS', '--moduleResolution', 'Node', '--outDir', 'dist/cjs'], { stdio: 'inherit' });
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
