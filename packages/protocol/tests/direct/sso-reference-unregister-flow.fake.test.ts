import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { decodeSsoResponse } from '../../src/direct/sso';
import { SSO_UNREGISTER_REFERENCE_COMMAND as command } from '../../src/direct/sso-unregister';
import { referenceUnregisterOnTransport } from '../../src/direct/sso-reference-unregister-flow';
import type { SsoReferenceHeartbeatOptions } from '../../src/direct/sso-reference-heartbeat-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Pure synthetic frames, opaque callback metadata, and an in-memory peer.
const expectedCommand = 'trpc.qq_new_tech.status_svc.StatusService.UnRegister';
const sequence = 0xf0000001;
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const referenceBody = '0801120a0a0012001a0022002a001801';
type Options = SsoReferenceHeartbeatOptions & { maxResponseBodyBytes: number };

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
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
}

function field(value: Uint8Array): Buffer {
    return Buffer.concat([word(value.length + 4), value]);
}

function reply(
    options: {
        sequence?: number;
        uin?: string;
        command?: string;
        retCode?: number;
        protocol?: number;
        flag?: number;
        dataFlag?: number;
        body?: Uint8Array;
    } = {},
): Buffer {
    const header = Buffer.concat([
        word(options.sequence ?? sequence),
        word(options.retCode ?? 0),
        field(Buffer.alloc(0)),
        field(Buffer.from(options.command ?? expectedCommand)),
        field(Buffer.alloc(0)),
        word(options.dataFlag ?? 0),
        field(Buffer.alloc(0)),
    ]);
    const plain = Buffer.concat([field(header), field(options.body ?? Buffer.alloc(0))]);
    const encrypted = qqTeaEncrypt(plain, key);
    const uin = Buffer.from(options.uin ?? '123');
    return Buffer.concat([
        word(14 + uin.length + encrypted.length),
        word(options.protocol ?? 12),
        Buffer.of(options.flag ?? 1, 0),
        field(uin),
        encrypted,
    ]);
}

function inspectRequest(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    const ticketEnd = 9 + frame.readUInt32BE(9);
    const accountStart = ticketEnd + 1;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), key));
    const headerEnd = inner.readUInt32BE(0);
    let offset = 28;

    const readField = () => {
        const end = offset + inner.readUInt32BE(offset);
        const value = inner.subarray(offset + 4, end);
        offset = end;
        return value;
    };

    const a2 = readField();
    const actualCommand = readField();
    const empty1 = readField();
    const guid = readField();
    const empty2 = readField();
    const versionEnd = offset + inner.readUInt16BE(offset);
    const version = inner.subarray(offset + 2, versionEnd);
    offset = versionEnd;
    const reserved = readField();
    return {
        length: frame.readUInt32BE(0),
        actualLength: frame.length,
        protocol: frame.readUInt32BE(4),
        flag: frame[8],
        dummy: frame[ticketEnd],
        d2: [...frame.subarray(13, ticketEnd)],
        uin: frame.subarray(accountStart + 4, accountEnd).toString(),
        sequence: inner.readUInt32BE(4),
        subAppId: inner.readInt32BE(8),
        locale: inner.readInt32BE(12),
        a2: [...a2],
        command: actualCommand.toString(),
        empty1: empty1.length,
        guid: guid.toString(),
        empty2: empty2.length,
        version: version.toString(),
        reserved: [...reserved],
        headerEnd,
        parsedHeaderEnd: offset,
        body: inner.subarray(headerEnd + 4).toString('hex'),
        bodyLength: inner.readUInt32BE(headerEnd),
    };
}

function config(): Options {
    return {
        login: {
            status: 'tickets',
            uin: '123',
            tickets: {
                d2: Uint8Array.of(3, 4),
                d2Key: Uint8Array.from(key),
                a1: Uint8Array.of(5),
                a2: Uint8Array.of(6, 7),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
        uid: 'fixture-uid',
        timeoutMs: 1000,
        maxResponseBodyBytes: 65536,
        buildReserved: () => Uint8Array.of(0x91, 2, 0xfe),
        verifyRaw: () => true,
    };
}

type Mode =
    | 'normal'
    | 'skip'
    | 'swap'
    | 'identity'
    | 'context'
    | 'double-build'
    | 'double-verify'
    | 'double-consume'
    | 'wrong-result'
    | 'wrong-builder-uin';

class Peer implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly finished = deferred<void>();
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    calls = 0;
    verifies = 0;
    consumes = 0;
    mode: Mode = 'normal';
    uin = '123';
    candidate = reply();
    frame?: Uint8Array;
    capturedFrame?: Uint8Array;
    identity?: { uin: string; sequence: number };
    callbacks?: Sso12RawOptions<unknown, unknown>;
    context?: unknown;

    async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        try {
            return await this.run(o);
        } finally {
            this.finished.resolve();
        }
    }

    private async run<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const identity = { uin: this.mode === 'wrong-builder-uin' ? '0' : this.uin, sequence };
        this.identity = identity;
        this.callbacks = o as Sso12RawOptions<unknown, unknown>;

        if (this.mode === 'skip') {
            return { kind: 'response', sequence, value: {} as T, writeState: 'written' };
        }

        try {
            const built = await o.buildRequest(identity);
            this.capturedFrame = built.frame;
            this.frame = Uint8Array.from(built.frame);
            this.context = built.context;

            if (this.mode === 'double-build') {
                await o.buildRequest(identity);
            }

            const id =
                this.mode === 'identity' ? { ...identity, sequence: sequence + 1 } : identity;
            const context = this.mode === 'context' ? ({} as C) : built.context;
            this.verifies++;
            const accepted = await o.verifyCandidate(this.candidate, context, id);

            if (!accepted) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            if (this.mode === 'double-verify') {
                await o.verifyCandidate(this.candidate, built.context, identity);
            }

            const actual =
                this.mode === 'swap' ? reply({ body: Uint8Array.of(18, 0) }) : this.candidate;
            this.consumes++;
            const value = await o.consumeCandidate(actual, built.context, identity);

            if (this.mode === 'double-consume') {
                await o.consumeCandidate(this.candidate, built.context, identity);
            }

            return {
                kind: 'response',
                sequence: this.mode === 'wrong-result' ? 7 : sequence,
                value,
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
    const lease = broker.acquire({ deadline: performance.now() + 10000 });
    const transport: Sso12RawTransport = { transactRaw: (options) => lease.transactRaw(options) };
    return { lease, transport };
}

// The deadline is an explicit value, never a thrown error accepted as a callback failure.
async function watched<T>(
    promise: Promise<T>,
    ms = 1500,
): Promise<{ tag: 'value'; value: T } | { tag: 'deadline' }> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise.then((value) => ({ tag: 'value' as const, value })),
            new Promise<{ tag: 'deadline' }>((resolve) => {
                timer = setTimeout(() => resolve({ tag: 'deadline' }), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function expected(message: { presence: 'absent' } | { presence: 'present'; text: string }) {
    return {
        kind: 'response',
        sequence,
        value: { status: 'observed', message },
        writeState: 'written',
    };
}

describe('synthetic borrowed unregister transaction', () => {
    it('binds independently copied callback bytes to the D2 request and response', async () => {
        const peer = new Peer();
        const { lease, transport } = borrowed(peer);
        const options = config();
        const sourceKey = Uint8Array.from(options.login.tickets.d2Key);
        const sourceGuid = Uint8Array.from(options.profile.guid);
        const opaque = Uint8Array.of(0x91, 2, 0xfe);
        const builds: unknown[] = [];
        const verifies: unknown[] = [];
        const candidateBefore = Uint8Array.from(peer.candidate);
        let signerView: Uint8Array | undefined;
        let requestView: Uint8Array | undefined;
        let responseView: Uint8Array | undefined;

        options.buildReserved = ({ uin, uid, sequence: seq, command: cmd, body }) => {
            builds.push({
                uin,
                uid,
                sequence: seq,
                command: cmd,
                body: Buffer.from(body).toString('hex'),
            });
            signerView = body;
            body.fill(0xff);
            return opaque;
        };

        options.verifyRaw = ({ uin, sequence: seq, command: cmd, requestFrame, responseFrame }) => {
            verifies.push({
                uin,
                sequence: seq,
                command: cmd,
                request: Uint8Array.from(requestFrame),
                response: Uint8Array.from(responseFrame),
            });
            expect(requestFrame).not.toBe(peer.capturedFrame);
            expect(responseFrame).not.toBe(peer.candidate);
            requestView = requestFrame;
            responseView = responseFrame;
            requestFrame.fill(0xee);
            responseFrame.fill(0xee);
            return true;
        };

        try {
            expect(await referenceUnregisterOnTransport(transport, options)).toEqual(
                expected({ presence: 'absent' }),
            );
            expect(command).toBe(expectedCommand);

            // These are the exact borrowed callback views, not external clones or engine storage.
            for (const view of [signerView, requestView, responseView]) {
                expect(view).toBeDefined();
                expect(view!.length).toBeGreaterThan(0);
                expect(view!.every((byte) => byte === 0)).toBe(true);
            }

            expect(builds).toEqual([
                {
                    uin: '123',
                    uid: 'fixture-uid',
                    sequence,
                    command: expectedCommand,
                    body: referenceBody,
                },
            ]);
            expect(verifies).toEqual([
                {
                    uin: '123',
                    sequence,
                    command: expectedCommand,
                    request: peer.frame,
                    response: candidateBefore,
                },
            ]);
            const request = inspectRequest(peer.frame!);
            expect(request).toEqual({
                length: request.actualLength,
                actualLength: request.actualLength,
                protocol: 12,
                flag: 1,
                dummy: 0,
                d2: [3, 4],
                uin: '123',
                sequence,
                subAppId: 42,
                locale: 2052,
                a2: [6, 7],
                command: expectedCommand,
                empty1: 0,
                guid: 'abcd',
                empty2: 0,
                version: 'header-v',
                reserved: [0x91, 2, 0xfe],
                headerEnd: request.parsedHeaderEnd,
                parsedHeaderEnd: request.parsedHeaderEnd,
                body: referenceBody,
                bodyLength: 20,
            });
            expect(peer.identity).toEqual({ uin: '123', sequence });
            expect(Uint8Array.from(peer.candidate)).toEqual(candidateBefore);
            expect(options.login.tickets.d2Key).toEqual(sourceKey);
            expect(options.profile.guid).toEqual(sourceGuid);
            expect(opaque).toEqual(Uint8Array.of(0x91, 2, 0xfe));
            expect(peer.calls).toBe(1);
            expect(peer.close).not.toHaveBeenCalled();
        } finally {
            lease.release();
        }
    });

    it('rejects a mismatched builder account before signer or frame production', async () => {
        const peer = new Peer();
        peer.mode = 'wrong-builder-uin';
        const options = config();
        options.buildReserved = vi.fn(options.buildReserved);
        expect(await referenceUnregisterOnTransport(peer, options)).toMatchObject({
            kind: 'failure',
        });
        expect(options.buildReserved).not.toHaveBeenCalled();
        expect(peer.frame).toBeUndefined();
    });

    it.each(['0', '01', '4294967296'])(
        'rejects invalid configured account %s before the peer',
        async (uin) => {
            const peer = new Peer();
            const options = config();
            options.login.uin = uin;
            options.buildReserved = vi.fn(options.buildReserved);
            const result = await referenceUnregisterOnTransport(peer, options).then(
                (value) => ({ tag: 'value' as const, value }),
                () => ({ tag: 'invalid' as const }),
            );

            if (result.tag === 'value') {
                expect(result.value.kind).toBe('failure');
            }

            expect(peer.calls).toBe(0);
            expect(options.buildReserved).not.toHaveBeenCalled();
        },
    );

    it.each(['1', '4294967295'])('accepts matching boundary account %s', async (uin) => {
        const peer = new Peer();
        peer.uin = uin;
        peer.candidate = reply({ uin });
        const options = config();
        options.login.uin = uin;
        const signer = vi.fn(options.buildReserved);
        options.buildReserved = signer;
        expect(await referenceUnregisterOnTransport(peer, options)).toEqual(
            expected({ presence: 'absent' }),
        );
        expect(signer.mock.calls[0][0]).toMatchObject({ uin, sequence });
        expect(inspectRequest(peer.frame!).uin).toBe(uin);
    });

    it('keeps simultaneous synthetic accounts and callback frames isolated', async () => {
        const first = new Peer();
        const second = new Peer();
        second.uin = '456';
        second.candidate = reply({ uin: '456', body: Buffer.from('120179', 'hex') });
        const a = config();
        const b = config();
        b.login.uin = '456';
        b.uid = 'second-uid';
        const signerA = vi.fn(a.buildReserved);
        const signerB = vi.fn(b.buildReserved);
        a.buildReserved = signerA;
        b.buildReserved = signerB;
        const results = await Promise.all([
            referenceUnregisterOnTransport(first, a),
            referenceUnregisterOnTransport(second, b),
        ]);
        expect(results).toEqual([
            expected({ presence: 'absent' }),
            expected({ presence: 'present', text: 'y' }),
        ]);
        expect(signerA.mock.calls[0][0]).toMatchObject({
            uin: '123',
            uid: 'fixture-uid',
            sequence,
        });
        expect(signerB.mock.calls[0][0]).toMatchObject({ uin: '456', uid: 'second-uid', sequence });
        expect(inspectRequest(first.frame!).uin).toBe('123');
        expect(inspectRequest(second.frame!).uin).toBe('456');
        expect(first.frame).not.toBe(second.frame);
    });

    it.each([
        ['absent', '', { presence: 'absent' }],
        ['empty', '1200', { presence: 'present', text: '' }],
        ['text', '120768656c6c6f2121', { presence: 'present', text: 'hello!!' }],
        ['wrong wire', '1001', { presence: 'absent' }],
        ['unknown', '4807', { presence: 'absent' }],
        ['duplicate and unknown', '1201614807120162', { presence: 'present', text: 'b' }],
        ['duplicate empty', '1201611200', { presence: 'present', text: '' }],
        ['invalid utf8 replacement', '1202c328', { presence: 'present', text: '\ufffd(' }],
    ] as const)('preserves Proton observation for %s', async (_, hex, message) => {
        const peer = new Peer();
        peer.candidate = reply({ body: Buffer.from(hex, 'hex') });
        expect(await referenceUnregisterOnTransport(peer, config())).toEqual(expected(message));
        expect(peer.calls).toBe(1);
    });

    it.each([-2147483648, -1, 1, 2147483647])(
        'returns SSO error %i before inner protobuf parsing or small cap',
        async (retCode) => {
            const peer = new Peer();
            peer.candidate = reply({ retCode, body: Uint8Array.of(18, 128) });
            expect(
                await referenceUnregisterOnTransport(peer, {
                    ...config(),
                    maxResponseBodyBytes: 0,
                }),
            ).toEqual({
                kind: 'response',
                sequence,
                value: { status: 'sso-error', retCode },
                writeState: 'written',
            });
        },
    );

    it('applies the cap to the decoded protobuf body, including a compressed body', async () => {
        const peer = new Peer();
        peer.candidate = reply({ body: deflateSync(Buffer.from('120178', 'hex')), dataFlag: 1 });
        expect(
            await referenceUnregisterOnTransport(peer, { ...config(), maxResponseBodyBytes: 3 }),
        ).toEqual(expected({ presence: 'present', text: 'x' }));
        const next = new Peer();
        next.candidate = reply({ body: deflateSync(Buffer.from('120178', 'hex')), dataFlag: 1 });
        expect(
            await referenceUnregisterOnTransport(next, { ...config(), maxResponseBodyBytes: 2 }),
        ).toMatchObject({ kind: 'failure' });
        expect(
            await referenceUnregisterOnTransport(new Peer(), {
                ...config(),
                maxResponseBodyBytes: 0,
            }),
        ).toEqual(expected({ presence: 'absent' }));
    });

    it('enforces the maximum body boundary without treating it as a total-frame cap', async () => {
        const atLimit = Buffer.concat([Buffer.from([0x4a, 0xfc, 0xff, 0x03]), Buffer.alloc(65532)]);
        const overLimit = Buffer.concat([
            Buffer.from([0x4a, 0xfd, 0xff, 0x03]),
            Buffer.alloc(65533),
        ]);
        const first = new Peer();
        first.candidate = reply({ body: atLimit });
        expect(await referenceUnregisterOnTransport(first, config())).toEqual(
            expected({ presence: 'absent' }),
        );
        const second = new Peer();
        second.candidate = reply({ body: overLimit });
        expect(await referenceUnregisterOnTransport(second, config())).toMatchObject({
            kind: 'failure',
        });
    });

    it.each([
        [0, 'none'],
        [2, 'zero'],
    ] as const)('rejects an otherwise valid flag %i response (%s)', async (flag, encryption) => {
        const source = decodeServiceResponse(reply({ body: Buffer.from('120178', 'hex') }), key);
        const payload = flag === 0 ? source.body : qqTeaEncrypt(source.body, new Uint8Array(16));
        const uin = Buffer.from('123');
        const candidate = Buffer.concat([
            word(14 + uin.length + payload.length),
            word(12),
            Buffer.of(flag, 0),
            field(uin),
            payload,
        ]);
        const outer = decodeServiceResponse(candidate, key);
        const inner = decodeSsoResponse(outer.body);
        expect(outer).toMatchObject({ protocol: 12, encryption, uin: '123' });
        expect(inner).toMatchObject({ sequence: sequence | 0, retCode: 0, command });
        expect(Buffer.from(inner.body).toString('hex')).toBe('120178');
        const peer = new Peer();
        peer.candidate = candidate;
        const options = config();
        options.verifyRaw = vi.fn(() => true);
        expect(await referenceUnregisterOnTransport(peer, options)).toMatchObject({
            kind: 'failure',
        });
        expect(options.verifyRaw).toHaveBeenCalledOnce();
        expect(peer.verifies).toBe(1);
        expect(peer.consumes).toBe(1);
    });

    it.each([
        ['uin', reply({ uin: '456' })],
        ['sequence', reply({ sequence: 7 })],
        ['command', reply({ command: 'other' })],
        ['protocol', reply({ protocol: 13 })],
        ['flag0 with D2 ciphertext', reply({ flag: 0 })],
        ['truncated', reply().subarray(0, 12)],
        ['bad total', Buffer.concat([word(1), reply().subarray(4)])],
        ['invalid protobuf', reply({ body: Uint8Array.of(18, 128) })],
        [
            'nonzero error and broken compression',
            reply({ retCode: 7, dataFlag: 1, body: Uint8Array.of(1, 2) }),
        ],
        ['nonzero error and unsupported data flag', reply({ retCode: 7, dataFlag: 9 })],
    ] as const)('fails for %s rather than fabricating an observation', async (_, candidate) => {
        const peer = new Peer();
        peer.candidate = candidate;
        expect(await referenceUnregisterOnTransport(peer, config())).toMatchObject({
            kind: 'failure',
        });
    });

    it.each([
        'skip',
        'swap',
        'identity',
        'context',
        'double-build',
        'double-verify',
        'double-consume',
        'wrong-result',
    ] as const)('guard rejects dishonest peer %s', async (mode) => {
        const peer = new Peer();
        peer.mode = mode;
        expect(await referenceUnregisterOnTransport(peer, config())).toMatchObject({
            kind: 'failure',
        });
    });

    it.each(['false', 'throw'] as const)(
        'does not commit when verifier returns %s',
        async (mode) => {
            const peer = new Peer();
            const options = config();
            options.verifyRaw = vi.fn(() => {
                if (mode === 'throw') {
                    throw new Error('synthetic verifier failure');
                }

                return false;
            });
            expect(await referenceUnregisterOnTransport(peer, options)).toMatchObject({
                kind: 'failure',
            });
            expect(options.verifyRaw).toHaveBeenCalledOnce();
        },
    );

    it.each([-1, 1.5, 65537, NaN, Infinity, undefined])(
        'rejects invalid cap %s before peer',
        async (cap) => {
            const peer = new Peer();
            const options = { ...config(), maxResponseBodyBytes: cap as number };
            const result = await referenceUnregisterOnTransport(peer, options).then(
                (value) => ({ tag: 'value' as const, value }),
                () => ({ tag: 'invalid' as const }),
            );

            if (result.tag === 'value') {
                expect(result.value.kind).toBe('failure');
            }

            expect(peer.calls).toBe(0);
        },
    );

    it.each([
        'proxy options',
        'proxy callback',
        'shared key',
        'resizable key',
        'detached key',
        'invalid signal',
    ] as const)('rejects %s before the peer', async (which) => {
        const peer = new Peer();
        let options = config();

        if (which === 'proxy callback') {
            options.buildReserved = new Proxy(options.buildReserved, {});
        } else if (which === 'shared key') {
            options.login.tickets.d2Key = new Uint8Array(new SharedArrayBuffer(16));
        } else if (which === 'resizable key') {
            options.login.tickets.d2Key = new Uint8Array(
                new ArrayBuffer(16, { maxByteLength: 32 }),
            );
        } else if (which === 'detached key') {
            const value = new Uint8Array(16);
            structuredClone(value, { transfer: [value.buffer] });
            options.login.tickets.d2Key = value;
        } else if (which === 'invalid signal') {
            options.signal = new Proxy(new AbortController().signal, {});
        } else {
            options = new Proxy(options, {});
        }

        const result = await referenceUnregisterOnTransport(peer, options).then(
            (value) => ({ tag: 'value' as const, value }),
            () => ({ tag: 'invalid' as const }),
        );

        if (result.tag === 'value') {
            expect(result.value.kind).toBe('failure');
        }

        expect(peer.calls).toBe(0);
    });

    it.each(['proxy', 'shared', 'resizable', 'detached'] as const)(
        'rejects %s signer output without a frame',
        async (kind) => {
            const peer = new Peer();
            const options = config();
            const detached = Uint8Array.of(1);
            structuredClone(detached, { transfer: [detached.buffer] });
            const values: Record<typeof kind, Uint8Array> = {
                proxy: new Proxy(Uint8Array.of(1), {}),
                shared: new Uint8Array(new SharedArrayBuffer(1)),
                resizable: new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 })),
                detached,
            };
            options.buildReserved = () => values[kind];
            expect(await referenceUnregisterOnTransport(peer, options)).toMatchObject({
                kind: 'failure',
            });
            expect(peer.frame).toBeUndefined();
        },
    );

    it('does not enter the peer for a pre-aborted signal', async () => {
        const peer = new Peer();
        const controller = new AbortController();
        controller.abort();
        expect(
            await referenceUnregisterOnTransport(peer, { ...config(), signal: controller.signal }),
        ).toMatchObject({ kind: 'failure', writeState: 'not-written' });
        expect(peer.calls).toBe(0);
    });

    it('observes a genuinely late underlying fake transport rejection after broker timeout', async () => {
        const gate = deferred<Sso12RawResult<unknown>>();
        const entered = deferred<void>();
        const closed = deferred<Sso12CloseReason>();
        let started = false;
        const peer: Sso12RawClient = {
            whenClosed: closed.promise,
            close: vi.fn(() => closed.resolve({ kind: 'local', code: 'fixture' })),
            transactRaw<C, T>(_options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                started = true;
                entered.resolve();
                return gate.promise as Promise<Sso12RawResult<T>>;
            },
        };
        const lease = createRawSessionBroker(peer, {
            trustedSuccessQuiescence: true,
            isUsable: () => true,
        }).acquire({ deadline: performance.now() + 5000 });
        const unhandled: unknown[] = [];

        const onUnhandled = (error: unknown) => {
            unhandled.push(error);
        };

        process.on('unhandledRejection', onUnhandled);
        const pending = referenceUnregisterOnTransport(lease, { ...config(), timeoutMs: 100 });
        const tracked = pending.then(
            (value) => ({ tag: 'resolved' as const, value }),
            (error: unknown) => ({ tag: 'rejected' as const, error }),
        );
        let turnTag = 'not-attempted';

        try {
            expect((await watched(entered.promise)).tag).toBe('value');
            const early = await watched(tracked);
            expect(early.tag).toBe('value');

            if (early.tag === 'value') {
                expect(early.value.tag).toBe('resolved');

                if (early.value.tag === 'resolved') {
                    expect(early.value.value.kind).toBe('failure');
                }
            }

            expect(await watched(lease.whenClosed)).toEqual({ tag: 'value', value: 'poisoned' });
            expect(peer.close).toHaveBeenCalledOnce();
        } finally {
            if (started) {
                gate.reject(new Error('late underlying fixture rejection'));
            } else {
                gate.resolve({ kind: 'failure', code: 'unused', writeState: 'not-written' });
            }

            try {
                turnTag = (await watched(new Promise<void>((resolve) => setImmediate(resolve))))
                    .tag;
            } finally {
                try {
                    lease.release();
                } finally {
                    process.removeListener('unhandledRejection', onUnhandled);
                }
            }
        }

        expect(turnTag).toBe('value');
        expect(unhandled).toEqual([]);
    });

    it.each(['abort-resolve', 'abort-reject', 'timeout-resolve', 'timeout-reject'] as const)(
        'broker races %s and observes late signer settlement',
        async (scenario) => {
            const peer = new Peer();
            const { lease, transport } = borrowed(peer);
            const controller = new AbortController();
            controller.signal.addEventListener('abort', (event) =>
                event.stopImmediatePropagation(),
            );
            const entered = deferred<void>();
            const gate = deferred<Uint8Array>();
            void gate.promise.catch(() => undefined);
            const options = config();
            options.signal = controller.signal;
            options.timeoutMs = scenario.startsWith('timeout') ? 100 : 5000;

            options.buildReserved = () => {
                entered.resolve();
                return gate.promise;
            };

            const unhandled: unknown[] = [];

            const onUnhandled = (error: unknown) => {
                unhandled.push(error);
            };

            process.on('unhandledRejection', onUnhandled);
            const pending = referenceUnregisterOnTransport(transport, options);
            // Attach immediately even when a watchdog fires; drain after releasing the signer.
            let settled = false;
            const tracked = pending.then(
                (value) => {
                    settled = true;
                    return { tag: 'resolved' as const, value };
                },
                (error: unknown) => {
                    settled = true;
                    return { tag: 'rejected' as const, error };
                },
            );

            let drainTag = 'not-attempted';
            let peerFinishedTag = 'not-attempted';
            let turnTag = 'not-attempted';

            try {
                const reached = await watched(entered.promise);
                expect(reached.tag).toBe('value');

                if (scenario.startsWith('abort')) {
                    await Promise.resolve();
                    expect(settled).toBe(false);
                    controller.abort();
                }

                const early = await watched(tracked, scenario.startsWith('abort') ? 750 : 1500);
                expect(early.tag).toBe('value');

                if (early.tag === 'value') {
                    expect(early.value.tag).toBe('resolved');

                    if (early.value.tag === 'resolved') {
                        expect(early.value.value.kind).toBe('failure');
                    }
                }

                const closed = await watched(lease.whenClosed);
                expect(closed).toEqual({ tag: 'value', value: 'poisoned' });
            } finally {
                if (scenario.endsWith('reject')) {
                    gate.reject(new Error('late synthetic signer rejection'));
                } else {
                    gate.resolve(Uint8Array.of(0x91));
                }

                try {
                    drainTag = (await watched(tracked)).tag;
                    peerFinishedTag = (await watched(peer.finished.promise)).tag;
                    turnTag = (await watched(new Promise<void>((resolve) => setImmediate(resolve))))
                        .tag;
                } finally {
                    try {
                        lease.release();
                    } finally {
                        process.removeListener('unhandledRejection', onUnhandled);
                    }
                }
            }

            expect(drainTag).toBe('value');
            expect(peerFinishedTag).toBe('value');
            expect(peer.frame).toBeUndefined();
            expect(peer.verifies).toBe(0);
            expect(peer.consumes).toBe(0);
            expect(turnTag).toBe('value');
            expect(unhandled).toEqual([]);
            expect(peer.close).toHaveBeenCalledOnce();
        },
    );
});
