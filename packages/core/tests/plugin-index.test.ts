import { describe, expect, it, vi } from 'vitest';
import {
    COMMUNITY_INDEX_URL,
    INDEX_MAX_BYTES,
    INDEX_TTL_MS,
    createCommunityIndexService,
    parseCommunityIndex,
} from '../src/webui/plugin-index';

function fixture() {
    return {
        version: '1.0.0',
        updateTime: '2026-11-06T14:03:03Z',
        statsUrl: 'https://example.test/stats',
        plugins: [
            {
                id: 'example',
                name: '示例',
                version: '3.3.3-2',
                description: '',
                author: '原作者',
                homepage: 'https://example.test/project',
                downloadUrl: 'https://example.test/plugin.zip',
                minVersion: '4.14.0',
                tags: ['工具'],
                license: 'MIT',
                authorHomepage: 'https://example.test/author',
            },
        ],
    };
}

function ok(data: unknown = fixture()) {
    return new Response(JSON.stringify(data), { status: 200 });
}

function fakeFetch(fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
    return fn as typeof fetch;
}

describe('community plugin index', () => {
    it('is lazy, fetches only the fixed index and preserves source identity and extensions', async () => {
        const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok());
        const service = createCommunityIndexService({ fetch: fakeFetch(fetcher), now: () => 42 });
        expect(fetcher).not.toHaveBeenCalled();
        const result = await service.get();
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][0]).toBe(COMMUNITY_INDEX_URL);
        expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
        expect(result).toMatchObject({
            index: fixture(),
            fetchedAt: 42,
            stale: false,
            verified: false,
            minVersionTarget: 'NapCat',
        });
        expect(result.index?.plugins[0].author).toBe('原作者');
    });

    it('deduplicates concurrent fetches and honours TTL and explicit refresh', async () => {
        let clock = 100;
        let complete!: (response: Response) => void;
        const fetcher = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    complete = resolve;
                }),
        );
        const service = createCommunityIndexService({
            fetch: fakeFetch(fetcher),
            now: () => clock,
        });
        const first = service.get();
        const second = service.get(true);
        expect(fetcher).toHaveBeenCalledOnce();
        complete(ok());
        const [a, b] = await Promise.all([first, second]);
        expect(a).toEqual(b);

        if (a.index) {
            a.index.plugins[0].author = 'changed';
        }

        expect((await service.get()).index?.plugins[0].author).toBe('原作者');
        clock += INDEX_TTL_MS;
        const third = service.get();
        expect(fetcher).toHaveBeenCalledTimes(2);
        complete(ok());
        await third;
        const forced = service.get(true);
        expect(fetcher).toHaveBeenCalledTimes(3);
        complete(ok());
        await forced;
    });

    it('retains the last snapshot with an explicit error after refresh failure', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(ok())
            .mockRejectedValue(new Error('private token'));
        const service = createCommunityIndexService({ fetch: fakeFetch(fetcher), now: () => 42 });
        await service.get();
        expect(await service.get(true)).toMatchObject({
            index: fixture(),
            stale: true,
            error: 'network',
        });
        expect(await service.get()).toMatchObject({ stale: true, error: 'network' });
        const failure = await createCommunityIndexService({ fetch: fakeFetch(fetcher) }).get();
        expect(failure).toMatchObject({ index: null, stale: true, error: 'network' });
        expect(JSON.stringify(failure)).not.toContain('private token');
    });

    it('rejects HTTP errors, redirects, invalid JSON and excessive content', async () => {
        for (const [response, error] of [
            [new Response('', { status: 500 }), 'http'],
            [new Response('{'), 'invalid'],
            [
                new Response('x', { headers: { 'content-length': String(INDEX_MAX_BYTES + 1) } }),
                'too_large',
            ],
            [new Response('x'.repeat(INDEX_MAX_BYTES + 1)), 'too_large'],
        ] as const) {
            const service = createCommunityIndexService({ fetch: fakeFetch(async () => response) });
            expect(await service.get()).toMatchObject({ index: null, error });
        }

        const redirected = ok();
        Object.defineProperty(redirected, 'redirected', { value: true });
        expect(
            await createCommunityIndexService({ fetch: fakeFetch(async () => redirected) }).get(),
        ).toMatchObject({ error: 'http' });
    });

    it('aborts and resolves a timeout even if the injected fetch ignores the signal', async () => {
        let signal: AbortSignal | undefined;
        const service = createCommunityIndexService({
            timeoutMs: 5,
            fetch: fakeFetch(async (_url, init) => {
                signal = init?.signal ?? undefined;
                return new Promise<Response>(() => {});
            }),
        });
        expect(await service.get()).toMatchObject({ index: null, error: 'timeout' });
        expect(signal?.aborted).toBe(true);
    });

    it('cancels discarded response bodies on HTTP, redirect and size failures', async () => {
        for (const kind of ['http', 'redirect', 'length', 'stream'] as const) {
            const cancel = vi.fn(() => Promise.reject(new Error('untrusted')));
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (kind === 'stream') {
                        controller.enqueue(new Uint8Array(INDEX_MAX_BYTES + 1));
                    }
                },
                cancel,
            });
            const response = new Response(stream, {
                status: kind === 'http' ? 500 : 200,
                headers: kind === 'length' ? { 'content-length': String(INDEX_MAX_BYTES + 1) } : {},
            });

            if (kind === 'redirect') {
                Object.defineProperty(response, 'redirected', { value: true });
            }

            const result = await createCommunityIndexService({
                fetch: fakeFetch(async () => response),
            }).get();
            expect(result.error).toBe(
                kind === 'http' || kind === 'redirect' ? 'http' : 'too_large',
            );
            expect(cancel).toHaveBeenCalledOnce();
            expect(stream.locked).toBe(false);
        }
    });

    it('cancels and unlocks a stalled reader without waiting for cancellation and permits retry', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const stream = new ReadableStream<Uint8Array>({ cancel });
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(stream))
            .mockResolvedValueOnce(ok());
        const service = createCommunityIndexService({ fetch: fakeFetch(fetcher), timeoutMs: 5 });
        expect(await service.get()).toMatchObject({ error: 'timeout', index: null });
        expect(cancel).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
        expect(await service.get()).toMatchObject({ error: null, index: fixture() });
    });

    it('cancels a response arriving after the timeout', async () => {
        let complete!: (response: Response) => void;
        const cancel = vi.fn();
        const stream = new ReadableStream<Uint8Array>({ cancel });
        const fetcher = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    complete = resolve;
                }),
        );
        const service = createCommunityIndexService({ fetch: fakeFetch(fetcher), timeoutMs: 5 });
        expect(await service.get()).toMatchObject({ error: 'timeout' });
        complete(new Response(stream));
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(stream.locked).toBe(false);
    });

    it('bounds chunk counts and memory even for empty or tiny chunks', async () => {
        for (const size of [0, 1]) {
            const cancel = vi.fn();
            let count = 0;
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    count++;
                    controller.enqueue(new Uint8Array(size));
                },
                cancel,
            });
            const result = await createCommunityIndexService({
                fetch: fakeFetch(async () => new Response(stream)),
            }).get();
            expect(result).toMatchObject({ index: null, error: 'invalid' });
            expect(count).toBeLessThanOrEqual(8195);
            expect(cancel).toHaveBeenCalledOnce();
            expect(stream.locked).toBe(false);
        }

        const bytes = new TextEncoder().encode(JSON.stringify(fixture()));
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const byte of bytes) {
                    controller.enqueue(Uint8Array.of(byte));
                }

                controller.close();
            },
        });
        const result = await createCommunityIndexService({
            fetch: fakeFetch(async () => new Response(stream)),
        }).get();
        expect(result).toMatchObject({ index: fixture(), error: null });

        const large = {
            ...fixture(),
            padding: Array.from({ length: 128 }, () => 'x'.repeat(16000)),
        };
        const largeBytes = new TextEncoder().encode(JSON.stringify(large));
        expect(largeBytes.byteLength).toBeLessThan(INDEX_MAX_BYTES);
        const largeStream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let offset = 0; offset < largeBytes.length; offset += 65536) {
                    controller.enqueue(largeBytes.subarray(offset, offset + 65536));
                }

                controller.close();
            },
        });
        const largeResult = await createCommunityIndexService({
            fetch: fakeFetch(async () => new Response(largeStream)),
        }).get();
        expect(largeResult).toMatchObject({ error: null, index: large });
    });

    it('bounds recursive JSON and validates required fields without assuming semver', () => {
        expect(parseCommunityIndex(fixture()).plugins[0].version).toBe('3.3.3-2');
        const withoutTags = fixture();
        const { tags: _tags, ...pluginWithoutTags } = withoutTags.plugins[0];
        expect(
            parseCommunityIndex({ ...withoutTags, plugins: [pluginWithoutTags] }).plugins[0].tags,
        ).toBeUndefined();
        const missing = fixture();
        missing.plugins[0].author = '';
        expect(() => parseCommunityIndex(missing)).toThrow();
        const badUrl = fixture();
        badUrl.plugins[0].homepage = 'javascript:alert(1)';
        expect(() => parseCommunityIndex(badUrl)).toThrow();
        const credentials = fixture();
        credentials.plugins[0].downloadUrl = 'https://user:password@example.test/a';
        expect(() => parseCommunityIndex(credentials)).toThrow();
        const deep: Record<string, unknown> = {};
        let node = deep;

        for (let i = 0; i < 20; i++) {
            node.next = {};
            node = node.next as Record<string, unknown>;
        }

        expect(() => parseCommunityIndex({ ...fixture(), deep })).toThrow();
        expect(() => parseCommunityIndex(JSON.parse('{"__proto__":{},"plugins":[]}'))).toThrow();
    });
});
