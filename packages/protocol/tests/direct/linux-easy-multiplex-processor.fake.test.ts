import { describe, expect, it } from 'vitest';
import {
    classifyLinuxEasyOwnerD2Candidate,
    extractLinuxEasyOwnerPushBody,
    isLinuxEasyOwnerPushActive,
    type LinuxEasyAccountOwner,
} from '../../src/direct/linux-easy-account-owner';
import { MSG_PUSH_CMD } from '../../src/msg-push';
import {
    bounded,
    EASY,
    fixture,
    KE,
    PeerFixtureInitializationError,
    PUSH,
    REGISTER,
    turn,
    UIN,
    waitUntil,
} from './support/linux-easy-multiplex-peer';

async function checkedFixture(
    ...args: Parameters<typeof fixture>
): Promise<ReturnType<typeof fixture>> {
    try {
        return fixture(...args);
    } catch (error) {
        if (error instanceof PeerFixtureInitializationError) {
            try {
                await error.cleanup;
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

describe('synthetic raw multiplex + Linux Easy owner + push processor', () => {
    it('waits for cleanup after an injected fixture factory fails', async () => {
        const marker = new Error('synthetic factory failure');
        let owner: LinuxEasyAccountOwner | undefined;
        let failure: unknown;

        try {
            fixture(false, false, {
                createProcessor: (input) => {
                    owner = input.owner;
                    throw marker;
                },
            });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(PeerFixtureInitializationError);
        const initFailure = failure as PeerFixtureInitializationError;
        expect(initFailure.cause).toBe(marker);
        await initFailure.cleanup;
        expect(owner).toBeDefined();
        expect(await owner!.start({} as never)).toEqual({
            kind: 'failure',
            stage: 'owner',
            code: 'closed',
        });
    });

    it('shares cleanup and wipes its synthetic frame after close', async () => {
        const f = await checkedFixture();
        const sample = f.push(PUSH);
        const firstClose = f.close();
        expect(f.close()).toBe(firstClose);
        await firstClose;
        expect(Array.from(sample.frame).every((byte) => byte === 0)).toBe(true);
        expect(Array.from(sample.body).every((byte) => byte === 0)).toBe(true);
    });

    it.each(['success', 'register-failure', 'stop'] as const)(
        'holds the coalesced push through staged registration: %s',
        async (mode) => {
            const f = await checkedFixture();
            const pending = f.start();
            const errors: unknown[] = [];

            try {
                await bounded(f.written[0]!.promise);
                f.feedKey();
                await bounded(f.written[1]!.promise);
                const { first, second } = f.feedEasyAndPush();
                await bounded(f.easyVerifyEntered.promise);
                await bounded(turn());
                expect(f.classified).toEqual(['ke', 'easy']);
                expect(f.muxVerified).toEqual([]);
                expect(f.onPush).not.toHaveBeenCalled();
                expect(f.fullVerified).toEqual([]);
                expect(f.dispatch).not.toHaveBeenCalled();
                expect(f.settled()).toBe(false);
                expect(f.processor.activate()).toBe(false);
                f.easyVerifyGate.resolve(true);
                // Delivery and register write run independently: wait for both,
                // without asserting which occurs first or holding either worker.
                await Promise.all([
                    bounded(f.written[2]!.promise),
                    waitUntil(() => f.onPush.mock.calls.length >= 2),
                ]);
                expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`, `push:${PUSH + 1}`]);
                expect(f.processor.status()).toBe('buffering');
                expect(f.settled()).toBe(false);
                expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(
                    f.meta(PUSH),
                );
                expect(classifyLinuxEasyOwnerD2Candidate(f.owner, second.frame)).toEqual(
                    f.meta(PUSH + 1),
                );
                expect(
                    extractLinuxEasyOwnerPushBody(f.owner, first.frame, f.meta(PUSH)),
                ).toBeUndefined();
                expect(
                    extractLinuxEasyOwnerPushBody(f.owner, second.frame, f.meta(PUSH + 1)),
                ).toBeUndefined();
                expect(f.muxVerified).toEqual([PUSH, PUSH + 1]);
                expect(f.onPush.mock.results[0]).toMatchObject({
                    type: 'return',
                    value: undefined,
                });
                expect(f.onPush.mock.calls.map(([, route]) => route.id)).toEqual([PUSH, PUSH + 1]);
                expect(f.onPush.mock.results[1]).toMatchObject({
                    type: 'return',
                    value: undefined,
                });
                expect(f.fullVerified).toEqual([]);
                expect(f.dispatch).not.toHaveBeenCalled();

                if (mode === 'stop') {
                    f.processor.stop();
                    await bounded(f.processor.drain());
                    expect((await bounded(pending)).kind).toBe('failure');
                    expect(f.processor.activate()).toBe(false);
                } else {
                    f.feedRegister(mode === 'success');
                    const result = await bounded(pending);
                    expect(f.classified).toEqual([
                        'ke',
                        'easy',
                        `push:${PUSH}`,
                        `push:${PUSH + 1}`,
                        'register',
                    ]);
                    expect(f.options.register.verifyRaw).toHaveBeenCalledOnce();

                    if (mode === 'register-failure') {
                        expect(result).toMatchObject({ kind: 'failure', stage: 'register' });
                        f.processor.stop();
                        await bounded(f.processor.drain());
                        expect(f.processor.activate()).toBe(false);
                    } else {
                        expect(result).toEqual({ kind: 'registered', registerSequence: REGISTER });
                        expect(f.settled()).toBe(true);
                        expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(true);
                        expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(
                            f.meta(PUSH),
                        );
                        const extracted = extractLinuxEasyOwnerPushBody(
                            f.owner,
                            first.frame,
                            f.meta(PUSH),
                        );

                        try {
                            expect(extracted).toBeDefined();
                            expect(Array.from(extracted!.body)).toEqual(Array.from(first.body));
                        } finally {
                            extracted?.body.fill(0);
                        }

                        expect(f.processor.activate()).toBe(true);
                        await bounded(f.dispatched.promise);
                        // The synchronous synthetic pipeline's local receipt chain
                        // settles after callback entry; this does not prove delivery.
                        await bounded(turn());
                        expect(f.processor.status()).toBe('active');
                        expect(f.onPush.mock.calls.map(([, route]) => route.id)).toEqual([
                            PUSH,
                            PUSH + 1,
                        ]);
                        expect(f.onPush.mock.results).toEqual([
                            { type: 'return', value: undefined },
                            { type: 'return', value: undefined },
                        ]);
                        expect(f.fullVerified).toEqual([PUSH, PUSH + 1]);
                        expect(f.dispatch).toHaveBeenCalledTimes(2);
                        expect(f.dispatch.mock.calls.map(([meta]) => meta)).toEqual([
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH },
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 1 },
                        ]);
                        // Check the relevant decoded event projection, not every field.
                        const third = f.push(PUSH + 2);
                        f.mux.feed(third.frame);
                        await bounded(waitUntil(() => f.dispatch.mock.calls.length >= 3));
                        await bounded(turn());
                        expect(f.classified).toEqual([
                            'ke',
                            'easy',
                            `push:${PUSH}`,
                            `push:${PUSH + 1}`,
                            'register',
                            `push:${PUSH + 2}`,
                        ]);
                        expect(f.muxVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
                        expect(f.onPush.mock.calls.map(([, route]) => route.id)).toEqual([
                            PUSH,
                            PUSH + 1,
                            PUSH + 2,
                        ]);
                        expect(f.onPush.mock.results).toEqual([
                            { type: 'return', value: undefined },
                            { type: 'return', value: undefined },
                            { type: 'return', value: undefined },
                        ]);
                        expect(f.fullVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
                        expect(f.dispatch).toHaveBeenCalledTimes(3);
                        expect(f.dispatch.mock.calls.map(([meta]) => meta)).toEqual([
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH },
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 1 },
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 2 },
                        ]);
                        expect(f.dispatch.mock.calls.map(([, events]) => events)).toMatchObject(
                            [PUSH, PUSH + 1, PUSH + 2].map((sequence) => [
                                {
                                    kind: 'friend_message',
                                    selfUin: Number(UIN),
                                    senderUin: 10001,
                                    elements: [{ type: 'text', text: `synthetic ${sequence}` }],
                                },
                            ]),
                        );
                        expect(f.processor.status()).toBe('active');
                        expect(f.mux.closed).toBe(false);
                    }
                }

                if (mode !== 'success') {
                    expect(f.fullVerified).toEqual([]);
                    expect(f.dispatch).not.toHaveBeenCalled();
                }

                expect(f.held.slice(0, 2)).toEqual([KE, EASY]);
                expect(f.frames).toHaveLength(3);
            } catch (error) {
                errors.push(error);
            } finally {
                try {
                    await f.close();
                } catch (error) {
                    errors.push(error);
                }

                try {
                    await bounded(pending.catch(() => undefined));
                } catch (error) {
                    errors.push(error);
                }
            }

            if (errors.length) {
                throw new AggregateError(errors, 'synthetic test or cleanup failed');
            }
        },
        20000,
    );

    it('replays a deferred synthetic D2 frame before a following push', async () => {
        const f = await checkedFixture(false, true);
        const pending = f.start();
        const errors: unknown[] = [];

        try {
            await bounded(f.written[0]!.promise);
            f.feedKey();
            await bounded(f.written[1]!.promise);
            // This is one synthetic feed, not an assertion about a real peer's order.
            const { first, second } = f.feedEasyAndPush();
            await bounded(f.easyVerifyEntered.promise);
            await bounded(turn());
            expect(f.classified).toEqual(['ke', 'easy']);
            expect(f.aAttempts).toHaveLength(1);
            expect(f.aAttempts[0]).toMatchObject({ phase: 'awaiting-a', sequence: EASY });
            expect(Array.from(f.aAttempts[0]!.frame)).toEqual(Array.from(first.frame));
            expect(f.frames).toHaveLength(2);
            expect(f.muxVerified).toEqual([]);
            expect(f.onPush).not.toHaveBeenCalled();
            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.settled()).toBe(false);
            expect(f.processor.status()).toBe('buffering');
            expect(f.processor.activate()).toBe(false);

            f.easyVerifyGate.resolve(true);
            await bounded(f.deferredVerifyEntered.promise);
            await bounded(turn());
            expect(f.aAttempts).toHaveLength(2);
            expect(f.aAttempts[1]).toMatchObject({ phase: 'easy-seen', sequence: EASY });
            expect(Array.from(f.aAttempts[1]!.frame)).toEqual(Array.from(first.frame));
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`]);
            expect(f.muxVerified).toEqual([PUSH]);
            // A's independent raw verification has not returned; it is not in the FIFO yet.
            expect(f.frames).toHaveLength(2);
            expect(f.onPush).not.toHaveBeenCalled();
            expect(f.settled()).toBe(false);
            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();

            f.deferredVerifyGate.resolve(true);
            await Promise.all([
                bounded(f.written[2]!.promise),
                bounded(waitUntil(() => f.onPush.mock.calls.length === 2)),
            ]);
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`, `push:${PUSH + 1}`]);
            expect(f.pushOrigins).toEqual([
                { id: PUSH, sequence: EASY },
                { id: PUSH + 1, sequence: EASY },
            ]);
            expect(f.muxVerified).toEqual([PUSH, PUSH + 1]);
            expect(f.callbackFrames.map(({ marker }) => marker)).toEqual(['A', 'B']);
            expect(f.callbackFrames.map(({ route }) => route)).toEqual([
                { kind: 'push', name: MSG_PUSH_CMD, id: PUSH },
                { kind: 'push', name: MSG_PUSH_CMD, id: PUSH + 1 },
            ]);
            expect(Array.from(f.callbackFrames[0]!.frame)).toEqual(Array.from(first.frame));
            expect(Array.from(f.callbackFrames[1]!.frame)).toEqual(Array.from(second.frame));
            expect(f.onPush.mock.results).toEqual([
                { type: 'return', value: undefined },
                { type: 'return', value: undefined },
            ]);
            expect(f.frames).toHaveLength(3);
            expect(f.held.slice(0, 2)).toEqual([KE, EASY]);
            expect(f.settled()).toBe(false);
            expect(f.processor.status()).toBe('buffering');
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);

            for (const [frame, id] of [
                [first.frame, PUSH],
                [second.frame, PUSH + 1],
            ] as const) {
                expect(classifyLinuxEasyOwnerD2Candidate(f.owner, frame)).toEqual(f.meta(id));
                expect(extractLinuxEasyOwnerPushBody(f.owner, frame, f.meta(id))).toBeUndefined();
            }

            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.processor.activate()).toBe(false);

            f.feedRegister(true);
            expect(await bounded(pending)).toEqual({
                kind: 'registered',
                registerSequence: REGISTER,
            });
            expect(f.options.register.verifyRaw).toHaveBeenCalledOnce();
            expect(f.classified).toEqual([
                'ke',
                'easy',
                `push:${PUSH}`,
                `push:${PUSH + 1}`,
                'register',
            ]);
            expect(f.settled()).toBe(true);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(true);

            for (const [item, id] of [
                [first, PUSH],
                [second, PUSH + 1],
            ] as const) {
                const extracted = extractLinuxEasyOwnerPushBody(f.owner, item.frame, f.meta(id));

                try {
                    expect(extracted).toBeDefined();
                    expect(extracted!.meta).toEqual(f.meta(id));
                    expect(Array.from(extracted!.body)).toEqual(Array.from(item.body));
                } finally {
                    extracted?.body.fill(0);
                }
            }

            expect(f.processor.activate()).toBe(true);
            await bounded(f.dispatched.promise);
            await bounded(turn());
            expect(f.fullVerified).toEqual([PUSH, PUSH + 1]);
            expect(f.dispatch.mock.calls.map(([meta]) => meta)).toEqual([
                { serviceCmd: MSG_PUSH_CMD, seqId: PUSH },
                { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 1 },
            ]);
            expect(f.dispatch.mock.calls.map(([, events]) => events)).toMatchObject(
                [PUSH, PUSH + 1].map((sequence) => [
                    {
                        kind: 'friend_message',
                        selfUin: Number(UIN),
                        senderUin: 10001,
                        elements: [{ type: 'text', text: `synthetic ${sequence}` }],
                    },
                ]),
            );
            expect(f.processor.status()).toBe('active');
            expect(f.mux.closed).toBe(false);
        } catch (error) {
            errors.push(error);
        } finally {
            try {
                await f.close();
            } catch (error) {
                errors.push(error);
            }

            try {
                await bounded(pending.catch(() => undefined));
            } catch (error) {
                errors.push(error);
            }
        }

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic deferred-frame test or cleanup failed');
        }
    }, 20000);

    it('retains the Easy origin of a synthetic split push across registration', async () => {
        const f = await checkedFixture(true);
        const pending = f.start();
        const errors: unknown[] = [];

        try {
            await bounded(f.written[0]!.promise);
            f.feedKey();
            await bounded(f.written[1]!.promise);
            const { first } = f.feedEasyAndPush(true);
            await bounded(f.easyVerifyEntered.promise);
            expect(f.classified).toEqual(['ke', 'easy']);
            expect(f.frames).toHaveLength(2);
            expect(f.onPush).not.toHaveBeenCalled();
            f.easyVerifyGate.resolve(true);

            // No more input arrives until the next transaction has actually written.
            await bounded(f.written[2]!.promise);
            expect(f.frames).toHaveLength(3);
            expect(f.settled()).toBe(false);
            expect(f.mux.closed).toBe(false);
            expect(f.classified).toEqual(['ke', 'easy']);
            expect(f.dispatch).not.toHaveBeenCalled();
            f.mux.feed(first.frame.subarray(1));
            await bounded(waitUntil(() => f.onPush.mock.calls.length === 1));
            expect(f.pushOrigins).toEqual([{ id: PUSH, sequence: EASY }]);
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`]);
            expect(f.muxVerified).toEqual([PUSH]);
            expect(f.onPush.mock.calls[0]![1]).toEqual({
                kind: 'push',
                name: MSG_PUSH_CMD,
                id: PUSH,
            });
            expect(f.onPush.mock.results[0]).toMatchObject({ type: 'return', value: undefined });
            expect(f.processor.status()).toBe('buffering');
            expect(f.settled()).toBe(false);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
            expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(f.meta(PUSH));
            expect(
                extractLinuxEasyOwnerPushBody(f.owner, first.frame, f.meta(PUSH)),
            ).toBeUndefined();
            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();

            f.feedRegister(true);
            expect(await bounded(pending)).toEqual({
                kind: 'registered',
                registerSequence: REGISTER,
            });
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`, 'register']);
            expect(f.options.register.verifyRaw).toHaveBeenCalledOnce();
            expect(f.settled()).toBe(true);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(true);
            expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(f.meta(PUSH));
            const extracted = extractLinuxEasyOwnerPushBody(f.owner, first.frame, f.meta(PUSH));

            try {
                expect(extracted).toBeDefined();
                expect(extracted!.meta).toEqual(f.meta(PUSH));
                expect(Array.from(extracted!.body)).toEqual(Array.from(first.body));
            } finally {
                extracted?.body.fill(0);
            }

            expect(f.processor.activate()).toBe(true);
            await bounded(waitUntil(() => f.dispatch.mock.calls.length === 1));
            await bounded(turn());
            expect(f.fullVerified).toEqual([PUSH]);
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect(f.dispatch.mock.calls[0]![0]).toEqual({
                serviceCmd: MSG_PUSH_CMD,
                seqId: PUSH,
            });
            expect(f.dispatch.mock.calls[0]![1]).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(UIN),
                    senderUin: 10001,
                    elements: [{ type: 'text', text: `synthetic ${PUSH}` }],
                },
            ]);
            expect(f.processor.status()).toBe('active');
            expect(f.mux.closed).toBe(false);
        } catch (error) {
            errors.push(error);
        } finally {
            try {
                await f.close();
            } catch (error) {
                errors.push(error);
            }

            try {
                await bounded(pending.catch(() => undefined));
            } catch (error) {
                errors.push(error);
            }
        }

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic split-frame test or cleanup failed');
        }
    }, 20000);
});
