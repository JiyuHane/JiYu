import { describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeServiceResponse, encodeServiceRequest } from '../../src/direct/service-frame';
import { decodeSsoResponse, encodeSso13Request } from '../../src/direct/sso';
import {
    referenceAliveOnTransport,
    SSO_REFERENCE_ALIVE_COMMAND,
    type SsoReferenceAliveOptions,
    type SsoReferenceAliveResult,
} from '../../src/direct/sso-reference-alive-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Synthetic local response candidates and opaque callback metadata only. These
// fixtures do not establish a V2 server response profile or authenticate a peer.
const uin = '123';
const uid = 'fixture-uid';
const command = 'Heartbeat.Alive';
const body = Buffer.from('00000004', 'hex');
const reserved = Uint8Array.of(0x91, 0x02, 0xfe);
const defaultSequence = 0xf0000001;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

function field(value: Uint8Array): Buffer {
    return Buffer.concat([word(value.length + 4), value]);
}

function candidate(
    options: {
        sequence?: number;
        uin?: string;
        command?: string;
        retCode?: number;
        protocol?: number;
        flag?: number;
        body?: Uint8Array;
    } = {},
): Buffer {
    const header = Buffer.concat([
        word(options.sequence ?? defaultSequence),
        word(options.retCode ?? 0),
        field(Buffer.alloc(0)),
        field(Buffer.from(options.command ?? command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const plain = Buffer.concat([field(header), field(options.body ?? Buffer.alloc(0))]);
    const inner = options.flag === 2 ? qqTeaEncrypt(plain, new Uint8Array(16)) : plain;
    const account = Buffer.from(options.uin ?? uin);
    // Inbound has no request sequence field after the flag.
    return Buffer.concat([
        word(14 + account.length + inner.length),
        word(options.protocol ?? 13),
        Buffer.of(options.flag ?? 0, 0),
        field(account),
        inner,
    ]);
}

function inspectRequest(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    const accountStart = 14;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const inner = frame.subarray(accountEnd);
    const headerEnd = inner.readUInt32BE(0);
    let pos = 4;

    const readField = () => {
        const end = pos + inner.readUInt32BE(pos);
        const value = inner.subarray(pos + 4, end);
        pos = end;
        return value;
    };

    const actualCommand = readField().toString();
    const empty = readField();
    const actualReserved = readField();
    return {
        frameLength: frame.readUInt32BE(0),
        actualLength: frame.length,
        protocol: frame.readInt32BE(4),
        flag: frame[8],
        sequence: frame.readUInt32BE(9),
        dummy: frame[13],
        uin: frame.subarray(accountStart + 4, accountEnd).toString(),
        command: actualCommand,
        empty: [...empty],
        reserved: [...actualReserved],
        headerEnd,
        parsedHeaderEnd: pos,
        bodyFieldLength: inner.readUInt32BE(headerEnd),
        body: inner.subarray(headerEnd + 4).toString('hex'),
    };
}

function config(): SsoReferenceAliveOptions {
    return {
        uin,
        uid,
        timeoutMs: 1000,
        buildReserved: () => Uint8Array.from(reserved),
        verifyRaw: () => true,
    };
}

type Mode =
    | 'normal'
    | 'swap'
    | 'skip'
    | 'double-build'
    | 'double-verify'
    | 'double-consume'
    | 'wrong-identity'
    | 'wrong-identity-uin'
    | 'wrong-context'
    | 'wrong-result-sequence'
    | 'wrong-token';

class Peer implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    calls = 0;
    sequence = defaultSequence;
    mode: Mode = 'normal';
    response = (sequence: number): Uint8Array => candidate({ sequence });
    frame?: Uint8Array;
    identity?: { uin: string; sequence: number };
    captured?: Sso12RawOptions<unknown, unknown>;
    context?: unknown;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const identity = { uin: '0', sequence: this.sequence };
        this.identity = identity;
        this.captured = options as Sso12RawOptions<unknown, unknown>;

        if (this.mode === 'skip') {
            return {
                kind: 'response',
                sequence: identity.sequence,
                value: {} as T,
                writeState: 'written',
            };
        }

        try {
            const built = await options.buildRequest(identity);
            this.frame = Uint8Array.from(built.frame);
            this.context = built.context;

            if (this.mode === 'double-build') {
                await options.buildRequest(identity);
            }

            const changedIdentity =
                this.mode === 'wrong-identity'
                    ? { ...identity, sequence: (identity.sequence + 1) >>> 0 }
                    : this.mode === 'wrong-identity-uin'
                      ? { ...identity, uin: '1' }
                      : identity;
            const context = this.mode === 'wrong-context' ? ({} as C) : built.context;
            const response = this.response(identity.sequence);
            const accepted = await options.verifyCandidate(response, context, changedIdentity);

            if (!accepted) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            if (this.mode === 'double-verify') {
                await options.verifyCandidate(response, built.context, identity);
            }

            const selected =
                this.mode === 'swap'
                    ? candidate({ sequence: identity.sequence, body: Uint8Array.of(1) })
                    : response;
            const value = await options.consumeCandidate(selected, built.context, identity);

            if (this.mode === 'double-consume') {
                await options.consumeCandidate(response, built.context, identity);
            }

            return {
                kind: 'response',
                sequence:
                    this.mode === 'wrong-result-sequence'
                        ? (identity.sequence + 1) >>> 0
                        : identity.sequence,
                value: this.mode === 'wrong-token' ? ({} as T) : value,
                writeState: 'written',
            };
        } catch {
            return { kind: 'failure', code: 'fixture-callback-failed', writeState: 'unknown' };
        }
    }
}

function borrowed(peer: Peer) {
    const broker = createRawSessionBroker(peer, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    const lease = broker.acquire({ deadline: performance.now() + 5000 });
    const owner = { close: vi.fn(), release: vi.fn(), poison: vi.fn() };
    const transport: Sso12RawTransport = {
        transactRaw: (options) => lease.transactRaw(options),
        ...owner,
    };
    return { broker, lease, owner, transport };
}

function expectNoSuccess(result: SsoReferenceAliveResult): void {
    expect(result.kind === 'response' && result.value.status === 'success').toBe(false);
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('synthetic borrowed reference Alive transaction', () => {
    it('self-checks only the locally constructed asymmetric response with production decoders', () => {
        const response = candidate();
        const outer = decodeServiceResponse(response);
        const inner = decodeSsoResponse(outer.body);
        expect(outer).toMatchObject({ protocol: 13, encryption: 'none', dummy: 0, uin });
        expect(inner).toMatchObject({ sequence: defaultSequence | 0, retCode: 0, command });
        expect([...inner.body]).toEqual([]);
    });

    it.each([0, 0x7fffffff, 0x80000000, 0xffffffff])(
        'binds confirmed account and lease sequence %# across the protocol-13 request',
        async (sequence) => {
            const peer = new Peer();
            peer.sequence = sequence;
            const { broker, lease, owner, transport } = borrowed(peer);
            const options = config();
            const builds: unknown[] = [];
            const verifies: unknown[] = [];
            options.buildReserved = vi.fn((input) => {
                builds.push({ ...input, body: Buffer.from(input.body).toString('hex') });
                return Uint8Array.from(reserved);
            });
            options.verifyRaw = vi.fn((input) => {
                verifies.push({
                    uin: input.uin,
                    sequence: input.sequence,
                    command: input.command,
                    request: Uint8Array.from(input.requestFrame),
                    response: Uint8Array.from(input.responseFrame),
                });
                return true;
            });

            try {
                const result = await referenceAliveOnTransport(transport, options);
                expect(result).toEqual({
                    kind: 'response',
                    sequence,
                    value: { status: 'success' },
                    writeState: 'written',
                });
                expect(SSO_REFERENCE_ALIVE_COMMAND).toBe(command);
                expect(builds).toEqual([{ uin, uid, sequence, command, body: '00000004' }]);
                expect(options.buildReserved).toHaveBeenCalledOnce();
                expect(options.verifyRaw).toHaveBeenCalledOnce();
                expect(peer.identity).toEqual({ uin: '0', sequence });
                const request = inspectRequest(peer.frame!);
                expect(request).toEqual({
                    frameLength: request.actualLength,
                    actualLength: request.actualLength,
                    protocol: 13,
                    flag: 0,
                    sequence,
                    dummy: 0,
                    uin,
                    command,
                    empty: [],
                    reserved: [...reserved],
                    headerEnd: request.parsedHeaderEnd,
                    parsedHeaderEnd: request.parsedHeaderEnd,
                    bodyFieldLength: 8,
                    body: '00000004',
                });
                const inner = encodeSso13Request({ command, reserved, body });
                const expected = Uint8Array.from(
                    encodeServiceRequest({
                        protocol: 13,
                        sequence: sequence | 0,
                        uin,
                        encryption: { type: 'none' },
                        body: inner,
                    }),
                );
                expect(peer.frame).toEqual(expected);
                expect(verifies).toEqual([
                    {
                        uin,
                        sequence,
                        command,
                        request: expected,
                        response: Uint8Array.from(candidate({ sequence })),
                    },
                ]);
                expect(peer.calls).toBe(1);
                expect(peer.close).not.toHaveBeenCalled();
                expect(Object.values(owner).every((mock) => mock.mock.calls.length === 0)).toBe(
                    true,
                );
                expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
            } finally {
                lease.release();
                expect(await lease.whenClosed).toBe('released');
            }

            expect(peer.close).not.toHaveBeenCalled();
        },
    );

    it('passes UIN zero and empty UID through callbacks before login', async () => {
        const peer = new Peer();
        peer.response = (sequence) => candidate({ sequence, uin: '0' });
        const { lease, owner, transport } = borrowed(peer);
        const options = config();
        options.uin = '0';
        options.uid = '';
        const builds: unknown[] = [];
        const verifies: unknown[] = [];

        options.buildReserved = (input) => {
            builds.push({
                uin: input.uin,
                uid: input.uid,
                sequence: input.sequence,
                command: input.command,
                body: Buffer.from(input.body).toString('hex'),
            });
            return Uint8Array.from(reserved);
        };

        options.verifyRaw = (input) => {
            verifies.push({ uin: input.uin, sequence: input.sequence, command: input.command });
            return true;
        };

        try {
            expect(await referenceAliveOnTransport(transport, options)).toEqual({
                kind: 'response',
                sequence: defaultSequence,
                value: { status: 'success' },
                writeState: 'written',
            });
            expect(builds).toEqual([
                { uin: '0', uid: '', sequence: defaultSequence, command, body: '00000004' },
            ]);
            expect(verifies).toEqual([{ uin: '0', sequence: defaultSequence, command }]);
            expect(inspectRequest(peer.frame!).uin).toBe('0');
            expect(peer.calls).toBe(1);
            expect(peer.close).not.toHaveBeenCalled();
            expect(Object.values(owner).every((mock) => mock.mock.calls.length === 0)).toBe(true);
        } finally {
            lease.release();
            expect(await lease.whenClosed).toBe('released');
        }
    });

    it.each(['00', '0123', '4294967296'])(
        'rejects malformed or overflowing UIN %s before transport',
        async (invalidUin) => {
            const peer = new Peer();
            const options = { ...config(), uin: invalidUin };
            options.buildReserved = vi.fn(options.buildReserved);
            options.verifyRaw = vi.fn(options.verifyRaw);
            const result = await referenceAliveOnTransport(peer, options).then(
                (value) => value,
                () => null,
            );

            if (result !== null) {
                expectNoSuccess(result);
                expect(result.kind).toBe('failure');
            }

            expect(peer.calls).toBe(0);
            expect(options.buildReserved).not.toHaveBeenCalled();
            expect(options.verifyRaw).not.toHaveBeenCalled();
            expect(peer.close).not.toHaveBeenCalled();
        },
    );

    it.each([-2147483648, -1, 1, 2147483647])(
        'preserves local nonzero retCode %i as an error outcome',
        async (retCode) => {
            const peer = new Peer();
            peer.response = (sequence) => candidate({ sequence, retCode });
            const result = await referenceAliveOnTransport(peer, config());
            expect(result).toEqual({
                kind: 'response',
                sequence: defaultSequence,
                value: { status: 'sso-error', retCode },
                writeState: 'written',
            });
            expectNoSuccess(result);
            expect(peer.calls).toBe(1);
            expect(peer.close).not.toHaveBeenCalled();
        },
    );

    const invalidCandidates: [string, Uint8Array][] = [
        ['protocol', candidate({ protocol: 12 })],
        ['encryption', candidate({ flag: 2 })],
        ['UIN', candidate({ uin: '456' })],
        ['sequence', candidate({ sequence: 7 })],
        ['command', candidate({ command: 'Heartbeat.Other' })],
        ['truncated', candidate().subarray(0, 12)],
        ['invalid total length', Buffer.concat([word(1), candidate().subarray(4)])],
        [
            'trailing inner data',
            (() => {
                const response = Buffer.concat([candidate(), Buffer.of(1)]);
                response.writeUInt32BE(response.length, 0);
                return response;
            })(),
        ],
    ];
    it.each(invalidCandidates)('rejects local candidate with wrong %s', async (_, response) => {
        const peer = new Peer();
        peer.response = () => response;
        const result = await referenceAliveOnTransport(peer, config());
        expectNoSuccess(result);
        expect(result.kind).toBe('failure');
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
    });

    it.each([
        'swap',
        'skip',
        'double-build',
        'double-verify',
        'double-consume',
        'wrong-identity',
        'wrong-identity-uin',
        'wrong-context',
        'wrong-result-sequence',
        'wrong-token',
    ] as const)('rejects dishonest in-memory transport mode %s', async (mode) => {
        const peer = new Peer();
        peer.mode = mode;
        const result = await referenceAliveOnTransport(peer, config());
        expectNoSuccess(result);
        expect(result.kind).toBe('failure');
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
    });

    it.each(['false', 'throw'] as const)('does not accept verifier %s', async (mode) => {
        const peer = new Peer();
        const options = config();
        options.verifyRaw = vi.fn(() => {
            if (mode === 'throw') {
                throw new Error('synthetic verification failure');
            }

            return false;
        });
        const result = await referenceAliveOnTransport(peer, options);
        expectNoSuccess(result);
        expect(result.kind).toBe('failure');
        expect(options.verifyRaw).toHaveBeenCalledOnce();
    });

    it('leaves a pre-aborted operation outside the transport', async () => {
        const peer = new Peer();
        const controller = new AbortController();
        controller.abort();
        const result = await referenceAliveOnTransport(peer, {
            ...config(),
            signal: controller.signal,
        });
        expectNoSuccess(result);
        expect(result).toMatchObject({ kind: 'failure', writeState: 'not-written' });
        expect(peer.calls).toBe(0);
        expect(peer.close).not.toHaveBeenCalled();
    });

    it('revokes each borrowed callback after completion', async () => {
        const peer = new Peer();
        const options = config();
        options.buildReserved = vi.fn(options.buildReserved);
        options.verifyRaw = vi.fn(options.verifyRaw);
        expect(await referenceAliveOnTransport(peer, options)).toMatchObject({
            kind: 'response',
            value: { status: 'success' },
        });
        const callbacks = peer.captured!;
        const identity = peer.identity!;
        await expect(
            Promise.resolve().then(() => callbacks.buildRequest(identity)),
        ).rejects.toThrow();
        await expect(
            Promise.resolve().then(() =>
                callbacks.verifyCandidate(candidate(), peer.context, identity),
            ),
        ).rejects.toThrow();
        await expect(
            Promise.resolve().then(() =>
                callbacks.consumeCandidate(candidate(), peer.context, identity),
            ),
        ).rejects.toThrow();
        expect(options.buildReserved).toHaveBeenCalledOnce();
        expect(options.verifyRaw).toHaveBeenCalledOnce();
    });

    it.each(['signer', 'verifier'] as const)(
        'times out and drains late %s resolution',
        async (stage) => {
            const peer = new Peer();
            const { lease, owner, transport } = borrowed(peer);
            const entered = deferred<void>();
            const gate = deferred<Uint8Array | boolean>();
            const options = config();
            options.timeoutMs = 100;

            if (stage === 'signer') {
                options.buildReserved = () => {
                    entered.resolve();
                    return gate.promise as Promise<Uint8Array>;
                };
            } else {
                options.verifyRaw = () => {
                    entered.resolve();
                    return gate.promise as Promise<boolean>;
                };
            }

            const unhandled: unknown[] = [];

            const onUnhandled = (error: unknown) => {
                unhandled.push(error);
            };

            process.on('unhandledRejection', onUnhandled);
            const pending = referenceAliveOnTransport(transport, options);

            try {
                await entered.promise;
                const result = await pending;
                expectNoSuccess(result);
                expect(result.kind).toBe('failure');
                expect(await lease.whenClosed).toBe('poisoned');
                expect(peer.close).toHaveBeenCalledOnce();
                expect(Object.values(owner).every((mock) => mock.mock.calls.length === 0)).toBe(
                    true,
                );
            } finally {
                gate.resolve(stage === 'signer' ? Uint8Array.from(reserved) : true);
                await pending;
                await turn();
                lease.release();
                process.removeListener('unhandledRejection', onUnhandled);
            }

            expect(unhandled).toEqual([]);
        },
    );

    it.each(['signer', 'verifier'] as const)(
        'forwards stopImmediatePropagation abort and drains late %s rejection',
        async (stage) => {
            const peer = new Peer();
            const { lease, owner, transport } = borrowed(peer);
            const controller = new AbortController();
            controller.signal.addEventListener('abort', (event) =>
                event.stopImmediatePropagation(),
            );
            const entered = deferred<void>();
            const gate = deferred<Uint8Array | boolean>();
            const options = config();
            options.timeoutMs = 2000;
            options.signal = controller.signal;

            if (stage === 'signer') {
                options.buildReserved = vi.fn(() => {
                    entered.resolve();
                    return gate.promise as Promise<Uint8Array>;
                });
            } else {
                options.verifyRaw = vi.fn(() => {
                    entered.resolve();
                    return gate.promise as Promise<boolean>;
                });
            }

            const unhandled: unknown[] = [];

            const onUnhandled = (error: unknown) => {
                unhandled.push(error);
            };

            process.on('unhandledRejection', onUnhandled);
            const pending = referenceAliveOnTransport(transport, options);
            let timer: ReturnType<typeof setTimeout> | undefined;

            try {
                await entered.promise;
                controller.abort();
                const result = await Promise.race([
                    pending,
                    new Promise<'not-prompt'>((resolve) => {
                        timer = setTimeout(() => resolve('not-prompt'), 500);
                    }),
                ]);
                expect(result).not.toBe('not-prompt');

                if (result !== 'not-prompt') {
                    expectNoSuccess(result);
                    expect(result.kind).toBe('failure');
                }

                expect(await lease.whenClosed).toBe('poisoned');
                expect(peer.close).toHaveBeenCalledOnce();
                expect(Object.values(owner).every((mock) => mock.mock.calls.length === 0)).toBe(
                    true,
                );
            } finally {
                clearTimeout(timer);
                gate.reject(new Error('late synthetic callback rejection'));
                await pending;
                await turn();
                lease.release();
                process.removeListener('unhandledRejection', onUnhandled);
            }

            expect(unhandled).toEqual([]);
        },
    );
});
