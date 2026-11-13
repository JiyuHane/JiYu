import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sdkRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.resolve(sdkRoot, '../..');
const noticeFiles = ['LICENSE', 'JIYU_NOTICE.md'];

function sha256(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('SDK package notices', () => {
    it('packs complete copies of the current repository notices', () => {
        const temporary = mkdtempSync(path.join(tmpdir(), 'jiyu-sdk-notices-'));

        try {
            const args = [
                'pack',
                '--ignore-scripts',
                '--offline',
                '--json',
                '--pack-destination',
                temporary,
            ];
            // npm is a .cmd shim on Windows; invoke it through cmd there.
            const options = {
                cwd: sdkRoot,
                encoding: 'utf8' as const,
                timeout: 30_000,
                env: { ...process.env, npm_config_cache: path.join(temporary, 'npm-cache') },
            };
            const result =
                process.platform === 'win32'
                    ? spawnSync(
                          `npm pack --ignore-scripts --offline --json --pack-destination "${temporary}"`,
                          {
                              ...options,
                              shell: true,
                          },
                      )
                    : spawnSync('npm', args, options);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
            const packed = JSON.parse(result.stdout) as {
                filename: string;
                files: { path: string }[];
            }[];
            expect(packed).toHaveLength(1);
            const entries = packed[0].files.map((file) => file.path);
            const extracted = spawnSync(
                'tar',
                ['-xzf', path.join(temporary, packed[0].filename), '-C', temporary],
                {
                    encoding: 'utf8',
                    timeout: 30_000,
                },
            );
            expect(extracted.error).toBeUndefined();
            expect(extracted.status, extracted.stderr).toBe(0);

            for (const name of noticeFiles) {
                expect(entries).toContain(name);
                const original = sha256(path.join(repositoryRoot, name));
                expect(sha256(path.join(sdkRoot, name))).toBe(original);
                expect(sha256(path.join(temporary, 'package', name))).toBe(original);
            }
        } finally {
            rmSync(temporary, { recursive: true, force: true });
        }
    }, 60_000);
});
