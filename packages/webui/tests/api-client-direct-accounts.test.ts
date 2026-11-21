import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';
import { createDirectAccountsApi } from '../src/lib/api/direct-accounts';
import { controlInput, directAccount, directOperation, pngBytes } from './fixtures/direct-accounts';

const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
const accepted = { account: directAccount, operation: directOperation };

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('authenticated direct account API', () => {
    it('uses the dedicated header and exact routes without putting tokens in URLs', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                json({
                    supported: true,
                    configured: true,
                    reason: null,
                    accounts: [directAccount],
                }),
            )
            .mockResolvedValueOnce(json(accepted, 202))
            .mockResolvedValueOnce(
                new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } }),
            );
        vi.stubGlobal('fetch', fetch);
        const api = createApiClient({
            tokenStore: { load: () => 'private-session', save: vi.fn() },
        });
        await expect(api.directAccounts.list()).resolves.toMatchObject({
            accounts: [directAccount],
        });
        await expect(
            api.directAccounts.start(directAccount.id, { ...controlInput, mode: 'qr' }),
        ).resolves.toEqual(accepted);
        expect((await api.directAccounts.qr(directOperation.id)).type).toBe('image/png');

        for (const [url, init] of fetch.mock.calls) {
            expect(url).not.toContain('private-session');
            expect(new Headers(init.headers).get('X-SnowLuma-Token')).toBe('private-session');
            expect(new Headers(init.headers).has('Authorization')).toBe(false);
            expect(init).toMatchObject({
                cache: 'no-store',
                redirect: 'error',
                credentials: 'same-origin',
            });
        }

        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            '/api/direct/accounts',
            `/api/direct/accounts/${directAccount.id}/start`,
            `/api/direct/operations/${directOperation.id}/qr`,
        ]);
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ ...controlInput, mode: 'qr' });
    });

    it('sends strict stop/renew/cancel bodies and keeps 202 as acceptance', async () => {
        const request = vi.fn().mockImplementation(async () => json(accepted, 202));
        const api = createDirectAccountsApi(request, () => 'token');
        await api.stop(directAccount.id, controlInput);
        await api.renew(directAccount.id, controlInput);
        await api.cancel(directOperation.id);
        expect(request.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
            controlInput,
            controlInput,
            {},
        ]);
        expect(accepted.operation.status).toBe('running');
    });

    it.each([
        [200, accepted],
        [202, null],
        [202, []],
        [202, { ...accepted, account: { ...directAccount, tickets: 'private-marker' } }],
        [202, { ...accepted, operation: { ...directOperation, accountId: 'other' } }],
    ])('rejects an invalid accepted envelope (%s)', async (status, body) => {
        const api = createDirectAccountsApi(
            async () => json(body, status as number),
            () => 'token',
        );
        await expect(
            api.start(directAccount.id, { ...controlInput, mode: 'qr' }),
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('rejects malformed list JSON instead of displaying an empty list', async () => {
        const api = createDirectAccountsApi(
            async () => json([]),
            () => 'token',
        );
        await expect(api.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('keeps a fixed failure and never echoes an extra raw diagnostic', async () => {
        let body: unknown = { status: 'failed', code: 'revision-conflict', message: '状态已变化' };
        const api = createDirectAccountsApi(
            async () => json(body, 409),
            () => 'token',
        );
        await expect(api.stop(directAccount.id, controlInput)).rejects.toMatchObject({
            status: 409,
            code: 'revision-conflict',
        });
        body = { status: 'failed', code: 'bad', message: 'private-marker', cause: 'raw' };
        await expect(api.stop(directAccount.id, controlInput)).rejects.toMatchObject({
            message: '直连账号请求失败',
        });
    });

    it('rejects mismatched operation/account identities', async () => {
        const api = createDirectAccountsApi(
            async () => json({ operation: directOperation }),
            () => 'token',
        );
        await expect(api.operation('d'.repeat(32))).rejects.toMatchObject({
            code: 'INVALID_RESPONSE',
        });
    });

    it.each([
        ['image/svg+xml', new TextEncoder().encode('<svg/>')],
        ['image/png', new TextEncoder().encode('not-png')],
        ['image/jpeg', pngBytes],
    ])('rejects QR type/signature mismatch %s', async (mime, bytes) => {
        const api = createDirectAccountsApi(
            async () => new Response(bytes, { headers: { 'Content-Type': mime } }),
            () => 'token',
        );
        await expect(api.qr(directOperation.id)).rejects.toMatchObject({
            code: 'INVALID_RESPONSE',
        });
    });

    it('bounds chunked bodies and cancels an oversized QR response', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel,
        });
        const api = createDirectAccountsApi(
            async () => new Response(body, { headers: { 'Content-Type': 'image/png' } }),
            () => 'token',
        );
        await expect(api.qr(directOperation.id)).rejects.toMatchObject({
            code: 'INVALID_RESPONSE',
        });
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
    });

    it('keeps the deadline active through an unfinished response body', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        const api = createDirectAccountsApi(
            async () => new Response(body),
            () => 'token',
        );
        const result = expect(api.list()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(30_000);
        await result;
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('drops a late QR from an old token and propagates caller cancellation', async () => {
        let token = 'old';
        const response = Promise.withResolvers<Response>();
        const api = createDirectAccountsApi(
            () => response.promise,
            () => token,
        );
        const result = expect(api.qr(directOperation.id)).rejects.toMatchObject({
            code: 'SESSION_CHANGED',
        });
        token = 'new';
        response.resolve(new Response(pngBytes));
        await result;
        const abort = new AbortController();
        abort.abort();
        await expect(api.qr(directOperation.id, abort.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
    });

    it('rejects private path input and non-UUID requests before fetch', async () => {
        const request = vi.fn();
        const api = createDirectAccountsApi(request, () => 'token');
        expect(() => api.get('../private')).toThrow();
        expect(() =>
            api.start(directAccount.id, { ...controlInput, operationKey: 'bad', mode: 'qr' }),
        ).toThrow();
        expect(request).not.toHaveBeenCalled();
    });
});
