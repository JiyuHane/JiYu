import { abortable, OneBot12ClientError, requestDeadline } from './client-types.js';
import type { OneBot12RequestOptions } from './client-types.js';
import { prepareOneBot12FileFragment, transferOneBot12FileFragment } from './file-fragmented.js';
import type { OneBot12FileFragmentRequester } from './file-fragmented.js';
import { parseOneBot12ActionRequest } from './protocol.js';
import type { OneBot12ActionResponse, OneBot12Self } from './types.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK = 256 * 1024;
const DEFAULT_CHUNK = 64 * 1024;
const MAX_TRANSFERS = 256;
const DEFAULT_TIMEOUT_MS = 30_000;
const OPTIONS = ['maxBytes', 'chunkSize', 'timeoutMs', 'signal', 'self', 'expectedSha256'] as const;

type OptionKey = (typeof OPTIONS)[number];
type DownloadSettings = Required<
    Pick<OneBot12FragmentedDownloadOptions, 'maxBytes' | 'chunkSize' | 'timeoutMs'>
> &
    Omit<OneBot12FragmentedDownloadOptions, 'maxBytes' | 'chunkSize' | 'timeoutMs'>;

export interface OneBot12FragmentedDownloadOptions {
    /** Required allocation limit for decoded bytes, from 0 through 8 MiB. */
    maxBytes: number;
    /** Range size from 1 byte through 256 KiB; defaults to 64 KiB. */
    chunkSize?: number;
    /** Optional independently known lowercase hexadecimal SHA-256. */
    expectedSha256?: string;
    self?: OneBot12Self;
    signal?: AbortSignal;
    /** Deadline shared by all requests and verification, default 30 seconds. */
    timeoutMs?: number;
}

export type OneBot12FragmentedDownloadResult =
    | { status: 'ok'; name: string; sha256: string; bytes: Uint8Array }
    | {
          status: 'failed';
          stage: 'prepare' | 'transfer';
          response: OneBot12ActionResponse & { status: 'failed' };
      };

function isSha256(value: unknown): value is string {
    return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function readSettings(fileId: unknown, value: unknown): DownloadSettings {
    try {
        if (
            typeof fileId !== 'string' ||
            fileId.length === 0 ||
            !value ||
            typeof value !== 'object'
        ) {
            throw new TypeError();
        }

        const prototype: unknown = Object.getPrototypeOf(value);

        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError();
        }

        const parts = Object.getOwnPropertyDescriptors(value);

        for (const key of Reflect.ownKeys(parts)) {
            if (
                typeof key !== 'string' ||
                !OPTIONS.some((allowed) => allowed === key) ||
                !parts[key]?.enumerable ||
                !('value' in parts[key])
            ) {
                throw new TypeError();
            }
        }

        const read = (key: OptionKey): unknown =>
            Object.hasOwn(parts, key) ? parts[key].value : undefined;
        const maxBytes = read('maxBytes');
        const chunk = read('chunkSize');
        const chunkSize = chunk === undefined ? DEFAULT_CHUNK : chunk;
        const timeout = read('timeoutMs');
        const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : timeout;
        const expectedSha256 = read('expectedSha256');
        const signal = read('signal');
        const suppliedSelf = read('self');

        if (
            !isIntegerIn(maxBytes, 0, MAX_BYTES) ||
            !isIntegerIn(chunkSize, 1, MAX_CHUNK) ||
            !isIntegerIn(timeoutMs, 1, 2_147_483_647) ||
            (expectedSha256 !== undefined && !isSha256(expectedSha256)) ||
            (signal !== undefined && !(signal instanceof AbortSignal))
        ) {
            throw new TypeError();
        }

        // Keep the account selector stable across stages, including JSON extensions.
        const { self } = parseOneBot12ActionRequest({
            action: 'get_file_fragmented',
            params: { stage: 'prepare', file_id: fileId },
            ...(suppliedSelf === undefined ? {} : { self: suppliedSelf }),
        });
        return { maxBytes, chunkSize, timeoutMs, expectedSha256, signal, self };
    } catch {
        throw new OneBot12ClientError('invalid_options', 'Invalid fragmented download options');
    }
}

function copyChunk(encoded: string, into: Uint8Array): void {
    try {
        if (encoded.length !== 4 * Math.ceil(into.length / 3)) {
            throw new TypeError();
        }

        const binary = atob(encoded);

        if (binary.length !== into.length || btoa(binary) !== encoded) {
            throw new TypeError();
        }

        for (let i = 0; i < into.length; i++) {
            into[i] = binary.charCodeAt(i);
        }
    } catch {
        throw new OneBot12ClientError('invalid_response', 'Invalid fragmented download chunk');
    }
}

/**
 * Read one file through the two staged actions, returning only complete verified bytes.
 * The server-reported digest binds content consistency, not its origin.
 */
export async function downloadOneBot12FragmentedFile(
    transport: OneBot12FileFragmentRequester,
    fileId: string,
    options: OneBot12FragmentedDownloadOptions,
): Promise<OneBot12FragmentedDownloadResult> {
    const { maxBytes, chunkSize, expectedSha256, self, signal, timeoutMs } = readSettings(
        fileId,
        options,
    );
    const subtle = globalThis.crypto?.subtle;

    if (
        !subtle ||
        typeof subtle.digest !== 'function' ||
        typeof atob !== 'function' ||
        typeof btoa !== 'function' ||
        (self !== undefined && typeof structuredClone !== 'function')
    ) {
        throw new OneBot12ClientError(
            'invalid_options',
            'Fragmented download runtime APIs are unavailable',
        );
    }

    const deadline = requestDeadline(timeoutMs, signal);
    const requestOptions = (): OneBot12RequestOptions =>
        self === undefined
            ? { signal: deadline.signal }
            : { signal: deadline.signal, self: structuredClone(self) };

    async function step<T>(run: () => Promise<T>): Promise<T> {
        if (deadline.signal.aborted) {
            throw deadline.failure();
        }

        const value = await abortable(run(), deadline.signal, deadline.failure);

        if (deadline.signal.aborted) {
            throw deadline.failure();
        }

        return value;
    }

    let staging: Uint8Array | undefined;
    let verified = false;

    try {
        const metadata = await step(() =>
            prepareOneBot12FileFragment(
                transport,
                { stage: 'prepare', file_id: fileId },
                requestOptions(),
            ),
        );

        if (metadata.status === 'failed') {
            return { status: 'failed', stage: 'prepare', response: metadata };
        }

        const { name, total_size: size, sha256 } = metadata.data;

        if (size < 0 || !isSha256(sha256)) {
            throw new OneBot12ClientError(
                'invalid_response',
                'Invalid fragmented download metadata',
            );
        }

        if (size > maxBytes || Math.ceil(size / chunkSize) > MAX_TRANSFERS) {
            throw new OneBot12ClientError(
                'limit',
                'Fragmented download exceeds the transfer budget',
            );
        }

        if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
            throw new OneBot12ClientError(
                'invalid_response',
                'Fragmented download digest does not match',
            );
        }

        const bytes = new Uint8Array(size);
        staging = bytes;

        for (let offset = 0; offset < size;) {
            const length = Math.min(size - offset, chunkSize);
            const fragment = await step(() =>
                transferOneBot12FileFragment(
                    transport,
                    { stage: 'transfer', file_id: fileId, offset, size: length },
                    requestOptions(),
                ),
            );

            if (fragment.status === 'failed') {
                return { status: 'failed', stage: 'transfer', response: fragment };
            }

            copyChunk(fragment.data.data, bytes.subarray(offset, offset + length));
            offset += length;
        }

        const digest = await step(async () => {
            try {
                return await subtle.digest('SHA-256', bytes);
            } catch {
                throw new OneBot12ClientError(
                    'protocol',
                    'Fragmented download digest calculation failed',
                );
            }
        });
        const actualSha256 = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0'),
        ).join('');

        if (actualSha256 !== sha256) {
            throw new OneBot12ClientError(
                'invalid_response',
                'Fragmented download digest does not match',
            );
        }

        verified = true;
        return { status: 'ok', name, sha256: actualSha256, bytes };
    } finally {
        deadline.cleanup();

        if (!verified) {
            staging?.fill(0);
        }
    }
}
