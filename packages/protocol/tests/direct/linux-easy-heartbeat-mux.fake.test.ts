import { describe, expect, it, vi } from 'vitest';
import { isLinuxEasyOwnerPushActive } from '../../src/direct/linux-easy-account-owner';
import { MSG_PUSH_CMD } from '../../src/msg-push';
import {
    bounded,
    EASY,
    fixture,
    HEARTBEAT,
    KE,
    PeerFixtureInitializationError,
    PUSH,
    REGISTER,
    turn,
    UIN,
    waitUntil,
} from './support/linux-easy-multiplex-peer';

// Pure in-memory peers and caller-supplied verification results. These tests do
// not establish peer authentication, signing, online status, or delivery.
type Peer = ReturnType<typeof fixture>;

async function checkedFixture(): Promise<Peer> {
    try {
        return fixture();
    } catch (error) {
        if (error instanceof PeerFixtureInitializationError) {
            try {
                await bounded(error.cleanup);
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    'synthetic fixture initialization cleanup failed',
                );
            }
        }

        throw error;
    }
}

async function register(f: Peer): Promise<void> {
    const pending = f.start();
    await bounded(f.written[0]!.promise);
    f.feedKey();
    await bounded(f.written[1]!.promise);
    f.feedEasyAndPush();
    await bounded(f.easyVerifyEntered.promise);
    f.easyVerifyGate.resolve(true);
    await Promise.all([
        bounded(f.written[2]!.promise),
        waitUntil(() => f.onPush.mock.calls.length === 2),
    ]);
    f.feedRegister(true);
    expect(await bounded(pending)).toEqual({ kind: 'registered', registerSequence: REGISTER });
    expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(true);
    expect(f.processor.activate()).toBe(true);
    await bounded(f.dispatched.promise);
    await bounded(turn());
    expect(f.dispatch).toHaveBeenCalledTimes(2);
}

async function cleanup(f: Peer, heartbeat?: ReturnType<Peer['owner']['heartbeat']>) {
    const errors: unknown[] = [];
    const first = f.close();

    try {
        expect(f.close()).toBe(first);
    } catch (error) {
        errors.push(error);
    }

    try {
        await bounded(first);
    } catch (error) {
        errors.push(error);
    }

    if (heartbeat) {
        try {
            await bounded(heartbeat);
        } catch (error) {
            errors.push(error);
        }
    }

    if (errors.length) {
        throw new AggregateError(errors, 'synthetic heartbeat cleanup failed');
    }
}

describe('synthetic Linux Easy owner heartbeat and multiplexed pushes', () => {
    it.each(['before', 'after'] as const)(
        'routes a push %s the heartbeat response in one chunk on the same owner and mux',
        async (position) => {
            const f = await checkedFixture();
            const transact = vi.spyOn(f.mux, 'transactRaw');
            let heartbeat: ReturnType<Peer['owner']['heartbeat']> | undefined;
            const errors: unknown[] = [];

            try {
                const owner = f.owner;
                const mux = f.mux;
                await register(f);
                expect(f.options.client).toBe(mux);
                expect(f.frames).toHaveLength(3);
                expect(f.classified).toEqual([
                    'ke',
                    'easy',
                    `push:${PUSH}`,
                    `push:${PUSH + 1}`,
                    'register',
                ]);

                heartbeat = owner.heartbeat({ timeoutMs: 5000 });
                await bounded(f.written[3]!.promise);
                expect(f.frames).toHaveLength(4);
                const { pushed } = f.feedHeartbeat(position);
                expect(pushed).toBeDefined();
                expect(await bounded(heartbeat)).toEqual({
                    kind: 'response',
                    sequence: HEARTBEAT,
                    value: { status: 'success', interval: 270n },
                    writeState: 'written',
                });
                await waitUntil(() => f.dispatch.mock.calls.length === 3);
                await bounded(turn());

                expect(HEARTBEAT).toBe(REGISTER + 1);
                expect(HEARTBEAT >>> 31).toBe(1);
                expect(f.owner).toBe(owner);
                expect(f.mux).toBe(mux);
                expect(transact).toHaveBeenCalledTimes(4);
                expect(f.options.register.verifyRaw).toHaveBeenCalledTimes(2);
                expect(f.classified).toEqual([
                    'ke',
                    'easy',
                    `push:${PUSH}`,
                    `push:${PUSH + 1}`,
                    'register',
                    ...(position === 'before'
                        ? [`push:${PUSH + 2}`, 'heartbeat']
                        : ['heartbeat', `push:${PUSH + 2}`]),
                ]);
                expect(f.pushOrigins).toEqual([
                    { id: PUSH, sequence: EASY },
                    { id: PUSH + 1, sequence: EASY },
                    { id: PUSH + 2, sequence: HEARTBEAT },
                ]);
                expect(f.held).toEqual([KE, EASY, REGISTER, HEARTBEAT]);
                expect(f.muxVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
                expect(f.fullVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
                expect(f.onPush.mock.calls.map(([, route]) => route.id)).toEqual([
                    PUSH,
                    PUSH + 1,
                    PUSH + 2,
                ]);
                expect(f.dispatch.mock.calls.map(([meta]) => meta)).toEqual(
                    [PUSH, PUSH + 1, PUSH + 2].map((seqId) => ({
                        serviceCmd: MSG_PUSH_CMD,
                        seqId,
                    })),
                );
                expect(f.dispatch.mock.calls[2]![1]).toMatchObject([
                    {
                        kind: 'friend_message',
                        selfUin: Number(UIN),
                        senderUin: 10001,
                        elements: [{ type: 'text', text: `synthetic ${PUSH + 2}` }],
                    },
                ]);
                expect(f.callbackErrors).toEqual([]);
                expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
                expect(f.processor.status()).toBe('active');
                expect(mux.closed).toBe(false);
            } catch (error) {
                errors.push(error);
            } finally {
                try {
                    await cleanup(f, heartbeat);
                } catch (error) {
                    errors.push(error);
                }

                transact.mockRestore();
            }

            if (errors.length) {
                throw new AggregateError(errors, 'synthetic heartbeat or cleanup failed');
            }
        },
        20000,
    );

    it('closes the local owner on a rejected heartbeat verification without retry', async () => {
        const f = await checkedFixture();
        const transact = vi.spyOn(f.mux, 'transactRaw');
        let heartbeat: ReturnType<Peer['owner']['heartbeat']> | undefined;
        const errors: unknown[] = [];

        try {
            await register(f);
            f.options.register.verifyRaw.mockImplementationOnce(() => false);
            heartbeat = f.owner.heartbeat({ timeoutMs: 5000 });
            await bounded(f.written[3]!.promise);
            f.feedHeartbeat();
            expect(await bounded(heartbeat)).toEqual({
                kind: 'failure',
                code: 'heartbeat-failed',
                writeState: 'unknown',
            });
            expect(f.options.register.verifyRaw).toHaveBeenCalledTimes(2);
            expect(transact).toHaveBeenCalledTimes(4);
            expect(f.frames).toHaveLength(4);
            expect(f.classified.at(-1)).toBe('heartbeat');
            expect(f.callbackErrors).toEqual([]);
            expect(f.dispatch).toHaveBeenCalledTimes(2);
            expect(f.mux.closed).toBe(true);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
            expect(await bounded(f.owner.heartbeat({ timeoutMs: 5000 }))).toEqual({
                kind: 'failure',
                code: 'closed',
                writeState: 'not-written',
            });
            expect(transact).toHaveBeenCalledTimes(4);
        } catch (error) {
            errors.push(error);
        } finally {
            try {
                await cleanup(f, heartbeat);
            } catch (error) {
                errors.push(error);
            }

            transact.mockRestore();
        }

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic rejection or cleanup failed');
        }
    }, 20000);
});
