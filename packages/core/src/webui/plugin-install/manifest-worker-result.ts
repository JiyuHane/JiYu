import { types } from 'node:util';
import type { ZipManifestResult, ZipPluginEntryResult } from './zip-preflight.ts';

export interface ManifestWorkerResult {
    readonly kind: 'zip-manifest-result';
    readonly version: 2;
    readonly sha256: string;
    readonly result: ZipManifestResult;
}

export interface PluginEntryWorkerResult {
    readonly kind: 'zip-plugin-entry-result';
    readonly version: 3;
    readonly sha256: string;
    readonly result: ZipPluginEntryResult;
}

type ManifestSuccess = Extract<ZipManifestResult, { ok: true }>;
type ManifestFailure = Extract<ZipManifestResult, { ok: false }>;
type PluginEntry = Extract<ZipPluginEntryResult, { ok: true }>['entry'];

type WorkerReceipt = { sha256: string; raw: unknown };

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

function readEnvelope(
    message: unknown,
    expectedSha256: unknown,
    kind: ManifestWorkerResult['kind'] | PluginEntryWorkerResult['kind'],
    version: 2 | 3,
): WorkerReceipt | null {
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        return null;
    }

    const envelope = dataObject(message, ['kind', 'version', 'sha256', 'result']);

    if (
        !envelope ||
        envelope.kind !== kind ||
        envelope.version !== version ||
        envelope.sha256 !== expectedSha256
    ) {
        return null;
    }

    return { sha256: expectedSha256, raw: envelope.result };
}

function readFailure(raw: unknown): ManifestFailure | null {
    const failure = dataObject(raw, ['ok', 'code']);

    if (
        !failure ||
        failure.ok !== false ||
        typeof failure.code !== 'string' ||
        !manifestErrors.includes(failure.code)
    ) {
        return null;
    }

    return Object.freeze({ ok: false, code: failure.code as ManifestFailure['code'] });
}

function readManifestSuccess(
    success: Record<string, unknown> | null,
    sha256: string,
): ManifestSuccess | null {
    if (!success || success.ok !== true || success.sha256 !== sha256) {
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

    return Object.freeze({
        ok: true,
        sha256,
        manifest: Object.freeze({
            main: manifest.main as ManifestSuccess['manifest']['main'],
            type: manifest.type as ManifestSuccess['manifest']['type'],
        }),
    });
}

function readPluginEntry(raw: unknown, manifest: ManifestSuccess['manifest']): PluginEntry | null {
    const candidate = dataObject(raw, ['source', 'status', 'format']);
    const entry = candidate ?? dataObject(raw, ['source', 'status']);
    const source = manifest.main === 'absent' ? 'fallback' : 'declared';

    if (!entry || entry.source !== source) {
        return null;
    }

    const { status } = entry;

    if (status === 'invalid_main') {
        return !candidate && source === 'declared' ? Object.freeze({ source, status }) : null;
    }

    // An explicitly empty or non-string main cannot reach path or format checks.
    if (manifest.main === 'empty' || manifest.main === 'non_string') {
        return null;
    }

    if (candidate) {
        const { format } = candidate;
        return status === 'candidate' &&
            (format === 'mjs' || (format === 'js' && manifest.type === 'module'))
            ? Object.freeze({ source, status, format })
            : null;
    }

    if (
        status === 'missing' ||
        status === 'directory' ||
        (status === 'unsupported_extension' && source === 'declared') ||
        (status === 'module_type_required' && manifest.type !== 'module') ||
        (status === 'scope_unknown' && source === 'declared' && manifest.type === 'module')
    ) {
        return Object.freeze({ source, status });
    }

    return null;
}

/** Validate a v2 candidate, without observing Worker exit or cleanup. */
export function readManifestWorkerResult(
    message: unknown,
    expectedSha256: unknown,
): ManifestWorkerResult | null {
    try {
        const envelope = readEnvelope(message, expectedSha256, 'zip-manifest-result', 2);

        if (!envelope) {
            return null;
        }

        const { sha256, raw } = envelope;
        const result =
            readFailure(raw) ??
            readManifestSuccess(dataObject(raw, ['ok', 'sha256', 'manifest']), sha256);
        return result
            ? Object.freeze({ kind: 'zip-manifest-result', version: 2, sha256, result })
            : null;
    } catch {
        return null;
    }
}

/**
 * Validate a v3 candidate and its manifest/entry relationship. The matching
 * digest binds only the reported identifier; the Worker still must be trusted.
 */
export function readPluginEntryWorkerResult(
    message: unknown,
    expectedSha256: unknown,
): PluginEntryWorkerResult | null {
    try {
        const envelope = readEnvelope(message, expectedSha256, 'zip-plugin-entry-result', 3);

        if (!envelope) {
            return null;
        }

        const { sha256, raw } = envelope;
        let result: ZipPluginEntryResult | null = readFailure(raw);

        if (!result) {
            const fields = dataObject(raw, ['ok', 'sha256', 'manifest', 'entry']);
            const summary = readManifestSuccess(fields, sha256);

            if (!fields || !summary) {
                return null;
            }

            const entry = readPluginEntry(fields.entry, summary.manifest);

            if (!entry) {
                return null;
            }

            result = Object.freeze({ ...summary, entry });
        }

        return Object.freeze({ kind: 'zip-plugin-entry-result', version: 3, sha256, result });
    } catch {
        return null;
    }
}
