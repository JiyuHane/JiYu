import protobufVitePlugin from '@snowluma/proton/vite';
import fs from 'fs';
import { builtinModules } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, PluginOption, UserConfig } from 'vite';
import cp from 'vite-plugin-cp';
import { sqliteBuildPlugin } from '@snowluma/sqlite/vite';
import { APP_VERSION } from '@snowluma/common/version';
import runtimePackage from '../runtime/package.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const distDir = path.resolve(repoRoot, 'dist');
const runtimeDir = path.resolve(repoRoot, 'packages', 'runtime');
const nativeDir = path.resolve(runtimeDir, 'native');

// vite-plugin-cp consumes globs through globby; on Windows we must use POSIX-style separators.
const toPosix = (p: string) => p.replace(/\\/g, '/');

// `@snowluma/websocket` is bundled — it's an
// in-tree TS workspace wrapper that routes its native `.node`
// addon through `dist/native/`. Only Node builtins stay external.
//
const nodeModules = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)].flat();

const runtimeSrc = toPosix(runtimeDir);
const nativeSrc = toPosix(nativeDir);

// Target selection: `SNOWLUMA_TARGET=<platform>-<arch>` overrides the host
// detection, enabling cross-target packaging on CI.
const targetTriple = process.env.SNOWLUMA_TARGET ?? `${process.platform}-${process.arch}`;
const [targetPlatform, targetArch] = targetTriple.split('-');

// Runtime scaffolding files copied into dist/. Windows and Linux use different
// launchers, while both targets ship their matching QQ integration binaries.
const runtimeDistFiles = [
    'check-node-version.cjs',
    targetPlatform === 'win32' ? 'launcher.bat' : 'launcher.sh',
];
const agreementFiles = ['EULA.md', 'PRIVACY.md'];
// Distributed alongside the agreements, but not additional consent items.
const noticeFiles = ['LICENSE', 'JIYU_NOTICE.md'];
const releaseDocuments = [...agreementFiles, ...noticeFiles];

// Native binaries shipped for the selected target:
//   * `snowluma-*.{dll,node,so}`           – NTQQ hook (Windows + Linux).
//   * `websocket-*.node`                   – RFC 6455 framing/mask addon (all platforms).
const nativeFiles = [
    `websocket-${targetTriple}.node`,
    ...(targetPlatform === 'win32'
        ? [`snowluma-${targetTriple}.dll`, `snowluma-${targetTriple}.node`]
        : []),
    ...(targetPlatform === 'linux'
        ? [`snowluma-${targetTriple}.node`, `snowluma-${targetTriple}.so`]
        : []),
];

// FFmpeg native addon ported from NapCat. Uses NapCat's
// `<platform>.<arch>` naming so the prebuilt binaries can be vendored
// as-is without renaming. Lives under `native/ffmpeg/` to keep it
// separate from the SnowLuma flat-naming addons above.
const ffmpegAddonFile = `ffmpegAddon.${targetPlatform}.${targetArch}.node`;
const ffmpegSrcDir = path.resolve(nativeDir, 'ffmpeg');

// Fail fast if any expected native binary is missing from packages/runtime/native/.
// vite-plugin-cp only emits a warning on missing source files; we want a hard
// error so CI can't accidentally ship an incomplete archive.
const missingNatives = nativeFiles.filter((f) => !fs.existsSync(path.join(nativeDir, f)));

if (!fs.existsSync(path.join(ffmpegSrcDir, ffmpegAddonFile))) {
    missingNatives.push(`ffmpeg/${ffmpegAddonFile}`);
}

if (missingNatives.length > 0) {
    throw new Error(
        `Missing native binaries for target ${targetTriple}:\n` +
            missingNatives.map((f) => `  - ${path.join(nativeDir, f)}`).join('\n'),
    );
}

// Agreements and their linked project notice and license must all ship together.
// Missing agreements would also silently disable the WebUI consent gate.
const missingDocuments = releaseDocuments.filter((f) => !fs.existsSync(path.resolve(repoRoot, f)));

if (missingDocuments.length > 0) {
    throw new Error(
        `Missing release documents:\n` +
            missingDocuments.map((f) => `  - ${path.resolve(repoRoot, f)}`).join('\n'),
    );
}

const BaseConfigPlugin: PluginOption[] = [
    {
        name: 'release-metadata',
        generateBundle(_options, bundle) {
            const entry = bundle['index.mjs'];

            if (entry?.type !== 'chunk' || entry.imports.some((id) => !nodeModules.includes(id))) {
                this.error('The update entry must only import Node builtins.');
            }

            this.emitFile({
                type: 'asset',
                fileName: 'package.json',
                source: JSON.stringify({ ...runtimePackage, version: APP_VERSION }, null, 2) + '\n',
            });

            if (process.env.BUILD_WEBUI === 'true') {
                const entries = [
                    ...new Set([
                        ...Object.keys(bundle).map((file) => file.split('/')[0]),
                        ...runtimeDistFiles,
                        ...releaseDocuments,
                        'native',
                        'client',
                        'package.json',
                        'release.json',
                    ]),
                ].sort();
                this.emitFile({
                    type: 'asset',
                    fileName: 'release.json',
                    source:
                        JSON.stringify(
                            { version: APP_VERSION, target: targetTriple, entries },
                            null,
                            2,
                        ) + '\n',
                });
            }
        },
    },
    // Proton substitutes every `protobuf_encode<T>` / `protobuf_decode<T>`
    // call site with a monomorphized codec at build time. WITHOUT this
    // plugin in the plugins array the runtime fallback in
    // `@snowluma/proton/runtime.ts` throws on the first call (and the
    // packaged Win/Linux release does exactly that). It MUST appear
    // before `cp` so the transform runs on every source file Vite asks
    // for, regardless of where `cp` later copies emitted assets.
    protobufVitePlugin(),
    sqliteBuildPlugin(targetTriple),
    cp({
        targets: [
            ...runtimeDistFiles.map((file) => ({
                src: `${runtimeSrc}/${file}`,
                dest: distDir,
                flatten: true,
            })),
            ...nativeFiles.map((f) => ({
                src: `${nativeSrc}/${f}`,
                dest: path.join(distDir, 'native'),
                flatten: true,
            })),
            {
                src: `${toPosix(ffmpegSrcDir)}/${ffmpegAddonFile}`,
                dest: path.join(distDir, 'native', 'ffmpeg'),
                flatten: true,
            },
            // Keep linked documents together; only agreements feed the consent gate.
            ...releaseDocuments.map((file) => ({
                src: toPosix(path.resolve(repoRoot, file)),
                dest: distDir,
                flatten: true,
            })),
        ],
    }),
];

const BaseConfig = (source_map: boolean = false) =>
    defineConfig({
        resolve: {
            conditions: ['node', 'default'],
            alias: {
                '@': path.resolve(__dirname, 'src'),
            },
        },
        build: {
            sourcemap: source_map,
            target: 'node24',
            minify: false,
            lib: {
                entry: {
                    index: path.resolve(__dirname, 'src/index.ts'),
                },
                formats: ['es'],
                fileName: (_, entryName) => `${entryName}.mjs`,
            },
            rollupOptions: {
                external: nodeModules,
                output: {
                    // Keep recovery runnable while an interrupted update is being restored.
                    codeSplitting: false,
                    // Bundled CommonJS dependencies still need Node's native require.
                    banner: [
                        "import { createRequire as __snowlumaCreateRequire } from 'node:module';",
                        'const require = __snowlumaCreateRequire(import.meta.url);',
                    ].join('\n'),
                },
            },
            // Emit to monorepo root dist/ so the existing release pipeline keeps working.
            outDir: distDir,
            // Required since outDir is outside the vite project root.
            emptyOutDir: true,
        },
        define: {
            __BUILD_WEBUI__: process.env.BUILD_WEBUI === 'true',
            __PACKAGED__: true,
        },
    });

export default defineConfig(({ mode }): UserConfig => {
    if (mode === 'development') {
        return {
            ...BaseConfig(true),
            plugins: [...BaseConfigPlugin],
        };
    }

    return {
        ...BaseConfig(),
        plugins: [...BaseConfigPlugin],
    };
});
