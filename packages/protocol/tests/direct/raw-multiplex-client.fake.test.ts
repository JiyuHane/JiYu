import { afterEach, describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeSsoResponse } from '../../src/direct/sso';
import { SSO_INFO_SYNC_COMMAND, SSO_HEARTBEAT_COMMAND } from '../../src/direct/sso-register';
import { createWtReferenceSession } from '../../src/direct/wt-reference-session';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';
import {
    createRawMultiplexClient,
    type RawMultiplexClientOptions,
} from '../../src/direct/raw-multiplex-client';
import { guardBorrowedTransport } from '../../src/direct/guard-raw-transaction';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import {
    decodeServiceResponse,
    encodeServiceRequest,
    MAX_SERVICE_FRAME_BYTES,
} from '../../src/direct/service-frame';
import type { Sso12RawOptions } from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const word = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

// Synthetic service response: classification is explicit fixture policy, not a seq heuristic.
function incoming(kind: number, id: number, uin = '123'): Uint8Array {
    const account = Buffer.from(uin);
    const body = Buffer.concat([Buffer.of(kind), word(id)]);
    return Buffer.concat([
        word(14 + account.length + body.length),
        word(12),
        Buffer.of(0, 0),
        word(4 + account.length),
        account,
        body,
    ]);
}

function route(frame: Uint8Array) {
    const body = Buffer.from(decodeServiceResponse(frame).body);
    const id = body.readUInt32BE(1);

    if (body[0] === 1) {
        return { kind: 'response' as const, sequence: id };
    }

    if (body[0] === 2) {
        return { kind: 'push' as const, name: 'fixture', id };
    }

    return { kind: 'reject' as const };
}

function fixture(overrides: Partial<RawMultiplexClientOptions> = {}) {
    const writes: Uint8Array[] = [];
    const pushed: number[] = [];
    const wrote = deferred<void>();
    const client = createRawMultiplexClient({
        uin: '0',
        initialSequence: 17,
        defaultTimeoutMs: 1000,
        maxFrameBytes: 1024,
        maxBufferedBytes: 4096,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 4096,
        write: (frame) => {
            writes.push(Uint8Array.from(frame));
            wrote.resolve();
        },
        classify: (frame) => route(frame),
        verifyPush: () => true,
        onPush: (_frame, item) => {
            pushed.push(item.id);
        },
        ...overrides,
    });
    return { client, writes, pushed, wrote };
}

function request(
    extra: Partial<Sso12RawOptions<null, string>> = {},
): Sso12RawOptions<null, string> {
    return {
        buildRequest: ({ sequence }) => ({
            frame: encodeServiceRequest({
                protocol: 12,
                uin: '0',
                encryption: { type: 'none' },
                d2: new Uint8Array(),
                body: word(sequence),
            }),
            context: null,
        }),
        verifyCandidate: () => true,
        consumeCandidate: (frame) => Buffer.from(decodeServiceResponse(frame).body).toString('hex'),
        ...extra,
    };
}

afterEach(() => vi.useRealTimers());

describe('raw multiplex client over in-memory service frames', () => {
    it.each(['push-first', 'response-first'] as const)(
        'reassembles fragmented and coalesced %s frames through a broker lease and guard',
        async (order) => {
            const seen: number[] = [];
            const f = fixture({
                onPush: (_frame, item) => {
                    seen.push(item.id);
                },
            });
            const lease = createRawSessionBroker(f.client, {
                trustedSuccessQuiescence: true,
                isUsable: () => !f.client.closed,
            }).acquire({ deadline: performance.now() + 5000 });
            const run = guardBorrowedTransport<null, string>(lease);
            let verified: Uint8Array | undefined;
            let consumed: Uint8Array | undefined;
            let actualCandidate: Uint8Array | undefined;
            let responseUin: string | undefined;
            const identities: unknown[] = [];
            const work = run(
                request({
                    verifyCandidate: (frame, _context, identity) => {
                        identities.push({ ...identity });
                        responseUin = decodeServiceResponse(frame).uin;
                        verified = frame;
                        frame.fill(0);
                        return true;
                    },
                    consumeCandidate: (frame, _context, identity) => {
                        identities.push({ ...identity });
                        consumed = frame;
                        actualCandidate = Uint8Array.from(frame);
                        return 'accepted';
                    },
                }),
            );
            await f.wrote.promise;
            const push = incoming(2, 17); // Equal sequence is still a push under explicit policy.
            const response = incoming(1, 17);
            const joined = Buffer.concat(
                order === 'push-first' ? [push, response] : [response, push],
            );

            for (const [start, end] of [
                [0, 1],
                [1, 3],
                [3, 4],
                [4, 10],
                [10, 19],
                [19, joined.length],
            ]) {
                f.client.feed(joined.subarray(start, end));
            }

            expect(await work).toEqual({
                kind: 'response',
                sequence: 17,
                value: 'accepted',
                writeState: 'written',
            });
            await turn();
            expect(seen).toEqual([17]);
            expect(identities).toEqual([
                { uin: '0', sequence: 17 },
                { uin: '0', sequence: 17 },
            ]);
            expect(responseUin).toBe('123');
            expect(actualCandidate).toEqual(Uint8Array.from(incoming(1, 17)));
            expect(verified).not.toBe(consumed);
            expect(verified?.every((b) => b === 0)).toBe(true);
            expect(consumed?.every((b) => b === 0)).toBe(true);
            expect(joined).toEqual(
                Buffer.concat(order === 'push-first' ? [push, response] : [response, push]),
            );
            lease.release();
            expect(await lease.whenClosed).toBe('released');
            f.client.close();
            expect((await f.client.whenClosed).kind).toBe('local');
        },
    );

    it('routes idle and queued pushes in order while response does not wait for the handler', async () => {
        const entered = deferred<void>();
        const release = deferred<void>();
        const seen: number[] = [];
        const f = fixture({
            onPush: async (_frame, item) => {
                seen.push(item.id);

                if (item.id === 1) {
                    entered.resolve();
                    await release.promise;
                }
            },
        });

        try {
            f.client.feed(incoming(2, 1));
            await entered.promise;
            const work = f.client.transactRaw(request());
            await f.wrote.promise;
            f.client.feed(Buffer.concat([incoming(2, 2), incoming(1, 17), incoming(2, 3)]));
            expect(await work).toMatchObject({ kind: 'response', sequence: 17 });
            expect(seen).toEqual([1]);
            release.resolve();
            await turn();
            expect(seen).toEqual([1, 2, 3]);
        } finally {
            release.resolve();
            f.client.close();
        }
    });

    it.each(['mismatch', 'reject', 'invalid', 'throw', 'verify-false', 'verify-throw'] as const)(
        'fails closed on %s and never promotes it to a push',
        async (mode) => {
            const onPush = vi.fn();
            const f = fixture({
                onPush,
                classify: (frame) => {
                    if (mode === 'invalid') {
                        return { kind: 'unknown' } as never;
                    }

                    if (mode === 'throw') {
                        throw Error('fixture');
                    }

                    if (mode === 'reject') {
                        return { kind: 'reject' };
                    }

                    return route(frame);
                },
            });
            const verify = vi.fn(() => {
                if (mode === 'verify-throw') {
                    throw Error('fixture');
                }

                return mode !== 'verify-false';
            });
            const consume = vi.fn(() => 'accepted');
            const work = f.client.transactRaw(
                request({ verifyCandidate: verify, consumeCandidate: consume }),
            );
            await f.wrote.promise;
            f.client.feed(incoming(1, mode === 'mismatch' ? 18 : 17));
            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            await f.client.whenClosed;
            expect(f.client.closed).toBe(true);
            expect(onPush).not.toHaveBeenCalled();
            expect(consume).not.toHaveBeenCalled();
        },
    );

    it('isolates feed, classification and push-verification callback copies', async () => {
        const gate = deferred<void>();
        const entered = deferred<void>();
        const delivered = deferred<Uint8Array>();
        const frame = incoming(2, 7);
        const expected = Uint8Array.from(frame);
        const f = fixture({
            classify: async (candidate) => {
                entered.resolve();
                await gate.promise;
                const result = route(candidate);
                candidate.fill(0);
                return result;
            },
            verifyPush: (candidate) => {
                expect(candidate).toEqual(expected);
                candidate.fill(0);
                return true;
            },
            onPush: (candidate) => {
                delivered.resolve(Uint8Array.from(candidate));
            },
        });

        try {
            f.client.feed(frame);
            await entered.promise;
            frame.fill(0);
            gate.resolve();
            expect(await delivered.promise).toEqual(expected);
        } finally {
            gate.resolve();
            f.client.close();
        }
    });

    it('closes on an unmatched idle response rather than treating it as push', async () => {
        const f = fixture();
        f.client.feed(incoming(1, 17));
        await f.client.whenClosed;
        expect(f.pushed).toEqual([]);
        expect(f.client.closed).toBe(true);
    });

    it.each([0, 13, 1025, MAX_SERVICE_FRAME_BYTES + 1, 0xffffffff])(
        'rejects declared frame length %i at prefix',
        async (length) => {
            const f = fixture();
            f.client.feed(word(length));
            await f.client.whenClosed;
            expect(f.client.closed).toBe(true);
        },
    );

    it.each([1, 3, 4, 10])('closes on end with %i partial bytes', async (length) => {
        const f = fixture();
        f.client.feed(incoming(2, 1).subarray(0, length));
        f.client.end();
        expect((await f.client.whenClosed).kind).toBe('protocol-error');
        expect(f.pushed).toEqual([]);
    });

    it('bounds queued pushes and fails closed without dispatching duplicates', async () => {
        const started = deferred<void>();
        const release = deferred<void>();
        const seen: number[] = [];
        const f = fixture({
            maxPushFrames: 1,
            onPush: async (_frame, item) => {
                seen.push(item.id);
                started.resolve();
                await release.promise;
            },
        });

        try {
            f.client.feed(incoming(2, 1));
            await started.promise;
            f.client.feed(Buffer.concat([incoming(2, 2), incoming(2, 3), incoming(2, 4)]));
            await f.client.whenClosed;
            expect(new Set(seen).size).toBe(seen.length);
            expect(seen).toEqual([1]);
        } finally {
            release.resolve();
            f.client.close();
        }
    });

    it.each(['throw', 'reject', 'false', 'verify-throw'] as const)(
        'closes on push verifier/handler %s',
        async (mode) => {
            const f = fixture({
                verifyPush: () => {
                    if (mode === 'verify-throw') {
                        throw Error('fixture');
                    }

                    return mode !== 'false';
                },
                onPush: () => {
                    if (mode === 'throw') {
                        throw Error('fixture');
                    }

                    if (mode === 'reject') {
                        return Promise.reject(Error('fixture'));
                    }
                },
            });
            f.client.feed(incoming(2, 1));
            await f.client.whenClosed;
            expect(f.client.closed).toBe(true);
        },
    );

    it('reports busy without perturbing the first request', async () => {
        const f = fixture();
        const first = f.client.transactRaw(request());
        await f.wrote.promise;
        expect(await f.client.transactRaw(request())).toMatchObject({
            kind: 'failure',
            code: 'busy',
            writeState: 'not-written',
        });
        f.client.feed(incoming(1, 17));
        expect(await first).toMatchObject({ kind: 'response', sequence: 17 });
        f.client.close();
    });

    it.each(['resolve', 'reject', 'close', 'abort', 'timeout'] as const)(
        'holds response callbacks until synchronous-feed write %s while later push advances',
        async (mode) => {
            const controller = new AbortController();
            const gate = deferred<void>();
            const entered = deferred<void>();
            const pushed = deferred<void>();
            const verify = vi.fn(() => true);
            const consume = vi.fn(() => 'accepted');
            const verifyPush = vi.fn(() => true);
            let client!: ReturnType<typeof createRawMultiplexClient>;
            const f = fixture({
                verifyPush,
                write: () => {
                    client.feed(Buffer.concat([incoming(1, 17), incoming(2, 77)]));
                    entered.resolve();
                    return gate.promise;
                },
                onPush: (_frame, item) => {
                    expect(item.id).toBe(77);
                    pushed.resolve();
                },
            });
            client = f.client;
            const work = client.transactRaw(
                request({
                    verifyCandidate: verify,
                    consumeCandidate: consume,
                    signal: controller.signal,
                    timeoutMs: mode === 'timeout' ? 300 : 1000,
                }),
            );

            try {
                await entered.promise;
                await pushed.promise;
                expect(verifyPush).toHaveBeenCalledOnce();
                expect(verify).not.toHaveBeenCalled();
                expect(consume).not.toHaveBeenCalled();

                if (mode === 'resolve') {
                    gate.resolve();
                    expect(await work).toMatchObject({
                        kind: 'response',
                        sequence: 17,
                        value: 'accepted',
                        writeState: 'written',
                    });
                    expect(verify).toHaveBeenCalledOnce();
                    expect(consume).toHaveBeenCalledOnce();
                } else {
                    if (mode === 'close') {
                        client.close();
                    } else if (mode === 'reject') {
                        gate.reject(Error('write fixture failure'));
                    } else if (mode === 'abort') {
                        controller.abort();
                    }

                    expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                    await client.whenClosed;
                    gate.resolve();
                    await turn();
                    expect(verify).not.toHaveBeenCalled();
                    expect(consume).not.toHaveBeenCalled();
                }
            } finally {
                gate.resolve();
                client.close();
            }
        },
    );

    it('observes a late push handler rejection after close and does not dispatch queued pushes', async () => {
        const entered = deferred<void>();
        const handler = deferred<void>();
        const observed: number[] = [];
        const unhandled: unknown[] = [];

        const listener = (reason: unknown) => {
            unhandled.push(reason);
        };

        process.on('unhandledRejection', listener);
        const f = fixture({
            onPush: (_frame, item) => {
                observed.push(item.id);
                entered.resolve();
                return handler.promise;
            },
        });

        try {
            f.client.feed(Buffer.concat([incoming(2, 1), incoming(2, 2)]));
            await entered.promise;
            f.client.close();
            await f.client.whenClosed;
            handler.reject(Error('late handler fixture'));
            await turn();
            await turn();
            expect(observed).toEqual([1]);
            expect(unhandled).toEqual([]);
        } finally {
            handler.resolve();
            f.client.close();
            process.off('unhandledRejection', listener);
        }
    });

    it('wipes a callback copy again after its late post-close mutation', async () => {
        const entered = deferred<void>();
        const release = deferred<void>();
        const returned = deferred<void>();
        let borrowed: Uint8Array | undefined;
        let independent: Uint8Array | undefined;
        const f = fixture({
            onPush: async (frame) => {
                borrowed = frame;
                independent = Uint8Array.from(frame);
                entered.resolve();
                await release.promise;
                frame.fill(0x5a);
                returned.resolve();
            },
        });

        try {
            f.client.feed(incoming(2, 5));
            await entered.promise;
            f.client.close();
            await f.client.whenClosed;
            release.resolve();
            await returned.promise;
            await turn();
            expect(borrowed?.every((byte) => byte === 0)).toBe(true);
            expect(independent?.some((byte) => byte !== 0)).toBe(true);
        } finally {
            release.resolve();
            independent?.fill(0);
            f.client.close();
        }
    });

    it.each(['sync', 'async'] as const)(
        'yields to an immediate cancellation during a finite %s recursively fed push stream',
        async (mode) => {
            const controller = new AbortController();
            const reachedFirst = deferred<void>();
            let processed = 0;
            let countAtAbort = -1;
            let client!: ReturnType<typeof createRawMultiplexClient>;
            const f = fixture({
                onPush: () => {
                    processed++;
                    reachedFirst.resolve();

                    if (processed < 1000) {
                        const next = processed + 1;

                        if (mode === 'async') {
                            return Promise.resolve().then(() => client.feed(incoming(2, next)));
                        }

                        client.feed(incoming(2, next));
                    }
                },
            });
            client = f.client;
            const lease = createRawSessionBroker(client, {
                trustedSuccessQuiescence: true,
                isUsable: () => !client.closed,
            }).acquire({ deadline: performance.now() + 5000 });
            const work = guardBorrowedTransport(lease)(request({ signal: controller.signal }));

            try {
                await f.wrote.promise;
                client.feed(incoming(2, 1));
                setImmediate(() => {
                    countAtAbort = processed;
                    controller.abort();
                });
                await reachedFirst.promise;
                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(countAtAbort).toBeGreaterThan(0);
                expect(countAtAbort).toBeLessThan(1000);
                expect(await lease.whenClosed).toBe('poisoned');
            } finally {
                controller.abort();
                lease.poison();
                client.close();
            }
        },
    );

    it('yields between asynchronously reentrant push batches while idle', async () => {
        const sentinel = deferred<number>();
        let count = 0;
        let client!: ReturnType<typeof createRawMultiplexClient>;
        const f = fixture({
            onPush: async () => {
                count++;
                await Promise.resolve();

                if (count < 1000 && !client.closed) {
                    client.feed(incoming(2, count + 1));
                }
            },
        });
        client = f.client;

        try {
            client.feed(incoming(2, 1));
            setImmediate(() => sentinel.resolve(count));
            const atImmediate = await sentinel.promise;
            expect(atImmediate).toBeGreaterThan(0);
            expect(atImmediate).toBeLessThan(1000);
        } finally {
            client.close();
            await client.whenClosed;
        }
    });

    it('waits for a pending write before committing a received response', async () => {
        const entered = deferred<void>();
        const gate = deferred<void>();
        const f = fixture({
            write: () => {
                entered.resolve();
                return gate.promise;
            },
        });
        let settled = false;
        const work = f.client.transactRaw(request()).then((result) => {
            settled = true;
            return result;
        });

        try {
            await entered.promise;
            f.client.feed(incoming(1, 17));
            await turn();
            expect(settled).toBe(false);
            gate.resolve();
            expect(await work).toMatchObject({
                kind: 'response',
                sequence: 17,
                writeState: 'written',
            });
        } finally {
            gate.resolve();
            f.client.close();
        }
    });

    it.each(['abort', 'timeout'] as const)(
        'fences a pending write after %s and observes late rejection',
        async (mode) => {
            const entered = deferred<void>();
            const gate = deferred<void>();
            const f = fixture({
                write: () => {
                    entered.resolve();
                    return gate.promise;
                },
            });
            const controller = new AbortController();
            controller.signal.addEventListener('abort', (event) =>
                event.stopImmediatePropagation(),
            );
            const lease = createRawSessionBroker(f.client, {
                trustedSuccessQuiescence: true,
                isUsable: () => !f.client.closed,
            }).acquire({ deadline: performance.now() + 5000 });
            const work = guardBorrowedTransport(lease)(
                request({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 30 : 1000 }),
            );
            await entered.promise;

            if (mode === 'abort') {
                controller.abort();
            }

            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(await lease.whenClosed).toBe('poisoned');
            gate.reject(Error('late fixture'));
            await turn();
            expect(f.client.closed).toBe(true);
        },
    );

    it('bounds complete frames while a classifier remains pending', async () => {
        const gate = deferred<ReturnType<typeof route>>();
        const started = deferred<void>();
        const f = fixture({
            maxFrames: 2,
            classify: () => {
                started.resolve();
                return gate.promise;
            },
        });

        try {
            f.client.feed(incoming(2, 1));
            await started.promise;
            f.client.feed(
                Buffer.concat([incoming(2, 2), incoming(2, 3), incoming(2, 4), incoming(2, 5)]),
            );
            await f.client.whenClosed;
            gate.resolve({ kind: 'push', name: 'fixture', id: 1 });
            await turn();
            expect(f.pushed).toEqual([]);
        } finally {
            gate.resolve({ kind: 'reject' });
            f.client.close();
        }
    });

    it('bounds queued bytes while classification is stalled', async () => {
        const gate = deferred<ReturnType<typeof route>>();
        const started = deferred<void>();
        const f = fixture({
            maxBufferedBytes: 1024,
            maxPushBytes: 1024,
            maxFrames: 200,
            classify: () => {
                started.resolve();
                return gate.promise;
            },
        });

        try {
            f.client.feed(incoming(2, 1));
            await started.promise;
            f.client.feed(Buffer.concat(Array.from({ length: 80 }, (_, i) => incoming(2, i + 2))));
            await f.client.whenClosed;
            gate.resolve({ kind: 'push', name: 'fixture', id: 1 });
            await turn();
            expect(f.pushed).toEqual([]);
        } finally {
            gate.resolve({ kind: 'reject' });
            f.client.close();
        }
    });

    it('rejects broker callback reentry without a second write', async () => {
        const f = fixture();
        const lease = createRawSessionBroker(f.client, {
            trustedSuccessQuiescence: true,
            isUsable: () => !f.client.closed,
        }).acquire({ deadline: performance.now() + 5000 });
        let reentry: unknown;
        const work = guardBorrowedTransport<null, string>(lease)(
            request({
                buildRequest: async ({ sequence }) => {
                    reentry = await lease.transactRaw(request());
                    return {
                        frame: encodeServiceRequest({
                            protocol: 12,
                            uin: '0',
                            encryption: { type: 'none' },
                            d2: new Uint8Array(),
                            body: word(sequence),
                        }),
                        context: null,
                    };
                },
            }),
        );
        await f.wrote.promise;
        f.client.feed(incoming(1, 17));
        expect(await work).toMatchObject({ kind: 'response', sequence: 17 });
        expect(reentry).toMatchObject({ kind: 'failure', code: 'busy', writeState: 'not-written' });
        expect(f.writes).toHaveLength(1);
        lease.release();
        f.client.close();
    });

    it('rechecks the deadline after the write copy is made and before invoking write', async () => {
        let built = false;
        let checksAfterBuild = 0;
        const write = vi.fn();
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            // Frozen implementation checks after build, after context, then after copy/wipe.
            if (built && ++checksAfterBuild >= 3) {
                return 1001;
            }

            return 0;
        });
        const f = fixture({ write });
        const normal = request();

        try {
            const result = await f.client.transactRaw(
                request({
                    timeoutMs: 1000,
                    buildRequest: (identity) => {
                        const value = normal.buildRequest(identity);
                        built = true;
                        return value;
                    },
                }),
            );
            expect(checksAfterBuild).toBeGreaterThanOrEqual(3);
            expect(result).toMatchObject({
                kind: 'failure',
                code: 'raw-timeout',
                writeState: 'not-written',
            });
            expect(write).not.toHaveBeenCalled();
            expect((await f.client.whenClosed).code).toBe('raw-timeout');
        } finally {
            clock.mockRestore();
            f.client.close();
        }
    });

    it('cancels a late builder before any write and does not revive it', async () => {
        const entered = deferred<void>();
        const late = deferred<{ frame: Uint8Array; context: null }>();
        const controller = new AbortController();
        const f = fixture();
        const lease = createRawSessionBroker(f.client, {
            trustedSuccessQuiescence: true,
            isUsable: () => !f.client.closed,
        }).acquire({ deadline: performance.now() + 5000 });
        const work = guardBorrowedTransport(lease)(
            request({
                signal: controller.signal,
                buildRequest: () => {
                    entered.resolve();
                    return late.promise;
                },
            }),
        );
        await entered.promise;
        controller.abort();
        expect(await work).toMatchObject({ kind: 'failure' });
        late.resolve({
            frame: encodeServiceRequest({
                protocol: 12,
                uin: '0',
                encryption: { type: 'none' },
                d2: new Uint8Array(),
                body: Uint8Array.of(1),
            }),
            context: null,
        });
        await turn();
        expect(f.writes).toHaveLength(0);
        expect(await lease.whenClosed).toBe('poisoned');
    });

    it('does not reuse the immediately preceding sequence at wrap', async () => {
        let wrote = deferred<void>();
        const identities: number[] = [];
        const f = fixture({ initialSequence: 0xffffffff, write: () => wrote.resolve() });

        for (const sequence of [0xffffffff, 0]) {
            const work = f.client.transactRaw(
                request({
                    buildRequest: (identity) => {
                        identities.push(identity.sequence);
                        return {
                            frame: encodeServiceRequest({
                                protocol: 12,
                                uin: '0',
                                encryption: { type: 'none' },
                                d2: new Uint8Array(),
                                body: word(identity.sequence),
                            }),
                            context: null,
                        };
                    },
                }),
            );
            await wrote.promise;
            f.client.feed(incoming(1, sequence));
            expect(await work).toMatchObject({ kind: 'response', sequence });
            wrote = deferred<void>();
        }

        expect(identities).toEqual([0xffffffff, 0]);
        f.client.close();
    });

    it('runs the real session owner login, registration and heartbeat across an independent push', async () => {
        // Synthetic peer and D2 classifier policy only; neither authenticates an online peer.
        const key = new Uint8Array(16).fill(10);
        const field = (data: Uint8Array) => Buffer.concat([word(data.length + 4), data]);
        const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
            commonInfo: { rspNT: { uid: 'fixture-uid' } },
        });
        const loginInner = encodeWtTlv([
            { tag: 0x143, value: Uint8Array.of(9) },
            { tag: 0x305, value: key },
            { tag: 0x10a, value: Uint8Array.of(11) },
            { tag: 0x106, value: Uint8Array.of(12) },
            { tag: 0x543, value: projection },
        ]);
        const loginBody = Buffer.concat([
            Buffer.of(0, 9, 0),
            encodeWtTlv([
                { tag: 0x119, value: qqTeaEncrypt(loginInner, new Uint8Array(16).fill(4)) },
            ]),
        ]);
        const pushes: number[] = [];
        const commands: string[] = [];
        let call = 0;
        let client!: ReturnType<typeof createRawMultiplexClient>;

        const replySso = (sequence: number, command: string, body: Uint8Array) => {
            const inner = Buffer.concat([
                field(
                    Buffer.concat([
                        word(sequence),
                        word(0),
                        field(Buffer.alloc(0)),
                        field(Buffer.from(command)),
                        field(Buffer.alloc(0)),
                        word(0),
                        field(Buffer.alloc(0)),
                    ]),
                ),
                field(body),
            ]);
            const cipher = qqTeaEncrypt(inner, key);
            return Buffer.concat([
                word(17 + cipher.length),
                word(12),
                Buffer.of(1, 0),
                field(Buffer.from('123')),
                cipher,
            ]);
        };

        client = createRawMultiplexClient({
            uin: '0',
            initialSequence: 50,
            maxFrameBytes: 65536,
            maxBufferedBytes: 262144,
            maxFrames: 16,
            maxPushFrames: 16,
            maxPushBytes: 65536,
            classify: (frame) => {
                const outer = decodeServiceResponse(frame, key);

                if (outer.encryption === 'none') {
                    return route(frame);
                }

                return { kind: 'response', sequence: decodeSsoResponse(outer.body).sequence >>> 0 };
            },
            verifyPush: () => true,
            onPush: (_frame, item) => {
                pushes.push(item.id);
            },
            write: (frame) => {
                call++;
                let reply: Uint8Array;

                if (call <= 3) {
                    const wt = parseWt(frame);
                    const body =
                        wt.kind === 0x31 ? fetchBody() : wt.kind === 0x12 ? pollBody(0) : loginBody;
                    reply = replyWt(wt, body);
                    wt.shared.fill(0);
                    wt.business.fill(0);
                } else {
                    const raw = Buffer.from(frame);
                    const ticketEnd = 9 + raw.readUInt32BE(9);
                    const accountStart = ticketEnd + 1;
                    const accountEnd = accountStart + raw.readUInt32BE(accountStart);
                    const inner = Buffer.from(qqTeaDecrypt(raw.subarray(accountEnd), key));
                    const commandStart = 28 + inner.readUInt32BE(28);
                    const commandEnd = commandStart + inner.readUInt32BE(commandStart);
                    const command = inner.subarray(commandStart + 4, commandEnd).toString();
                    commands.push(command);
                    const body =
                        command === SSO_INFO_SYNC_COMMAND
                            ? protobuf_encode<SsoRegisterResponse>({
                                  register: { message: 'register success' },
                              })
                            : protobuf_encode<SsoHeartbeatResponse>({ interval: 270n });
                    reply = replySso(inner.readUInt32BE(4), command, body);
                    inner.fill(0);
                }

                const outgoing = call === 1 ? Buffer.concat([incoming(2, 91), reply]) : reply;
                setImmediate(() => client.feed(outgoing));
            },
        });
        const lease = createRawSessionBroker(client, {
            trustedSuccessQuiescence: true,
            isUsable: () => !client.closed,
        }).acquire({ deadline: performance.now() + 10000 });
        const session = createWtReferenceSession(lease, {
            profile: {
                uin: '999',
                appId: 42,
                subAppId: 43,
                clientVersion: 44,
                guid: Uint8Array.of(1, 2),
                unknown21: new Uint8Array(21),
                randomKey: new Uint8Array(16).fill(7),
                peerPublicKey: peer.publicKey,
                ssoVersion: 'header-v',
                qrCommand: 'fixture.qr',
                loginCommand: 'fixture.login',
            },
            timeoutMs: 3000,
            attemptTimeoutMs: 9000,
            getTimestamp: () => 10,
            buildWtReserved: () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => responseUin === requestUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            registration: {
                version: 'build-v',
                deviceName: 'name',
                deviceType: 'type',
                vendorOs: 'os',
                random: 4,
            },
            buildRegisterReserved: () => Uint8Array.of(8),
            verifyRegisterRaw: () => true,
        });

        try {
            expect(
                (
                    await session.fetch({
                        packageName: 'p',
                        ptVersion: 'v',
                        miscBitMap: 1,
                        ssoVersion: 1,
                        d1: Uint8Array.of(1),
                    })
                ).qrUrl,
            ).toBe('https://example.invalid/qr');
            expect(await session.poll()).toEqual({ status: 'confirmed' });
            expect(
                await session.loginAndRegister({
                    mainSigMap: 1,
                    miscBitMap: 2,
                    subSigMap: 3,
                    packageName: 'p',
                    ptVersion: 'v',
                    sdkVersion: 's',
                    os: 'x',
                    deviceName: 'd',
                    apkSignature: Uint8Array.of(3),
                    tlv124Value: new Uint8Array(12),
                }),
            ).toEqual({ status: 'success' });
            expect(await session.heartbeat()).toEqual({ status: 'success', interval: 270n });
            await turn();
            expect(pushes).toEqual([91]);
            expect(commands).toEqual([SSO_INFO_SYNC_COMMAND, SSO_HEARTBEAT_COMMAND]);
            expect(call).toBe(5);
            expect(client.closed).toBe(false);
            session.close();
            lease.release();
            expect(await lease.whenClosed).toBe('released');
        } finally {
            session.close();
            lease.release();
            client.close();
            loginInner.fill(0);
            loginBody.fill(0);
            projection.fill(0);
            key.fill(0);
        }
    });

    it('does not consume a late-accepted verifier after cancellation', async () => {
        const entered = deferred<void>();
        const verify = deferred<boolean>();
        const consume = vi.fn(() => 'late');
        const controller = new AbortController();
        const f = fixture();
        const lease = createRawSessionBroker(f.client, {
            trustedSuccessQuiescence: true,
            isUsable: () => !f.client.closed,
        }).acquire({ deadline: performance.now() + 5000 });
        const work = guardBorrowedTransport(lease)(
            request({
                signal: controller.signal,
                verifyCandidate: () => {
                    entered.resolve();
                    return verify.promise;
                },
                consumeCandidate: consume,
            }),
        );
        await f.wrote.promise;
        f.client.feed(incoming(1, 17));
        await entered.promise;
        controller.abort();
        expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        verify.resolve(true);
        await turn();
        expect(consume).not.toHaveBeenCalled();
        expect(await lease.whenClosed).toBe('poisoned');
    });
});
