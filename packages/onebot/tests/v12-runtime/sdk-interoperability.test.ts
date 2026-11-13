import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { OneBot12WebSocketClient } from '../../../sdk/src/v12/websocket-client.js';
import type { OneBot12Event } from '../../../sdk/src/v12/types.js';
import { makeDefaultOneBotConfig } from '../../src/config';
import { defaultGlobalSettings } from '../../src/global-config';
import { OneBotInstance } from '../../src/instance';
import { MediaStore } from '../../src/media-store';
import { MessageStore } from '../../src/message-store';
import { hashMessageIdInt32, PRIVATE_NT_MESSAGE_EVENT } from '../../src/message-id';

const instances: OneBotInstance[] = [];
const clients: OneBot12WebSocketClient[] = [];
const releaseGates: Array<() => void> = [];
const token = randomBytes(32).toString('base64url');

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function sequenceWithNegativeId(target: number): number {
    for (let sequence = 1; sequence < 10000; sequence++) {
        if (hashMessageIdInt32(sequence, target, PRIVATE_NT_MESSAGE_EVENT) < 0) {
            return sequence;
        }
    }

    throw new Error('fixture sequence not found');
}

async function fixture(uin: string, port: number, v11Port?: number, fresh = false) {
    const events = new BridgeEventBus();
    const sequence = sequenceWithNegativeId(20001);
    const receipt = { sequence, clientSequence: 12, random: 45, timestamp: 1700000123 };
    const sendPrivate = vi.fn(async (_target: number, _elements: unknown) => receipt);
    const sendGroup = vi.fn(async (_target: number, _elements: unknown) => ({
        ...receipt,
        sequence: sequence + 1,
    }));
    const recallPrivate = vi.fn(async (..._args: number[]) => undefined);
    const bridge = {
        events,
        identity: { initialization: Promise.resolve(), nickname: 'fixture', groups: [] },
        receiveHealthy: true,
        apis: {
            contacts: { fetchDownloadRKeys: async () => [] },
            message: { sendPrivate, sendGroup, recallPrivate },
        },
        resolveUserUid: async () => 'fixture-uid',
    } as unknown as BridgeInterface;
    const config = makeDefaultOneBotConfig();
    config.networks = { httpServers: [], httpClients: [], wsServers: [], wsClients: [] };

    if (v11Port !== undefined) {
        config.networks.httpServers.push({
            name: 'v11',
            host: '127.0.0.1',
            port: v11Port,
            messageFormat: 'array',
            reportSelfMessage: false,
        });
    }

    config.v12 = {
        enabled: true,
        host: '127.0.0.1',
        port,
        accessToken: token,
        allowNonLoopback: false,
    };
    config.statusCommand.enabled = false;
    const databasePath = `data/${uin}/messages.db`;
    expect(existsSync(databasePath)).toBe(false);

    if (!fresh) {
        // Prepare the shared account database sequentially, as for an existing installation.
        const media = new MediaStore(databasePath);
        await media.initialization;
        await media.close();
        const messages = new MessageStore(databasePath);
        await messages.initialization;
        await messages.close();
    }

    const instance = new OneBotInstance(uin, bridge, config, defaultGlobalSettings());
    instances.push(instance);
    expect((await instance.waitUntilNetworkReady()).applied).toBe(true);
    const http = new OneBot12HttpClient({
        baseUrl: `http://127.0.0.1:${port}/`,
        accessToken: token,
    });
    const ws = new OneBot12WebSocketClient({
        url: `ws://127.0.0.1:${port}/`,
        accessToken: token,
        tokenTransport: 'query',
    });
    clients.push(ws);
    const received: OneBot12Event[] = [];
    const errors: string[] = [];
    ws.onEvent((event) => {
        received.push(event);
    });
    ws.onError((error) => {
        errors.push(error.code);
    });
    await ws.connect();
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2));
    return {
        bridge,
        events,
        sendPrivate,
        sendGroup,
        recallPrivate,
        receipt,
        instance,
        http,
        ws,
        received,
        errors,
    };
}

afterEach(async () => {
    for (const release of releaseGates.splice(0)) {
        release();
    }

    for (const client of clients.splice(0)) {
        client.close();
    }

    for (const instance of instances.splice(0)) {
        await instance.dispose();
    }

    vi.restoreAllMocks();
});

describe('SDK v12 interoperability with real account instances', () => {
    it('starts and drains a fresh account database without store prewarming', async () => {
        const port = await freePort();
        const account = await fixture('10004', port, undefined, true);
        const version = await account.http.request('get_version');
        expect(account.received[0]).toMatchObject({
            detail_type: 'connect',
            version: version.data,
        });
        expect(await account.ws.request('get_status')).toMatchObject({
            status: 'ok',
            data: { bots: [{ self: { platform: 'qq', user_id: '10004' } }] },
        });
        expect(
            await account.http.request('send_message', {
                detail_type: 'private',
                user_id: '20001',
                message: 'fresh database fixture',
            }),
        ).toMatchObject({ status: 'ok', data: { time: account.receipt.timestamp } });
        expect(account.sendPrivate).toHaveBeenCalledOnce();
        expect(existsSync('data/10004/messages.db')).toBe(true);
        account.ws.close();
        expect(await account.instance.dispose()).toMatchObject({ closed: true, errors: [] });
    });

    it('isolates two listeners, actions, stores and events while keeping v11 alive', async () => {
        const aPort = await freePort();
        const v11Port = await freePort();
        const a = await fixture('10001', aPort, v11Port);
        const bPort = await freePort();
        const b = await fixture('10002', bPort);
        const version = await a.http.request('get_version', {}, { echo: 'http-version' });
        expect(version).toMatchObject({
            status: 'ok',
            echo: 'http-version',
            data: { impl: 'jiyu', onebot_version: '12' },
        });
        expect(a.received[0]).toMatchObject({
            type: 'meta',
            detail_type: 'connect',
            version: version.data,
        });
        const status = await a.http.request('get_status');
        expect(a.received[1]).toMatchObject({
            type: 'meta',
            detail_type: 'status_update',
            status: status.data,
        });
        expect((await b.http.request('get_status')).data).toMatchObject({
            bots: [{ self: { user_id: '10002' } }],
        });

        const gate = deferred<typeof a.receipt>();
        releaseGates.push(() => gate.resolve(a.receipt));
        a.sendPrivate.mockImplementationOnce(() => gate.promise);
        const pending = a.ws.request('send_message', {
            detail_type: 'private',
            user_id: '20001',
            message: [{ type: 'text', data: { text: 'private fixture' } }],
        });
        await vi.waitFor(() => expect(a.sendPrivate).toHaveBeenCalledTimes(1));
        const fast = await a.ws.request('get_version');
        expect(fast.data).toEqual(version.data);
        gate.resolve(a.receipt);
        const sent = await pending;
        const signedId = hashMessageIdInt32(a.receipt.sequence, 20001, PRIVATE_NT_MESSAGE_EVENT);
        expect(signedId).toBeLessThan(0);
        expect(sent).toMatchObject({
            status: 'ok',
            data: { message_id: String(signedId), time: a.receipt.timestamp },
        });
        expect(a.sendPrivate).toHaveBeenCalledWith(20001, [
            expect.objectContaining({ type: 'text', text: 'private fixture' }),
        ]);
        expect(b.sendPrivate).not.toHaveBeenCalled();
        expect(
            await a.http.request('delete_message', { message_id: String(signedId) }),
        ).toMatchObject({ status: 'ok' });
        expect(a.recallPrivate).toHaveBeenCalledWith(
            20001,
            12,
            a.receipt.sequence,
            45,
            a.receipt.timestamp,
        );
        expect(
            (await b.http.request('delete_message', { message_id: String(signedId) })).status,
        ).toBe('failed');
        expect(b.recallPrivate).not.toHaveBeenCalled();
        expect(
            await b.http.request('send_message', {
                detail_type: 'group',
                group_id: '30001',
                message: 'group fixture',
            }),
        ).toMatchObject({ status: 'ok', data: { time: b.receipt.timestamp } });
        expect(b.sendGroup).toHaveBeenCalledWith(30001, [
            expect.objectContaining({ type: 'text', text: 'group fixture' }),
        ]);
        expect(a.sendGroup).not.toHaveBeenCalled();
        expect(
            await b.ws.request('get_status', {}, { self: { platform: 'qq', user_id: '10001' } }),
        ).toMatchObject({ status: 'failed', retcode: 10102 });
        const wrong = new OneBot12HttpClient({
            baseUrl: `http://127.0.0.1:${aPort}/`,
            accessToken: 'wrong',
        });
        await expect(wrong.request('get_status')).rejects.toMatchObject({
            code: 'http_status',
            status: 401,
        });

        const beforeA = a.received.length;
        const beforeB = b.received.length;
        await a.events.emit({
            kind: 'friend_message',
            time: 1700000000,
            selfUin: 10001,
            senderUin: 20002,
            senderNick: 'fixture',
            msgSeq: 11,
            ntMsgSeq: 11,
            clientSeq: 1011,
            sequenceAuthoritative: true,
            msgId: 555,
            elements: [{ type: 'text', text: 'incoming fixture' }],
        });
        await vi.waitFor(() => expect(a.received.length).toBeGreaterThan(beforeA));
        expect(a.received.at(-1)).toMatchObject({
            type: 'message',
            self: { user_id: '10001' },
            user_id: '20002',
            alt_message: 'incoming fixture',
        });
        // A response round trip fences prior frames on the other connection.
        await b.ws.request('get_status');
        expect(b.received.length).toBe(beforeB);
        const debug = vi.fn();
        a.instance.subscribeDebugEvents(debug);
        Object.defineProperty(a.bridge, 'receiveHealthy', {
            get: () => {
                throw new Error('fixture status failure');
            },
        });
        await a.instance.emitBotStatus('online');
        expect(debug).toHaveBeenCalledWith(expect.objectContaining({ notice_type: 'bot_status' }));
        const v11 = await fetch(`http://127.0.0.1:${v11Port}/get_version_info`);
        expect(v11.status).toBe(200);
        expect(((await v11.json()) as { status: string }).status).toBe('ok');
    });

    it('does not retry a timed-out WebSocket action', async () => {
        const port = await freePort();
        const a = await fixture('10003', port);
        const gate = deferred<typeof a.receipt>();
        releaseGates.push(() => gate.resolve(a.receipt));
        a.sendPrivate.mockImplementationOnce(() => gate.promise);
        const pending = a.ws.request(
            'send_message',
            { detail_type: 'private', user_id: '20001', message: 'delayed fixture' },
            { timeoutMs: 100 },
        );
        await vi.waitFor(() => expect(a.sendPrivate).toHaveBeenCalledOnce());
        await expect(pending).rejects.toMatchObject({ code: 'timeout' });
        gate.resolve(a.receipt);
        await vi.waitFor(() => expect(a.errors).toContain('protocol'));
        expect(a.sendPrivate).toHaveBeenCalledOnce();
        expect((await a.ws.request('get_status')).status).toBe('ok');
    });
});
