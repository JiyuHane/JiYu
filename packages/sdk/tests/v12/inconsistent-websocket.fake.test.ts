import { afterEach, describe, expect, it, vi } from 'vitest';
import * as protocolModule from '../../src/v12/protocol.js';
import { OneBot12ClientError } from '../../src/v12/client-types.js';
import { OneBot12WebSocketClient } from '../../src/v12/websocket-client.js';
import type { OneBot12Event } from '../../src/v12/types.js';

// This constructor only records frames in memory; it never creates a network socket.
class FakeSocket extends EventTarget {
    static instances: FakeSocket[] = [];
    readonly sent: string[] = [];
    readonly bufferedAmount = 0;
    readyState = 0;

    constructor(readonly url: string) {
        super();
        FakeSocket.instances.push(this);
    }

    open(): void {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
    }

    send(data: string): void {
        this.sent.push(data);
    }

    frame(value: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }

    close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
    }
}

const clients: OneBot12WebSocketClient[] = [];

async function connected(): Promise<{ client: OneBot12WebSocketClient; socket: FakeSocket }> {
    const client = new OneBot12WebSocketClient({
        url: 'ws://fixture.invalid/',
        webSocket: FakeSocket as unknown as typeof WebSocket,
        requestTimeoutMs: 0,
    });
    clients.push(client);
    const opening = client.connect();
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    socket.open();
    await opening;
    return { client, socket };
}

function echoAt(socket: FakeSocket, index: number): string {
    return (JSON.parse(socket.sent[index]) as { echo: string }).echo;
}

function response(echo: string, retcode = 0, data: unknown = null) {
    return { status: 'ok', retcode, data, message: '', echo };
}

const event = {
    id: 'event-1',
    time: 1,
    type: 'meta',
    detail_type: 'heartbeat',
    sub_type: '',
};

// Flush promise continuations without advancing a request deadline or using a real socket.
async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index++) {
        await Promise.resolve();
    }
}

afterEach(() => {
    for (const client of clients.splice(0)) {
        client.close();
    }

    FakeSocket.instances = [];
});

describe('OneBot 12 inconsistent WebSocket responses', () => {
    it('rejects only the correlated request immediately; late and unmatched frames do not contaminate new work', async () => {
        const { client, socket } = await connected();
        const errors: OneBot12ClientError[] = [];
        client.onError((error) => errors.push(error));
        const first = client.request('first');
        const second = client.request('second');
        let firstOutcome: unknown = 'pending';
        let secondOutcome: unknown = 'pending';
        void first.then(
            (value) => {
                firstOutcome = value;
            },
            (error: unknown) => {
                firstOutcome = error;
            },
        );
        void second.then(
            (value) => {
                secondOutcome = value;
            },
            (error: unknown) => {
                secondOutcome = error;
            },
        );
        const firstEcho = echoAt(socket, 0);
        const secondEcho = echoAt(socket, 1);
        expect(firstEcho).not.toBe(secondEcho);

        socket.frame(response(firstEcho, 10001));
        await flushMicrotasks();
        expect(firstOutcome).toBeInstanceOf(OneBot12ClientError);
        expect(firstOutcome).toMatchObject({ code: 'invalid_response' });
        expect(errors.map((error) => error.code)).toEqual(['invalid_response']);
        expect(secondOutcome).toBe('pending');
        expect(client.isConnected).toBe(true);
        expect(socket.readyState).toBe(1);
        expect(socket.sent).toHaveLength(2);
        expect(FakeSocket.instances).toHaveLength(1);

        // Existing unmatched valid responses report protocol, without closing the connection.
        socket.frame(response('never-issued'));
        // An unmatched malformed response follows the existing parse-error path.
        socket.frame(response('never-issued-bad', 10001));
        expect(errors.map((error) => error.code)).toEqual([
            'invalid_response',
            'protocol',
            'invalid_response',
        ]);
        expect(client.isConnected).toBe(true);
        socket.frame(response(secondEcho, 0, 'second-result'));
        await expect(second).resolves.toMatchObject({
            status: 'ok',
            retcode: 0,
            data: 'second-result',
        });

        const third = client.request('third');
        void third.catch(() => {});
        const thirdEcho = echoAt(socket, 2);
        expect(thirdEcho).not.toBe(firstEcho);
        let thirdSettled = false;
        void third.then(
            () => {
                thirdSettled = true;
            },
            () => {
                thirdSettled = true;
            },
        );
        socket.frame(response(firstEcho, 0, 'late'));
        await flushMicrotasks();
        expect(thirdSettled).toBe(false);
        expect(errors.map((error) => error.code)).toEqual([
            'invalid_response',
            'protocol',
            'invalid_response',
            'protocol',
        ]);
        expect(client.isConnected).toBe(true);
        socket.frame(response(thirdEcho, 0, 'fresh'));
        await expect(third).resolves.toMatchObject({ data: 'fresh' });
        expect(socket.sent).toHaveLength(3);
        expect(FakeSocket.instances).toHaveLength(1);
    });

    it('keeps a normal event with status and echo extensions as an event', async () => {
        const { client, socket } = await connected();
        const events: OneBot12Event[] = [];
        const errors: OneBot12ClientError[] = [];
        client.onEvent((value) => events.push(value));
        client.onError((error) => errors.push(error));
        const pending = client.request('pending');
        void pending.catch(() => {});
        let settled = false;
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        const echo = echoAt(socket, 0);

        // It has response-like fields but lacks both response data and message.
        socket.frame({ ...event, status: 'ok', retcode: 10001, echo });
        await flushMicrotasks();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ ...event, status: 'ok', retcode: 10001, echo });
        expect(errors).toEqual([]);
        expect(settled).toBe(false);
        expect(client.isConnected).toBe(true);
        socket.frame(response(echo, 0, 'after-event'));
        await expect(pending).resolves.toMatchObject({ data: 'after-event' });
        expect(socket.sent).toHaveLength(1);
        expect(FakeSocket.instances).toHaveLength(1);
    });

    it('checks response shape only after an event parses successfully', async () => {
        const shapeSpy = vi.spyOn(protocolModule, 'parseOneBot12ActionResponseShapeJson');

        try {
            const { client, socket } = await connected();
            const events: OneBot12Event[] = [];
            const errors: OneBot12ClientError[] = [];
            client.onEvent((value) => events.push(value));
            client.onError((error) => errors.push(error));
            const eventExtensions = { id: 'extension', type: 'meta', detail_type: 'heartbeat' };

            const valid = client.request('valid');
            const validEcho = echoAt(socket, 0);
            socket.frame({ ...response(validEcho, 0, 'valid'), ...eventExtensions });
            await expect(valid).resolves.toMatchObject({ status: 'ok', retcode: 0, data: 'valid' });
            expect(shapeSpy).toHaveBeenCalledTimes(0);
            expect(client.isConnected).toBe(true);

            const invalid = client.request('invalid');
            const invalidResult = expect(invalid).rejects.toMatchObject({
                code: 'invalid_response',
            });
            const invalidEcho = echoAt(socket, 1);
            socket.frame({ ...response(invalidEcho, 10001), ...eventExtensions });
            await invalidResult;
            expect(shapeSpy).toHaveBeenCalledTimes(0);
            expect(errors.map((error) => error.code)).toEqual(['invalid_response']);
            expect(client.isConnected).toBe(true);
            expect(events).toEqual([]);

            const ambiguous = client.request('ambiguous');
            const ambiguousResult = expect(ambiguous).rejects.toMatchObject({ code: 'protocol' });
            const ambiguousEcho = echoAt(socket, 2);
            const frame = { ...event, ...response(ambiguousEcho, 10001) };
            socket.frame(frame);
            await ambiguousResult;
            expect(shapeSpy).toHaveBeenCalledTimes(1);
            expect(shapeSpy).toHaveBeenCalledWith(JSON.stringify(frame));
            expect(shapeSpy).toHaveReturnedTimes(1);
            expect(events).toEqual([]);
            expect(errors.map((error) => error.code)).toEqual(['invalid_response', 'protocol']);
            expect(client.isConnected).toBe(false);
            expect(socket.sent).toHaveLength(3);
            expect(FakeSocket.instances).toHaveLength(1);
        } finally {
            shapeSpy.mockRestore();
        }
    });

    it('fails the connection as protocol ambiguity for a complete event and contradictory response shape', async () => {
        const { client, socket } = await connected();
        const events: OneBot12Event[] = [];
        const errors: OneBot12ClientError[] = [];
        client.onEvent((value) => events.push(value));
        client.onError((error) => errors.push(error));
        const first = client.request('first');
        const second = client.request('second');
        const firstRejected = expect(first).rejects.toMatchObject({ code: 'protocol' });
        const secondRejected = expect(second).rejects.toMatchObject({ code: 'protocol' });
        const echo = echoAt(socket, 0);

        socket.frame({ ...event, ...response(echo, 10001) });
        await Promise.all([firstRejected, secondRejected]);
        expect(events).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(OneBot12ClientError);
        expect(errors[0].code).toBe('protocol');
        expect(client.isConnected).toBe(false);
        expect(socket.readyState).toBe(3);
        expect(socket.sent).toHaveLength(2);
        expect(FakeSocket.instances).toHaveLength(1);
    });
});
