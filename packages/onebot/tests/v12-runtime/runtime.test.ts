import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocket } from '@snowluma/websocket';
import { subscribeLogs } from '@snowluma/common/logger';
import { V12Transport } from '../../src/v12-network';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { makeDefaultOneBotConfig } from '../../src/config';
import { OneBotInstance } from '../../src/instance';
import { OneBotNetworkManager, type DesiredNetworkAdapter } from '../../src/network';
import type { OneBotConfig } from '../../src/types';

const instances: OneBotInstance[] = [];
const sockets: WebSocket[] = [];
const token = randomBytes(32).toString('base64url');
const newToken = randomBytes(32).toString('base64url');

afterEach(async () => {
    for (const ws of sockets.splice(0)) {
        ws.terminate();
    }

    for (const instance of instances.splice(0)) {
        await instance.dispose();
    }
});

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
}

function config(port: number, accessToken = token): OneBotConfig {
    const value = makeDefaultOneBotConfig();
    value.networks = { httpServers: [], httpClients: [], wsServers: [], wsClients: [] };
    value.v12 = { enabled: true, host: '127.0.0.1', port, accessToken, allowNonLoopback: false };
    value.statusCommand.enabled = false;
    return value;
}

async function fixture(
    uin: string,
    port: number,
    time: () => Promise<number | null> = async () => 1700000000,
) {
    const send = vi.fn(async () => ({ messageId: -123 }));
    const api = new ApiHandler(
        { sendPrivateMessage: send } as unknown as ApiActionContext,
        Number(uin),
    );
    const instance = Object.create(OneBotInstance.prototype) as OneBotInstance;
    const internals = instance as unknown as {
        createNetworkAdapter(desired: DesiredNetworkAdapter, ctx: unknown): unknown;
        dispatchEvent(event: Record<string, unknown>, source?: 'bridge' | 'send'): Promise<void>;
        trackAction<T>(label: string, start: () => Promise<T>): Promise<T>;
    };
    const log = { warn: vi.fn(), trace: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const closeStore = vi.fn(async () => undefined);
    const manager = new OneBotNetworkManager(
        (desired) =>
            internals.createNetworkAdapter(desired, {
                uin,
                api,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            }) as never,
    );
    Object.assign(instance as unknown as Record<string, unknown>, {
        uin,
        bridge: { receiveHealthy: true },
        apiHandler: api,
        messageStore: {
            findMeta: async () => {
                const timestamp = await time();
                return timestamp === null ? null : { timestamp };
            },
            close: closeStore,
        },
        mediaStore: { close: closeStore },
        reactionStore: { close: closeStore },
        networkManager: manager,
        lifecycleTail: Promise.resolve(),
        ctx: { config: config(port) },
        online: true,
        v12Online: false,
        v12Adapter: null,
        heartbeatTimer: null,
        eventPipeline: null,
        eventPipelineDrain: Promise.resolve(),
        disposePromise: null,
        disposeRequested: false,
        acceptingActions: true,
        inFlightActions: new Set(),
        historySyncAbortController: new AbortController(),
        historySyncTask: null,
        storeCloseState: { message: false, media: false, reaction: false },
        recentSelfSentEvents: new Map(),
        statusCommandCooldown: new Map(),
        cacheMessageEvent: vi.fn(async () => true),
        logReceivedMessage: vi.fn(async () => undefined),
        log,
    });
    instances.push(instance);
    expect((await manager.reconcile(config(port))).applied).toBe(true);
    return { instance, internals, manager, send, closeStore, log };
}

async function request(port: number, action: object, accessToken = token) {
    const result = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(action),
    });
    return { status: result.status, body: (await result.json()) as any };
}

function connect(port: number, accessToken = token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?access_token=${accessToken}`);
    sockets.push(ws);
    const values: any[] = [];
    const waiters: Array<(value: any) => void> = [];
    ws.on('message', (data: Buffer) => {
        const value = JSON.parse(data.toString());
        const waiter = waiters.shift();

        if (waiter) {
            waiter(value);
        } else {
            values.push(value);
        }
    });
    return {
        ws,
        next: () =>
            values.length
                ? Promise.resolve(values.shift())
                : new Promise<any>((resolve) => waiters.push(resolve)),
    };
}

const sendRequest = {
    action: 'send_message',
    params: {
        detail_type: 'private',
        user_id: '20001',
        message: [{ type: 'text', data: { text: 'hi' } }],
    },
};

describe('v12 instance integration on loopback', () => {
    it('routes through the real handler and per-account stores, including negative IDs and auth', async () => {
        const [pa, pb] = await Promise.all([freePort(), freePort()]);
        const a = await fixture('10001', pa);
        const b = await fixture('10002', pb, async () => 1700000001);
        expect((await request(pa, sendRequest, 'wrong')).status).toBe(401);
        const sent = await request(pa, sendRequest);
        expect(sent.body).toMatchObject({
            status: 'ok',
            data: { message_id: '-123', time: 1700000000 },
        });
        expect(a.send).toHaveBeenCalledOnce();
        expect(b.send).not.toHaveBeenCalled();
        const wrong = await request(pb, {
            ...sendRequest,
            self: { platform: 'qq', user_id: '10001' },
        });
        expect(wrong.body.retcode).toBe(10102);
        const wrongPlatform = await request(pb, {
            ...sendRequest,
            self: { platform: 'other', user_id: '10002' },
        });
        expect(wrongPlatform.body.retcode).toBe(10102);
        expect(b.send).not.toHaveBeenCalled();
        const initial = await request(pb, { action: 'get_status', params: {} });
        expect(initial.body.data).toMatchObject({
            good: false,
            bots: [{ self: { user_id: '10002' }, online: false }],
        });
        await b.instance.emitBotStatus('online');
        expect((await request(pb, { action: 'get_status', params: {} })).body.data.good).toBe(true);
    });

    it('sends connect then the current account status to each new connection', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const first = connect(port);
        const firstConnect = await first.next();
        expect(firstConnect).toMatchObject({
            type: 'meta',
            detail_type: 'connect',
            version: { impl: 'jiyu', onebot_version: '12' },
        });
        expect(await first.next()).toMatchObject({
            type: 'meta',
            detail_type: 'status_update',
            status: {
                good: false,
                bots: [{ self: { platform: 'qq', user_id: '10001' }, online: false }],
            },
        });
        const version = await request(port, { action: 'get_version', params: {} });
        expect(version.body.data).toEqual(firstConnect.version);
        await f.instance.emitBotStatus('online');
        expect(await first.next()).toMatchObject({
            detail_type: 'status_update',
            status: { good: true, bots: [{ online: true }] },
        });
        const second = connect(port);
        expect(await second.next()).toMatchObject({ detail_type: 'connect' });
        expect(await second.next()).toMatchObject({
            detail_type: 'status_update',
            status: { good: true, bots: [{ online: true }] },
        });
        first.ws.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'no-broadcast' }));
        expect(await first.next()).toMatchObject({ echo: 'no-broadcast', status: 'ok' });
    });

    it('keeps v11 status delivery when v12 status observation fails', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const client = connect(port);
        await client.next();
        await client.next();
        const debug = vi.fn();
        f.manager.subscribeDebug(debug);
        const bridge = (f.instance as unknown as { bridge: object }).bridge;
        Object.defineProperty(bridge, 'receiveHealthy', {
            get: () => {
                throw new Error(token);
            },
        });
        const logs: string[] = [];
        const unsubscribe = subscribeLogs((entry) => logs.push(entry.message));

        try {
            await f.instance.emitBotStatus('online');
            expect(debug).toHaveBeenCalledWith(
                expect.objectContaining({ notice_type: 'bot_status' }),
            );
            expect(logs.join(' ')).toContain('v12 status update unavailable');
            expect(logs.join(' ')).not.toContain(token);
        } finally {
            unsubscribe();
        }
    });

    it('fans out only after pipeline suppression and preserves v11 on unsupported self events', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const client = connect(port);
        await client.next();
        await client.next();
        const debug = vi.fn();
        f.manager.subscribeDebug(debug);
        const base = {
            time: 1700000000,
            self_id: 10001,
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            user_id: 20001,
            message_id: -10,
            message_seq: 5,
            raw_message: 'hi',
            message: [{ type: 'text', data: { text: 'hi' } }],
        };
        await f.internals.dispatchEvent(base);
        expect(await client.next()).toMatchObject({
            type: 'message',
            message_id: '-10',
            self: { user_id: '10001' },
        });
        const self = { ...base, post_type: 'message_sent', user_id: 10001, target_id: 20001 };
        await f.internals.dispatchEvent(self, 'send');
        await f.internals.dispatchEvent(self, 'bridge');
        expect(debug).toHaveBeenCalledTimes(2);
        client.ws.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'after-self' }));
        expect(await client.next()).toMatchObject({ echo: 'after-self', status: 'ok' });
    });

    it('force release revokes existing clients and drops the listener', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const client = connect(port);
        await client.next();
        await client.next();
        const closed = new Promise<void>((resolve) => client.ws.once('close', () => resolve()));
        f.instance.forceRelease();
        await closed;
        await vi.waitFor(async () => {
            await expect(request(port, { action: 'get_version', params: {} })).rejects.toThrow();
        });
    });

    it('drains metadata lookup after quiescing before store close', async () => {
        const port = await freePort();
        let finish!: (value: number | null) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<number | null>((resolve) => {
            finish = resolve;
        });
        const f = await fixture('10001', port, async () => {
            entered();
            return gate;
        });
        const response = request(port, sendRequest).catch(() => null);
        await started;
        const disposing = f.instance.dispose();
        await Promise.resolve();
        expect(f.closeStore).not.toHaveBeenCalled();
        finish(1700000000);
        await response;
        await disposing;
        expect(f.closeStore).toHaveBeenCalledTimes(3);
    });

    it('hands listener ports between v11 and v12 inside the same FIFO', async () => {
        const [a, b] = await Promise.all([freePort(), freePort()]);
        const f = await fixture('10001', a);
        const moved = config(b);
        moved.networks.httpServers.push({
            name: 'v11-http',
            host: '127.0.0.1',
            port: a,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        expect((await f.instance.reloadConfig(moved)).applied).toBe(true);
        expect((await request(b, { action: 'get_version', params: {} })).status).toBe(200);
        const swapped = config(a);
        swapped.networks.httpServers.push({
            name: 'v11-http',
            host: '127.0.0.1',
            port: b,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        expect((await f.instance.reloadConfig(swapped)).applied).toBe(true);
        expect((await request(a, { action: 'get_version', params: {} })).status).toBe(200);
    });

    it('reports a failed port change and restores or retries the previous listener', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const blocker = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const blockedPort = (blocker.address() as { port: number }).port;

        try {
            const result = await f.instance.reloadConfig(config(blockedPort));
            expect(result.applied).toBe(false);
            expect(result.errors.some((error) => error.name === 'OneBot v12')).toBe(true);
            expect(f.instance.getConnectionStatuses()[0].status).toBe('degraded');
            expect((await request(port, { action: 'get_version', params: {} })).status).toBe(200);
        } finally {
            await new Promise<void>((resolve, reject) =>
                blocker.close((error) => (error ? reject(error) : resolve())),
            );
        }

        expect((await f.instance.reloadConfig(config(blockedPort))).applied).toBe(true);
        expect((await request(blockedPort, { action: 'get_version', params: {} })).status).toBe(
            200,
        );
    });

    it('never revives disabled v12 when a same-name v11 replacement fails and retries', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        expect((await request(port, { action: 'get_version', params: {} })).status).toBe(200);
        const client = connect(port);
        await client.next();
        await client.next();
        const closed = new Promise<void>((resolve) => client.ws.once('close', () => resolve()));
        const blocker = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const blockedPort = (blocker.address() as { port: number }).port;
        const next = config(port, newToken);
        next.v12!.enabled = false;
        next.networks.httpServers.push({
            name: 'OneBot v12',
            host: '127.0.0.1',
            port: blockedPort,
            accessToken: newToken,
            messageFormat: 'array',
            reportSelfMessage: false,
        });

        try {
            const result = await f.instance.reloadConfig(next);
            expect(result.applied).toBe(false);
            expect(result.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        name: 'OneBot v12',
                        phase: 'replace',
                        restored: false,
                    }),
                ]),
            );
            expect(f.instance.getConnectionStatuses()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'OneBot v12', status: 'degraded' }),
                ]),
            );
            await closed;
            await expect(
                request(port, { action: 'get_version', params: {} }, token),
            ).rejects.toThrow();
            await expect(
                request(port, { action: 'get_version', params: {} }, newToken),
            ).rejects.toThrow();
        } finally {
            await new Promise<void>((resolve, reject) =>
                blocker.close((error) => (error ? reject(error) : resolve())),
            );
        }

        expect((await f.instance.reloadConfig(next)).applied).toBe(true);
        expect(f.manager.get('OneBot v12')?.isActive).toBe(true);
        const result = await request(
            blockedPort,
            { action: 'send_private_msg', params: { user_id: 20001, message: 'hi' } },
            newToken,
        );
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ status: 'ok', data: { message_id: -123 } });
    });

    it('retains the old v11 listener if restoration binds then throws', async () => {
        const [oldPort, originalV12Port] = await Promise.all([freePort(), freePort()]);
        const f = await fixture('10001', originalV12Port);
        const v11 = config(originalV12Port);
        v11.v12!.enabled = false;
        v11.networks.httpServers.push({
            name: 'OneBot v12',
            host: '127.0.0.1',
            port: oldPort,
            accessToken: token,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        expect((await f.instance.reloadConfig(v11)).applied).toBe(true);
        const old = f.manager.get('OneBot v12')!;
        const realOpen = old.open.bind(old);
        const restore = vi.spyOn(old, 'open').mockImplementationOnce(async () => {
            await realOpen();
            throw new Error(`restore fixture ${token} ${newToken}`);
        });
        const blocker = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const blockedPort = (blocker.address() as { port: number }).port;

        try {
            const result = await f.instance.reloadConfig(config(blockedPort, newToken));
            expect(result.applied).toBe(false);
            expect(result.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ phase: 'restore' }),
                    expect.objectContaining({ phase: 'replace', restored: false }),
                ]),
            );
            expect(JSON.stringify(result)).not.toContain(token);
            expect(JSON.stringify(result)).not.toContain(newToken);
            expect(f.manager.get('OneBot v12')).toBe(old);
            expect(f.instance.getConnectionStatuses()[0].status).toBe('degraded');
            expect(
                (
                    await request(
                        oldPort,
                        { action: 'send_private_msg', params: { user_id: 20001, message: 'hi' } },
                        token,
                    )
                ).status,
            ).toBe(200);
            f.instance.forceRelease();
            await vi.waitFor(async () => {
                await expect(
                    request(oldPort, { action: 'get_version', params: {} }, token),
                ).rejects.toThrow();
            });
            await f.instance.dispose();
        } finally {
            restore.mockRestore();
            await new Promise<void>((resolve, reject) =>
                blocker.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });

    it('never revives disabled v12 when the same-name v11 factory fails', async () => {
        const [port, replacementPort] = await Promise.all([freePort(), freePort()]);
        const f = await fixture('10001', port);
        const next = config(port, newToken);
        next.v12!.enabled = false;
        next.networks.httpServers.push({
            name: 'OneBot v12',
            host: '127.0.0.1',
            port: replacementPort,
            accessToken: newToken,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        const factory = vi.spyOn(f.internals, 'createNetworkAdapter').mockImplementationOnce(() => {
            throw new Error(`factory failure ${token} ${newToken}`);
        });

        try {
            const result = await f.instance.reloadConfig(next);
            expect(result.applied).toBe(false);
            expect(result.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ phase: 'replace', restored: false }),
                ]),
            );
            expect(JSON.stringify(result)).not.toContain(token);
            expect(JSON.stringify(result)).not.toContain(newToken);
            expect(f.instance.getConnectionStatuses()[0].status).toBe('degraded');
            await expect(request(port, { action: 'get_version', params: {} })).rejects.toThrow();
        } finally {
            factory.mockRestore();
        }

        expect((await f.instance.reloadConfig(next)).applied).toBe(true);
        expect(f.manager.get('OneBot v12')?.isActive).toBe(true);
    });

    it('revokes the old token before an unrelated v11 handoff close fails', async () => {
        const [a, b] = await Promise.all([freePort(), freePort()]);
        const f = await fixture('10001', a);
        const initial = config(a);
        initial.networks.httpServers.push({
            name: 'v11-http',
            host: '127.0.0.1',
            port: b,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        expect((await f.instance.reloadConfig(initial)).applied).toBe(true);
        const client = connect(a);
        await client.next();
        await client.next();
        const closed = new Promise<void>((resolve) => client.ws.once('close', () => resolve()));
        const logs: string[] = [];
        const unsubscribe = subscribeLogs((entry) => logs.push(entry.message));
        const close = vi
            .spyOn(f.manager.get('v11-http')!, 'close')
            .mockRejectedValueOnce(new Error(`fixture close failure ${token} ${newToken}`));

        try {
            const next = config(b, newToken);
            next.networks.httpServers.push({
                name: 'v11-http',
                host: '127.0.0.1',
                port: a,
                messageFormat: 'array',
                reportSelfMessage: false,
            });
            const result = await f.instance.reloadConfig(next);
            expect(result.applied).toBe(false);
            const outward = JSON.stringify({
                result,
                statuses: f.instance.getConnectionStatuses(),
                logs,
            });
            expect(outward).not.toContain(token);
            expect(outward).not.toContain(newToken);
            expect(outward).toContain('network operation failed');
            await closed;
            await expect(request(a, { action: 'get_version', params: {} })).rejects.toThrow();
        } finally {
            close.mockRestore();
            unsubscribe();
        }
    });

    it('redacts v12 credentials in a separate v11 open failure', async () => {
        const [a, b] = await Promise.all([freePort(), freePort()]);
        const f = await fixture('10001', a);
        const next = config(a, newToken);
        next.networks.httpServers.push({
            name: 'new-v11',
            host: '127.0.0.1',
            port: b,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        const original = f.internals.createNetworkAdapter.bind(f.instance);
        const factory = vi
            .spyOn(f.internals, 'createNetworkAdapter')
            .mockImplementation((desired, ctx) => {
                const adapter = original(desired, ctx) as { open(): Promise<void> };

                if (desired.name === 'new-v11') {
                    vi.spyOn(adapter, 'open').mockRejectedValueOnce(
                        new Error(`fixture v11 open ${token} ${newToken}`),
                    );
                }

                return adapter;
            });
        const logs: string[] = [];
        const unsubscribe = subscribeLogs((entry) => logs.push(entry.message));

        try {
            const result = await f.instance.reloadConfig(next);
            expect(result.applied).toBe(false);
            const outward = JSON.stringify({
                result,
                statuses: f.instance.getConnectionStatuses(),
                logs,
            });
            expect(outward).not.toContain(token);
            expect(outward).not.toContain(newToken);
            expect(outward).toContain('network operation failed');
            expect((await request(a, { action: 'get_version', params: {} }, token)).status).toBe(
                401,
            );
            expect((await request(a, { action: 'get_version', params: {} }, newToken)).status).toBe(
                200,
            );
        } finally {
            factory.mockRestore();
            unsubscribe();
        }
    });

    it('does not log current or revoked v12 credentials on a later v11 shutdown failure', async () => {
        const [a, b] = await Promise.all([freePort(), freePort()]);
        const f = await fixture('10001', a);
        const next = config(a, newToken);
        next.networks.httpServers.push({
            name: 'new-v11',
            host: '127.0.0.1',
            port: b,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
        expect((await f.instance.reloadConfig(next)).applied).toBe(true);
        const close = vi
            .spyOn(f.manager.get('new-v11')!, 'close')
            .mockRejectedValueOnce(new Error(`shutdown fixture ${token} ${newToken}`));
        const logs: string[] = [];
        const unsubscribe = subscribeLogs((entry) => logs.push(entry.message));

        try {
            let failure: unknown;

            try {
                await f.instance.dispose();
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(Error);
            const outward = JSON.stringify({
                failure: failure instanceof Error ? failure.message : String(failure),
                statuses: f.instance.getConnectionStatuses(),
                logs,
            });
            expect(outward).not.toContain(token);
            expect(outward).not.toContain(newToken);
            expect(outward).toContain('network operation failed');
        } finally {
            close.mockRestore();
            unsubscribe();
        }

        await expect(f.instance.dispose()).resolves.toMatchObject({ closed: true });
    });

    it('redacts both credential generations from listener errors, logs and status', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const logs: string[] = [];
        const unsubscribe = subscribeLogs((entry) => logs.push(entry.message));
        const open = vi
            .spyOn(V12Transport.prototype, 'open')
            .mockRejectedValueOnce(new Error(`failure ${token} ${newToken}`));

        try {
            const result = await f.instance.reloadConfig(config(port, newToken));
            expect(result.applied).toBe(false);
            const outward = JSON.stringify({
                result,
                statuses: f.instance.getConnectionStatuses(),
                logs,
            });
            expect(outward).not.toContain(token);
            expect(outward).not.toContain(newToken);
            expect(outward).toContain('v12 operation failed');
        } finally {
            open.mockRestore();
            unsubscribe();
        }
    });

    it('does not restore a revoked token when the replacement bind fails', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const blocker = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const blockedPort = (blocker.address() as { port: number }).port;
        const client = connect(port);
        await client.next();
        await client.next();
        const closed = new Promise<void>((resolve) => client.ws.once('close', () => resolve()));

        try {
            const result = await f.instance.reloadConfig(config(blockedPort, newToken));
            expect(result.applied).toBe(false);
            await closed;
            await expect(request(port, { action: 'get_version', params: {} })).rejects.toThrow();
        } finally {
            await new Promise<void>((resolve, reject) =>
                blocker.close((error) => (error ? reject(error) : resolve())),
            );
        }

        expect((await f.instance.reloadConfig(config(blockedPort, newToken))).applied).toBe(true);
        expect(
            (await request(blockedPort, { action: 'get_version', params: {} }, newToken)).status,
        ).toBe(200);
    });

    it('preserves unchanged connections and revokes old token on reload', async () => {
        const port = await freePort();
        const f = await fixture('10001', port);
        const client = connect(port);
        await client.next();
        await client.next();
        const same = await f.instance.reloadConfig(config(port));
        expect(same.applied).toBe(true);
        expect((await request(port, { action: 'get_version', params: {} })).status).toBe(200);
        const closed = new Promise<void>((resolve) => client.ws.once('close', () => resolve()));
        const next = newToken;
        expect((await f.instance.reloadConfig(config(port, next))).applied).toBe(true);
        await closed;
        expect((await request(port, { action: 'get_version', params: {} })).status).toBe(401);
        expect((await request(port, { action: 'get_version', params: {} }, next)).status).toBe(200);
    });
});
