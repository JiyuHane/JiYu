import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { downloadOneBot12FragmentedFile, OneBot12ClientError } from '../../src/v12/index.js';
import type {
    OneBot12ActionResponse,
    OneBot12FileFragmentRequester,
    OneBot12FragmentedDownloadOptions,
    OneBot12JsonObject,
    OneBot12RequestOptions,
} from '../../src/v12/index.js';

const FILE = 'fixture-local-file';
const BINARY = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f]);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const DIGEST = hash(BINARY);
const NAME = '合成🪶.bin';

function ok(data: OneBot12JsonObject): OneBot12ActionResponse {
    return { status: 'ok', retcode: 0, message: '', data };
}

function metadata(size = BINARY.length, digest = DIGEST): OneBot12ActionResponse {
    return ok({ name: NAME, total_size: size, sha256: digest });
}

const businessFailure = {
    status: 'failed',
    retcode: 20001,
    message: 'file unavailable',
    data: { retry_hint: null },
    'vendor.reason': ['fixture'],
} as const;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((success, failure) => {
        resolve = success;
        reject = failure;
    });
    return { promise, resolve, reject };
}

async function rejectsWith(
    pending: Promise<unknown>,
    code: OneBot12ClientError['code'],
    message?: string,
) {
    await expect(pending).rejects.toBeInstanceOf(OneBot12ClientError);
    await expect(pending).rejects.toMatchObject({ code, ...(message ? { message } : {}) });
}

function fakeRequest(initial = metadata()) {
    return vi.fn<OneBot12FileFragmentRequester['request']>().mockResolvedValueOnce(initial);
}

describe('bounded v12 fragmented download with only an in-memory requester', () => {
    it('reads exact increasing ranges, copying selectors per request and verifying returned bytes', async () => {
        const self = { platform: 'qq', user_id: 'fixture', 'x.scope': ['initial'] };
        const options = { maxBytes: BINARY.length, chunkSize: 2, expectedSha256: DIGEST, self };
        const seen: Array<OneBot12JsonObject | undefined> = [];
        const signals: Array<AbortSignal | undefined> = [];
        const transport: OneBot12FileFragmentRequester = {
            async request(action, params, supplied) {
                expect(this).toBe(transport);
                expect(action).toBe('get_file_fragmented');
                expect(supplied?.self).toEqual({
                    platform: 'qq',
                    user_id: 'fixture',
                    'x.scope': ['initial'],
                });
                seen.push(params);
                signals.push(supplied?.signal);
                self.user_id = 'changed by caller';
                self['x.scope'][0] = 'changed by caller';
                options.chunkSize = 1;
                options.maxBytes = 0;
                supplied!.self!.user_id = 'changed by requester';
                (supplied!.self!['x.scope'] as string[])[0] = 'changed by requester';

                if (params?.stage === 'prepare') {
                    return metadata();
                }

                const offset = params?.offset;
                const size = params?.size;

                if (typeof offset !== 'number' || typeof size !== 'number') {
                    throw new Error('unexpected range');
                }

                return ok({ data: BINARY.subarray(offset, offset + size).toString('base64') });
            },
        };
        const outcome = await downloadOneBot12FragmentedFile(transport, FILE, options);
        expect(outcome).toStrictEqual({
            status: 'ok',
            name: NAME,
            sha256: DIGEST,
            bytes: Uint8Array.from(BINARY),
        });
        expect(seen).toEqual([
            { stage: 'prepare', file_id: FILE },
            { stage: 'transfer', file_id: FILE, offset: 0, size: 2 },
            { stage: 'transfer', file_id: FILE, offset: 2, size: 2 },
            { stage: 'transfer', file_id: FILE, offset: 4, size: 1 },
        ]);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(new Set(signals).size).toBe(1);
    });

    it('verifies empty files with just prepare and allows a zero-byte allocation budget', async () => {
        const sha256 = hash(new Uint8Array());
        const request = fakeRequest(metadata(0, sha256));
        expect(
            await downloadOneBot12FragmentedFile({ request }, FILE, { maxBytes: 0 }),
        ).toStrictEqual({
            status: 'ok',
            name: NAME,
            sha256,
            bytes: new Uint8Array(),
        });
        expect(request).toHaveBeenCalledOnce();

        const wrong = fakeRequest(metadata(0, DIGEST));
        await rejectsWith(
            downloadOneBot12FragmentedFile({ request: wrong }, FILE, { maxBytes: 0 }),
            'invalid_response',
        );
        expect(wrong).toHaveBeenCalledOnce();
    });

    it.each(['prepare', 'transfer'] as const)(
        'returns an unmodified business failure snapshot for %s',
        async (stage) => {
            const failure: OneBot12ActionResponse = {
                ...businessFailure,
                'vendor.reason': ['fixture'],
            };
            const request =
                stage === 'prepare'
                    ? fakeRequest(failure)
                    : fakeRequest()
                          .mockResolvedValueOnce(ok({ data: 'AP8=' }))
                          .mockResolvedValueOnce(failure);
            const result = await downloadOneBot12FragmentedFile({ request }, FILE, {
                maxBytes: 5,
                chunkSize: 2,
            });
            expect(result).toEqual({ status: 'failed', stage, response: failure });
            expect(result).not.toHaveProperty('bytes');

            if (result.status !== 'failed') {
                throw new Error('expected failure');
            }

            expect(result.response).not.toBe(failure);
            expect(request).toHaveBeenCalledTimes(stage === 'prepare' ? 1 : 3);
        },
    );

    it('preserves a transport rejection without retry or more stages', async () => {
        const cause = new Error('fixture transport failed');
        const request = fakeRequest().mockRejectedValueOnce(cause);
        await expect(
            downloadOneBot12FragmentedFile({ request }, FILE, {
                maxBytes: BINARY.length,
                chunkSize: 1,
            }),
        ).rejects.toBe(cause);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('validates local limits, selectors and digest syntax before any request', async () => {
        const getter = vi.fn(() => {
            throw new Error('fixture secret');
        });
        const request = fakeRequest();
        const base = { maxBytes: 5 };

        for (const value of [
            null,
            {},
            { maxBytes: -1 },
            { maxBytes: 1.5 },
            { maxBytes: 8 * 1024 * 1024 + 1 },
            { ...base, chunkSize: 0 },
            { ...base, chunkSize: 256 * 1024 + 1 },
            { ...base, timeoutMs: 0 },
            { ...base, timeoutMs: Infinity },
            { ...base, expectedSha256: DIGEST.toUpperCase() },
            { ...base, expectedSha256: DIGEST + '\n' },
            { ...base, self: { platform: 'qq', user_id: 1 } },
            { ...base, signal: {} },
            { ...base, extra: 1 },
            Object.create(base),
            Object.defineProperty({}, 'maxBytes', { get: getter }),
        ]) {
            await rejectsWith(
                downloadOneBot12FragmentedFile(
                    { request },
                    FILE,
                    value as OneBot12FragmentedDownloadOptions,
                ),
                'invalid_options',
                'Invalid fragmented download options',
            );
        }

        await rejectsWith(downloadOneBot12FragmentedFile({ request }, '', base), 'invalid_options');
        expect(getter).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it.each([
        [-1, DIGEST, undefined, { maxBytes: 5 }, 'invalid_response'],
        [1, DIGEST.toUpperCase(), undefined, { maxBytes: 5 }, 'invalid_response'],
        [6, DIGEST, undefined, { maxBytes: 5 }, 'limit'],
        [257, DIGEST, undefined, { maxBytes: 257, chunkSize: 1 }, 'limit'],
        [5, DIGEST, 'a'.repeat(64), { maxBytes: 5 }, 'invalid_response'],
    ] as const)(
        'stops at prepare for size %i or unexpected metadata',
        async (size, digest, expectedSha256, options, code) => {
            const request = fakeRequest(metadata(size, digest));
            await rejectsWith(
                downloadOneBot12FragmentedFile({ request }, FILE, { ...options, expectedSha256 }),
                code,
            );
            expect(request).toHaveBeenCalledOnce();
        },
    );

    it.each(['', 'YQ', 'YR==', 'YQ= ', 'YWJj', '_w==', 'YQ===='])(
        'does not expose partial bytes or continue after a malformed chunk (%j)',
        async (encoded) => {
            const request = fakeRequest().mockResolvedValueOnce(ok({ data: encoded }));
            await rejectsWith(
                downloadOneBot12FragmentedFile({ request }, FILE, { maxBytes: 5, chunkSize: 1 }),
                'invalid_response',
                'Invalid fragmented download chunk',
            );
            expect(request).toHaveBeenCalledTimes(2);
        },
    );

    it('rejects different bytes even when Base64 syntax and exact decoded length match', async () => {
        const wrong = Buffer.alloc(BINARY.length, 0xb0).toString('base64');
        const request = fakeRequest().mockResolvedValueOnce(ok({ data: wrong }));
        await rejectsWith(
            downloadOneBot12FragmentedFile({ request }, FILE, {
                maxBytes: 5,
                expectedSha256: DIGEST,
            }),
            'invalid_response',
            'Fragmented download digest does not match',
        );
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not start work on a pre-aborted request or continue after an in-flight abort', async () => {
        const cancellation = new AbortController();
        const held = deferred<OneBot12ActionResponse>();
        const request = vi
            .fn<OneBot12FileFragmentRequester['request']>()
            .mockReturnValue(held.promise);
        const result = downloadOneBot12FragmentedFile({ request }, FILE, {
            maxBytes: 5,
            signal: cancellation.signal,
        });
        const captured = request.mock.calls[0]?.[2];
        cancellation.abort('fixture private reason');
        await rejectsWith(result, 'aborted', 'OneBot 12 request aborted');
        expect(captured?.signal?.aborted).toBe(true);
        held.resolve(metadata());
        await Promise.resolve();
        await rejectsWith(
            downloadOneBot12FragmentedFile({ request }, FILE, {
                maxBytes: 5,
                signal: cancellation.signal,
            }),
            'aborted',
        );
        expect(request).toHaveBeenCalledOnce();
    });

    it('shares one deadline across prepare and transfer, observing late rejections', async () => {
        vi.useFakeTimers();

        try {
            const held = deferred<OneBot12ActionResponse>();
            const request = vi
                .fn<OneBot12FileFragmentRequester['request']>()
                .mockImplementationOnce(
                    () => new Promise((resolve) => setTimeout(() => resolve(metadata()), 35)),
                )
                .mockReturnValueOnce(held.promise);
            const result = downloadOneBot12FragmentedFile({ request }, FILE, {
                maxBytes: 5,
                chunkSize: 2,
                timeoutMs: 50,
            });
            const observed = rejectsWith(result, 'timeout', 'OneBot 12 request timed out');
            await vi.advanceTimersByTimeAsync(35);
            expect(request).toHaveBeenCalledTimes(2);
            const opts: OneBot12RequestOptions | undefined = request.mock.calls[1]?.[2];
            expect(opts?.signal?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(15);
            await observed;
            expect(opts?.signal?.aborted).toBe(true);
            held.reject(new Error('late fixture failure'));
            await vi.advanceTimersByTimeAsync(100);
            expect(request).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels during verification and clears unpublished staging bytes', async () => {
        const cancellation = new AbortController();
        const held = deferred<ArrayBuffer>();
        const entered = deferred<Uint8Array>();
        const spy = vi
            .spyOn(globalThis.crypto.subtle, 'digest')
            .mockImplementation((_algorithm, data) => {
                entered.resolve(data as Uint8Array);
                return held.promise;
            });

        try {
            const request = fakeRequest().mockResolvedValueOnce(
                ok({ data: BINARY.toString('base64') }),
            );
            const result = downloadOneBot12FragmentedFile({ request }, FILE, {
                maxBytes: 5,
                signal: cancellation.signal,
            });
            const staging = await entered.promise;
            expect(staging).toEqual(Uint8Array.from(BINARY));
            cancellation.abort();
            await rejectsWith(result, 'aborted');
            expect(staging).toStrictEqual(new Uint8Array(5));
            held.resolve(Uint8Array.from(Buffer.from(DIGEST, 'hex')).buffer);
            expect(request).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });
});
