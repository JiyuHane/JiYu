import type { LinuxNTEasyLoginReferenceResponseBody } from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterRequest, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { registerLinuxEasyReference } from '../../src/direct/linux-easy-reference-register';
import type { LinuxEasyLoginSessionResult } from '../../src/direct/linux-easy-login-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Synthetic bytes and in-memory transport only; a classified response is not an online claim.
const UIN = '123';
const SEQUENCE = 0xf0000001;
const KEY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const A1 = Uint8Array.of(0x11, 0x12);
const A2 = Uint8Array.of(0x21, 0x22);
const D2 = Uint8Array.of(0x31, 0x32, 0x33);
const GUID = Uint8Array.of(0xab, 0xcd);
const RESERVED = Uint8Array.of(0xe1, 0xe2);
const UID = 'synthetic-uid';

const word = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
};

const field = (bytes: Uint8Array): Buffer => Buffer.concat([word(bytes.length + 4), bytes]);

function reply(message = 'register success'): Uint8Array {
    const body = protobuf_encode<SsoRegisterResponse>({ register: { message } });
    const header = Buffer.concat([
        word(SEQUENCE),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(SSO_INFO_SYNC_COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const encrypted = qqTeaEncrypt(Buffer.concat([field(header), field(body)]), KEY);
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from(UIN)),
        encrypted,
    ]);
    frame.writeUInt32BE(frame.length);
    return frame;
}

function ticketBody(
    tickets: Partial<NonNullable<LinuxNTEasyLoginReferenceResponseBody['tickets']>> = {
        a1: A1,
        a2: A2,
        d2: D2,
        d2Key: KEY,
    },
): Uint8Array {
    return protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({ tickets });
}

function session(
    body: Uint8Array | null = ticketBody(),
): Extract<LinuxEasyLoginSessionResult, { kind: 'response' }> {
    return {
        kind: 'response',
        keyExchangeSequence: 7,
        easyLoginSequence: 8,
        value: { status: { kind: 'code', codePresent: true, code: 0n }, body },
    };
}

function unpack(input: Uint8Array) {
    const frame = Buffer.from(input);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(1);
    const d2End = 9 + frame.readUInt32BE(9);
    const d2 = frame.subarray(13, d2End);
    expect(frame[d2End]).toBe(0);
    const accountStart = d2End + 1;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const uin = frame.subarray(accountStart + 4, accountEnd).toString();
    const inner = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), KEY));
    const sequence = inner.readUInt32BE(4);
    const subAppId = inner.readInt32BE(8);
    let offset = 28;

    const take = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
        expect(length).toBeGreaterThanOrEqual(width);
        expect(offset + length).toBeLessThanOrEqual(inner.length);
        const value = inner.subarray(offset + width, offset + length);
        offset += length;
        return value;
    };

    const a2 = take();
    const command = take().toString();
    take();
    const guid = take().toString();
    take();
    const version = take(2).toString();
    const reserved = take();
    expect(offset).toBe(inner.readUInt32BE(0));
    const body = take();
    expect(offset).toBe(inner.length);
    return { uin, d2, sequence, subAppId, a2, command, guid, version, reserved, body };
}

class FakeClient implements Sso12RawClient {
    readonly whenClosed = new Promise<Sso12CloseReason>(() => {});
    readonly close = vi.fn();
    calls = 0;
    frame?: Uint8Array;
    mode: 'ok' | 'failure' | 'throw' | 'identity' | 'rejected' | 'hang' = 'ok';
    gate?: Promise<void>;
    entered!: () => void;
    readonly started = new Promise<void>((resolve) => {
        this.entered = resolve;
    });

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        this.entered();

        if (this.mode === 'throw') {
            throw new Error('synthetic-credential-secret');
        }

        if (this.mode === 'failure') {
            return { kind: 'failure', code: 'synthetic-credential-secret', writeState: 'unknown' };
        }

        if (this.mode === 'hang') {
            return new Promise<Sso12RawResult<T>>(() => {});
        }

        try {
            const identity = { uin: this.mode === 'identity' ? '124' : UIN, sequence: SEQUENCE };
            const built = await options.buildRequest(identity);
            this.frame = Uint8Array.from(built.frame);

            if (this.gate) {
                await this.gate;
            }

            const candidate = reply(
                this.mode === 'rejected' ? 'register rejected' : 'register success',
            );

            if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'fixture-rejected', writeState: 'unknown' };
            }

            const value = await options.consumeCandidate(candidate, built.context, identity);
            return { kind: 'response', sequence: SEQUENCE, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'fixture-callback-failed', writeState: 'unknown' };
        }
    }
}

function setup() {
    const fake = new FakeClient();
    const lease = createRawSessionBroker(fake, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    }).acquire({ deadline: performance.now() + 10000 });
    const acceptLogin = vi.fn((_input: { uin: string; uid: string; statusCode: bigint }) => true);
    const buildReserved = vi.fn(
        (_input: {
            uin: string;
            uid: string;
            sequence: number;
            command: string;
            body: Uint8Array;
        }) => Uint8Array.from(RESERVED),
    );
    const verifyRaw = vi.fn(() => true);
    const options = {
        session: session(),
        uin: UIN,
        profile: { guid: Uint8Array.from(GUID), version: 'header-v', subAppId: 42 },
        registration: {
            uid: UID,
            version: 'build-v',
            deviceName: 'fixture-device',
            deviceType: 'fixture-type',
            vendorOs: 'fixture-os',
            random: 4,
        },
        timeoutMs: 2000,
        buildReserved,
        verifyRaw,
        acceptLogin,
    };
    return { fake, lease, options, acceptLogin, buildReserved, verifyRaw };
}

async function within<T>(pending: Promise<T>, timeout = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('fixture watchdog expired')), timeout);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function expectFailure(
    result: Promise<unknown>,
    lease: ReturnType<typeof setup>['lease'],
    allowPreclaim = false,
) {
    const outcome = await within(result);
    expect(outcome).toMatchObject({ kind: 'failure' });
    const poison = (outcome as { poison?: string }).poison;

    if (allowPreclaim && poison === 'not-requested') {
        lease.release();
        expect(await within(lease.whenClosed)).toBe('released');
    } else {
        expect(poison).toBe('requested');
        expect(await within(lease.whenClosed)).toBe('poisoned');
    }

    expect(JSON.stringify(outcome)).not.toContain('synthetic-credential-secret');
    return outcome;
}

describe('Linux EasyLogin to reference registration (synthetic in-memory broker)', () => {
    it('snapshots the response and profile, signs and decrypts a locally classified register success without releasing the lease', async () => {
        const { fake, lease, options, acceptLogin, buildReserved, verifyRaw } = setup();
        let closed = false;
        void lease.whenClosed.then(() => {
            closed = true;
        });
        const pending = registerLinuxEasyReference(lease, options);
        options.session.value.body!.fill(0);
        options.profile.guid.fill(0);
        options.profile.version = 'mutated';
        options.registration.uid = 'mutated';
        const result = await within(pending);
        expect(result).toMatchObject({ kind: 'response', sequence: SEQUENCE, value: 'success' });
        expect(acceptLogin).toHaveBeenCalledOnce();
        expect(acceptLogin).toHaveBeenCalledWith({ uin: UIN, uid: UID, statusCode: 0n });
        expect(Object.keys(acceptLogin.mock.calls[0]![0]).sort()).toEqual([
            'statusCode',
            'uid',
            'uin',
        ]);
        expect(buildReserved).toHaveBeenCalledOnce();
        expect(buildReserved.mock.calls[0]![0]).toMatchObject({
            uin: UIN,
            uid: UID,
            sequence: SEQUENCE,
            command: SSO_INFO_SYNC_COMMAND,
        });
        expect(verifyRaw).toHaveBeenCalledOnce();
        expect(fake.calls).toBe(1);
        const request = unpack(fake.frame!);
        expect(request).toMatchObject({
            uin: UIN,
            sequence: SEQUENCE,
            subAppId: 42,
            command: SSO_INFO_SYNC_COMMAND,
            guid: 'abcd',
            version: 'header-v',
        });
        expect(request.d2).toEqual(Buffer.from(D2));
        expect(request.a2).toEqual(Buffer.from(A2));
        expect(request.reserved).toEqual(Buffer.from(RESERVED));
        const decoded = protobuf_decode<SsoRegisterRequest>(request.body);
        expect(decoded.register).toMatchObject({
            guid: 'ABCD',
            buildVersion: 'build-v',
            device: { name: 'fixture-device', type: 'fixture-type', vendorOs: 'fixture-os' },
        });
        expect(closed).toBe(false);
        expect(fake.close).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(UID);
        expect(JSON.stringify(result)).not.toContain('d2Key');
        lease.release();
        expect(await within(lease.whenClosed)).toBe('released');
    });

    it.each([
        'missing-code',
        'nonzero',
        'missing-head',
        'missing-error-info',
        'missing-body',
    ] as const)('rejects %s without a registration transaction', async (kind) => {
        const { fake, lease, options } = setup();

        if (kind === 'missing-code') {
            options.session.value.status = { kind: 'code', codePresent: false, code: 0n };
        }

        if (kind === 'nonzero') {
            options.session.value.status = { kind: 'code', codePresent: true, code: 1n };
        }

        if (kind === 'missing-head') {
            options.session.value.status = { kind: 'missing-head' };
        }

        if (kind === 'missing-error-info') {
            options.session.value.status = { kind: 'missing-error-info' };
        }

        if (kind === 'missing-body') {
            options.session.value.body = null;
        }

        await expectFailure(registerLinuxEasyReference(lease, options), lease, true);
        expect(fake.calls).toBe(0);
    });

    it.each(['tickets', 'a1', 'a2', 'd2', 'd2Key', 'empty-d2', 'short-key', 'uin', 'uid'] as const)(
        'rejects invalid %s before sending',
        async (kind) => {
            const { fake, lease, options } = setup();
            const tickets: Partial<NonNullable<LinuxNTEasyLoginReferenceResponseBody['tickets']>> =
                { a1: A1, a2: A2, d2: D2, d2Key: KEY };

            if (kind === 'tickets') {
                options.session.value.body = protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>(
                    {},
                );
            } else if (kind === 'a1' || kind === 'a2' || kind === 'd2' || kind === 'd2Key') {
                delete tickets[kind];
                options.session.value.body = ticketBody(tickets);
            } else if (kind === 'empty-d2') {
                options.session.value.body = ticketBody({ ...tickets, d2: new Uint8Array() });
            } else if (kind === 'short-key') {
                options.session.value.body = ticketBody({ ...tickets, d2Key: KEY.subarray(1) });
            } else if (kind === 'uin') {
                options.uin = '4294967296';
            } else {
                options.registration.uid = '';
            }

            await expectFailure(registerLinuxEasyReference(lease, options), lease, true);
            expect(fake.calls).toBe(0);
        },
    );

    it('accepts present empty A1 and A2 ticket fields', async () => {
        const { lease, options, fake } = setup();
        options.session.value.body = ticketBody({
            a1: new Uint8Array(),
            a2: new Uint8Array(),
            d2: D2,
            d2Key: KEY,
        });
        expect(await within(registerLinuxEasyReference(lease, options))).toMatchObject({
            kind: 'response',
            value: 'success',
        });
        expect(unpack(fake.frame!).a2.length).toBe(0);
        lease.release();
        expect(await within(lease.whenClosed)).toBe('released');
    });

    it.each(['false', 'throw', 'async-rejected'] as const)(
        'poisons after %s login policy',
        async (kind) => {
            const { fake, lease, options } = setup();
            options.acceptLogin = (() => {
                if (kind === 'throw') {
                    throw new Error('synthetic-credential-secret');
                }

                if (kind === 'async-rejected') {
                    return Promise.reject(new Error('synthetic-credential-secret'));
                }

                return false;
            }) as typeof options.acceptLogin;
            await expectFailure(registerLinuxEasyReference(lease, options), lease);
            expect(fake.calls).toBe(0);
        },
    );

    it.each(['failure', 'throw', 'identity', 'rejected'] as const)(
        'poisons on child %s',
        async (kind) => {
            const { fake, lease, options } = setup();
            fake.mode = kind;

            if (kind === 'rejected') {
                expect(await within(registerLinuxEasyReference(lease, options))).toMatchObject({
                    kind: 'response',
                    value: 'rejected',
                    poison: 'requested',
                });
                expect(await within(lease.whenClosed)).toBe('poisoned');
            } else {
                await expectFailure(registerLinuxEasyReference(lease, options), lease);
            }

            expect(fake.calls).toBe(1);
        },
    );

    it.each(['timeout', 'abort'] as const)(
        'settles and poisons on %s while child stalls',
        async (kind) => {
            const { fake, lease, options } = setup();
            const controller = new AbortController();
            fake.mode = 'hang';
            const input = {
                ...options,
                timeoutMs: kind === 'timeout' ? 50 : 2000,
                signal: controller.signal,
            };
            const pending = registerLinuxEasyReference(lease, input);
            await within(fake.started);

            if (kind === 'abort') {
                controller.abort();
            }

            await expectFailure(pending, lease);
            expect(fake.calls).toBe(1);
        },
    );

    it('rejects a duplicate claim without poisoning or interrupting the winning call', async () => {
        const { fake, lease, options } = setup();
        let open!: () => void;
        fake.gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        const winner = registerLinuxEasyReference(lease, options);
        await within(fake.started);
        const duplicate = await within(
            registerLinuxEasyReference(lease, { ...options, session: session() }),
        );
        expect(duplicate).toMatchObject({ kind: 'failure', poison: 'not-requested' });
        expect(fake.close).not.toHaveBeenCalled();
        open();
        expect(await within(winner)).toMatchObject({
            kind: 'response',
            sequence: SEQUENCE,
            value: 'success',
        });
        expect(fake.calls).toBe(1);
        expect(fake.close).not.toHaveBeenCalled();
        lease.release();
        expect(await within(lease.whenClosed)).toBe('released');
    });
});
