import { describe, expect, it, vi } from 'vitest';
import { abortable } from '../../src/v12/client-types.js';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';

describe('OneBot 12 abort cleanup', () => {
    it('observes an input promise even when the signal was already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const pending = new Promise<string>(() => {});
        const then = vi.spyOn(pending, 'then');
        const failure = new Error('aborted');

        await expect(abortable(pending, controller.signal, () => failure)).rejects.toBe(failure);
        expect(then).toHaveBeenCalledTimes(1);
    });

    it('preserves abort if observing a modified promise throws', async () => {
        const controller = new AbortController();
        controller.abort();
        const pending = new Promise<string>(() => {});
        Object.defineProperty(pending, 'constructor', {
            get() {
                throw new Error('synthetic constructor error');
            },
        });
        const failure = new Error('aborted');

        await expect(abortable(pending, controller.signal, () => failure)).rejects.toBe(failure);
    });

    it('does not suppress the input rejection for another consumer', async () => {
        const controller = new AbortController();
        controller.abort();
        const failure = new Error('synthetic input failure');
        let rejectInput: ((error: Error) => void) | undefined;
        const pending = new Promise<string>((_, reject) => {
            rejectInput = reject;
        });
        const otherConsumer = pending.catch((error: unknown) => error);

        await expect(
            abortable(pending, controller.signal, () => new Error('aborted')),
        ).rejects.toThrow('aborted');
        rejectInput?.(failure);
        await expect(otherConsumer).resolves.toBe(failure);
    });

    it('preserves a read failure when no abort occurs', async () => {
        const reader = {
            read: () => Promise.reject(new Error('synthetic read error')),
            cancel: vi.fn(async () => {}),
            releaseLock: vi.fn(),
        };
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () =>
                ({
                    status: 200,
                    headers: new Headers(),
                    body: { getReader: () => reader },
                }) as unknown as Response,
        });

        await expect(client.request('get_status')).rejects.toMatchObject({ code: 'network' });
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    });

    it.each(['aborted', 'network'] as const)(
        'preserves %s and releases the reader if cancellation throws synchronously',
        async (expectedCode) => {
            const controller = new AbortController();
            const reader = {
                read() {
                    if (expectedCode === 'aborted') {
                        controller.abort();
                    }

                    throw new Error('synthetic read error');
                },
                cancel: vi.fn(() => {
                    throw new Error('synthetic cancel error');
                }),
                releaseLock: vi.fn(),
            };
            const client = new OneBot12HttpClient({
                baseUrl: 'http://example.test/',
                fetch: async () =>
                    ({
                        status: 200,
                        headers: new Headers(),
                        body: { getReader: () => reader },
                    }) as unknown as Response,
            });

            await expect(
                client.request('get_status', {}, { signal: controller.signal }),
            ).rejects.toMatchObject({ code: expectedCode });
            expect(reader.cancel).toHaveBeenCalledTimes(1);
            expect(reader.releaseLock).toHaveBeenCalledTimes(1);
        },
    );

    it('releases a successfully read response without cancelling it', async () => {
        let first = true;
        const reader = {
            read: vi.fn(async () => {
                if (first) {
                    first = false;
                    return {
                        done: false as const,
                        value: new TextEncoder().encode(
                            JSON.stringify({ status: 'ok', retcode: 0, data: null, message: '' }),
                        ),
                    };
                }

                return { done: true as const, value: undefined };
            }),
            cancel: vi.fn(async () => {}),
            releaseLock: vi.fn(),
        };
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () =>
                ({
                    status: 200,
                    headers: new Headers(),
                    body: { getReader: () => reader },
                }) as unknown as Response,
        });

        await expect(client.request('get_status')).resolves.toMatchObject({ status: 'ok' });
        expect(reader.cancel).not.toHaveBeenCalled();
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    });

    it('releases the reader when a nonstandard cancellation returns no promise', async () => {
        const reader = {
            read: () => Promise.reject(new Error('synthetic read error')),
            cancel: vi.fn(() => undefined),
            releaseLock: vi.fn(),
        };
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () =>
                ({
                    status: 200,
                    headers: new Headers(),
                    body: { getReader: () => reader },
                }) as unknown as Response,
        });

        await expect(client.request('get_status')).rejects.toMatchObject({ code: 'network' });
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    });

    it('observes a cancellation that rejects after the request settles', async () => {
        let rejectCancel: ((error: Error) => void) | undefined;
        const reader = {
            read: () => Promise.reject(new Error('synthetic read error')),
            cancel: vi.fn(
                () =>
                    new Promise<void>((_, reject) => {
                        rejectCancel = reject;
                    }),
            ),
            releaseLock: vi.fn(),
        };
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () =>
                ({
                    status: 200,
                    headers: new Headers(),
                    body: { getReader: () => reader },
                }) as unknown as Response,
        });

        await expect(client.request('get_status')).rejects.toMatchObject({ code: 'network' });
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
        expect(rejectCancel).toBeDefined();
        rejectCancel?.(new Error('synthetic late cancel error'));
        await new Promise<void>((resolve) => setImmediate(resolve));
    });

    it('cancels an HTTP reader if it aborts synchronously and later rejects', async () => {
        const controller = new AbortController();
        let rejectRead: ((error: Error) => void) | undefined;
        const cancel = vi.fn(async () => {});
        const releaseLock = vi.fn();
        const reader = {
            read() {
                controller.abort();
                return new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
                    rejectRead = reject;
                });
            },
            cancel,
            releaseLock,
        };
        const response = {
            status: 200,
            headers: new Headers(),
            body: { getReader: () => reader },
        } as unknown as Response;
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () => response,
        });

        await expect(
            client.request('get_status', {}, { signal: controller.signal }),
        ).rejects.toMatchObject({
            code: 'aborted',
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(releaseLock).toHaveBeenCalledTimes(1);
        expect(rejectRead).toBeDefined();
        rejectRead?.(new Error('synthetic late read error'));
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
});
