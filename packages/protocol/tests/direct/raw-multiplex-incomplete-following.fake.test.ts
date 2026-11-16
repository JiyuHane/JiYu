import { describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexClient,
    type RawMultiplexClientOptions,
    type RawMultiplexIdentity,
    type RawMultiplexPushRoute,
    type RawMultiplexRoute,
} from '../../src/direct/raw-multiplex-client';
import type { Sso12RawIdentity, Sso12RawOptions } from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

// Every externally awaited gate has a finite watchdog; no network transport is involved.
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic watchdog expired')), 3000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

// Synthetic framing only: kind 1 is a response, kind 2 a push.
function frame(kind: number, id: number): Uint8Array {
    const bytes = new Uint8Array(14);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[4] = kind;
    view.setUint32(5, id);
    return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;

    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

function route(bytes: Uint8Array): RawMultiplexRoute {
    const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5);
    return bytes[4] === 1
        ? { kind: 'response', sequence: id }
        : { kind: 'push', name: 'synthetic', id };
}

function request(
    overrides: Partial<Sso12RawOptions<null, string>> = {},
): Sso12RawOptions<null, string> {
    return {
        buildRequest: Object.freeze(({ sequence }: Sso12RawIdentity) => ({
            frame: frame(1, sequence),
            context: null,
        })),
        verifyCandidate: Object.freeze(() => true),
        consumeCandidate: Object.freeze(() => 'accepted'),
        ...overrides,
    };
}

function fixture(overrides: Partial<RawMultiplexClientOptions> = {}) {
    const writes: number[] = [];
    const identities: Array<{ kind: number; identity: RawMultiplexIdentity }> = [];
    const events: string[] = [];
    const frozenIdentities: boolean[] = [];
    const frozenRoutes: boolean[] = [];
    const verifiedPushBytes: Uint8Array[] = [];
    const deliveredPushBytes: Uint8Array[] = [];
    const pushed = deferred<void>();
    const client = createRawMultiplexClient({
        uin: '0',
        initialSequence: 17,
        defaultTimeoutMs: 5000,
        maxFrameBytes: 1024,
        maxBufferedBytes: 4096,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 4096,
        allowIncompleteFollowingFrame: true,
        write: Object.freeze((bytes: Uint8Array) => {
            writes.push(
                new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5),
            );
        }),
        classify: Object.freeze((bytes: Uint8Array, identity: RawMultiplexIdentity) => {
            frozenIdentities.push(Object.isFrozen(identity));
            identities.push({ kind: bytes[4], identity: { ...identity } });
            events.push(`classify:${bytes[4]}`);
            return route(bytes);
        }),
        verifyPush: Object.freeze((bytes: Uint8Array, item: RawMultiplexPushRoute) => {
            frozenRoutes.push(Object.isFrozen(item));
            verifiedPushBytes.push(Uint8Array.from(bytes));
            events.push(`verify:${item.id}`);
            return true;
        }),
        onPush: Object.freeze((bytes: Uint8Array, item: RawMultiplexPushRoute) => {
            frozenRoutes.push(Object.isFrozen(item));
            deliveredPushBytes.push(Uint8Array.from(bytes));
            events.push(`push:${item.id}`);
            pushed.resolve();
        }),
        ...overrides,
    });

    const dispose = () => {
        client.close();

        for (const bytes of [...verifiedPushBytes, ...deliveredPushBytes]) {
            bytes.fill(0);
        }
    };

    return {
        client,
        writes,
        identities,
        events,
        pushed,
        frozenIdentities,
        frozenRoutes,
        verifiedPushBytes,
        deliveredPushBytes,
        dispose,
    };
}

function observed<T>(promise: Promise<T>) {
    let settled = false;
    const result = promise.then((value) => {
        settled = true;
        return value;
    });
    return { result, isSettled: () => settled };
}

describe('raw multiplex incomplete-following policy with synthetic in-memory frames', () => {
    it.each([1, 2, 3, 4, 7])(
        'settles after write, verify and consume with %i bytes of a following frame',
        async (split) => {
            const writeEntered = deferred<void>();
            const writeGate = deferred<void>();
            const verifyEntered = deferred<void>();
            const verifyGate = deferred<boolean>();
            const consumeEntered = deferred<void>();
            const consumeGate = deferred<void>();
            const buildEntered = deferred<void>();
            const buildGate = deferred<void>();
            let writeCount = 0;
            const stages: string[] = [];
            const callbackIdentities: Array<{ sequence: number; frozen: boolean }> = [];
            const f = fixture({
                write: Object.freeze(() => {
                    writeCount++;

                    if (writeCount === 1) {
                        writeEntered.resolve();
                        return writeGate.promise;
                    }
                }),
            });
            const first = observed(
                f.client.transactRaw(
                    request({
                        verifyCandidate: Object.freeze(
                            (_bytes: Uint8Array, _context: null, identity: Sso12RawIdentity) => {
                                stages.push('verify');
                                callbackIdentities.push({
                                    sequence: identity.sequence,
                                    frozen: Object.isFrozen(identity),
                                });
                                verifyEntered.resolve();
                                return verifyGate.promise;
                            },
                        ),
                        consumeCandidate: Object.freeze(
                            async (
                                _bytes: Uint8Array,
                                _context: null,
                                identity: Sso12RawIdentity,
                            ) => {
                                stages.push('consume');
                                callbackIdentities.push({
                                    sequence: identity.sequence,
                                    frozen: Object.isFrozen(identity),
                                });
                                consumeEntered.resolve();
                                await consumeGate.promise;
                                return 'first';
                            },
                        ),
                    }),
                ),
            );
            const old = frame(2, 77);
            const expectedOld = Uint8Array.from(old);

            try {
                await bounded(writeEntered.promise);
                f.client.feed(join(frame(1, 17), old.subarray(0, split)));
                await turn();
                expect(first.isSettled()).toBe(false);
                expect(stages).toEqual([]);
                writeGate.resolve();
                await bounded(verifyEntered.promise);
                await turn();
                expect(first.isSettled()).toBe(false);
                expect(stages).toEqual(['verify']);
                verifyGate.resolve(true);
                await bounded(consumeEntered.promise);
                await turn();
                expect(first.isSettled()).toBe(false);
                expect(stages).toEqual(['verify', 'consume']);
                consumeGate.resolve();
                expect(await bounded(first.result)).toEqual({
                    kind: 'response',
                    sequence: 17,
                    value: 'first',
                    writeState: 'written',
                });

                // transactRaw starts its deadline now, while the new builder holds its write.
                const second = f.client.transactRaw(
                    request({
                        buildRequest: Object.freeze(async (identity: Sso12RawIdentity) => {
                            callbackIdentities.push({
                                sequence: identity.sequence,
                                frozen: Object.isFrozen(identity),
                            });
                            buildEntered.resolve();
                            await buildGate.promise;
                            return { frame: frame(1, identity.sequence), context: null };
                        }),
                    }),
                );
                await bounded(buildEntered.promise);
                expect(writeCount).toBe(1);
                f.client.feed(old.subarray(split));
                await bounded(f.pushed.promise);
                expect(f.identities).toEqual([
                    { kind: 1, identity: { uin: '0', sequence: 17 } },
                    { kind: 2, identity: { uin: '0', sequence: 17 } },
                ]);
                expect(f.events).toEqual(['classify:1', 'classify:2', 'verify:77', 'push:77']);
                expect(callbackIdentities).toEqual([
                    { sequence: 17, frozen: true },
                    { sequence: 17, frozen: true },
                    { sequence: 18, frozen: true },
                ]);
                expect(f.frozenIdentities).toEqual([true, true]);
                expect(f.frozenRoutes).toEqual([true, true]);
                expect(f.verifiedPushBytes.map((bytes) => Array.from(bytes))).toEqual([
                    Array.from(expectedOld),
                ]);
                expect(f.deliveredPushBytes.map((bytes) => Array.from(bytes))).toEqual([
                    Array.from(expectedOld),
                ]);
                expect(Array.from(old)).toEqual(Array.from(expectedOld));
                expect(f.client.closed).toBe(false);
                expect(writeCount).toBe(1);
                buildGate.resolve();

                // Wait for the actual write, not just the asynchronous build continuation.
                for (let i = 0; i < 20 && writeCount < 2; i++) {
                    await turn();
                }

                expect(writeCount).toBe(2);
                f.client.feed(frame(1, 18));
                expect(await bounded(second)).toMatchObject({
                    kind: 'response',
                    sequence: 18,
                    value: 'accepted',
                    writeState: 'written',
                });
            } finally {
                writeGate.resolve();
                verifyGate.resolve(true);
                consumeGate.resolve();
                buildGate.resolve();
                f.dispose();
                old.fill(0);
                expectedOld.fill(0);
            }
        },
    );

    it.each([17, 18, 99])(
        'rejects the old response even when its route sequence is %i',
        async (sequence) => {
            const buildEntered = deferred<void>();
            const buildGate = deferred<void>();
            const wrote = deferred<void>();
            const f = fixture({ write: Object.freeze(() => wrote.resolve()) });
            const old = frame(1, sequence);
            const first = f.client.transactRaw(request());

            try {
                await bounded(wrote.promise);
                f.client.feed(join(frame(1, 17), old.subarray(0, 2)));
                const result = await bounded(first);
                expect(result).toMatchObject({ kind: 'response', sequence: 17, value: 'accepted' });
                const second = f.client.transactRaw(
                    request({
                        buildRequest: Object.freeze(async (identity: Sso12RawIdentity) => {
                            buildEntered.resolve();
                            await buildGate.promise;
                            return { frame: frame(1, identity.sequence), context: null };
                        }),
                    }),
                );
                await bounded(buildEntered.promise);
                f.client.feed(old.subarray(2));
                expect(await bounded(second)).toMatchObject({
                    kind: 'failure',
                    code: 'unexpected-response',
                    writeState: 'not-written',
                });
                expect(await bounded(f.client.whenClosed)).toMatchObject({
                    kind: 'protocol-error',
                    code: 'unexpected-response',
                });
                expect(f.identities[1]).toEqual({ kind: 1, identity: { uin: '0', sequence: 17 } });
                expect(result).toMatchObject({ kind: 'response', value: 'accepted' });
                expect(f.events).toEqual(['classify:1', 'classify:1']);
            } finally {
                buildGate.resolve();
                f.dispose();
            }
        },
    );

    it.each(['absent', 'undefined', 'false'] as const)(
        'retains strict drain behavior when the option is %s',
        async (mode) => {
            const wrote = deferred<void>();
            // The absent variant deliberately omits the property rather than passing undefined.
            const strict = createRawMultiplexClient({
                uin: '0',
                initialSequence: 17,
                defaultTimeoutMs: 5000,
                maxFrameBytes: 1024,
                maxBufferedBytes: 4096,
                maxFrames: 8,
                maxPushFrames: 8,
                maxPushBytes: 4096,
                write: Object.freeze(() => wrote.resolve()),
                classify: Object.freeze((bytes: Uint8Array) => route(bytes)),
                verifyPush: Object.freeze(() => true),
                onPush: Object.freeze(() => {}),
                ...(mode === 'false'
                    ? { allowIncompleteFollowingFrame: false }
                    : mode === 'undefined'
                      ? { allowIncompleteFollowingFrame: undefined }
                      : {}),
            });
            const work = observed(strict.transactRaw(request()));
            const old = frame(2, 77);

            try {
                await bounded(wrote.promise);
                strict.feed(join(frame(1, 17), old.subarray(0, 1)));
                await turn();
                expect(work.isSettled()).toBe(false);
                strict.feed(old.subarray(1));
                expect(await bounded(work.result)).toMatchObject({
                    kind: 'response',
                    sequence: 17,
                });
            } finally {
                strict.close();
            }
        },
    );

    it.each([null, 0, 1, 'true', {}, []])('rejects a nonboolean policy value %#', (value) => {
        expect(() =>
            fixture({ allowIncompleteFollowingFrame: value as unknown as boolean }),
        ).toThrow();
    });

    it('waits for active classification and verification of complete queued frames', async () => {
        const started = deferred<void>();
        const gate = deferred<void>();
        const wrote = deferred<void>();
        const f = fixture({
            write: Object.freeze(() => wrote.resolve()),
            verifyPush: Object.freeze(async () => {
                started.resolve();
                await gate.promise;
                return true;
            }),
        });
        const first = observed(f.client.transactRaw(request()));

        try {
            await bounded(wrote.promise);
            f.client.feed(join(frame(1, 17), frame(2, 40), frame(2, 41).subarray(0, 1)));
            await bounded(started.promise);
            await turn();
            expect(first.isSettled()).toBe(false);
            gate.resolve();
            expect(await bounded(first.result)).toMatchObject({ kind: 'response', sequence: 17 });
        } finally {
            gate.resolve();
            f.dispose();
        }
    });

    it.each(['malformed', 'verify-false'] as const)(
        'closes on a later %s frame without rolling back the completed response',
        async (mode) => {
            const wrote = deferred<void>();
            const onPush = vi.fn();
            const f = fixture({
                write: Object.freeze(() => wrote.resolve()),
                verifyPush: Object.freeze(() => false),
                onPush,
            });
            const old = mode === 'malformed' ? Uint8Array.of(0, 0, 0, 13) : frame(2, 77);
            const first = f.client.transactRaw(request());

            try {
                await bounded(wrote.promise);
                f.client.feed(join(frame(1, 17), old.subarray(0, 1)));
                const result = await bounded(first);
                expect(result).toMatchObject({ kind: 'response', sequence: 17, value: 'accepted' });
                f.client.feed(old.subarray(1));
                expect(await bounded(f.client.whenClosed)).toMatchObject({
                    kind: 'protocol-error',
                    code: mode === 'malformed' ? 'invalid-stream' : 'push-rejected',
                });
                expect(result).toMatchObject({ kind: 'response', value: 'accepted' });
                expect(onPush).not.toHaveBeenCalled();
            } finally {
                f.dispose();
            }
        },
    );

    it.each(['max-frame', 'reserved-frames', 'reserved-bytes'] as const)(
        'enforces %s after an incomplete frame survives settlement',
        async (limit) => {
            const wrote = deferred<void>();
            const f = fixture({
                maxFrameBytes: limit === 'max-frame' ? 14 : 1024,
                maxFrames: limit === 'reserved-frames' ? 1 : 8,
                maxBufferedBytes: limit === 'reserved-bytes' ? 27 : 4096,
                write: Object.freeze(() => wrote.resolve()),
            });
            const old = frame(2, 77);
            const first = f.client.transactRaw(request());

            try {
                await bounded(wrote.promise);
                f.client.feed(join(frame(1, 17), old.subarray(0, 1)));
                expect(await bounded(first)).toMatchObject({ kind: 'response', sequence: 17 });

                if (limit === 'max-frame') {
                    f.client.feed(Uint8Array.of(0, 0, 15));
                } else {
                    // The completed old frame still occupies its reservation when the next
                    // prefix is parsed in the same feed call, before the pump runs.
                    f.client.feed(old.subarray(1, 4));
                    f.client.feed(join(old.subarray(4), frame(2, 78).subarray(0, 4)));
                }

                expect(await bounded(f.client.whenClosed)).toMatchObject({
                    kind: 'protocol-error',
                    code: 'invalid-stream',
                });
            } finally {
                f.dispose();
            }
        },
    );

    it('starts the second deadline before its held builder reaches write', async () => {
        const wrote = deferred<void>();
        const buildEntered = deferred<void>();
        const buildGate = deferred<void>();
        const f = fixture({ write: Object.freeze(() => wrote.resolve()) });
        const old = frame(2, 77);
        const first = f.client.transactRaw(request());

        try {
            await bounded(wrote.promise);
            f.client.feed(join(frame(1, 17), old.subarray(0, 1)));
            expect(await bounded(first)).toMatchObject({ kind: 'response', sequence: 17 });
            const second = f.client.transactRaw(
                request({
                    timeoutMs: 100,
                    buildRequest: Object.freeze(async (identity: Sso12RawIdentity) => {
                        buildEntered.resolve();
                        await buildGate.promise;
                        return { frame: frame(1, identity.sequence), context: null };
                    }),
                }),
            );
            await bounded(buildEntered.promise);
            expect(await bounded(second)).toMatchObject({
                kind: 'failure',
                code: 'raw-timeout',
                writeState: 'not-written',
            });
            await bounded(f.client.whenClosed);
            expect(() => f.client.feed(old.subarray(1))).toThrow();
            expect(f.events).toEqual(['classify:1']);
        } finally {
            buildGate.resolve();
            f.dispose();
        }
    });

    it.each(['verify-false', 'consume-reject'] as const)(
        'closes on response %s while a following frame is partial',
        async (mode) => {
            const wrote = deferred<void>();
            const onPush = vi.fn();
            const calls: string[] = [];
            const f = fixture({ write: Object.freeze(() => wrote.resolve()), onPush });
            const old = frame(2, 77);
            const work = f.client.transactRaw(
                request({
                    verifyCandidate: Object.freeze(() => {
                        calls.push('verify');
                        return mode !== 'verify-false';
                    }),
                    consumeCandidate: Object.freeze(() => {
                        calls.push('consume');
                        throw new Error('synthetic consume failure');
                    }),
                }),
            );

            try {
                await bounded(wrote.promise);
                f.client.feed(join(frame(1, 17), old.subarray(0, 7)));
                expect(await bounded(work)).toMatchObject({
                    kind: 'failure',
                    code: mode === 'verify-false' ? 'raw-rejected' : 'frame-handler-failed',
                });
                await bounded(f.client.whenClosed);
                expect(calls).toEqual(mode === 'verify-false' ? ['verify'] : ['verify', 'consume']);
                expect(f.events).toEqual(['classify:1']);
                expect(f.frozenIdentities).toEqual([true]);
                expect(() => f.client.feed(old.subarray(7))).toThrow();
                expect(onPush).not.toHaveBeenCalled();
            } finally {
                f.dispose();
            }
        },
    );

    it.each(['abort', 'close'] as const)(
        'drops retained partial bytes on %s and dispatches no late data',
        async (mode) => {
            const wrote = deferred<void>();
            const buildEntered = deferred<void>();
            const buildGate = deferred<void>();
            const abort = new AbortController();
            const f = fixture({ write: Object.freeze(() => wrote.resolve()) });
            const old = frame(2, 77);
            const first = f.client.transactRaw(request());

            try {
                await bounded(wrote.promise);
                f.client.feed(join(frame(1, 17), old.subarray(0, 7)));
                expect(await bounded(first)).toMatchObject({ kind: 'response', sequence: 17 });
                const second = f.client.transactRaw(
                    request({
                        signal: abort.signal,
                        buildRequest: Object.freeze(async (identity: Sso12RawIdentity) => {
                            buildEntered.resolve();
                            await buildGate.promise;
                            return { frame: frame(1, identity.sequence), context: null };
                        }),
                    }),
                );
                await bounded(buildEntered.promise);

                if (mode === 'abort') {
                    abort.abort();
                } else {
                    f.dispose();
                }

                const code = mode === 'abort' ? 'raw-cancelled' : 'local-close';
                expect(await bounded(second)).toMatchObject({
                    kind: 'failure',
                    code,
                    writeState: 'not-written',
                });
                expect(await bounded(f.client.whenClosed)).toEqual({ kind: 'local', code });
                expect(() => f.client.feed(old.subarray(7))).toThrow();
                buildGate.resolve();
                await turn();
                expect(f.events).toEqual(['classify:1']);
                expect(f.identities).toHaveLength(1);
            } finally {
                buildGate.resolve();
                f.dispose();
            }
        },
    );
});
