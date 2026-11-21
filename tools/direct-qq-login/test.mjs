import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const require = createRequire(path.join(root, 'packages/protocol/package.json'));
const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const child = spawn(
  process.execPath,
  [cli, 'run', '--config', path.join(directory, 'vitest.config.mjs'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', shell: false },
);
child.on('error', () => {
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
