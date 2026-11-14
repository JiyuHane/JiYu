import type { Socket } from 'node:net';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { peer, fetchBody, pollBody, parseWt, replyWt } from './fixtures/wt-sso-synthetic';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import type {
    Sso12PacketClientOptions,
    Sso12RawOptions,
} from '../../src/direct/sso12-packet-client';
import {
    WtReferenceLoginAttempt,
    type WtReferenceLoginAttemptOptions,
} from '../../src/direct/wt-reference-login-attempt';
import * as keystore from '../../src/direct/wt-login-keystore';
import * as loginDecoder from '../../src/direct/wt-login-response';

// Transport only is fake. The callbacks and all protocol codecs are production implementations.
const fake = vi.hoisted(() => ({
    responders: new WeakMap<object, (frame: Uint8Array) => Uint8Array>(),
    discard: new WeakSet<object>(),
    discarded: new WeakMap<object, unknown>(),
}));

vi.mock('../../src/direct/sso12-packet-client', () => ({
    Sso12PacketClient: class {
        private sequence: number;
        private options: Sso12PacketClientOptions;
        readonly whenClosed = new Promise<never>(() => {});

        constructor(options: Sso12PacketClientOptions) {
            this.options = options;
            this.sequence = options.initialSequence ?? 0;
        }

        close() {
            (this.options.socket as unknown as { destroyed: boolean }).destroyed = true;
        }

        async transactRaw<C, T>(options: Sso12RawOptions<C, T>) {
            const identity = { uin: this.options.uin, sequence: ++this.sequence };
            const request = await options.buildRequest(identity);
            const response = fake.responders.get(this.options.socket)!(request.frame);

            if (!(await options.verifyCandidate(response, request.context, identity))) {
                return {
                    kind: 'failure' as const,
                    code: 'rejected',
                    writeState: 'unknown' as const,
                };
            }

            const value = await options.consumeCandidate(response, request.context, identity);

            if (fake.discard.has(this.options.socket)) {
                fake.discarded.set(this.options.socket, value);
                return {
                    kind: 'failure' as const,
                    code: 'discard',
                    writeState: 'unknown' as const,
                };
            }

            return {
                kind: 'response' as const,
                sequence: identity.sequence,
                value,
                writeState: 'written' as const,
            };
        }
    },
}));

const key = new Uint8Array(16).fill(4);
const attempts: WtReferenceLoginAttempt[] = [];

const be32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([be32(b.length + 4), b]);

function loginBody(projection: Uint8Array | undefined) {
    const inner = [
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: new Uint8Array(16).fill(10) },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
    ];

    if (projection !== undefined) {
        inner.push({ tag: 0x543, value: projection });
    }

    return Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(encodeWtTlv(inner), key) }]),
    ]);
}

type ReplyOverrides = { loginBody?: Uint8Array; responseUin?: string; oicqUin?: number };

function response(
    frame: Uint8Array,
    uin: bigint,
    projection: Uint8Array | undefined,
    overrides: ReplyOverrides,
) {
    const req = parseWt(frame);
    const { kind, shared } = req;
    const command = Buffer.from(req.command);
    const account = Buffer.from(
        kind === 0x810 ? (overrides.responseUin ?? req.account) : req.account,
    );
    const business: Uint8Array =
        kind === 0x31
            ? fetchBody()
            : kind === 0x12
              ? pollBody(0, uin)
              : (overrides.loginBody ?? loginBody(projection));

    if (
        kind !== 0x810 ||
        (uin === 123n && overrides.responseUin === undefined && overrides.oicqUin === undefined)
    ) {
        const result = replyWt(req, business);
        shared.fill(0);
        req.business.fill(0);
        return result;
    }

    const cipher = qqTeaEncrypt(business, shared);
    const wt = Buffer.alloc(17 + cipher.length);
    wt[0] = 2;
    wt.writeUInt16BE(wt.length, 1);
    wt.writeUInt16BE(kind === 0x810 ? 0x810 : 0x812, 5);
    wt.writeUInt32BE(overrides.oicqUin ?? Number(uin), 9);
    wt.set(cipher, 16);
    wt[wt.length - 1] = 3;
    const sso = Buffer.concat([
        field(
            Buffer.concat([
                be32(req.seq),
                be32(0),
                field(Buffer.alloc(0)),
                field(command),
                field(Buffer.alloc(0)),
                be32(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(wt),
    ]);
    const encrypted = qqTeaEncrypt(sso, new Uint8Array(16));
    shared.fill(0);
    req.business.fill(0);
    return Buffer.concat([
        be32(14 + account.length + encrypted.length),
        be32(12),
        Buffer.of(2, 0),
        field(account),
        encrypted,
    ]);
}

const fetchFields = {
    packageName: 'p',
    ptVersion: 'v',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1),
};
const loginFields = {
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
};
const encodeUid = (uid: string) =>
    protobuf_encode<DirectThirdPartyLoginResponse>({ commonInfo: { rspNT: { uid } } });

function setup(
    uin: bigint,
    projection: Uint8Array | undefined,
    overrides: Partial<WtReferenceLoginAttemptOptions> = {},
    replyOverrides: ReplyOverrides = {},
) {
    const socket = { destroyed: false } as unknown as Socket;
    fake.responders.set(socket, (frame) => response(frame, uin, projection, replyOverrides));
    const options: WtReferenceLoginAttemptOptions = {
        socket,
        profile: {
            uin: '999',
            appId: 42,
            subAppId: 43,
            clientVersion: 44,
            guid: Uint8Array.of(1, 2),
            unknown21: new Uint8Array(21),
            randomKey: new Uint8Array(16).fill(7),
            peerPublicKey: peer.publicKey,
            ssoVersion: 'v',
            qrCommand: 'fixture.qr',
            loginCommand: 'fixture.login',
        },
        timeoutMs: 500,
        attemptTimeoutMs: 5000,
        getTimestamp: () => 10,
        buildReserved: async () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: ({ requestUin, responseUin }) => requestUin === responseUin,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        ...overrides,
    };
    const attempt = new WtReferenceLoginAttempt(options);
    attempts.push(attempt);
    return { attempt, socket, options };
}

async function confirmed(attempt: WtReferenceLoginAttempt) {
    await attempt.fetch(fetchFields);
    expect(await attempt.poll()).toEqual({ status: 'confirmed' });
}

afterEach(() => {
    for (const attempt of attempts.splice(0)) {
        attempt.close();
    }

    vi.restoreAllMocks();
});

describe('reference attempt UID projection, in-memory synthetic transport', () => {
    it.each([undefined, false])(
        'keeps the original result shape and ignores malformed UID when option is %s',
        async (enabled) => {
            const spy = vi.spyOn(keystore, 'projectWtLoginUid');
            const { attempt } = setup(123n, Uint8Array.of(0x4a, 0x80), {
                enableUidProjection: enabled,
            });
            await confirmed(attempt);
            expect(await attempt.login(loginFields)).toEqual({
                status: 'tickets',
                uin: '123',
                tickets: {
                    d2: Uint8Array.of(9),
                    d2Key: new Uint8Array(16).fill(10),
                    a2: Uint8Array.of(11),
                    a1: Uint8Array.of(12),
                },
            });
            expect(spy).not.toHaveBeenCalled();
        },
    );
    it.each([
        {
            name: 'present',
            input: encodeUid('synthetic-uid'),
            expected: { status: 'present', uid: 'synthetic-uid' },
        },
        { name: 'absent', input: undefined, expected: { status: 'absent' } },
        { name: 'empty', input: new Uint8Array(), expected: { status: 'present', uid: '' } },
    ])('projects $name from accepted login TLVs', async ({ input, expected }) => {
        const { attempt } = setup(123n, input, { enableUidProjection: true });
        await confirmed(attempt);
        expect(await attempt.login(loginFields)).toMatchObject({
            status: 'tickets',
            uin: '123',
            uidProjection: expected,
        });
    });
    it.each([encodeUid('synthetic'), Uint8Array.of(0x4a, 0x80)])(
        'wipes decoded TLVs and ticket copies after projection',
        async (input) => {
            const original = loginDecoder.decodeWtLoginResponse;
            let decoded: ReturnType<typeof original> | undefined;
            vi.spyOn(loginDecoder, 'decodeWtLoginResponse').mockImplementation((...args) => {
                decoded = original(...args);
                return decoded;
            });
            const { attempt } = setup(123n, input, { enableUidProjection: true });
            await confirmed(attempt);

            if (input[0] === 0x4a && input[1] === 0x80) {
                await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
            } else {
                await attempt.login(loginFields);
            }

            expect(decoded?.status).toBe('tickets');

            if (decoded?.status !== 'tickets') {
                throw new Error('fixture');
            }

            expect(
                [...decoded.innerTlvs, ...decoded.outerTlvs].every((entry) =>
                    entry.value.every((byte) => byte === 0),
                ),
            ).toBe(true);
            expect(
                Object.values(decoded.tickets).every((bytes) => bytes.every((byte) => byte === 0)),
            ).toBe(true);
        },
    );
    it('does not project UID from a non-ticket response', async () => {
        const spy = vi.spyOn(keystore, 'projectWtLoginUid');
        const loginBody = Buffer.concat([
            Buffer.of(0, 9, 2),
            encodeWtTlv([{ tag: 0x543, value: encodeUid('synthetic') }]),
        ]);
        const { attempt } = setup(123n, undefined, { enableUidProjection: true }, { loginBody });
        await confirmed(attempt);
        expect(await attempt.login(loginFields)).toEqual({
            status: 'verification-required',
            state: 2,
        });
        expect(spy).not.toHaveBeenCalled();
    });
    it.each(['outer', 'oicq'] as const)(
        'rejects mismatched login %s UIN before projection',
        async (layer) => {
            const spy = vi.spyOn(keystore, 'projectWtLoginUid');
            const { attempt } = setup(
                123n,
                encodeUid('synthetic'),
                { enableUidProjection: true },
                layer === 'outer' ? { responseUin: '456' } : { oicqUin: 456 },
            );
            await confirmed(attempt);
            await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
            expect(spy).not.toHaveBeenCalled();
            expect(attempt.getState()).toBe('failed');
        },
    );
    it('fails closed on malformed projection', async () => {
        const { attempt } = setup(123n, Uint8Array.of(0x4a, 0x80), { enableUidProjection: true });
        await confirmed(attempt);
        await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
        expect(attempt.getState()).toBe('failed');
    });
    it.each(['raw', 'context'] as const)(
        'projects only after %s verification accepts',
        async (rejected) => {
            const spy = vi.spyOn(keystore, 'projectWtLoginUid');
            const { attempt } = setup(123n, encodeUid('synthetic'), {
                enableUidProjection: true,
                verifyRaw: ({ operation }) => rejected !== 'raw' || operation !== 'login',
                verifyContext: ({ operation }) => rejected !== 'context' || operation !== 'login',
            });
            await confirmed(attempt);
            await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
            expect(spy).not.toHaveBeenCalled();
        },
    );
    it.each(['raw', 'context'] as const)(
        'does not expose late %s verification after cancellation',
        async (phase) => {
            const controller = new AbortController();
            let entered!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const wait = new Promise<void>((resolve) => {
                release = resolve;
            });
            const spy = vi.spyOn(keystore, 'projectWtLoginUid');

            const verify = async ({ operation }: { operation: string }) => {
                if (operation === 'login') {
                    entered();
                    await wait;
                }

                return true;
            };

            const { attempt } = setup(123n, encodeUid('late'), {
                enableUidProjection: true,
                signal: controller.signal,
                ...(phase === 'raw' ? { verifyRaw: verify } : { verifyContext: verify }),
            });
            await confirmed(attempt);
            const pending = attempt.login(loginFields);
            const rejection = expect(pending).rejects.toThrow('attempt login failed');
            await started;
            controller.abort();
            release();
            await rejection;
            expect(attempt.getState()).toBe('failed');
            expect(spy).not.toHaveBeenCalled();
        },
    );
    it('discards staged data if transport does not commit', async () => {
        const { attempt, socket } = setup(123n, encodeUid('discarded'), {
            enableUidProjection: true,
        });
        await confirmed(attempt);
        fake.discard.add(socket);
        await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
        expect(attempt.getState()).toBe('failed');
        const staged = fake.discarded.get(socket) as {
            result: { tickets: Record<string, Uint8Array>; uidProjection?: unknown };
        };
        expect(staged.result).not.toHaveProperty('uidProjection');
        expect(
            Object.values(staged.result.tickets).every((bytes) =>
                bytes.every((byte) => byte === 0),
            ),
        ).toBe(true);
    });
    it('keeps simultaneous accounts and projected UIDs separate', async () => {
        const a = setup(123n, encodeUid('uid-a'), { enableUidProjection: true }).attempt;
        const b = setup(456n, encodeUid('uid-b'), { enableUidProjection: true }).attempt;
        await Promise.all([confirmed(a), confirmed(b)]);
        const [rb, ra] = await Promise.all([b.login(loginFields), a.login(loginFields)]);
        expect(ra).toMatchObject({
            uin: '123',
            uidProjection: { status: 'present', uid: 'uid-a' },
        });
        expect(rb).toMatchObject({
            uin: '456',
            uidProjection: { status: 'present', uid: 'uid-b' },
        });
    });
    it('rejects non-booleans and accessor options before claiming the transport', () => {
        const { options } = setup(123n, undefined);

        for (const value of [null, 0, 1, 'true', {}, new Boolean(true)]) {
            expect(
                () =>
                    new WtReferenceLoginAttempt({
                        ...options,
                        enableUidProjection: value as boolean,
                    }),
            ).toThrow('invalid attempt configuration');
        }

        let invoked = false;
        const hostile = {
            ...options,
            get enableUidProjection() {
                invoked = true;
                return true;
            },
        };
        expect(() => new WtReferenceLoginAttempt(hostile)).toThrow('invalid record');
        expect(invoked).toBe(false);
    });
});
