import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneBot12ReverseWebSocketSession } from '../../src/v12/node/reverse-websocket-server.js';
import type { OneBot12ClientError } from '../../src/v12/client-types.js';

// These are in-memory emitters, not WebSocket clients or listeners.
class FakeSocket extends EventEmitter {
    readyState = 1; // WebSocket.OPEN
    bufferedAmount = 0;
    readonly sent: Array<{ action: string; echo: string }> = [];
    readonly terminate = vi.fn(() => {
        this.readyState = 3;
        this.emit('close');
    });

    send(payload: string, callback: (error?: Error) => void): void {
        this.sent.push(JSON.parse(payload) as { action: string; echo: string });
        callback();
    }

    receive(frame: object): void {
        this.emit('message', Buffer.from(JSON.stringify(frame)), false);
    }
}

class FakeOwner extends EventEmitter {
    pending = 0;
    readonly reserve = vi.fn((_bytes: number) => {
        this.pending++;
    });
    readonly release = vi.fn(() => {
        this.pending--;
    });
    readonly report = vi.fn(
        (error: OneBot12ClientError, session?: OneBot12ReverseWebSocketSession) => {
            session?.report(error);
            this.emit('diagnostic', error);
        },
    );
    readonly disconnected = vi.fn((_session: OneBot12ReverseWebSocketSession) => {});
}

const sessions: OneBot12ReverseWebSocketSession[] = [];
afterEach(() => {
    for (const session of sessions.splice(0)) {
        if (session.isConnected) {
            session.close();
        }
    }
});

function setup() {
    const socket = new FakeSocket();
    const owner = new FakeOwner();
    // Exercise the actual exported session; its TypeScript-private constructor is runtime callable.
    const session = Reflect.construct(OneBot12ReverseWebSocketSession, [
        'fake-implementation',
        socket,
        owner,
        0,
    ]) as OneBot12ReverseWebSocketSession;
    sessions.push(session);
    const diagnostics = vi.fn();
    owner.on('diagnostic', diagnostics);
    return { socket, owner, session, diagnostics };
}

function pendingCount(session: OneBot12ReverseWebSocketSession): number {
    return (session as unknown as { pending: Map<string, unknown> }).pending.size;
}

const event = {
    id: 'event-id',
    time: 1,
    type: 'notice',
    detail_type: 'test',
    sub_type: '',
    self: { platform: 'test', user_id: '42' },
};
const response = (echo: string, data: unknown = null, retcode = 0) => ({
    status: 'ok',
    retcode,
    data,
    message: '',
    echo,
});

describe('OneBot 12 reverse session inconsistent responses (in-memory)', () => {
    it('rejects only the matching inconsistent response immediately and ignores late and unmatched echoes', async () => {
        const { socket, owner, session, diagnostics } = setup();
        const first = session.call('first', {}, { timeoutMs: 0 });
        const second = session.call('second', {}, { timeoutMs: 0 });
        // Keep both outcomes observed even if an earlier assertion fails.
        void first.catch(() => {});
        void second.catch(() => {});
        const failed = expect(first).rejects.toMatchObject({ code: 'invalid_response' });
        const firstEcho = socket.sent[0]!.echo;
        const secondEcho = socket.sent[1]!.echo;
        expect(firstEcho).not.toBe(secondEcho);
        expect(owner.pending).toBe(2);
        expect(pendingCount(session)).toBe(2);

        socket.receive(response(firstEcho, 'false-success', 7));
        // The rejection and release happen synchronously in the receive handler, with no timeout.
        expect(owner.pending).toBe(1);
        expect(pendingCount(session)).toBe(1);
        expect(owner.release).toHaveBeenCalledTimes(1);
        expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({ code: 'invalid_response' }),
        );
        expect(session.isConnected).toBe(true);
        await failed;

        socket.receive(response('never-requested', 'unmatched'));
        socket.receive(response(firstEcho, 'late'));
        expect(diagnostics.mock.calls.filter(([error]) => error.code === 'protocol')).toHaveLength(
            2,
        );
        expect(owner.pending).toBe(1);
        expect(pendingCount(session)).toBe(1);
        expect(owner.release).toHaveBeenCalledTimes(1);
        let secondSettled = false;
        void second.then(
            () => {
                secondSettled = true;
            },
            () => {
                secondSettled = true;
            },
        );
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        socket.receive(response(secondEcho, 'correct'));
        await expect(second).resolves.toMatchObject({ status: 'ok', retcode: 0, data: 'correct' });
        expect(owner.pending).toBe(0);
        expect(pendingCount(session)).toBe(0);
        expect(owner.release).toHaveBeenCalledTimes(2);
        const beforeClose = diagnostics.mock.calls.length;
        session.close();
        socket.receive(response(secondEcho, 'after-close'));
        expect(diagnostics).toHaveBeenCalledTimes(beforeClose);
        expect(owner.disconnected).toHaveBeenCalledTimes(1);
        expect(socket.terminate).toHaveBeenCalledTimes(1);
        expect(owner.pending).toBe(0);
    });

    it('dispatches an ordinary event with status and matching echo extensions without consuming pending work', async () => {
        const { socket, owner, session, diagnostics } = setup();
        const seen = vi.fn();
        session.onEvent(seen);
        const waiting = session.call('wait', {}, { timeoutMs: 0 });
        void waiting.catch(() => {});
        const echo = socket.sent[0]!.echo;
        socket.receive({ ...event, status: 'ok', echo });
        expect(seen).toHaveBeenCalledTimes(1);
        expect(seen).toHaveBeenCalledWith(
            expect.objectContaining({ ...event, status: 'ok', echo }),
        );
        expect(owner.pending).toBe(1);
        expect(pendingCount(session)).toBe(1);
        expect(diagnostics).not.toHaveBeenCalled();
        socket.receive(response(echo, 'still-associated'));
        await expect(waiting).resolves.toMatchObject({ data: 'still-associated' });
        expect(owner.pending).toBe(0);
        session.close();
        socket.receive({ ...event, status: 'ok', echo });
        expect(seen).toHaveBeenCalledTimes(1);
        expect(owner.release).toHaveBeenCalledTimes(1);
        expect(owner.disconnected).toHaveBeenCalledTimes(1);
    });

    it.each([0, 7])(
        'treats a complete event + response with retcode %i as fatal ambiguity',
        async (retcode) => {
            const { socket, owner, session, diagnostics } = setup();
            const seen = vi.fn();
            session.onEvent(seen);
            const first = session.call('first', {}, { timeoutMs: 0 });
            const second = session.call('second', {}, { timeoutMs: 0 });
            void first.catch(() => {});
            void second.catch(() => {});
            const firstFailure = expect(first).rejects.toMatchObject({ code: 'protocol' });
            const secondFailure = expect(second).rejects.toMatchObject({ code: 'protocol' });
            const firstEcho = socket.sent[0]!.echo;
            const secondEcho = socket.sent[1]!.echo;
            socket.receive({ ...event, ...response(firstEcho, null, retcode) });
            expect(session.isConnected).toBe(false);
            expect(owner.pending).toBe(0);
            expect(pendingCount(session)).toBe(0);
            expect(owner.release).toHaveBeenCalledTimes(2);
            expect(owner.disconnected).toHaveBeenCalledTimes(1);
            expect(socket.terminate).toHaveBeenCalledTimes(1);
            expect(seen).not.toHaveBeenCalled();
            expect(diagnostics).toHaveBeenCalledWith(
                expect.objectContaining({
                    code: 'protocol',
                    message: 'Ambiguous OneBot 12 event and response',
                }),
            );
            await Promise.all([firstFailure, secondFailure]);
            const beforeLate = diagnostics.mock.calls.length;
            socket.receive(response(firstEcho));
            socket.receive(response(secondEcho));
            socket.receive(event);
            expect(diagnostics).toHaveBeenCalledTimes(beforeLate);
            expect(seen).not.toHaveBeenCalled();
            expect(owner.release).toHaveBeenCalledTimes(2);
        },
    );

    it('releases both outstanding requests on close and ignores later frames', async () => {
        const { socket, owner, session, diagnostics } = setup();
        const seen = vi.fn();
        session.onEvent(seen);
        const first = session.call('first', {}, { timeoutMs: 0 });
        const second = session.call('second', {}, { timeoutMs: 0 });
        void first.catch(() => {});
        void second.catch(() => {});
        const firstFailure = expect(first).rejects.toMatchObject({ code: 'closed' });
        const secondFailure = expect(second).rejects.toMatchObject({ code: 'closed' });
        const echoes = socket.sent.map((item) => item.echo);
        session.close();
        expect(owner.pending).toBe(0);
        expect(pendingCount(session)).toBe(0);
        expect(owner.release).toHaveBeenCalledTimes(2);
        expect(owner.disconnected).toHaveBeenCalledTimes(1);
        await Promise.all([firstFailure, secondFailure]);

        for (const echo of echoes) {
            socket.receive(response(echo));
        }

        socket.receive(event);
        expect(diagnostics).not.toHaveBeenCalled();
        expect(seen).not.toHaveBeenCalled();
        expect(owner.release).toHaveBeenCalledTimes(2);
    });
});
