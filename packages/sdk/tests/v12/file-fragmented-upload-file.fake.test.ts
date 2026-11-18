import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OneBot12ClientError, uploadOneBot12FragmentedFile } from '../../src/v12/index.js';
import type {
    OneBot12ActionResponse,
    OneBot12FileFragmentRequester,
    OneBot12FragmentedUploadOptions,
    OneBot12JsonValue,
} from '../../src/v12/index.js';

const DRAFT = 'fixture-draft';
const PUBLISHED = 'fixture-published';
const NAME = '合成🪶.bin';
const CONTENT = Buffer.from([0, 255, 128, 10, 127]);
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const ok = (data: OneBot12JsonValue): OneBot12ActionResponse => ({
    status: 'ok',
    retcode: 0,
    data,
    message: '',
});
const business: OneBot12ActionResponse = {
    status: 'failed',
    retcode: 10004,
    data: { marker: ['fixture', null] },
    message: 'not written',
};
const requester = () => vi.fn<OneBot12FileFragmentRequester['request']>();

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((success, failure) => {
        resolve = success;
        reject = failure;
    });
    return { promise, resolve, reject };
}

async function rejectsWith(promise: Promise<unknown>, code: OneBot12ClientError['code']) {
    await expect(promise).rejects.toBeInstanceOf(OneBot12ClientError);
    await expect(promise).rejects.toMatchObject({ code });
}

describe('bounded fragmented v12 upload with an in-memory requester', () => {
    it('pins the selected bytes and account, then publishes only the finish ID', async () => {
        const buffer = Buffer.concat([Buffer.from([13]), CONTENT, Buffer.from([14])]);
        const input = buffer.subarray(1, -1);
        const trap = vi.fn(() => {
            throw new Error('fixture getter');
        });
        Object.defineProperty(input, 'byteLength', { get: trap });
        Object.defineProperty(input, 'slice', { get: trap });
        const self = { platform: 'qq', user_id: 'fixture', 'x.hint': ['initial'] };
        const options = { maxBytes: 5, chunkSize: 2, self };
        const request = requester();
        const transport = { request };
        request.mockImplementation(async function (
            this: typeof transport,
            action,
            params,
            callOptions,
        ) {
            expect(this).toBe(transport);
            expect(action).toBe('upload_file_fragmented');
            expect(callOptions?.self).toEqual({
                platform: 'qq',
                user_id: 'fixture',
                'x.hint': ['initial'],
            });
            callOptions!.self!.user_id = 'changed by transport';
            (callOptions!.self!['x.hint'] as string[])[0] = 'changed by transport';

            if (params?.stage === 'prepare') {
                return ok({ file_id: DRAFT });
            }

            return params?.stage === 'finish' ? ok({ file_id: PUBLISHED }) : ok(null);
        });

        const pending = uploadOneBot12FragmentedFile(transport, NAME, input, options);
        input.fill(0x42);
        self.user_id = 'changed by caller';
        self['x.hint'][0] = 'changed by caller';
        options.chunkSize = 1;
        options.maxBytes = 0;
        const digest = sha256(CONTENT);
        expect(await pending).toStrictEqual({
            status: 'ok',
            fileId: PUBLISHED,
            sha256: digest,
            size: 5,
        });
        expect(request.mock.calls.map(([, params]) => params)).toEqual([
            { stage: 'prepare', name: NAME, total_size: 5 },
            { stage: 'transfer', file_id: DRAFT, offset: 0, data: 'AP8=' },
            { stage: 'transfer', file_id: DRAFT, offset: 2, data: 'gAo=' },
            { stage: 'transfer', file_id: DRAFT, offset: 4, data: 'fw==' },
            { stage: 'finish', file_id: DRAFT, sha256: digest },
        ]);
        expect(new Set(request.mock.calls.map(([, , selected]) => selected?.signal)).size).toBe(1);
        expect(request.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
        expect(trap).not.toHaveBeenCalled();
        expect(buffer[0]).toBe(13);
        expect(buffer.at(-1)).toBe(14);
    });

    it('skips transfer and sends the empty digest for a zero-byte input', async () => {
        const bytes = new Uint8Array();
        const request = requester()
            .mockResolvedValueOnce(ok({ file_id: DRAFT }))
            .mockResolvedValueOnce(ok({ file_id: PUBLISHED }));
        const digest = sha256(bytes);
        expect(await uploadOneBot12FragmentedFile({ request }, '', bytes, { maxBytes: 0 })).toEqual(
            {
                status: 'ok',
                fileId: PUBLISHED,
                size: 0,
                sha256: digest,
            },
        );
        expect(request.mock.calls.map(([, params]) => params)).toEqual([
            { stage: 'prepare', name: '', total_size: 0 },
            { stage: 'finish', file_id: DRAFT, sha256: digest },
        ]);
    });

    it.each([
        ['prepare', [business]],
        ['transfer', [ok({ file_id: DRAFT }), ok(null), business]],
        ['finish', [ok({ file_id: DRAFT }), ok(null), ok(null), ok(null), business]],
    ] as const)('preserves a %s business failure and stops', async (stage, replies) => {
        const request = requester();

        for (const response of replies) {
            request.mockResolvedValueOnce(response);
        }

        const result = await uploadOneBot12FragmentedFile({ request }, NAME, CONTENT, {
            maxBytes: 5,
            chunkSize: 2,
        });
        expect(result).toEqual({ status: 'failed', stage, response: business });
        expect(result).not.toHaveProperty('fileId');
        expect(request).toHaveBeenCalledTimes(replies.length);
    });

    it('rejects non-acknowledgements and transport errors without a retry or later stage', async () => {
        const bad = requester()
            .mockResolvedValueOnce(ok({ file_id: DRAFT }))
            .mockResolvedValueOnce(ok({}));
        await rejectsWith(
            uploadOneBot12FragmentedFile({ request: bad }, NAME, CONTENT, { maxBytes: 5 }),
            'invalid_response',
        );
        expect(bad).toHaveBeenCalledTimes(2);

        const error = new Error('fixture unknown outcome');
        const failed = requester()
            .mockResolvedValueOnce(ok({ file_id: DRAFT }))
            .mockResolvedValueOnce(ok(null))
            .mockRejectedValueOnce(error);
        await expect(
            uploadOneBot12FragmentedFile({ request: failed }, NAME, CONTENT, { maxBytes: 5 }),
        ).rejects.toBe(error);
        expect(failed).toHaveBeenCalledTimes(3);
    });

    it('rejects unsuitable byte views before hashing or staging', async () => {
        const trap = vi.fn(() => {
            throw new Error('fixture proxy');
        });
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const Resizable = ArrayBuffer as unknown as new (
            size: number,
            options: { maxByteLength: number },
        ) => ArrayBuffer;
        const request = requester();

        for (const invalid of [
            null,
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            new Uint8Array(new SharedArrayBuffer(1)),
            new Uint8Array(new Resizable(1, { maxByteLength: 2 })),
            detached,
            Object.create(Uint8Array.prototype),
            new Proxy(new Uint8Array(1), { get: trap }),
        ]) {
            await rejectsWith(
                uploadOneBot12FragmentedFile({ request }, NAME, invalid as Uint8Array, {
                    maxBytes: 5,
                }),
                'invalid_options',
            );
        }

        expect(trap).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('enforces allocation and transfer counts before allocating a server draft', async () => {
        const request = requester();
        await rejectsWith(
            uploadOneBot12FragmentedFile({ request }, NAME, CONTENT, { maxBytes: 4 }),
            'limit',
        );
        await rejectsWith(
            uploadOneBot12FragmentedFile({ request }, NAME, new Uint8Array(257), {
                maxBytes: 257,
                chunkSize: 1,
            }),
            'limit',
        );

        for (const options of [
            { maxBytes: -1 },
            { maxBytes: 8 * 1024 * 1024 + 1 },
            { maxBytes: 5, timeoutMs: 0 },
            { maxBytes: 5, expectedSha256: 'a'.repeat(64) },
            { maxBytes: 5, chunkSize: 0 },
        ]) {
            await rejectsWith(
                uploadOneBot12FragmentedFile(
                    { request },
                    NAME,
                    CONTENT,
                    options as OneBot12FragmentedUploadOptions,
                ),
                'invalid_options',
            );
        }

        await rejectsWith(
            uploadOneBot12FragmentedFile({ request }, 'x'.repeat(4097), CONTENT, { maxBytes: 5 }),
            'invalid_options',
        );
        expect(request).not.toHaveBeenCalled();
    });

    it('reports a digest error without reserving a draft and clears its private copy', async () => {
        let staging: Uint8Array | undefined;
        const spy = vi
            .spyOn(globalThis.crypto.subtle, 'digest')
            .mockImplementation(async (_algorithm, data) => {
                staging = data as Uint8Array;
                throw new Error('fixture private error');
            });

        try {
            const request = requester();
            const result = uploadOneBot12FragmentedFile({ request }, NAME, CONTENT, {
                maxBytes: 5,
            });
            await rejectsWith(result, 'protocol');
            await expect(result).rejects.toMatchObject({
                message: 'Fragmented upload digest calculation failed',
            });
            expect(request).not.toHaveBeenCalled();
            expect(staging).toEqual(new Uint8Array(5));
            expect(CONTENT).toEqual(Buffer.from([0, 255, 128, 10, 127]));
        } finally {
            spy.mockRestore();
        }
    });

    it('never stages an already aborted transfer', async () => {
        const cancellation = new AbortController();
        cancellation.abort('fixture private reason');
        const request = requester();
        await rejectsWith(
            uploadOneBot12FragmentedFile({ request }, NAME, CONTENT, {
                maxBytes: 5,
                signal: cancellation.signal,
            }),
            'aborted',
        );
        expect(request).not.toHaveBeenCalled();
    });

    it('stops after an in-flight abort even if the requester later acknowledges the chunk', async () => {
        const cancellation = new AbortController();
        const entered = deferred<AbortSignal | undefined>();
        const held = deferred<OneBot12ActionResponse>();
        const request = requester()
            .mockResolvedValueOnce(ok({ file_id: DRAFT }))
            .mockImplementationOnce((_action, _params, options) => {
                entered.resolve(options?.signal);
                return held.promise;
            });
        const result = uploadOneBot12FragmentedFile({ request }, NAME, CONTENT, {
            maxBytes: 5,
            chunkSize: 2,
            signal: cancellation.signal,
        });
        const signal = await entered.promise;
        cancellation.abort();
        await rejectsWith(result, 'aborted');
        expect(signal?.aborted).toBe(true);
        held.resolve(ok(null));
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('uses the same deadline for digest, prepare and all later stages', async () => {
        const digest = Uint8Array.from(Buffer.from(sha256(CONTENT), 'hex')).buffer;
        vi.useFakeTimers();
        const spy = vi
            .spyOn(globalThis.crypto.subtle, 'digest')
            .mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve(digest), 30)),
            );

        try {
            const held = deferred<OneBot12ActionResponse>();
            const request = requester().mockReturnValueOnce(held.promise);
            const result = uploadOneBot12FragmentedFile({ request }, NAME, CONTENT, {
                maxBytes: 5,
                timeoutMs: 50,
            });
            const checked = rejectsWith(result, 'timeout');
            await vi.advanceTimersByTimeAsync(29);
            expect(request).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(request).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(20);
            await checked;
            held.reject(new Error('late fixture rejection'));
            await vi.advanceTimersByTimeAsync(1);
            expect(request).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            spy.mockRestore();
            vi.useRealTimers();
        }
    });
});
