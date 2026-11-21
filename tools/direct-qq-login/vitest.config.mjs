import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const require = createRequire(path.join(root, 'packages/protocol/package.json'));
const { default: protobufVitePlugin } = await import(
  pathToFileURL(require.resolve('@snowluma/proton/vite')).href
);
export default {
  root,
  plugins: [protobufVitePlugin()],
  resolve: {
    alias: [
      {
        find: 'vitest',
        replacement: path.join(
          path.dirname(require.resolve('vitest/package.json')),
          'dist/index.js',
        ),
      },
      { find: /^@snowluma\/proton$/, replacement: require.resolve('@snowluma/proton') },
    ],
  },
  test: {
    include: ['tools/direct-qq-login/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 10000,
  },
};
