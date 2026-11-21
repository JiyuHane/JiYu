import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const require = createRequire(path.join(root, 'packages/protocol/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: protobufVitePlugin } = await import(
  pathToFileURL(require.resolve('@snowluma/proton/vite')).href
);
const outDir = path.join(root, 'node_modules/.cache/jiyu-direct-login');
await build({
  configFile: false,
  root,
  plugins: [protobufVitePlugin()],
  build: {
    target: 'node24',
    outDir,
    emptyOutDir: false,
    minify: false,
    lib: { entry: path.join(directory, 'cli.ts'), formats: ['es'], fileName: () => 'runner.mjs' },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
console.log('Built node_modules/.cache/jiyu-direct-login/runner.mjs (no login performed).');
