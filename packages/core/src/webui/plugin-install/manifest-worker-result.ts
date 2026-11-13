import { types } from 'node:util';
import type { ZipManifestResult } from './zip-preflight.ts';

export interface ManifestWorkerResult {
    readonly kind: 'zip-manifest-result';
    readonly version: 2;
    readonly sha256: string;
    readonly result: ZipManifestResult;
}

function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || types.isProxy(value)) {
        return null;
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        return null;
    }

    const actual = Reflect.ownKeys(value);

    if (actual.length !== keys.length || actual.some((key) => !keys.includes(key as string))) {
        return null;
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            return null;
        }

        result[key] = descriptor.value;
    }

    return result;
}

const manifestErrors: readonly string[] = [
    'malformed',
    'unsupported',
    'unsafe_path',
    'collision',
    'integrity',
    'limit',
    'invalid_input',
    'internal',
    'manifest_missing',
    'manifest_too_large',
    'manifest_invalid',
    'manifest_internal',
];
const mainTypes: readonly string[] = ['absent', 'empty', 'string', 'non_string'];
const moduleTypes: readonly string[] = [
    'absent',
    'module',
    'commonjs',
    'other_string',
    'non_string',
];

/**
 * Validate a candidate only; this does not observe Worker exit or cleanup and
 * the matching hash cannot prove a Worker was honest. No input object is retained.
 */
export function readManifestWorkerResult(
    message: unknown,
    expectedSha256: unknown,
): ManifestWorkerResult | null {
    try {
        if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
            return null;
        }

        const envelope = dataObject(message, ['kind', 'version', 'sha256', 'result']);

        if (
            !envelope ||
            envelope.kind !== 'zip-manifest-result' ||
            envelope.version !== 2 ||
            envelope.sha256 !== expectedSha256
        ) {
            return null;
        }

        const raw = envelope.result;

        if (typeof raw !== 'object' || raw === null || types.isProxy(raw)) {
            return null;
        }

        const ok = Object.getOwnPropertyDescriptor(raw, 'ok');

        if (!ok || !('value' in ok)) {
            return null;
        }

        let result: ZipManifestResult;

        if (ok.value === false) {
            const failure = dataObject(raw, ['ok', 'code']);

            if (
                !failure ||
                typeof failure.code !== 'string' ||
                !manifestErrors.includes(failure.code)
            ) {
                return null;
            }

            result = Object.freeze({
                ok: false,
                code: failure.code as Extract<ZipManifestResult, { ok: false }>['code'],
            });
        } else if (ok.value === true) {
            const success = dataObject(raw, ['ok', 'sha256', 'manifest']);

            if (!success || success.sha256 !== expectedSha256) {
                return null;
            }

            const manifest = dataObject(success.manifest, ['main', 'type']);

            if (
                !manifest ||
                typeof manifest.main !== 'string' ||
                !mainTypes.includes(manifest.main) ||
                typeof manifest.type !== 'string' ||
                !moduleTypes.includes(manifest.type)
            ) {
                return null;
            }

            result = Object.freeze({
                ok: true,
                sha256: expectedSha256,
                manifest: Object.freeze({
                    main: manifest.main as Extract<
                        ZipManifestResult,
                        { ok: true }
                    >['manifest']['main'],
                    type: manifest.type as Extract<
                        ZipManifestResult,
                        { ok: true }
                    >['manifest']['type'],
                }),
            });
        } else {
            return null;
        }

        return Object.freeze({
            kind: 'zip-manifest-result',
            version: 2,
            sha256: expectedSha256,
            result,
        });
    } catch {
        return null;
    }
}
