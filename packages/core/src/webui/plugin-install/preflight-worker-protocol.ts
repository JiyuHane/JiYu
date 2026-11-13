import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { isMarkedAsUntransferable } from 'node:worker_threads';
import { inspectZipManifest, preflightZip } from './zip-preflight.ts';
import { readManifestWorkerResult } from './manifest-worker-result.ts';

export { readManifestWorkerResult } from './manifest-worker-result.ts';
export type { ManifestWorkerResult } from './manifest-worker-result.ts';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const usedPorts = new WeakSet<object>();
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const getArrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const copy = Uint8Array.prototype.set;
const transfer = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer')?.value as
    ((this: ArrayBuffer) => ArrayBuffer) | undefined;

export interface PreflightWorkerData {
    readonly kind: 'zip-preflight';
    readonly version: 1;
    readonly bytes: ArrayBuffer;
}

/**
 * Copy a caller's view, not its underlying buffer. The caller must transfer the
 * returned bytes to a trusted, exclusively controlled Worker and must not retain
 * or mutate the envelope before transfer. This helper starts no threads.
 */
export function createPreflightWorkerData(input: unknown): PreflightWorkerData {
    try {
        if (types.isProxy(input) || !types.isUint8Array(input)) {
            throw new Error();
        }

        const buffer: unknown = getBuffer.call(input);
        const offset: number = getOffset.call(input);
        const length: number = getLength.call(input);

        if (!types.isArrayBuffer(buffer) || length > MAX_ARCHIVE) {
            throw new Error();
        }

        const source = new Uint8Array(buffer as ArrayBuffer, offset, length);
        const owned = new Uint8Array(length);
        copy.call(owned, source);
        return { kind: 'zip-preflight', version: 1, bytes: owned.buffer };
    } catch {
        throw new TypeError('invalid_preflight_input');
    }
}

export interface ManifestWorkerData {
    readonly kind: 'zip-manifest';
    readonly version: 2;
    readonly bytes: ArrayBuffer;
}

/** Copy a view without transferring its original backing buffer. */
export function createManifestWorkerData(input: unknown): ManifestWorkerData {
    const { bytes } = createPreflightWorkerData(input);
    return { kind: 'zip-manifest', version: 2, bytes };
}

export interface PreflightWorkerPort {
    postMessage(message: unknown): void;
    close(): void;
}

export type PreflightHandlerStatus =
    'sent' | 'invalid_port' | 'invalid_request' | 'already_handled';

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

function requestBuffer(value: unknown, expectedKind: string, expectedVersion: number): unknown {
    if (typeof value !== 'object' || value === null || types.isProxy(value)) {
        return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);

    if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.length !== 3 ||
        keys.some((key) => key !== 'kind' && key !== 'version' && key !== 'bytes')
    ) {
        return undefined;
    }

    const kind = Object.getOwnPropertyDescriptor(value, 'kind');
    const version = Object.getOwnPropertyDescriptor(value, 'version');

    if (
        !kind ||
        !('value' in kind) ||
        kind.value !== expectedKind ||
        !version ||
        !('value' in version) ||
        version.value !== expectedVersion
    ) {
        return undefined;
    }

    const bytes = Object.getOwnPropertyDescriptor(value, 'bytes');
    return bytes && 'value' in bytes ? bytes.value : undefined;
}

/**
 * One-shot offline handler. Port callbacks are a trusted adapter, not a proof
 * of delivery, endpoint identity or worker honesty. A host must supply its own
 * exclusive, synchronous void-returning port wrapper; asynchronous adapters are
 * outside this contract. Reentrant calls, retries and reuse of the same wrapper
 * are ignored; distinct wrappers around one endpoint remain the adapter's concern.
 * Invalid input
 * sends no message: a real worker that naturally exits 0 is reported as `exit`
 * by PreflightWorkerTask. Send/close failures throw fixed errors: the Worker
 * entry must let those errors escape so a candidate cannot succeed on exit 0.
 * Transfer detaches aliases in this thread only; it does not authenticate the
 * sender or establish that other copies never existed. This module never calls
 * process.exit, starts a Worker, or accesses a file.
 */
export function createPreflightWorkerHandler(
    port: unknown,
): (data: unknown) => PreflightHandlerStatus {
    return createWorkerHandler(port, 'zip-preflight', 1, (owned) => ({
        kind: 'result',
        result: preflightZip(new Uint8Array(owned)),
    }));
}

/**
 * Manifest candidate only: no parent lifecycle controller, default factory or
 * production entry exists. The supplied synchronous adapter is trusted.
 */
export function createManifestWorkerHandler(
    port: unknown,
): (data: unknown) => PreflightHandlerStatus {
    return createWorkerHandler(port, 'zip-manifest', 2, (owned) => {
        const bytes = new Uint8Array(owned);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const result = inspectZipManifest(bytes);
        return readManifestWorkerResult(
            { kind: 'zip-manifest-result', version: 2, sha256, result },
            sha256,
        );
    });
}

function createWorkerHandler(
    port: unknown,
    kind: string,
    version: number,
    inspect: (owned: ArrayBuffer) => unknown,
): (data: unknown) => PreflightHandlerStatus {
    let handled = false;

    return (data: unknown): PreflightHandlerStatus => {
        if (handled) {
            return 'already_handled';
        }

        handled = true;
        let adapter: Record<string, unknown> | null;

        try {
            adapter = dataObject(port, ['postMessage', 'close']);
        } catch {
            return 'invalid_port';
        }

        if (
            !adapter ||
            typeof adapter.postMessage !== 'function' ||
            typeof adapter.close !== 'function'
        ) {
            return 'invalid_port';
        }

        if (usedPorts.has(port as object)) {
            return 'already_handled';
        }

        usedPorts.add(port as object);
        let status: PreflightHandlerStatus = 'invalid_request';
        let sendFailed = false;

        try {
            const buffer: unknown = requestBuffer(data, kind, version);

            if (
                !types.isProxy(buffer) &&
                types.isArrayBuffer(buffer) &&
                Object.getPrototypeOf(buffer) === ArrayBuffer.prototype &&
                Reflect.ownKeys(buffer).length === 0 &&
                getResizable !== undefined &&
                typeof transfer === 'function' &&
                (kind !== 'zip-manifest' ||
                    (typeof isMarkedAsUntransferable === 'function' &&
                        !isMarkedAsUntransferable(buffer))) &&
                getResizable.call(buffer) === false &&
                getArrayBufferLength.call(buffer) <= MAX_ARCHIVE
            ) {
                // Transfer detaches every original JS alias, rejects detached or
                // explicitly untransferable buffers, and establishes this turn's
                // exclusive ownership without executing any input properties.
                const owned = transfer.call(buffer as ArrayBuffer);
                const message = inspect(owned);

                if (message !== null) {
                    sendFailed = true;
                    Reflect.apply(adapter.postMessage, undefined, [message]);
                    sendFailed = false;
                    status = 'sent';
                }
            }
        } catch {
            // A preflight exception or invalid/detached buffer is not exposed.
            // Do not send a second message if the adapter threw while sending.
        }

        try {
            Reflect.apply(adapter.close, undefined, []);
        } catch {
            throw new Error('preflight_close_failed');
        }

        if (sendFailed) {
            throw new Error('preflight_send_failed');
        }

        return status;
    };
}
