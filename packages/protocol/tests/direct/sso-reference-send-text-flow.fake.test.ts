import type {
    DirectSendMessageRequest,
    DirectSendMessageResponse,
} from '@snowluma/proto-defs/direct-send-message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { createRawMultiplexClient } from '../../src/direct/raw-multiplex-client';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    referenceSendTextOnTransport,
    type SsoReferenceSendTextOptions,
} from '../../src/direct/sso-reference-send-text-flow';
import type { Sso12RawOptions, Sso12RawTransport } from '../../src/direct/sso12-packet-client';

// These are in-memory fixtures only. The callbacks are local policies, not signatures,
// authentication, proof of server receipt, or proof of business delivery.
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const outerSequence = 0xf0000001;
const innerSequence = 9007199254740993n;
const command = 'MessageSvc.PbSendMsg';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function word(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
}

const field = (value: Uint8Array) => Buffer.concat([word(value.length + 4), value]);

// Response construction is intentionally separate from request production and the
// production decoders. It creates synthetic encrypted service/SSO candidates only.
function syntheticResponse(
    options: {
        sequence?: number;
        uin?: string;
        command?: string;
        retCode?: number;
        body?: Uint8Array;
    } = {},
): Uint8Array {
    const header = Buffer.concat([
        word(options.sequence ?? outerSequence),
        word(options.retCode ?? 0),
        field(Buffer.alloc(0)),
        field(Buffer.from(options.command ?? command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(options.body ?? new Uint8Array())]);
    const cipher = qqTeaEncrypt(inner, key);
    const uin = Buffer.from(options.uin ?? '123');
    return Buffer.concat([
        word(14 + uin.length + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(uin),
        cipher,
    ]);
}

function inspectWritten(frame: Uint8Array) {
    const wire = Buffer.from(frame);
    const ticketEnd = 9 + wire.readUInt32BE(9);
    const accountStart = ticketEnd + 1;
    const accountEnd = accountStart + wire.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(accountEnd), key));
    const headerEnd = inner.readUInt32BE(0);
    let position = 28;

    const readField = () => {
        const end = position + inner.readUInt32BE(position);
        const value = inner.subarray(position + 4, end);
        position = end;
        return value;
    };

    readField(); // A2
    const commandBytes = readField();
    readField(); // empty
    readField(); // GUID
    readField(); // empty
    position += inner.readUInt16BE(position);
    const reserved = readField();
    return {
        uin: wire.subarray(accountStart + 4, accountEnd).toString(),
        sequence: inner.readUInt32BE(4),
        command: commandBytes.toString(),
        reserved: Uint8Array.from(reserved),
        body: Uint8Array.from(inner.subarray(headerEnd + 4)),
        bodyLength: inner.readUInt32BE(headerEnd),
    };
}

function config(kind: 'private' | 'group' = 'private'): SsoReferenceSendTextOptions {
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
        request: {
            route:
                kind === 'private'
                    ? { kind: 'private', peerUin: 456n, peerUid: 'fixture-peer' }
                    : { kind: 'group', groupUin: 789n },
            text: 'synthetic text 中🙂',
            clientSequence: innerSequence,
            random: 0x12345678,
        },
        maxResponseBodyBytes: 65536,
        timeoutMs: 1000,
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

type Interference = 'none' | 'swap' | 'identity';

function fixture(
    settings: {
        interference?: Interference;
        transportUin?: string;
        write?: (frame: Uint8Array) => void | Promise<void>;
    } = {},
) {
    const writes: Uint8Array[] = [];
    const wrote = deferred<void>();
    const observations: Array<{
        phase: string;
        ref: Uint8Array;
        snapshot: Uint8Array;
        identity: { uin: string; sequence: number };
    }> = [];
    const client = createRawMultiplexClient({
        uin: settings.transportUin ?? '123',
        initialSequence: outerSequence,
        defaultTimeoutMs: 1000,
        maxFrameBytes: 131072,
        maxBufferedBytes: 262144,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 262144,
        write: (frame) => {
            writes.push(Uint8Array.from(frame));
            wrote.resolve();
            return settings.write?.(frame);
        },
        // This is explicit fixture routing, independent of the ciphertext contents.
        // Production must still check the decrypted account, command and sequence.
        classify: () => ({ kind: 'response', sequence: outerSequence }),
        verifyPush: () => false,
        onPush: () => {
            throw new Error('unexpected synthetic push');
        },
    });
    const owner = { close: vi.fn(), release: vi.fn(), poison: vi.fn() };
    let calls = 0;
    const transport: Sso12RawTransport = {
        ...owner,
        transactRaw<C, T>(raw: Sso12RawOptions<C, T>) {
            calls++;
            return client.transactRaw({
                ...raw,
                verifyCandidate: (bytes, context, identity) => {
                    observations.push({
                        phase: 'verify',
                        ref: bytes,
                        snapshot: Uint8Array.from(bytes),
                        identity: { ...identity },
                    });
                    return raw.verifyCandidate(bytes, context, identity);
                },
                consumeCandidate: (bytes, context, identity) => {
                    observations.push({
                        phase: 'consume',
                        ref: bytes,
                        snapshot: Uint8Array.from(bytes),
                        identity: { ...identity },
                    });
                    const altered =
                        settings.interference === 'swap' ? Uint8Array.from(bytes) : bytes;

                    if (settings.interference === 'swap') {
                        altered[altered.length - 1] ^= 1;
                    }

                    const id =
                        settings.interference === 'identity'
                            ? { ...identity, sequence: (identity.sequence + 1) >>> 0 }
                            : identity;
                    return raw.consumeCandidate(altered, context, id);
                },
            });
        },
    };
    return {
        client,
        transport,
        owner,
        writes,
        wrote,
        observations,
        get calls() {
            return calls;
        },
    };
}

async function exchange(
    options: SsoReferenceSendTextOptions,
    candidate: Uint8Array,
    settings: Parameters<typeof fixture>[0] = {},
) {
    const f = fixture(settings);

    try {
        const pending = referenceSendTextOnTransport(f.transport, options);
        await f.wrote.promise;
        // Fragmentation exercises real in-memory framing; no socket is created.
        f.client.feed(candidate.subarray(0, 3));
        f.client.feed(candidate.subarray(3));
        const result = await pending;
        return { ...f, calls: f.calls, result };
    } finally {
        f.client.close();
    }
}

const absence = {
    result: null,
    errMsg: null,
    sendTime: null,
    msgInfoFlag: null,
    sequence: null,
    clientSequence: null,
    presence: {
        result: false,
        errMsg: false,
        sendTime: false,
        msgInfoFlag: false,
        sequence: false,
        clientSequence: false,
    },
    selectedSequence: 0n,
};

describe('synthetic reference send-text over in-memory multiplex transport', () => {
    it.each(['private', 'group'] as const)(
        'binds %s inner bytes to signer inputs and a separate outer sequence',
        async (kind) => {
            const options = config(kind);
            let signerCopy!: Uint8Array;
            let signerSnapshot!: Uint8Array;
            let verifyRequest!: Uint8Array;
            let verifyResponse!: Uint8Array;
            const sign = vi.fn(
                ({
                    uin,
                    uid,
                    sequence,
                    command: actualCommand,
                    body,
                }: Parameters<SsoReferenceSendTextOptions['buildReserved']>[0]) => {
                    expect({ uin, uid, sequence, command: actualCommand }).toEqual({
                        uin: '123',
                        uid: 'fixture-uid',
                        sequence: outerSequence,
                        command,
                    });
                    signerCopy = body;
                    signerSnapshot = Uint8Array.from(body);
                    return Uint8Array.of(8);
                },
            );
            options.buildReserved = sign;
            options.verifyRaw = vi.fn(
                ({ uin, sequence, command: actualCommand, requestFrame, responseFrame }) => {
                    expect({ uin, sequence, command: actualCommand }).toEqual({
                        uin: '123',
                        sequence: outerSequence,
                        command,
                    });
                    verifyRequest = requestFrame;
                    verifyResponse = responseFrame;
                    requestFrame.fill(0x55);
                    responseFrame.fill(0x66);
                    return true;
                },
            );
            const body = protobuf_encode<DirectSendMessageResponse>({
                result: 0,
                sequence: 99n,
                clientSequence: 88n,
            });
            const candidate = syntheticResponse({ body });
            const candidateBefore = Uint8Array.from(candidate);
            const f = await exchange(options, candidate);
            expect(f.result).toMatchObject({
                kind: 'response',
                sequence: outerSequence,
                writeState: 'written',
                value: {
                    status: 'response',
                    response: {
                        result: 0,
                        sequence: 99n,
                        clientSequence: 88n,
                        selectedSequence: 88n,
                        presence: { result: true, sequence: true, clientSequence: true },
                    },
                },
            });
            const written = inspectWritten(f.writes[0]);
            expect(written).toMatchObject({
                uin: '123',
                sequence: outerSequence,
                command,
                reserved: Uint8Array.of(8),
            });
            expect(written.bodyLength).toBe(written.body.length + 4);
            expect(written.body).toEqual(signerSnapshot);
            const decoded = protobuf_decode<DirectSendMessageRequest>(written.body);
            expect(decoded.clientSequence).toBe(innerSequence);
            expect(decoded.clientSequence).not.toBe(BigInt(written.sequence));
            expect(decoded.random).toBe(options.request.random);
            expect(decoded.messageBody.richText.elems[0].text.text).toBe(options.request.text);

            if (kind === 'private') {
                expect(decoded.routingHead.c2c).toEqual({ peerUin: 456n, peerUid: 'fixture-peer' });
                expect(decoded.routingHead.group).toBeNull();
            } else {
                expect(decoded.routingHead.group).toEqual({ groupUin: 789n });
                expect(decoded.routingHead.c2c).toBeNull();
            }

            expect(f.observations.map((o) => o.phase)).toEqual(['verify', 'consume']);
            expect(f.observations[0].identity).toEqual({ uin: '123', sequence: outerSequence });
            expect(f.observations[1].identity).toEqual(f.observations[0].identity);
            expect(f.observations[0].ref).not.toBe(f.observations[1].ref);
            expect(f.observations[0].snapshot).toEqual(candidateBefore);
            expect(f.observations[1].snapshot).toEqual(candidateBefore);
            expect(Uint8Array.from(candidate)).toEqual(candidateBefore);
            expect(signerCopy.every((b) => b === 0)).toBe(true);
            expect(verifyRequest.every((b) => b === 0)).toBe(true);
            expect(verifyResponse.every((b) => b === 0)).toBe(true);
            expect(f.observations.every((o) => o.ref.every((b) => b === 0))).toBe(true);
            expect(sign).toHaveBeenCalledOnce();
            expect(options.verifyRaw).toHaveBeenCalledOnce();
            expect(f.calls).toBe(1);
            expect(f.writes).toHaveLength(1);
            expect(Object.values(f.owner).every((fn) => fn.mock.calls.length === 0)).toBe(true);
        },
    );

    it('returns an SSO error without parsing malformed business bytes', async () => {
        const f = await exchange(
            config(),
            syntheticResponse({ retCode: -42, body: Uint8Array.of(0x08, 0x80) }),
        );
        expect(f.result).toEqual({
            kind: 'response',
            sequence: outerSequence,
            writeState: 'written',
            value: { status: 'sso-error', retCode: -42 },
        });
        expect(f.calls).toBe(1);
        expect(f.writes).toHaveLength(1);
    });

    it.each([
        ['absent', new Uint8Array(), absence],
        [
            'zero and zero fallback',
            Uint8Array.of(0x08, 0, 0x58, 7, 0x70, 0),
            {
                ...absence,
                result: 0,
                sequence: 7n,
                clientSequence: 0n,
                presence: {
                    ...absence.presence,
                    result: true,
                    sequence: true,
                    clientSequence: true,
                },
                selectedSequence: 7n,
            },
        ],
        [
            'nonzero with untrusted error',
            protobuf_encode<DirectSendMessageResponse>({
                result: -42,
                errMsg: 'synthetic error 明文',
                sequence: 300n,
                clientSequence: 4n,
            }),
            {
                ...absence,
                result: -42,
                errMsg: 'synthetic error 明文',
                sequence: 300n,
                clientSequence: 4n,
                presence: {
                    ...absence.presence,
                    result: true,
                    errMsg: true,
                    sequence: true,
                    clientSequence: true,
                },
                selectedSequence: 4n,
            },
        ],
        [
            'sequence only',
            protobuf_encode<DirectSendMessageResponse>({ sequence: 4294967296n }),
            {
                ...absence,
                sequence: 4294967296n,
                presence: { ...absence.presence, sequence: true },
                selectedSequence: 4294967296n,
            },
        ],
    ] as const)('preserves business projection %s', async (_label, body, response) => {
        const f = await exchange(config(), syntheticResponse({ body }));
        expect(f.result).toEqual({
            kind: 'response',
            sequence: outerSequence,
            writeState: 'written',
            value: { status: 'response', response },
        });
        expect(f.calls).toBe(1);
        expect(f.writes).toHaveLength(1);
    });

    it.each([
        ['truncated protobuf', syntheticResponse({ body: Uint8Array.of(0x08, 0x80) })],
        ['wrong account', syntheticResponse({ uin: '456' })],
        ['wrong command', syntheticResponse({ command: 'synthetic.wrong' })],
        ['wrong outer sequence', syntheticResponse({ sequence: 9 })],
    ] as const)('does not return a response for %s', async (_label, candidate) => {
        const f = await exchange(config(), candidate, {});
        expect(f.result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        expect(f.calls).toBe(1);
        expect(f.writes).toHaveLength(1);
    });

    it('rejects a truncated service frame when the synthetic input ends', async () => {
        const f = fixture();

        try {
            const pending = referenceSendTextOnTransport(f.transport, config());
            await f.wrote.promise;
            const candidate = syntheticResponse();
            f.client.feed(candidate.subarray(0, candidate.length - 1));
            f.client.end();
            expect(await pending).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(f.calls).toBe(1);
            expect(f.writes).toHaveLength(1);
        } finally {
            f.client.close();
        }
    });

    it('enforces configured response body limits at exact and oversized boundaries', async () => {
        const body = Uint8Array.of(0x08, 0x00);
        const exact = config();
        exact.maxResponseBodyBytes = body.length;
        const accepted = await exchange(exact, syntheticResponse({ body }));
        expect(accepted.result).toMatchObject({
            kind: 'response',
            value: { status: 'response', response: { result: 0, presence: { result: true } } },
        });
        const short = config();
        short.maxResponseBodyBytes = body.length - 1;
        const rejected = await exchange(short, syntheticResponse({ body }));
        expect(rejected.result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        expect(rejected.writes).toHaveLength(1);
    });

    it.each(['swap', 'identity'] as const)(
        'guard rejects %s between verify and consume',
        async (interference) => {
            const f = await exchange(
                config(),
                syntheticResponse({ body: Uint8Array.of(0x08, 0) }),
                { interference },
            );
            expect(f.result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(f.observations.map((o) => o.phase)).toEqual(['verify', 'consume']);
            expect(f.calls).toBe(1);
            expect(f.writes).toHaveLength(1);
        },
    );

    it.each(['false', 'throw'] as const)(
        'fails local verifier %s once without retry',
        async (mode) => {
            const options = config();
            options.verifyRaw = vi.fn(() => {
                if (mode === 'throw') {
                    throw new Error('synthetic local policy');
                }

                return false;
            });
            const f = await exchange(options, syntheticResponse());
            expect(f.result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(options.verifyRaw).toHaveBeenCalledOnce();
            expect(f.observations.map((o) => o.phase)).toEqual(['verify']);
            expect(f.calls).toBe(1);
            expect(f.writes).toHaveLength(1);
        },
    );

    it('keeps untrusted business error text in the result without logging it', async () => {
        const spies = [
            vi.spyOn(console, 'log'),
            vi.spyOn(console, 'warn'),
            vi.spyOn(console, 'error'),
        ];

        try {
            const text = 'synthetic untrusted error';
            const body = protobuf_encode<DirectSendMessageResponse>({ result: 9, errMsg: text });
            const f = await exchange(config(), syntheticResponse({ body }));
            expect(f.result).toMatchObject({
                kind: 'response',
                value: { status: 'response', response: { result: 9, errMsg: text } },
            });

            for (const spy of spies) {
                expect(spy).not.toHaveBeenCalled();
            }
        } finally {
            spies.forEach((spy) => spy.mockRestore());
        }
    });

    it('wipes the signer callback copy after cancellation while signing is pending', async () => {
        const entered = deferred<void>();
        const release = deferred<Uint8Array>();
        const abort = new AbortController();
        const options = config();
        options.signal = abort.signal;
        let borrowed!: Uint8Array;
        options.buildReserved = vi.fn(({ body }) => {
            borrowed = body;
            entered.resolve();
            return release.promise;
        });
        const f = fixture();

        try {
            const pending = referenceSendTextOnTransport(f.transport, options);
            await entered.promise;
            abort.abort();
            const result = await pending;
            expect(result).toMatchObject({ kind: 'failure' });
            expect(f.writes).toHaveLength(0);
            expect(f.calls).toBe(1);
            expect(borrowed.every((b) => b === 0)).toBe(true);
            release.resolve(Uint8Array.of(8));
            await new Promise<void>((done) => setImmediate(done));
            expect(borrowed.every((b) => b === 0)).toBe(true);
            expect(f.writes).toHaveLength(0);
            expect(options.buildReserved).toHaveBeenCalledOnce();
        } finally {
            release.resolve(Uint8Array.of(8));
            f.client.close();
        }
    });

    it('times out a pending signer without a late fake mux write', async () => {
        const entered = deferred<void>();
        const signerGate = deferred<Uint8Array>();
        const builderSettled = deferred<'fulfilled' | 'rejected'>();
        const options = config();
        options.timeoutMs = 250;
        const tickets = options.login.tickets;
        const original = [tickets.d2, tickets.d2Key, tickets.a1, tickets.a2, options.profile.guid];
        const snapshots = original.map((bytes) => Uint8Array.from(bytes));
        let signerBody!: Uint8Array;
        options.buildReserved = vi.fn(({ body }) => {
            signerBody = body;
            entered.resolve();
            return signerGate.promise;
        });
        options.verifyRaw = vi.fn(options.verifyRaw);
        const f = fixture();
        let builder: Promise<unknown> | undefined;
        const transport: Sso12RawTransport = {
            transactRaw<C, T>(raw: Sso12RawOptions<C, T>) {
                return f.transport.transactRaw({
                    ...raw,
                    buildRequest: (identity) => {
                        const operation = Promise.resolve()
                            .then(() => raw.buildRequest(identity))
                            .then(
                                (value) => {
                                    builderSettled.resolve('fulfilled');
                                    return value;
                                },
                                (error: unknown) => {
                                    builderSettled.resolve('rejected');
                                    throw error;
                                },
                            );
                        builder = operation;
                        void operation.then(
                            () => {},
                            () => {},
                        );
                        return operation;
                    },
                });
            },
        };
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        const bounded = <T>(promise: Promise<T>): Promise<T> =>
            Promise.race([
                promise,
                new Promise<T>((_resolve, reject) => {
                    timers.push(setTimeout(() => reject(new Error('fixture watchdog')), 3000));
                }),
            ]);
        let pending: ReturnType<typeof referenceSendTextOnTransport> | undefined;
        let failed = false;
        let failure: unknown;

        try {
            pending = referenceSendTextOnTransport(transport, options);
            void pending.then(
                () => {},
                () => {},
            );
            await bounded(entered.promise);
            expect(await bounded(pending)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'not-written',
            });
            expect(await bounded(f.client.whenClosed)).toEqual({
                kind: 'local',
                code: 'raw-timeout',
            });
            expect(signerBody.length).toBeGreaterThan(0);
            expect(signerBody.every((byte) => byte === 0)).toBe(true);
            original.forEach((bytes, index) => expect(bytes).toEqual(snapshots[index]));
            expect(f.writes).toHaveLength(0);
            expect(options.verifyRaw).not.toHaveBeenCalled();
            expect(Object.values(f.owner).every((fn) => fn.mock.calls.length === 0)).toBe(true);
            signerGate.resolve(Uint8Array.of(8));
            expect(await bounded(builderSettled.promise)).toBe('rejected');
            await new Promise<void>((done) => setImmediate(done));
            expect(f.writes).toHaveLength(0);
            expect(options.verifyRaw).not.toHaveBeenCalled();
            original.forEach((bytes, index) => expect(bytes).toEqual(snapshots[index]));
        } catch (error) {
            failed = true;
            failure = error;
        } finally {
            signerGate.resolve(Uint8Array.of(8));
            f.client.close();
            const work: Promise<unknown>[] = [];

            if (pending) {
                work.push(pending);
            }

            if (builder) {
                work.push(builder, builderSettled.promise);
            }

            try {
                await bounded(Promise.allSettled(work));
            } catch (error) {
                if (!failed) {
                    failed = true;
                    failure = error;
                } else {
                    console.error('fixture cleanup failed after test failure', error);
                }
            } finally {
                timers.forEach(clearTimeout);
            }
        }

        if (failed) {
            throw failure;
        }
    }, 10000);

    it('waits for a noncooperative borrowed owner after cancellation and deadline', async () => {
        const entered = deferred<void>();
        const signerGate = deferred<Uint8Array>();
        const ownerGate = deferred<void>();
        const builderSettled = deferred<'fulfilled' | 'rejected'>();
        const abort = new AbortController();
        const options = config();
        options.timeoutMs = 80;
        options.signal = abort.signal;
        const tickets = options.login.tickets;
        const original = [tickets.d2, tickets.d2Key, tickets.a1, tickets.a2, options.profile.guid];
        const snapshots = original.map((bytes) => Uint8Array.from(bytes));
        let signerBody!: Uint8Array;
        let observedSignal: AbortSignal | undefined;
        let observedTimeout: number | undefined;
        const write = vi.fn();
        options.verifyRaw = vi.fn(options.verifyRaw);
        options.buildReserved = vi.fn(({ body }) => {
            signerBody = body;
            entered.resolve();
            return signerGate.promise;
        });
        let builder: Promise<unknown> | undefined;
        const transport: Sso12RawTransport = {
            transactRaw<C, T>(raw: Sso12RawOptions<C, T>) {
                observedSignal = raw.signal;
                observedTimeout = raw.timeoutMs;
                const operation = Promise.resolve()
                    .then(() => raw.buildRequest({ uin: '123', sequence: outerSequence }))
                    .then(
                        () => {
                            write();
                            builderSettled.resolve('fulfilled');
                        },
                        (error: unknown) => {
                            builderSettled.resolve('rejected');
                            throw error;
                        },
                    );
                builder = operation;
                void operation.then(
                    () => {},
                    () => {},
                );
                return ownerGate.promise.then(() => ({
                    kind: 'failure' as const,
                    code: 'fake-owner-release',
                    writeState: 'unknown' as const,
                }));
            },
        };
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        const bounded = <T>(promise: Promise<T>): Promise<T> =>
            Promise.race([
                promise,
                new Promise<T>((_resolve, reject) => {
                    timers.push(setTimeout(() => reject(new Error('fixture watchdog')), 3000));
                }),
            ]);
        let settled = false;
        let failed = false;
        let failure: unknown;
        let pending: ReturnType<typeof referenceSendTextOnTransport> | undefined;

        try {
            pending = referenceSendTextOnTransport(transport, options);
            void pending.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            await bounded(entered.promise);
            expect(observedTimeout).toBeGreaterThan(0);
            expect(observedTimeout).toBeLessThanOrEqual(options.timeoutMs);
            abort.abort();
            await bounded(
                new Promise<void>((resolve) => {
                    timers.push(setTimeout(resolve, 160));
                }),
            );
            expect(settled).toBe(false);
            expect(observedSignal?.aborted).toBe(true);
            ownerGate.resolve();
            expect(await bounded(pending)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(signerBody.length).toBeGreaterThan(0);
            expect(signerBody.every((byte) => byte === 0)).toBe(true);
            signerGate.resolve(Uint8Array.of(8));
            expect(await bounded(builderSettled.promise)).toBe('rejected');
            expect(write).not.toHaveBeenCalled();
            expect(options.verifyRaw).not.toHaveBeenCalled();
            original.forEach((bytes, index) => expect(bytes).toEqual(snapshots[index]));
        } catch (error) {
            failed = true;
            failure = error;
        } finally {
            ownerGate.resolve();
            signerGate.resolve(Uint8Array.of(8));
            const work: Promise<unknown>[] = [];

            if (pending) {
                work.push(pending);
            }

            if (builder) {
                work.push(builder, builderSettled.promise);
            }

            try {
                await bounded(Promise.allSettled(work));
            } catch (error) {
                if (!failed) {
                    failed = true;
                    failure = error;
                } else {
                    console.error('fixture cleanup failed after test failure', error);
                }
            } finally {
                timers.forEach(clearTimeout);
            }
        }

        if (failed) {
            throw failure;
        }
    }, 10000);

    it('preserves unknown write state after a fake write failure without retry', async () => {
        const f = fixture({
            write: () => {
                throw new Error('synthetic write failed');
            },
        });

        try {
            const result = await referenceSendTextOnTransport(f.transport, config());
            expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(f.calls).toBe(1);
            expect(f.writes).toHaveLength(1);
        } finally {
            f.client.close();
        }
    });

    it('reads the transport getter once before snapshot and preserves its receiver', async () => {
        const f = fixture();
        const options = config();
        options.buildReserved = vi.fn(options.buildReserved);
        options.verifyRaw = vi.fn(options.verifyRaw);
        let reads = 0;
        let receiver: Sso12RawTransport | undefined;
        const transport: Sso12RawTransport = {
            get transactRaw() {
                reads++;
                Object.defineProperty(options.login, 'uin', {
                    value: '456',
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });

                return function <C, T>(this: Sso12RawTransport, raw: Sso12RawOptions<C, T>) {
                    receiver = this;
                    return f.transport.transactRaw(raw);
                };
            },
        };

        try {
            expect(await referenceSendTextOnTransport(transport, options)).toMatchObject({
                kind: 'failure',
            });
            expect(reads).toBe(1);
            expect(receiver).toBe(transport);
            expect(options.login.uin).toBe('456');
            expect(f.calls).toBe(1);
            expect(options.buildReserved).not.toHaveBeenCalled();
            expect(options.verifyRaw).not.toHaveBeenCalled();
            expect(f.writes).toHaveLength(0);
        } finally {
            f.client.close();
        }
    });

    it('rejects a second concurrent request as not-written and does not retry it', async () => {
        const f = fixture();

        try {
            const first = referenceSendTextOnTransport(f.transport, config());
            await f.wrote.promise;
            const second = await referenceSendTextOnTransport(f.transport, config('group'));
            expect(second).toMatchObject({ kind: 'failure', writeState: 'not-written' });
            expect(f.writes).toHaveLength(1);
            f.client.feed(syntheticResponse());
            expect(await first).toMatchObject({ kind: 'response', writeState: 'written' });
            expect(f.calls).toBe(2);
        } finally {
            f.client.close();
        }
    });

    it.each(['abort', 'timeout'] as const)(
        'reports uncertain write after %s with no retry',
        async (mode) => {
            const f = fixture();
            const abort = new AbortController();
            const options = config();
            options.signal = abort.signal;
            options.timeoutMs = mode === 'timeout' ? 80 : 1000;

            try {
                const pending = referenceSendTextOnTransport(f.transport, options);
                await f.wrote.promise;

                if (mode === 'abort') {
                    abort.abort();
                }

                expect(await pending).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(f.calls).toBe(1);
                expect(f.writes).toHaveLength(1);
            } finally {
                f.client.close();
            }
        },
    );

    it.each(['0', '456', '0123'])(
        'fails transport account %s before invoking the signer or writing',
        async (transportUin) => {
            const f = fixture({ transportUin });
            const options = config();
            options.buildReserved = vi.fn(options.buildReserved);
            options.verifyRaw = vi.fn(options.verifyRaw);

            try {
                expect(await referenceSendTextOnTransport(f.transport, options)).toMatchObject({
                    kind: 'failure',
                });
                expect(options.buildReserved).not.toHaveBeenCalled();
                expect(options.verifyRaw).not.toHaveBeenCalled();
                expect(f.writes).toHaveLength(0);
                expect(f.calls).toBe(1);
            } finally {
                f.client.close();
            }
        },
    );

    it('does not enter transport for a pre-aborted request', async () => {
        const f = fixture();
        const abort = new AbortController();
        abort.abort();

        try {
            expect(
                await referenceSendTextOnTransport(f.transport, {
                    ...config(),
                    signal: abort.signal,
                }),
            ).toMatchObject({ kind: 'failure', writeState: 'not-written' });
            expect(f.calls).toBe(0);
            expect(f.writes).toHaveLength(0);
        } finally {
            f.client.close();
        }
    });
});
