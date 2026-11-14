import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SsoHeartbeatResponse } from '@snowluma/proto-defs/sso-register';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { SSO_HEARTBEAT_COMMAND } from '../../src/direct/sso-register';
import {
    referenceHeartbeatOnTransport,
    type SsoReferenceHeartbeatOptions,
} from '../../src/direct/sso-reference-heartbeat-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Synthetic framing and callbacks only; these fixtures make no server or signature claim.
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const sequence = 0xf0000001;
const referenceBody = '08011202080018002000';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

function reply(
    options: {
        sequence?: number;
        uin?: string;
        command?: string;
        retCode?: number;
        body?: Uint8Array;
    } = {},
): Buffer {
    const body = options.body ?? protobuf_encode<SsoHeartbeatResponse>({ interval: 270n });
    const header = Buffer.concat([
        word(options.sequence ?? sequence),
        word(options.retCode ?? 0),
        field(Buffer.alloc(0)),
        field(Buffer.from(options.command ?? SSO_HEARTBEAT_COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const encrypted = qqTeaEncrypt(Buffer.concat([field(header), field(body)]), key);
    const uin = Buffer.from(options.uin ?? '123');
    return Buffer.concat([
        word(14 + uin.length + encrypted.length),
        word(12),
        Buffer.of(1, 0),
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
    const command = readField();
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
        account: frame.subarray(accountStart + 4, accountEnd).toString(),
        sequence: inner.readUInt32BE(4),
        subAppId: inner.readInt32BE(8),
        locale: inner.readInt32BE(12),
        a2: [...a2],
        command: command.toString(),
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

function config(): SsoReferenceHeartbeatOptions {
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
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

type Mode =
    | 'normal'
    | 'swap'
    | 'wrong-result-sequence'
    | 'skip'
    | 'double-build'
    | 'double-verify'
    | 'double-consume'
    | 'identity'
    | 'context'
    | 'timeout'
    | 'abort';

class Peer implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    calls = 0;
    nextSequence = sequence;
    candidate = reply();
    mode: Mode = 'normal';
    frame?: Uint8Array;
    captured?: Sso12RawOptions<unknown, unknown>;
    identity?: { uin: string; sequence: number };
    context?: unknown;

    async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const identity = { uin: '0', sequence: this.nextSequence++ >>> 0 };
        this.identity = identity;
        this.captured = o as Sso12RawOptions<unknown, unknown>;

        if (this.mode === 'skip') {
            return {
                kind: 'response',
                sequence: identity.sequence,
                value: {} as T,
                writeState: 'written',
            };
        }

        try {
            const built = await o.buildRequest(identity);
            this.frame = Uint8Array.from(built.frame);
            this.context = built.context;

            if (this.mode === 'double-build') {
                await o.buildRequest(identity);
            }

            if (this.mode === 'timeout' || this.mode === 'abort') {
                return { kind: 'failure', code: this.mode, writeState: 'not-written' };
            }

            const id =
                this.mode === 'identity'
                    ? { ...identity, sequence: identity.sequence + 1 }
                    : identity;
            const context = this.mode === 'context' ? ({} as C) : built.context;
            const accepted = await o.verifyCandidate(this.candidate, context, id);

            if (!accepted) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            if (this.mode === 'double-verify') {
                await o.verifyCandidate(this.candidate, built.context, identity);
            }

            const value = await o.consumeCandidate(
                this.mode === 'swap' ? reply({ body: Buffer.from('1800', 'hex') }) : this.candidate,
                built.context,
                identity,
            );

            if (this.mode === 'double-consume') {
                await o.consumeCandidate(this.candidate, built.context, identity);
            }

            return {
                kind: 'response',
                sequence: this.mode === 'wrong-result-sequence' ? 7 : identity.sequence,
                value,
                writeState: 'written',
            };
        } catch {
            return { kind: 'failure', code: 'callback', writeState: 'unknown' };
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

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('synthetic reference heartbeat transaction', () => {
    it('uses the real broker callback sequence, confirmed account, exact body and D2 envelope', async () => {
        const peer = new Peer();
        const { broker, lease, owner, transport } = borrowed(peer);
        const options = config();
        const builds: unknown[] = [];
        const verifies: unknown[] = [];

        options.buildReserved = ({ uin, uid, sequence: actual, command, body }) => {
            builds.push({
                uin,
                uid,
                sequence: actual,
                command,
                body: Buffer.from(body).toString('hex'),
            });
            return Uint8Array.of(8);
        };

        options.verifyRaw = ({ uin, sequence: actual, command, requestFrame, responseFrame }) => {
            verifies.push({ uin, sequence: actual, command });
            expect(inspectRequest(requestFrame).sequence).toBe(actual);
            expect(Buffer.from(responseFrame)).toEqual(peer.candidate);
            return true;
        };

        expect(await referenceHeartbeatOnTransport(transport, options)).toEqual({
            kind: 'response',
            sequence,
            value: { status: 'success', interval: 270n },
            writeState: 'written',
        });
        expect(builds).toEqual([
            {
                uin: '123',
                uid: 'fixture-uid',
                sequence,
                command: SSO_HEARTBEAT_COMMAND,
                body: referenceBody,
            },
        ]);
        expect(verifies).toEqual([{ uin: '123', sequence, command: SSO_HEARTBEAT_COMMAND }]);
        const request = inspectRequest(peer.frame!);
        expect(request).toEqual({
            length: request.actualLength,
            actualLength: request.actualLength,
            protocol: 12,
            flag: 1,
            dummy: 0,
            d2: [3, 4],
            account: '123',
            sequence,
            subAppId: 42,
            locale: 2052,
            a2: [6, 7],
            command: SSO_HEARTBEAT_COMMAND,
            empty1: 0,
            guid: 'abcd',
            empty2: 0,
            version: 'header-v',
            reserved: [8],
            headerEnd: request.parsedHeaderEnd,
            parsedHeaderEnd: request.parsedHeaderEnd,
            body: referenceBody,
            bodyLength: 14,
        });
        expect(peer.identity).toEqual({ uin: '0', sequence });
        expect(options.login.tickets.d2Key).toEqual(key);
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
        expect(Object.values(owner).every((mock) => mock.mock.calls.length === 0)).toBe(true);
        expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
        lease.release();
        expect(await lease.whenClosed).toBe('released');
        expect(peer.close).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', Buffer.alloc(0), { status: 'missing-interval' }],
        ['zero', Buffer.from('1800', 'hex'), { status: 'success', interval: 0n }],
        [
            '270',
            protobuf_encode<SsoHeartbeatResponse>({ interval: 270n }),
            { status: 'success', interval: 270n },
        ],
        [
            'uint64 max',
            protobuf_encode<SsoHeartbeatResponse>({ interval: 0xffffffffffffffffn }),
            { status: 'success', interval: 0xffffffffffffffffn },
        ],
    ] as const)('preserves %s interval exactly without assuming units', async (_, body, value) => {
        const peer = new Peer();
        peer.candidate = reply({ body });
        const { lease, transport, owner } = borrowed(peer);
        expect(await referenceHeartbeatOnTransport(transport, config())).toEqual({
            kind: 'response',
            sequence,
            value,
            writeState: 'written',
        });
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
        expect(Object.values(owner).every((mock) => mock.mock.calls.length === 0)).toBe(true);
        lease.release();
    });

    // These exercise the local strict validator and Proton, not observed server wire behavior.
    it.each([
        ['duplicate interval', '18011802', 2n],
        ['nested group field 3', '4b1a01784c1801', 1n],
        ['length-delimited unknown', '4a031a01781800', 0n],
        ['ordinary unknown', '48071800', 0n],
    ] as const)('decodes local wire case %s', async (_, wire, interval) => {
        const peer = new Peer();
        peer.candidate = reply({ body: Buffer.from(wire, 'hex') });
        expect(await referenceHeartbeatOnTransport(peer, config())).toEqual({
            kind: 'response',
            sequence,
            value: { status: 'success', interval },
            writeState: 'written',
        });
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
    });

    const manyUnknowns = Buffer.from(
        Array.from({ length: 65 }, (_, index) => {
            const tag = (index + 9) * 8;
            return tag < 128 ? [tag, 0] : [(tag & 127) | 128, tag >>> 7, 0];
        }).flat(),
    );

    it.each([
        ['wrong wire after interval', Buffer.from('18011a00', 'hex')],
        ['wrong wire before interval', Buffer.from('1a001801', 'hex')],
        ['overflow', Buffer.from('1880808080808080808002', 'hex')],
        ['mismatched group', Buffer.from('4b1a017854', 'hex')],
        [
            'wrong wire after 65 unknown kinds',
            Buffer.concat([manyUnknowns, Buffer.from('1a00', 'hex')]),
        ],
    ] as const)('rejects local malformed wire case %s', async (_, body) => {
        const peer = new Peer();
        peer.candidate = reply({ body });
        expect(await referenceHeartbeatOnTransport(peer, config())).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
    });

    it.each([-1, 1, -2147483648])(
        'uses actual SSO retCode %i instead of a successful interval',
        async (retCode) => {
            const peer = new Peer();
            peer.candidate = reply({ retCode });
            const { lease, transport } = borrowed(peer);
            expect(await referenceHeartbeatOnTransport(transport, config())).toEqual({
                kind: 'response',
                sequence,
                value: { status: 'sso-error', retCode },
                writeState: 'written',
            });
            expect(peer.close).not.toHaveBeenCalled();
            lease.release();
        },
    );

    it.each([
        ['malformed protobuf', reply({ body: Buffer.from('1880', 'hex') })],
        ['response sequence', reply({ sequence: 7 })],
        ['response UIN', reply({ uin: '456' })],
        ['response command', reply({ command: 'wrong' })],
    ] as const)('rejects %s', async (_, candidate) => {
        const peer = new Peer();
        peer.candidate = candidate;
        expect(await referenceHeartbeatOnTransport(peer, config())).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
    });

    it.each([
        'swap',
        'wrong-result-sequence',
        'skip',
        'double-build',
        'double-verify',
        'double-consume',
        'identity',
        'context',
    ] as const)('rejects dishonest callback state %s', async (mode) => {
        const peer = new Peer();
        peer.mode = mode;
        expect(await referenceHeartbeatOnTransport(peer, config())).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect(peer.calls).toBe(1);
        expect(peer.close).not.toHaveBeenCalled();
    });

    it('does not consume when caller verification returns false', async () => {
        const peer = new Peer();
        const options = config();
        options.verifyRaw = vi.fn(() => false);
        expect(await referenceHeartbeatOnTransport(peer, options)).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect(options.verifyRaw).toHaveBeenCalledOnce();
        expect(peer.calls).toBe(1);
    });

    it.each(['timeout', 'abort'] as const)(
        'returns transport %s without close or retry',
        async (mode) => {
            const peer = new Peer();
            peer.mode = mode;
            expect(await referenceHeartbeatOnTransport(peer, config())).toMatchObject({
                kind: 'failure',
                writeState: 'not-written',
            });
            expect(peer.calls).toBe(1);
            expect(peer.close).not.toHaveBeenCalled();
        },
    );

    it('ignores a pre-aborted request before entering the transport', async () => {
        const peer = new Peer();
        const abort = new AbortController();
        abort.abort();
        expect(
            await referenceHeartbeatOnTransport(peer, { ...config(), signal: abort.signal }),
        ).toMatchObject({ kind: 'failure', writeState: 'not-written' });
        expect(peer.calls).toBe(0);
    });

    it('revokes callbacks after a completed transaction', async () => {
        const peer = new Peer();
        const options = config();
        options.buildReserved = vi.fn(options.buildReserved);
        options.verifyRaw = vi.fn(options.verifyRaw);
        expect(await referenceHeartbeatOnTransport(peer, options)).toMatchObject({
            kind: 'response',
        });
        const callbacks = peer.captured!;
        const id = peer.identity!;
        await expect(Promise.resolve().then(() => callbacks.buildRequest(id))).rejects.toThrow();
        await expect(
            Promise.resolve().then(() =>
                callbacks.verifyCandidate(peer.candidate, peer.context, id),
            ),
        ).rejects.toThrow();
        await expect(
            Promise.resolve().then(() =>
                callbacks.consumeCandidate(peer.candidate, peer.context, id),
            ),
        ).rejects.toThrow();
        expect(options.buildReserved).toHaveBeenCalledOnce();
        expect(options.verifyRaw).toHaveBeenCalledOnce();
    });

    it('rejects concurrent verification and never calls the external verifier twice', async () => {
        const gate = deferred<boolean>();
        const entered = deferred<void>();
        const options = config();
        options.verifyRaw = vi.fn(() => {
            entered.resolve();
            return gate.promise;
        });
        const peer: Sso12RawTransport = {
            async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                const id = { uin: '0', sequence };
                const built = await o.buildRequest(id);
                const first = Promise.resolve(o.verifyCandidate(reply(), built.context, id)).catch(
                    () => false,
                );
                await entered.promise;
                await Promise.resolve(o.verifyCandidate(reply(), built.context, id)).catch(
                    () => false,
                );
                gate.resolve(true);
                await first;
                return { kind: 'response', sequence, value: {} as T, writeState: 'written' };
            },
        };
        expect(await referenceHeartbeatOnTransport(peer, options)).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect(options.verifyRaw).toHaveBeenCalledOnce();
    });

    it('forwards externally stopped abort while the signer is pending', async () => {
        const entered = deferred<void>();
        const gate = deferred<Uint8Array>();
        const external = new AbortController();
        external.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const options = config();
        options.timeoutMs = 2000;
        options.signal = external.signal;
        options.buildReserved = vi.fn(() => {
            entered.resolve();
            return gate.promise;
        });
        const peer = new Peer();
        const { lease, owner, transport } = borrowed(peer);
        const pending = referenceHeartbeatOnTransport(transport, options);
        await entered.promise;
        external.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            const result = await Promise.race([
                pending,
                new Promise<'not-prompt'>((resolve) => {
                    timer = setTimeout(() => resolve('not-prompt'), 300);
                }),
            ]);
            expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(options.buildReserved).toHaveBeenCalledOnce();
            expect(peer.calls).toBe(1);
            expect(Object.values(owner).every((mock) => mock.mock.calls.length === 0)).toBe(true);
            expect(await lease.whenClosed).toBe('poisoned');
        } finally {
            clearTimeout(timer);
            gate.resolve(Uint8Array.of(8));
            await pending;
            await turn();
            lease.release();
        }
    });

    it.each(['timeout', 'abort'] as const)('revokes a late builder after %s', async (mode) => {
        const entered = deferred<void>();
        const gate = deferred<Uint8Array>();
        const options = config();
        let callbackBody!: Uint8Array;

        options.buildReserved = ({ body }) => {
            callbackBody = body;
            entered.resolve();
            return gate.promise;
        };

        const abort = new AbortController();
        options.signal = abort.signal;
        options.timeoutMs = mode === 'timeout' ? 30 : 1000;
        let late!: Promise<unknown>;
        const peer: Sso12RawTransport = {
            async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                late = Promise.resolve(o.buildRequest({ uin: '0', sequence })).catch(
                    () => undefined,
                );
                await entered.promise;

                if (mode === 'abort') {
                    abort.abort();
                } else {
                    await new Promise<void>((resolve) => setTimeout(resolve, 50));
                }

                return { kind: 'failure', code: mode, writeState: 'not-written' };
            },
        };
        expect(await referenceHeartbeatOnTransport(peer, options)).toMatchObject({
            kind: 'failure',
        });
        expect(callbackBody.every((value) => value === 0)).toBe(true);
        gate.resolve(Uint8Array.of(8));
        await late;
        await turn();
        expect(callbackBody.every((value) => value === 0)).toBe(true);
    });
});
