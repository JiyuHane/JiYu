import { afterEach, describe, expect, it, vi } from 'vitest';
import * as privateSession from '../../src/direct/wt-reference-session-private';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    createSsoReferenceExchange,
    type SsoReferenceExchangeOptions,
    type SsoReferenceExchangeRecord,
    type SsoReferenceExchangeSpec,
} from '../../src/direct/sso-reference-exchange-internal';
import { referenceSendTextOnTransport } from '../../src/direct/sso-reference-send-text-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Trusted synthetic codec specs exercise the real common guard/SSO/TEA implementation.
// This fixture does not implement a friend schema, establish a socket or access QQ.
const command = 'fixture.FixedStep';
const sequence = 0x80000007;
const key = new Uint8Array(16).fill(0x31);
type Request = { value: number };
type Projection = { value: number };

const word = (n: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n >>> 0);
    return bytes;
};

const field = (value: Uint8Array) => Buffer.concat([word(value.length + 4), value]);

function response(body = Uint8Array.of(0x52), name = command, retCode = 0) {
    const header = Buffer.concat([
        word(sequence),
        word(retCode),
        field(Buffer.alloc(0)),
        field(Buffer.from(name)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const plain = Buffer.concat([field(header), field(body)]);
    const cipher = qqTeaEncrypt(plain, key);
    plain.fill(0);
    return Buffer.concat([
        word(17 + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from('123')),
        cipher,
    ]);
}

function inspectWritten(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    const accountStart = 10 + frame.readUInt32BE(9);
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const plain = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), key));

    try {
        const commandStart = 28 + plain.readUInt32BE(28);
        return {
            command: plain
                .subarray(commandStart + 4, commandStart + plain.readUInt32BE(commandStart))
                .toString(),
            sequence: plain.readUInt32BE(4),
            body: Uint8Array.from(plain.subarray(plain.readUInt32BE(0) + 4)),
        };
    } finally {
        plain.fill(0);
    }
}

function options(): SsoReferenceExchangeOptions<Request> {
    return {
        login: {
            status: 'tickets',
            uin: '123',
            tickets: {
                d2: Uint8Array.of(3),
                d2Key: key.slice(),
                a1: Uint8Array.of(4),
                a2: Uint8Array.of(5),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(1, 2), version: 'fixture' },
        uid: 'synthetic-uid',
        request: { value: 0x41 },
        maxResponseBodyBytes: 1024,
        timeoutMs: 1000,
        buildReserved: () => Uint8Array.of(7),
        verifyRaw: () => true,
    };
}

function spec() {
    return {
        name: 'fixture-exchange',
        command,
        snapshotRequest(input: unknown, record: SsoReferenceExchangeRecord): Request {
            const snapshot = record(input, ['value']);

            if (
                typeof snapshot.value !== 'number' ||
                !Number.isInteger(snapshot.value) ||
                snapshot.value < 0 ||
                snapshot.value > 255
            ) {
                throw new TypeError('invalid fixture value');
            }

            return { value: snapshot.value };
        },
        encodeRequest: (request) => Uint8Array.of(request.value),
        decodeResponse: (body) => ({ value: body[0] ?? 0 }),
    } satisfies SsoReferenceExchangeSpec<Request, Projection>;
}

function fixture(candidate = response()) {
    const writes: Uint8Array[] = [];
    const borrowedFrames: Uint8Array[] = [];
    const identity = { uin: '123', sequence };
    let calls = 0;
    const transport: Sso12RawTransport = {
        async transactRaw<C, T>(input: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            calls++;
            const built = await input.buildRequest(identity);
            borrowedFrames.push(built.frame);
            writes.push(Uint8Array.from(built.frame));

            if (!(await input.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'fixture-verifier', writeState: 'unknown' };
            }

            const value = await input.consumeCandidate(candidate, built.context, identity);
            return { kind: 'response', sequence, value, writeState: 'written' };
        },
    };
    return {
        transport,
        writes,
        borrowedFrames,
        get calls() {
            return calls;
        },
    };
}

function expectWiped(buffers: Uint8Array[]): void {
    for (const buffer of buffers) {
        expect(buffer).toEqual(new Uint8Array(buffer.length));
    }
}

type OwnedProjection = { sig: Uint8Array; verify: Uint8Array };
const failed = {
    kind: 'failure',
    code: 'borrowed-transaction-failed',
    writeState: 'unknown',
} as const;
const identity = { uin: '123', sequence };

function ownedCodec() {
    const transient: Uint8Array[] = [];
    const projections: OwnedProjection[] = [];
    const decodeResponse = vi.fn((body: Uint8Array): OwnedProjection => {
        transient.push(body);
        const projection = { sig: Uint8Array.from(body), verify: Uint8Array.of(0x63, 0x64) };
        projections.push(projection);
        return projection;
    });
    const disposeResponse = vi.fn((projection: OwnedProjection) => {
        projection.sig.fill(0);
        projection.verify.fill(0);
    });
    const policy = {
        ...spec(),
        encodeRequest: (request: Request) => {
            const bytes = Uint8Array.of(request.value);
            transient.push(bytes);
            return bytes;
        },
        decodeResponse,
        disposeResponse,
    };
    return { policy, transient, projections, decodeResponse, disposeResponse };
}

// Erase only the transport's opaque generic tokens; the real guard still binds
// every build/verify/consume callback and validates the script's final result.
function scriptedTransport(
    run: (raw: Sso12RawOptions<unknown, unknown>) => Promise<Sso12RawResult<unknown>>,
): Sso12RawTransport {
    return {
        transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            return run(raw as Sso12RawOptions<unknown, unknown>) as Promise<Sso12RawResult<T>>;
        },
    };
}

async function prepare(raw: Sso12RawOptions<unknown, unknown>) {
    const built = await raw.buildRequest(identity);
    const candidate = response();
    expect(await raw.verifyCandidate(candidate, built.context, identity)).toBe(true);
    return { built, candidate };
}

function capability(lease: Sso12RawTransport) {
    // These deep-internal fixture registrations exercise the real private slot;
    // they do not create a login attempt, account session or network connection.
    const attempt = { state: 'new', busy: false };
    const token = privateSession.createReferenceKeyCapability();
    const reservation = privateSession.reserveReferenceKeyCapability(token);
    privateSession.registerReferenceBorrowedAttempt(attempt, lease);
    privateSession.bindReferenceKeyAttemptOwnerLease(token, attempt, reservation, lease);
    privateSession.stageReferenceConfirmed(token, attempt, '123', '123', sequence);
    privateSession.stageReferenceKey(token, attempt, '123', '123', sequence, key);
    privateSession.commitReferenceKey(token);
    return { token, attempt, lease, run: {} };
}

function expectReleased(binding: ReturnType<typeof capability>): void {
    expect(() =>
        privateSession.beginReferenceSend(
            binding.token,
            binding.attempt,
            binding.lease,
            binding.run,
        ),
    ).toThrow('invalid reference send binding');
    const next = {};
    privateSession.beginReferenceSend(binding.token, binding.attempt, binding.lease, next);
    privateSession.endReferenceSend(binding.token, binding.attempt, binding.lease, next);
}

function expectDisposed(codec: ReturnType<typeof ownedCodec>): void {
    expect(codec.decodeResponse).toHaveBeenCalledOnce();
    expect(codec.disposeResponse).toHaveBeenCalledExactlyOnceWith(codec.projections[0]);
    expectWiped([...codec.transient, ...codec.projections.flatMap((p) => [p.sig, p.verify])]);
}

afterEach(() => vi.restoreAllMocks());

describe('internal fixed-codec SSO exchange factoring', () => {
    it('captures the code-only spec once and binds its actual command to signing, wire and verification', async () => {
        const original = spec();
        const encoded: Uint8Array[] = [];
        const decoded: Uint8Array[] = [];
        const mutable = {
            ...original,
            encodeRequest: vi.fn((request: Request) => {
                const bytes = original.encodeRequest(request);
                encoded.push(bytes);
                return bytes;
            }),
            decodeResponse: vi.fn((body: Uint8Array) => {
                decoded.push(body);
                return original.decodeResponse(body);
            }),
        };
        const exchange = createSsoReferenceExchange(mutable);
        const replacement = vi.fn((_request: Request) => Uint8Array.of(0xff));
        mutable.command = 'fixture.Replaced';
        mutable.encodeRequest = replacement;
        const config = options();
        const borrowed: Uint8Array[] = [];
        const commands: string[] = [];

        config.buildReserved = (input) => {
            commands.push(input.command);
            borrowed.push(input.body);
            config.request.value = 0xfe;
            return Uint8Array.of(7);
        };

        config.verifyRaw = (input) => {
            commands.push(input.command);
            borrowed.push(input.requestFrame, input.responseFrame);
            return true;
        };

        const f = fixture();
        expect(await exchange(f.transport, config)).toEqual({
            kind: 'response',
            sequence,
            writeState: 'written',
            value: { status: 'response', response: { value: 0x52 } },
        });
        expect(commands).toEqual([command, command]);
        expect(inspectWritten(f.writes[0])).toEqual({
            command,
            sequence,
            body: Uint8Array.of(0x41),
        });
        expect(replacement).not.toHaveBeenCalled();
        expectWiped([...encoded, ...decoded, ...borrowed, ...f.borrowedFrames]);
        expect(config.login.tickets.d2Key).toEqual(key);
    });

    it.each(['command', 'spec', 'body', 'encodeRequest', 'decodeResponse', 'disposeResponse'])(
        'does not accept %s through operation options',
        async (field) => {
            const f = fixture();
            const exchange = createSsoReferenceExchange(spec());
            await expect(
                exchange(f.transport, { ...options(), [field]: 'injected' }),
            ).rejects.toThrow('invalid fixture-exchange configuration');
            expect(f.calls).toBe(0);
        },
    );

    it('keeps the public text options closed to a command override and its constructor guard intact', async () => {
        const f = fixture();
        const config = {
            ...options(),
            request: {
                route: { kind: 'group' as const, groupUin: 456n },
                text: 'fixture',
                clientSequence: 1n,
                random: 1,
            },
            command: 'fixture.Replaced',
        };
        await expect(referenceSendTextOnTransport(f.transport, config)).rejects.toThrow(
            'invalid send-text configuration',
        );
        expect(() =>
            Reflect.construct(referenceSendTextOnTransport, [f.transport, config]),
        ).toThrow('referenceSendTextOnTransport is not a constructor');
        expect(f.calls).toBe(0);
    });

    it.each(['command', 'body'] as const)(
        'retains signer %s mutation checks for the captured non-text command',
        async (field) => {
            const f = fixture();
            const config = options();
            const signerBuffers: Uint8Array[] = [];

            config.buildReserved = (input) => {
                signerBuffers.push(input.body);

                if (field === 'command') {
                    input.command = 'fixture.Replaced';
                } else {
                    input.body[0] ^= 1;
                }

                return Uint8Array.of(7);
            };

            expect((await createSsoReferenceExchange(spec())(f.transport, config)).kind).toBe(
                'failure',
            );
            expect(f.writes).toEqual([]);
            expectWiped(signerBuffers);
        },
    );

    it('transfers an independent successful projection while wiping transient response bytes', async () => {
        const borrowed: Uint8Array[] = [];
        const exchange = createSsoReferenceExchange({
            ...spec(),
            decodeResponse: (body: Uint8Array) => {
                borrowed.push(body);
                return { bytes: Uint8Array.from(body) };
            },
        });
        const f = fixture();
        const result = await exchange(f.transport, options());
        expect(result.kind).toBe('response');

        if (result.kind !== 'response' || result.value.status !== 'response') {
            throw new Error('unexpected fixture result');
        }

        expect(result.value.response.bytes).toEqual(Uint8Array.of(0x52));
        expectWiped(borrowed);
        result.value.response.bytes.fill(0);
    });

    it('keeps nonzero SSO handling ahead of body acceptance and business decoding', async () => {
        const decode = vi.fn(spec().decodeResponse);
        const exchange = createSsoReferenceExchange({ ...spec(), decodeResponse: decode });
        const f = fixture(response(Uint8Array.of(1, 2, 3), command, 9));
        const config = options();
        config.maxResponseBodyBytes = 0;
        expect(await exchange(f.transport, config)).toEqual({
            kind: 'response',
            sequence,
            writeState: 'written',
            value: { status: 'sso-error', retCode: 9 },
        });
        expect(decode).not.toHaveBeenCalled();
    });

    it('keeps transport getter evaluation before the public operation snapshot', async () => {
        const f = fixture();
        const config = options();
        let reads = 0;
        const transport: Sso12RawTransport = {
            get transactRaw() {
                reads++;
                config.request.value = 0x61;
                return f.transport.transactRaw;
            },
        };
        await createSsoReferenceExchange(spec())(transport, config);
        expect(reads).toBe(1);
        expect(inspectWritten(f.writes[0]).body).toEqual(Uint8Array.of(0x61));
    });
});

describe('internal exchange projection ownership', () => {
    it('transfers successful owned bytes only after buffer and capability cleanup', async () => {
        const codec = ownedCodec();
        const f = fixture();
        const binding = capability(f.transport);
        const end = privateSession.endReferenceSend;
        let atEnd: Uint8Array[] = [];
        let pendingSig: Uint8Array | undefined;
        const endSpy = vi
            .spyOn(privateSession, 'endReferenceSend')
            .mockImplementation((...args) => {
                atEnd = [...codec.transient, ...f.borrowedFrames].map((bytes) => bytes.slice());
                pendingSig = codec.projections[0].sig.slice();
                end(...args);
            });

        try {
            const result = await createSsoReferenceExchange(codec.policy)(
                undefined,
                options(),
                binding,
            );
            expect(result).toMatchObject({ kind: 'response', value: { status: 'response' } });

            if (result.kind !== 'response' || result.value.status !== 'response') {
                throw new Error('unexpected fixture result');
            }

            expect(result.value.response).toBe(codec.projections[0]);
            expect(result.value.response.sig).toEqual(Uint8Array.of(0x52));
            expect(result.value.response.verify).toEqual(Uint8Array.of(0x63, 0x64));
            expect(pendingSig).toEqual(Uint8Array.of(0x52));
            expect(atEnd.length).toBeGreaterThan(0);
            expectWiped(atEnd);
            expect(codec.disposeResponse).not.toHaveBeenCalled();
            endSpy.mockRestore();
            expectReleased(binding);
            result.value.response.sig.fill(0);
            result.value.response.verify.fill(0);
        } finally {
            privateSession.revokeReferenceKey(binding.token);
        }
    });

    it('captures the disposer once rather than reading mutable policy or operation options', async () => {
        const codec = ownedCodec();
        const original = codec.disposeResponse;
        const exchange = createSsoReferenceExchange(codec.policy);
        const replaced = vi.fn((_projection: OwnedProjection) => {});
        codec.policy.disposeResponse = replaced;
        const transport = scriptedTransport(async (raw) => {
            const { built, candidate } = await prepare(raw);
            await raw.consumeCandidate(candidate, built.context, identity);
            return failed;
        });
        expect(await exchange(transport, options())).toEqual(failed);
        expectDisposed(codec);
        expect(original).toHaveBeenCalledOnce();
        expect(replaced).not.toHaveBeenCalled();
    });

    it.each([
        'forged-value',
        'sequence',
        'write-state',
        'failure',
        'throw',
        'accessor',
        'proxy',
    ] as const)(
        'disposes exactly once after a decoded result is discarded for raw %s',
        async (mode) => {
            const codec = ownedCodec();
            let frame: Uint8Array | undefined;
            const transport = scriptedTransport(async (raw) => {
                const { built, candidate } = await prepare(raw);
                frame = built.frame;
                const value = await raw.consumeCandidate(candidate, built.context, identity);
                const result = {
                    kind: 'response',
                    sequence,
                    value,
                    writeState: 'written',
                } as const;

                if (mode === 'failure') {
                    return failed;
                }

                if (mode === 'throw') {
                    throw new Error('fixture raw failure');
                }

                if (mode === 'accessor') {
                    return Object.defineProperty(result, 'kind', { get: () => 'response' });
                }

                if (mode === 'proxy') {
                    return new Proxy(result, {});
                }

                return {
                    ...result,
                    value: mode === 'forged-value' ? {} : value,
                    sequence: mode === 'sequence' ? sequence + 1 : sequence,
                    writeState: mode === 'write-state' ? 'not-written' : 'written',
                } as Sso12RawResult<unknown>;
            });
            expect(await createSsoReferenceExchange(codec.policy)(transport, options())).toEqual(
                failed,
            );
            expectDisposed(codec);
            expect(frame).toBeDefined();
            expectWiped([frame!]);
        },
    );

    it.each(['abort', 'deadline'] as const)(
        'owns a projection returned after its decoder triggers %s',
        async (mode) => {
            const codec = ownedCodec();
            const decode = codec.decodeResponse.getMockImplementation()!;
            const controller = new AbortController();
            let now = 0;
            vi.spyOn(performance, 'now').mockImplementation(() => now);
            codec.decodeResponse.mockImplementation((body) => {
                const projection = decode(body);

                if (mode === 'abort') {
                    controller.abort();
                } else {
                    now = 1000;
                }

                return projection;
            });
            const f = fixture();
            expect(
                await createSsoReferenceExchange(codec.policy)(f.transport, {
                    ...options(),
                    signal: controller.signal,
                }),
            ).toEqual(failed);
            expectDisposed(codec);
            expectWiped(f.borrowedFrames);
        },
    );

    it.each(['revoke', 'replace-run'] as const)(
        'recovers a decoded projection when %s invalidates the capability before consume returns',
        async (mode) => {
            const codec = ownedCodec();
            const decode = codec.decodeResponse.getMockImplementation()!;
            const f = fixture();
            const binding = capability(f.transport);
            const replacement = {};
            codec.decodeResponse.mockImplementation((body) => {
                const projection = decode(body);

                if (mode === 'revoke') {
                    privateSession.revokeReferenceKey(binding.token);
                } else {
                    privateSession.endReferenceSend(
                        binding.token,
                        binding.attempt,
                        binding.lease,
                        binding.run,
                    );
                    privateSession.beginReferenceSend(
                        binding.token,
                        binding.attempt,
                        binding.lease,
                        replacement,
                    );
                }

                return projection;
            });

            try {
                expect(
                    await createSsoReferenceExchange(codec.policy)(undefined, options(), binding),
                ).toEqual(failed);
                expectDisposed(codec);
                expectWiped(f.borrowedFrames);

                if (mode === 'replace-run') {
                    expect(
                        privateSession.assertReferenceSendIdentity(
                            binding.token,
                            binding.attempt,
                            binding.lease,
                            replacement,
                            '123',
                            '123',
                        ),
                    ).toBeUndefined();
                    privateSession.endReferenceSend(
                        binding.token,
                        binding.attempt,
                        binding.lease,
                        replacement,
                    );
                    expectReleased(binding);
                } else {
                    expect(privateSession.referenceKeyState(binding.token)).toBe('revoked');
                }
            } finally {
                privateSession.revokeReferenceKey(binding.token);
            }
        },
    );

    it.each(['repeated', 'concurrent', 'decoder-reentry'] as const)(
        'decodes and disposes once despite %s consume attempts',
        async (mode) => {
            const codec = ownedCodec();
            const decode = codec.decodeResponse.getMockImplementation()!;
            const pending: Promise<unknown>[] = [];
            let consume!: () => Promise<unknown>;

            if (mode === 'decoder-reentry') {
                codec.decodeResponse.mockImplementation((body) => {
                    pending.push(consume().catch(() => undefined));
                    return decode(body);
                });
            }

            const transport = scriptedTransport(async (raw) => {
                const { built, candidate } = await prepare(raw);
                consume = () =>
                    Promise.resolve(raw.consumeCandidate(candidate, built.context, identity));
                const first = consume().catch(() => undefined);
                pending.push(first);

                if (mode === 'repeated') {
                    await first;
                }

                if (mode !== 'decoder-reentry') {
                    pending.push(consume().catch(() => undefined));
                }

                await Promise.all(pending);
                return failed;
            });
            expect(await createSsoReferenceExchange(codec.policy)(transport, options())).toEqual(
                failed,
            );
            await Promise.all(pending);
            expectDisposed(codec);
        },
    );

    it('recovers a started consume after early settlement and rejects later callback reuse', async () => {
        const codec = ownedCodec();
        let pending: Promise<unknown> | undefined;
        let repeat!: () => Promise<unknown>;
        const transport = scriptedTransport(async (raw) => {
            const { built, candidate } = await prepare(raw);
            repeat = () =>
                Promise.resolve(raw.consumeCandidate(candidate, built.context, identity));
            pending = repeat().catch(() => undefined);
            return failed;
        });
        expect(await createSsoReferenceExchange(codec.policy)(transport, options())).toEqual(
            failed,
        );
        await pending;
        await expect(repeat()).rejects.toThrow('invalid borrowed raw transaction');
        expectDisposed(codec);
    });

    it('does not reclaim caller-owned success when stale callbacks or signals fire later', async () => {
        const codec = ownedCodec();
        const controller = new AbortController();
        let repeat!: () => Promise<unknown>;
        const transport = scriptedTransport(async (raw) => {
            const { built, candidate } = await prepare(raw);
            repeat = () =>
                Promise.resolve(raw.consumeCandidate(candidate, built.context, identity));
            const value = await repeat();
            return { kind: 'response', sequence, value, writeState: 'written' };
        });
        const result = await createSsoReferenceExchange(codec.policy)(transport, {
            ...options(),
            signal: controller.signal,
        });
        expect(result.kind).toBe('response');
        controller.abort();
        await expect(repeat()).rejects.toThrow('invalid borrowed raw transaction');
        expect(codec.decodeResponse).toHaveBeenCalledOnce();
        expect(codec.disposeResponse).not.toHaveBeenCalled();
        expect(codec.projections[0].sig).toEqual(Uint8Array.of(0x52));
        expect(codec.projections[0].verify).toEqual(Uint8Array.of(0x63, 0x64));
        codec.projections[0].sig.fill(0);
        codec.projections[0].verify.fill(0);
    });

    it.each(['abort', 'deadline', 'revoke'] as const)(
        'reclaims a consumed projection when raw completion triggers %s',
        async (mode) => {
            const codec = ownedCodec();
            const controller = new AbortController();
            let now = 0;
            vi.spyOn(performance, 'now').mockImplementation(() => now);
            const transport = scriptedTransport(async (raw) => {
                const { built, candidate } = await prepare(raw);
                const value = await raw.consumeCandidate(candidate, built.context, identity);

                if (mode === 'abort') {
                    controller.abort();
                } else if (mode === 'deadline') {
                    now = 1000;
                } else {
                    privateSession.revokeReferenceKey(binding.token);
                }

                return { kind: 'response', sequence, value, writeState: 'written' };
            });
            const binding = capability(transport);

            try {
                expect(
                    await createSsoReferenceExchange(codec.policy)(
                        undefined,
                        {
                            ...options(),
                            signal: controller.signal,
                        },
                        binding,
                    ),
                ).toEqual(failed);
                expectDisposed(codec);

                if (mode !== 'revoke') {
                    expectReleased(binding);
                }
            } finally {
                privateSession.revokeReferenceKey(binding.token);
            }
        },
    );

    it('still releases other resources when a disposer throws before clearing its own bytes', async () => {
        const codec = ownedCodec();
        codec.disposeResponse.mockImplementation(() => {
            throw new Error('fixture early disposal failure');
        });
        let frame: Uint8Array | undefined;
        const transport = scriptedTransport(async (raw) => {
            const { built, candidate } = await prepare(raw);
            frame = built.frame;
            await raw.consumeCandidate(candidate, built.context, identity);
            return failed;
        });
        const binding = capability(transport);

        try {
            expect(
                await createSsoReferenceExchange(codec.policy)(undefined, options(), binding),
            ).toEqual(failed);
            expect(codec.disposeResponse).toHaveBeenCalledExactlyOnceWith(codec.projections[0]);
            expect(frame).toBeDefined();
            expectWiped([...codec.transient, frame!]);
            expectReleased(binding);
            expect(codec.projections[0].sig).toEqual(Uint8Array.of(0x52));
        } finally {
            for (const projection of codec.projections) {
                projection.sig.fill(0);
                projection.verify.fill(0);
            }

            privateSession.revokeReferenceKey(binding.token);
        }
    });

    it.each(['success', 'failure'] as const)(
        'tracks undefined as a legitimate %s projection',
        async (mode) => {
            const disposeResponse = vi.fn((_projection: undefined) => {});
            const exchange = createSsoReferenceExchange({
                ...spec(),
                decodeResponse: () => undefined,
                disposeResponse,
            });
            const transport = scriptedTransport(async (raw) => {
                const { built, candidate } = await prepare(raw);
                const value = await raw.consumeCandidate(candidate, built.context, identity);
                return mode === 'failure'
                    ? failed
                    : { kind: 'response', sequence, value, writeState: 'written' };
            });
            const result = await exchange(transport, options());

            if (mode === 'failure') {
                expect(result).toEqual(failed);
                expect(disposeResponse).toHaveBeenCalledExactlyOnceWith(undefined);
            } else {
                expect(result).toEqual({
                    kind: 'response',
                    sequence,
                    writeState: 'written',
                    value: { status: 'response', response: undefined },
                });
                expect(disposeResponse).not.toHaveBeenCalled();
            }
        },
    );

    it.each(['sso-error', 'size-limit', 'decoder-throw'] as const)(
        'does not dispose a projection that was never returned for %s',
        async (mode) => {
            const codec = ownedCodec();
            const config = options();
            const f = fixture(response(Uint8Array.of(0x52), command, mode === 'sso-error' ? 9 : 0));
            let partial: Uint8Array | undefined;

            if (mode === 'size-limit') {
                config.maxResponseBodyBytes = 0;
            }

            if (mode === 'decoder-throw') {
                codec.decodeResponse.mockImplementation((body) => {
                    partial = body.slice();

                    try {
                        throw new Error('fixture partial decode');
                    } finally {
                        partial.fill(0);
                    }
                });
            }

            const result = await createSsoReferenceExchange(codec.policy)(f.transport, config);
            expect(result.kind).toBe(mode === 'sso-error' ? 'response' : 'failure');
            expect(codec.decodeResponse).toHaveBeenCalledTimes(mode === 'decoder-throw' ? 1 : 0);
            expect(codec.disposeResponse).not.toHaveBeenCalled();
            expect(codec.projections).toEqual([]);
            expectWiped([...codec.transient, ...f.borrowedFrames]);

            if (mode === 'decoder-throw') {
                expect(partial).toEqual(Uint8Array.of(0));
            }
        },
    );

    it.each([
        'abort',
        'deadline',
        'clock-abort',
        'clock-revoke',
        'clock-throw',
        'end-throw',
    ] as const)('retains ownership until the cleanup/final fence passes: %s', async (mode) => {
        const codec = ownedCodec();
        const f = fixture();
        const binding = capability(f.transport);
        const controller = new AbortController();
        const end = privateSession.endReferenceSend;
        let cleanupReached = false;
        let fenceReached = false;
        let atCleanup: Uint8Array[] = [];
        vi.spyOn(performance, 'now').mockImplementation(() => {
            if (cleanupReached) {
                fenceReached = true;

                if (mode === 'clock-abort') {
                    controller.abort();
                } else if (mode === 'clock-revoke') {
                    privateSession.revokeReferenceKey(binding.token);
                } else if (mode === 'clock-throw') {
                    throw new Error('fixture final clock');
                }
            }

            return mode === 'deadline' && cleanupReached ? 1000 : 0;
        });
        const endSpy = vi
            .spyOn(privateSession, 'endReferenceSend')
            .mockImplementation((...args) => {
                end(...args);
                atCleanup = [...codec.transient, ...f.borrowedFrames].map((bytes) => bytes.slice());
                cleanupReached = true;

                if (mode === 'abort') {
                    controller.abort();
                } else if (mode === 'end-throw') {
                    throw new Error('fixture final capability cleanup');
                }
            });

        try {
            expect(
                await createSsoReferenceExchange(codec.policy)(
                    undefined,
                    {
                        ...options(),
                        signal: controller.signal,
                    },
                    binding,
                ),
            ).toEqual(failed);
            expect(cleanupReached).toBe(true);
            expect(fenceReached).toBe(mode !== 'abort');
            expect(atCleanup.length).toBeGreaterThan(0);
            expectWiped(atCleanup);
            expectDisposed(codec);
            endSpy.mockRestore();

            if (mode !== 'clock-revoke') {
                expectReleased(binding);
            }
        } finally {
            privateSession.revokeReferenceKey(binding.token);
        }
    });

    it.each(['guard', 'final-fence'] as const)(
        'finishes buffer and capability cleanup when the %s disposer throws or reenters',
        async (phase) => {
            const codec = ownedCodec();
            const dispose = codec.disposeResponse.getMockImplementation()!;
            const controller = new AbortController();
            const borrowed: Uint8Array[] = [];
            let repeat!: () => Promise<unknown>;
            let reentered: Promise<unknown> | undefined;
            const transport = scriptedTransport(async (raw) => {
                const { built, candidate } = await prepare(raw);
                borrowed.push(built.frame);
                repeat = () =>
                    Promise.resolve(raw.consumeCandidate(candidate, built.context, identity));
                const value = await repeat();
                return phase === 'guard'
                    ? failed
                    : { kind: 'response', sequence, value, writeState: 'written' };
            });
            const binding = capability(transport);
            const end = privateSession.endReferenceSend;
            const endSpy = vi
                .spyOn(privateSession, 'endReferenceSend')
                .mockImplementation((...args) => {
                    end(...args);

                    if (phase === 'final-fence') {
                        controller.abort();
                    }
                });
            codec.disposeResponse.mockImplementation((projection) => {
                dispose(projection);
                reentered = repeat().catch(() => undefined);
                throw new Error('fixture disposer failure');
            });

            try {
                expect(
                    await createSsoReferenceExchange(codec.policy)(
                        undefined,
                        {
                            ...options(),
                            signal: controller.signal,
                        },
                        binding,
                    ),
                ).toEqual(failed);
                await reentered;
                expectDisposed(codec);
                expectWiped(borrowed);
                expect(endSpy).toHaveBeenCalledOnce();
                endSpy.mockRestore();
                expectReleased(binding);
            } finally {
                privateSession.revokeReferenceKey(binding.token);
            }
        },
    );
});

describe('code-owned per-spec response ceiling', () => {
    it.each([65536, 65537, 2 * 1024 * 1024])(
        'accepts %s bytes only under a fixed larger spec',
        async (size) => {
            const decodeResponse = vi.fn((body: Uint8Array) => ({ value: body.byteLength }));
            const policy = { ...spec(), responseBodyLimit: 2 * 1024 * 1024, decodeResponse };
            const exchange = createSsoReferenceExchange(policy);
            policy.responseBodyLimit = 0;
            const f = fixture(response(new Uint8Array(size).fill(0x52)));
            const result = await exchange(f.transport, {
                ...options(),
                maxResponseBodyBytes: size,
                timeoutMs: 5000,
            });
            expect(result).toMatchObject({
                kind: 'response',
                value: { status: 'response', response: { value: size } },
            });
            expect(decodeResponse).toHaveBeenCalledOnce();
            expectWiped(f.borrowedFrames);
        },
    );

    it('retains the default 64 KiB ceiling and blocks caller-supplied spec fields', async () => {
        const f = fixture();
        await expect(
            createSsoReferenceExchange(spec())(f.transport, {
                ...options(),
                maxResponseBodyBytes: 65537,
            }),
        ).rejects.toThrow();
        await expect(
            createSsoReferenceExchange(spec())(f.transport, {
                ...options(),
                responseBodyLimit: 2 * 1024 * 1024,
            } as SsoReferenceExchangeOptions<Request>),
        ).rejects.toThrow();
        expect(f.calls).toBe(0);
    });

    it('enforces a smaller caller cap inside a larger fixed ceiling', async () => {
        const decodeResponse = vi.fn(spec().decodeResponse);
        const f = fixture(response(new Uint8Array(65537)));
        const result = await createSsoReferenceExchange({
            ...spec(),
            responseBodyLimit: 2 * 1024 * 1024,
            decodeResponse,
        })(f.transport, { ...options(), maxResponseBodyBytes: 65536 });
        expect(result.kind).toBe('failure');
        expect(decodeResponse).not.toHaveBeenCalled();
        expectWiped(f.borrowedFrames);
    });

    it.each([-1, 0.5, NaN, Infinity, 2 * 1024 * 1024 + 1, null, '2097152'])(
        'rejects invalid code-only cap %s at construction',
        (limit) => {
            expect(() =>
                createSsoReferenceExchange({ ...spec(), responseBodyLimit: limit as number }),
            ).toThrow();
        },
    );
});
