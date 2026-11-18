import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    COMMUNITY_INDEX_URL,
    INDEX_TTL_MS,
    createCommunityIndexService,
    type IndexError,
    type IndexResult,
} from '../src/webui/plugin-index';

const FIRST_AT = 10_000;
const EXPIRES_AT = FIRST_AT + INDEX_TTL_MS;
const TIMEOUT_MS = 30;
const TAG = '"index-v1"';
const WEAK_TAG = `W/${TAG}`;
const NEW_TAG = '"index-v2"';

function indexFixture(version = '1.0.0') {
    return {
        version,
        updateTime: '2026-01-01T00:00:00Z',
        statsUrl: 'https://fixture.invalid/stats',
        plugins: [
            {
                id: 'fixture',
                name: 'In-memory fixture',
                version,
                description: '',
                author: 'Fixture author',
                homepage: 'https://fixture.invalid/project',
                downloadUrl: 'https://fixture.invalid/plugin.zip',
                minVersion: '4.0.0',
                tags: ['fixture'],
            },
        ],
    };
}

function fullIndex(etag?: string, version?: string, status = 200): Response {
    return new Response(JSON.stringify(indexFixture(version)), {
        status,
        headers: etag === undefined ? undefined : { ETag: etag },
    });
}

function notModified(etag?: string): Response {
    return new Response(null, {
        status: 304,
        headers: etag === undefined ? undefined : { ETag: etag },
    });
}

function snapshot(
    fetchedAt = FIRST_AT,
    error: IndexError | null = null,
    version?: string,
): IndexResult {
    return {
        index: indexFixture(version),
        fetchedAt,
        stale: error !== null,
        error,
        verified: false,
        minVersionTarget: 'NapCat',
    };
}

function emptyResult(error: IndexError): IndexResult {
    return {
        index: null,
        fetchedAt: null,
        stale: true,
        error,
        verified: false,
        minVersionTarget: 'NapCat',
    };
}

function deferredResponse() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function setup(now?: () => number) {
    const nextResponse = vi
        .fn<() => Promise<Response>>()
        .mockRejectedValue(new Error('Unexpected community index request'));
    const requests: {
        url: Parameters<typeof fetch>[0];
        method: RequestInit['method'];
        redirect: RequestInit['redirect'];
        signal: RequestInit['signal'];
        accept: string | null;
        ifNoneMatch: string | null;
    }[] = [];
    const service = createCommunityIndexService({
        timeoutMs: TIMEOUT_MS,
        now,
        fetch(url, init) {
            const headers = new Headers(init?.headers);
            requests.push({
                url,
                method: init?.method,
                redirect: init?.redirect,
                signal: init?.signal,
                accept: headers.get('accept'),
                ifNoneMatch: headers.get('if-none-match'),
            });
            return nextResponse();
        },
    });

    function expectRequests(...tags: (string | null)[]): void {
        expect(requests).toStrictEqual(
            tags.map((tag) => ({
                url: COMMUNITY_INDEX_URL,
                method: 'GET',
                redirect: 'error',
                signal: expect.any(AbortSignal),
                accept: 'application/json',
                ifNoneMatch: tag,
            })),
        );
    }

    return { service, nextResponse, requests, expectRequests };
}

let externalCalls: string[];

function blockExternalCall(name: string): () => never {
    return function blocked(): never {
        externalCalls.push(name);
        throw new Error(`Unexpected external call: ${name}`);
    };
}

beforeEach(() => {
    externalCalls = [];
    vi.useFakeTimers();
    vi.setSystemTime(FIRST_AT);
    vi.stubGlobal('fetch', blockExternalCall('fetch'));
    vi.stubGlobal('WebSocket', blockExternalCall('WebSocket'));
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(
        blockExternalCall('Socket.connect'),
    );
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blockExternalCall('Server.listen'));
    vi.spyOn(http, 'request').mockImplementation(blockExternalCall('http.request'));
    vi.spyOn(http, 'get').mockImplementation(blockExternalCall('http.get'));
    vi.spyOn(https, 'request').mockImplementation(blockExternalCall('https.request'));
    vi.spyOn(https, 'get').mockImplementation(blockExternalCall('https.get'));
    vi.spyOn(tls, 'connect').mockImplementation(blockExternalCall('tls.connect'));
});

afterEach(() => {
    try {
        expect(externalCalls).toStrictEqual([]);
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    }
});

describe('community plugin index conditional revalidation (in memory)', () => {
    it('refreshes TTL on a matching 304 but preserves the public snapshot and fetchedAt', async () => {
        const { service, nextResponse, expectRequests } = setup();
        const reply = deferredResponse();
        const matching = notModified(WEAK_TAG);
        Object.defineProperty(matching, 'url', { value: COMMUNITY_INDEX_URL });
        // A 304 may describe the full representation's size without carrying a body.
        matching.headers.set('content-length', String(JSON.stringify(indexFixture()).length));
        nextResponse
            .mockResolvedValueOnce(fullIndex(TAG))
            .mockImplementationOnce(() => reply.promise)
            .mockResolvedValueOnce(notModified())
            .mockResolvedValueOnce(notModified(TAG));

        expectRequests();
        expect(await service.get()).toStrictEqual(snapshot());
        vi.setSystemTime(EXPIRES_AT - 1);
        expect(await service.get()).toStrictEqual(snapshot());
        expectRequests(null);

        vi.setSystemTime(EXPIRES_AT);
        const refresh = service.get();
        await vi.advanceTimersByTimeAsync(1);
        expectRequests(null, TAG);
        reply.resolve(matching);
        expect(await refresh).toStrictEqual(snapshot());

        vi.setSystemTime(EXPIRES_AT + INDEX_TTL_MS);
        expect(await service.get()).toStrictEqual(snapshot());
        expectRequests(null, TAG);
        vi.setSystemTime(EXPIRES_AT + INDEX_TTL_MS + 1);
        expect(await service.get()).toStrictEqual(snapshot());
        expectRequests(null, TAG, WEAK_TAG);
        expect(await service.get(true)).toStrictEqual(snapshot());
        expectRequests(null, TAG, WEAK_TAG, WEAK_TAG);
    });

    it.each([
        { reason: 'forced with a fresh snapshot', force: true, at: FIRST_AT + 1 },
        { reason: 'expired snapshot', force: false, at: EXPIRES_AT },
    ])('joins synchronous reentry and other callers ($reason)', async ({ force, at }) => {
        const { service, nextResponse, expectRequests } = setup();
        const reply = deferredResponse();
        const reentered: Promise<IndexResult>[] = [];
        const settled = vi.fn();
        const observe = (call: Promise<IndexResult>) =>
            call.then((result) => {
                settled();
                return result;
            });
        nextResponse.mockResolvedValueOnce(fullIndex(TAG)).mockImplementationOnce(() => {
            reentered.push(observe(service.get()), observe(service.get(true)));
            return reply.promise;
        });
        expect(await service.get()).toStrictEqual(snapshot());
        vi.setSystemTime(at);

        const owner = observe(service.get(force));
        const callers = [observe(service.get()), observe(service.get(true))];
        await vi.advanceTimersByTimeAsync(0);
        expectRequests(null, TAG);
        expect(reentered).toHaveLength(2);
        expect(settled).not.toHaveBeenCalled();

        reply.resolve(notModified());
        const [first, ...joined] = await Promise.all([owner, ...callers, ...reentered]);
        const expected = snapshot();
        expect(first).toStrictEqual(expected);
        first.index?.plugins[0].tags?.push('consumer edit');
        expect(joined).toStrictEqual([expected, expected, expected, expected]);
        expect(await service.get()).toStrictEqual(expected);
        expectRequests(null, TAG);
    });

    it.each([
        { clockJoin: 'ordinary read', force: false, fails: false },
        { clockJoin: 'forced read', force: true, fails: false },
        { clockJoin: 'ordinary read, then throws', force: false, fails: true },
        { clockJoin: 'forced read, then throws', force: true, fails: true },
    ])(
        'shares the cache decision when the clock reenters: $clockJoin',
        async ({ force, fails }) => {
            let onClock: (() => void) | undefined;
            const now = vi.fn(() => {
                const callback = onClock;
                onClock = undefined;
                callback?.();
                return Date.now();
            });
            const { service, nextResponse, expectRequests } = setup(now);
            nextResponse
                .mockResolvedValueOnce(fullIndex(TAG))
                .mockResolvedValueOnce(fullIndex(NEW_TAG, '2.0.0'));
            expect(await service.get()).toStrictEqual(snapshot());
            const nextAt = FIRST_AT + 1;
            vi.setSystemTime(nextAt);
            now.mockClear();

            const clockFailure = new Error('Fixture clock failure');
            const joined: Promise<IndexResult>[] = [];

            onClock = () => {
                joined.push(service.get(force));

                if (fails) {
                    throw clockFailure;
                }
            };

            const decisions = Promise.allSettled([service.get(), ...joined]);
            expect(now).toHaveBeenCalledOnce();
            expect(joined).toHaveLength(1);

            if (!force) {
                expectRequests(null);
            }

            // A cache hit or clock failure already chosen must not swallow a subsequent force.
            const [results, subsequent] = await Promise.all([
                decisions,
                force ? null : service.get(true),
            ]);
            const refreshed = snapshot(nextAt, null, '2.0.0');

            if (fails && !force) {
                for (const result of results) {
                    expect(result.status === 'rejected' ? result.reason : result).toBe(
                        clockFailure,
                    );
                }
            } else {
                const expected = { status: 'fulfilled', value: force ? refreshed : snapshot() };
                expect(results).toStrictEqual([expected, expected]);
            }

            if (!force) {
                expect(subsequent).toStrictEqual(refreshed);
            }

            expectRequests(null, TAG);
        },
    );

    it.each([
        { kind: 'empty opaque value', tag: '""' },
        { kind: 'weak empty opaque value', tag: 'W/""' },
        { kind: 'ASCII punctuation including comma and backslash', tag: '"!#~a,b\\c"' },
        { kind: '1024-unit strong tag', tag: `"${'x'.repeat(1022)}"` },
        { kind: '1024-unit weak tag', tag: `W/"${'x'.repeat(1020)}"` },
    ])('sends a valid 200 ETag unchanged: $kind', async ({ tag }) => {
        const { service, nextResponse, expectRequests } = setup();
        nextResponse.mockResolvedValueOnce(fullIndex(tag)).mockResolvedValueOnce(notModified(tag));
        expect(await service.get()).toStrictEqual(snapshot());
        expect(await service.get(true)).toStrictEqual(snapshot());
        expectRequests(null, tag);
    });

    it.each([
        { kind: 'empty header', tag: '' },
        { kind: 'wildcard', tag: '*' },
        { kind: 'list of tags', tag: `${TAG}, W/"other"` },
        { kind: 'missing quotes', tag: 'index-v1' },
        { kind: 'unclosed quote', tag: '"index-v1' },
        { kind: 'space in the opaque value', tag: '"index v1"' },
        { kind: 'space after the weak prefix', tag: `W/ ${TAG}` },
        { kind: 'lowercase weak prefix', tag: `w/${TAG}` },
        { kind: 'non-ASCII byte accepted by Headers', tag: '"caf\u00e9"' },
        { kind: 'DEL', tag: '"tag\x7f"' },
        { kind: '1025-unit strong tag', tag: `"${'x'.repeat(1023)}"` },
        { kind: '1025-unit weak tag', tag: `W/"${'x'.repeat(1021)}"` },
    ])('keeps a valid 200 body without caching its invalid ETag: $kind', async ({ tag }) => {
        const { service, nextResponse, expectRequests } = setup();
        nextResponse.mockResolvedValueOnce(fullIndex(tag)).mockResolvedValueOnce(notModified());
        expect(await service.get()).toStrictEqual(snapshot());
        vi.setSystemTime(EXPIRES_AT);
        expect(await service.get()).toStrictEqual(snapshot(FIRST_AT, 'http'));
        expectRequests(null, null);
    });

    it.each([
        { kind: 'unsolicited 304', response: () => notModified(TAG), error: 'http' },
        {
            kind: 'schema-invalid 200',
            response: () => new Response('{}', { headers: { ETag: TAG } }),
            error: 'invalid',
        },
    ] as const)(
        'does not establish a snapshot or validator from $kind',
        async ({ response, error }) => {
            const { service, nextResponse, expectRequests } = setup();
            nextResponse.mockResolvedValueOnce(response()).mockResolvedValueOnce(notModified(TAG));
            expect(await service.get()).toStrictEqual(emptyResult(error));
            expect(await service.get()).toStrictEqual(emptyResult('http'));
            expectRequests(null, null);
        },
    );

    it('ignores a 200 ETag if the body never completes, even with valid JSON bytes already read', async () => {
        const { service, nextResponse, expectRequests } = setup();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(indexFixture())));
            },
            cancel,
        });
        nextResponse
            .mockResolvedValueOnce(new Response(body, { headers: { ETag: TAG } }))
            .mockResolvedValueOnce(notModified(TAG));

        const initial = service.get();
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
        expect(await initial).toStrictEqual(emptyResult('timeout'));
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(await service.get()).toStrictEqual(emptyResult('http'));
        expectRequests(null, null);
    });

    it.each([
        {
            kind: 'redirected even at the expected URL',
            response: () =>
                Object.defineProperties(notModified(TAG), {
                    redirected: { value: true },
                    url: { value: COMMUNITY_INDEX_URL },
                }),
        },
        {
            kind: 'different path on the same origin',
            response: () =>
                Object.defineProperty(notModified(TAG), 'url', {
                    value: new URL('/different.json', COMMUNITY_INDEX_URL).href,
                }),
        },
        {
            kind: 'different origin',
            response: () =>
                Object.defineProperty(notModified(TAG), 'url', {
                    value: 'https://different.invalid/plugins.v4.json',
                }),
        },
        { kind: 'nonmatching opaque case', response: () => notModified('W/"INDEX-v1"') },
        { kind: 'wildcard ETag', response: () => notModified('*') },
        { kind: 'empty ETag header', response: () => notModified('') },
        {
            kind: 'ETag list containing the sent tag',
            response: () => notModified(`${TAG}, "other"`),
        },
    ])('rejects a 304 without renewing TTL: $kind', async ({ response }) => {
        const { service, nextResponse, expectRequests } = setup();
        nextResponse
            .mockResolvedValueOnce(fullIndex(TAG))
            .mockResolvedValueOnce(response())
            .mockResolvedValueOnce(notModified(TAG));
        expect(await service.get()).toStrictEqual(snapshot());
        vi.setSystemTime(EXPIRES_AT);
        expect(await service.get()).toStrictEqual(snapshot(FIRST_AT, 'http'));
        expectRequests(null, TAG);
        vi.setSystemTime(EXPIRES_AT + 1);
        expect(await service.get()).toStrictEqual(snapshot());
        expectRequests(null, TAG, TAG);
    });

    it('rejects a 304 with a body without waiting for best-effort cancellation', async () => {
        const { service, nextResponse, expectRequests } = setup();
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const stream = new ReadableStream<Uint8Array>({ cancel });
        // The Fetch constructor forbids 304 bodies; emulate a malformed transport result.
        const unexpectedBody = Object.defineProperty(notModified(TAG), 'body', { value: stream });
        nextResponse
            .mockResolvedValueOnce(fullIndex(TAG))
            .mockResolvedValueOnce(unexpectedBody)
            .mockResolvedValueOnce(notModified());
        expect(await service.get()).toStrictEqual(snapshot());
        vi.setSystemTime(EXPIRES_AT);

        const observe = vi.fn<(result: IndexResult) => void>();
        void service.get().then(observe);
        await vi.advanceTimersByTimeAsync(0);
        expect(observe).toHaveBeenCalledExactlyOnceWith(snapshot(FIRST_AT, 'http'));
        expect(cancel).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
        expectRequests(null, TAG);
        expect(await service.get()).toStrictEqual(snapshot());
        expectRequests(null, TAG, TAG);
    });

    it('recovers repeated stale results and retries on the last successful TTL, not on errors', async () => {
        const { service, nextResponse, expectRequests } = setup();
        nextResponse
            .mockResolvedValueOnce(fullIndex(TAG))
            .mockResolvedValueOnce(notModified(NEW_TAG))
            .mockResolvedValueOnce(notModified())
            .mockRejectedValueOnce(new Error('Fixture transport failure'))
            .mockResolvedValueOnce(notModified(WEAK_TAG));
        expect(await service.get()).toStrictEqual(snapshot());

        for (const [cycle, error] of (['http', 'network'] as const).entries()) {
            const lastSuccessAt = FIRST_AT + cycle * INDEX_TTL_MS;
            vi.setSystemTime(lastSuccessAt + 1);
            expect(await service.get(true)).toStrictEqual(snapshot(FIRST_AT, error));
            expect(await service.get()).toStrictEqual(snapshot(FIRST_AT, error));
            vi.setSystemTime(lastSuccessAt + INDEX_TTL_MS);
            expect(await service.get()).toStrictEqual(snapshot());
        }

        expectRequests(null, TAG, TAG, TAG, TAG);
    });

    it.each([
        { kind: '200 with new ETag', status: 200, tag: NEW_TAG, nextTag: NEW_TAG },
        { kind: '200 without ETag', status: 200, tag: undefined, nextTag: null },
        { kind: '200 with malformed ETag', status: 200, tag: '*', nextTag: null },
        { kind: '203 with a valid ETag', status: 203, tag: NEW_TAG, nextTag: null },
    ])(
        'replaces the body and discards the old validator: $kind',
        async ({ status, tag, nextTag }) => {
            const { service, nextResponse, expectRequests } = setup();
            nextResponse
                .mockResolvedValueOnce(fullIndex(TAG))
                .mockResolvedValueOnce(fullIndex(tag, '2.0.0', status))
                .mockResolvedValueOnce(notModified(TAG))
                .mockResolvedValueOnce(notModified(NEW_TAG));
            expect(await service.get()).toStrictEqual(snapshot());
            const replacedAt = FIRST_AT + 1;
            vi.setSystemTime(replacedAt);
            expect(await service.get(true)).toStrictEqual(snapshot(replacedAt, null, '2.0.0'));
            vi.setSystemTime(replacedAt + INDEX_TTL_MS);
            expect(await service.get()).toStrictEqual(snapshot(replacedAt, 'http', '2.0.0'));
            expect(await service.get()).toStrictEqual(
                snapshot(replacedAt, nextTag === null ? 'http' : null, '2.0.0'),
            );
            expectRequests(null, TAG, nextTag, nextTag);
        },
    );

    it('ignores a matching 304 received after timeout and never retries automatically', async () => {
        const { service, nextResponse, requests, expectRequests } = setup();
        const late = deferredResponse();
        nextResponse
            .mockResolvedValueOnce(fullIndex(TAG))
            .mockImplementationOnce(() => late.promise)
            .mockResolvedValueOnce(fullIndex(NEW_TAG, '2.0.0'));
        expect(await service.get()).toStrictEqual(snapshot());
        vi.setSystemTime(FIRST_AT + 1);
        const refresh = service.get(true);
        await vi.advanceTimersByTimeAsync(0);
        expectRequests(null, TAG);
        const signal = requests[1].signal;
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
        expect(await refresh).toStrictEqual(snapshot(FIRST_AT, 'timeout'));
        expect(signal?.aborted).toBe(true);

        await vi.advanceTimersByTimeAsync(EXPIRES_AT - Date.now() - 1);
        expectRequests(null, TAG);
        late.resolve(notModified(WEAK_TAG));
        await vi.advanceTimersByTimeAsync(0);
        expect(await service.get()).toStrictEqual(snapshot(FIRST_AT, 'timeout'));
        expectRequests(null, TAG);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(1);
        expect(await service.get()).toStrictEqual(snapshot(EXPIRES_AT, null, '2.0.0'));
        expectRequests(null, TAG, TAG);
    });
});
