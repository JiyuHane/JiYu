import { abortable, OneBot12ClientError, requestDeadline } from './client-types.js';
import type { OneBot12RequestOptions } from './client-types.js';
import { parseOneBot12ActionRequest } from './protocol.js';
import type { OneBot12JsonObject, OneBot12Self } from './types.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK = 256 * 1024;
const DEFAULT_CHUNK = 64 * 1024;
const MAX_TRANSFERS = 256;
const DEFAULT_TIMEOUT_MS = 30_000;
const OPTIONS = ['maxBytes', 'chunkSize', 'timeoutMs', 'signal', 'self'] as const;
type Direction = 'upload' | 'download';
type OptionKey = (typeof OPTIONS)[number] | 'expectedSha256';

export interface FragmentedTransferOptions {
    /** Required decoded-byte limit from 0 through 8 MiB. */
    maxBytes: number;
    /** Chunk size from 1 byte through 256 KiB; defaults to 64 KiB. */
    chunkSize?: number;
    self?: OneBot12Self;
    signal?: AbortSignal;
    /** Shared deadline for the staged operation, default 30 seconds. */
    timeoutMs?: number;
}

type Settings = Required<Pick<FragmentedTransferOptions, 'maxBytes' | 'chunkSize' | 'timeoutMs'>> &
    Omit<FragmentedTransferOptions, 'maxBytes' | 'chunkSize' | 'timeoutMs'> & {
        expectedSha256?: string;
    };

export function isSha256(value: unknown): value is string {
    return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function exceedsFragmentBudget(
    size: number,
    limits: Pick<Settings, 'maxBytes' | 'chunkSize'>,
): boolean {
    return size > limits.maxBytes || Math.ceil(size / limits.chunkSize) > MAX_TRANSFERS;
}

export function invalidFragmentOptions(direction: Direction): OneBot12ClientError {
    return new OneBot12ClientError('invalid_options', `Invalid fragmented ${direction} options`);
}

export function readFragmentedSettings(
    value: unknown,
    direction: Direction,
    prepareParams: OneBot12JsonObject,
): Settings {
    try {
        if (value === null || typeof value !== 'object') {
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
                !(
                    OPTIONS.some((allowed) => allowed === key) ||
                    (direction === 'download' && key === 'expectedSha256')
                ) ||
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

        // Validate the complete request shape and preserve the selector across all stages.
        const { self } = parseOneBot12ActionRequest({
            action: direction === 'download' ? 'get_file_fragmented' : 'upload_file_fragmented',
            params: prepareParams,
            ...(suppliedSelf === undefined ? {} : { self: suppliedSelf }),
        });
        return { maxBytes, chunkSize, timeoutMs, expectedSha256, signal, self };
    } catch {
        throw invalidFragmentOptions(direction);
    }
}

export function createFragmentedOperation(
    { timeoutMs, signal, self }: Settings,
    direction: Direction,
) {
    const subtle = globalThis.crypto?.subtle;

    if (
        !subtle ||
        typeof subtle.digest !== 'function' ||
        typeof btoa !== 'function' ||
        (direction === 'download' && typeof atob !== 'function') ||
        (self !== undefined && typeof structuredClone !== 'function')
    ) {
        throw new OneBot12ClientError(
            'invalid_options',
            `Fragmented ${direction} runtime APIs are unavailable`,
        );
    }

    const deadline = requestDeadline(timeoutMs, signal);
    const requestOptions = (): OneBot12RequestOptions =>
        self === undefined
            ? { signal: deadline.signal }
            : { signal: deadline.signal, self: structuredClone(self) };

    function check(): void {
        if (deadline.signal.aborted) {
            throw deadline.failure();
        }
    }

    async function step<T>(run: () => Promise<T>): Promise<T> {
        check();
        const value = await abortable(run(), deadline.signal, deadline.failure);
        check();
        return value;
    }

    const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
        const digest = await step(async () => {
            try {
                return await subtle.digest('SHA-256', bytes);
            } catch {
                throw new OneBot12ClientError(
                    'protocol',
                    `Fragmented ${direction} digest calculation failed`,
                );
            }
        });
        check();
        return Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0'),
        ).join('');
    };

    return { check, step, sha256, requestOptions, cleanup: deadline.cleanup };
}
