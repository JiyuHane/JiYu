import { createCipheriv } from 'node:crypto';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import {
    assertLinuxEasyKeyTentative,
    commitLinuxEasyKey,
    consumeLinuxEasyKeySessionReservation,
    createLinuxEasyKeyCapability,
    decodeLinuxEasyServiceResponse,
    linuxEasyKeyState,
    reserveLinuxEasyKeyForSession,
    revokeLinuxEasyKey,
    stageLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';
import { guardBorrowedTransport } from '../../src/direct/guard-raw-transaction';
import { decodeLinuxNTEasyLoginReferenceResponse } from '../../src/direct/nt-linux-easy-login-reference';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';
import {
    LINUX_EASY_LOGIN_COMMAND,
    referenceLinuxEasyLoginWithKeyCapability,
    referenceLinuxEasyLoginWithReservedKeyCapability,
    type SsoReferenceLinuxEasyLoginOptions,
} from '../../src/direct/sso-reference-linux-easy-login-flow';

// Synthetic bytes and identities only. All transports below are in-memory callbacks.
const UIN = '123456';
const SEQUENCE = 0xf0000001;
const SESSION_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const D2_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x70 + i);

function fixture(uin = UIN) {
    const lease = {};
    const token = createLinuxEasyKeyCapability({ lease, uin, generation: {} });
    return { token, lease, uin };
}

// A null-prototype descriptor remains a valid accessor descriptor even when
// Object.prototype.value is present. Never evaluate the tested accessor.
function accessor(target: object, name: string, onRead: () => void): void {
    const descriptor = Object.create(null) as PropertyDescriptor;
    descriptor.configurable = true;
    descriptor.enumerable = true;

    descriptor.get = () => {
        onRead();
        return undefined;
    };

    Object.defineProperty(target, name, descriptor);
}

function restore(name: string, original: PropertyDescriptor | undefined): void {
    delete (Object.prototype as Record<string, unknown>)[name];

    if (original) {
        Object.defineProperty(Object.prototype, name, original);
    }
}

function rejected(operation: () => unknown): boolean {
    try {
        operation();
        return false;
    } catch {
        return true;
    }
}

function options(): SsoReferenceLinuxEasyLoginOptions {
    return {
        uin: UIN,
        sessionKey: Uint8Array.from(SESSION_KEY),
        sessionTicket: Uint8Array.of(0x11),
        a1: Uint8Array.of(0x12),
        nonce: new Uint8Array(12),
        guid: Uint8Array.of(1, 2),
        version: 'fixture-version',
        subAppId: 42,
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        timeoutMs: 5000,
        buildReserved: () => Uint8Array.of(0x55),
        verifyRaw: () => true,
    };
}

const word = (value: number): Buffer => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
};

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

const pbField = (number: number, value: Uint8Array): Buffer => {
    if (value.length >= 128) {
        throw new Error('fixture field too large');
    }

    return Buffer.concat([Buffer.of(number * 8 + 2, value.length), value]);
};

// Mirrors the minimal fixture in linux-easy-login-key-stage.fake.test.ts; uses
// production Proton and QQTEA with synthetic AES-GCM ciphertext.
function syntheticResponse(): { frame: Uint8Array; body: Uint8Array } {
    const tickets = Buffer.concat([
        pbField(3, Buffer.alloc(0)),
        pbField(4, Buffer.alloc(0)),
        pbField(5, Buffer.of(0x41, 0x42)),
        pbField(6, D2_KEY),
    ]);
    const body = pbField(1, tickets);
    const plain = Buffer.concat([pbField(1, pbField(4, Buffer.of(8, 0))), pbField(2, body)]);
    const nonce = Buffer.alloc(12, 0x51);
    const cipher = createCipheriv('aes-128-gcm', SESSION_KEY, nonce);
    const encrypted = Buffer.concat([
        nonce,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
    const forward = protobuf_encode<NTLoginForwardRequest>({
        sessionTicket: Uint8Array.of(0x42),
        buffer: encrypted,
        type: 1,
    });
    const header = Buffer.concat([
        word(SEQUENCE),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(LINUX_EASY_LOGIN_COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(forward)]);
    const encryptedSso = qqTeaEncrypt(inner, new Uint8Array(16), (length) =>
        new Uint8Array(length).fill(0x35),
    );
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(UIN)),
        encryptedSso,
    ]);
    frame.writeUInt32BE(frame.length);
    return { frame: Uint8Array.from(frame), body: Uint8Array.from(body) };
}

describe('Linux EasyLogin prototype pollution regression with synthetic fixtures', () => {
    it('does not invoke an inherited numeric setter when snapshotting capability fields', () => {
        const original = Object.getOwnPropertyDescriptor(Object.prototype, '0');
        const f = fixture();
        let hits = 0;
        let result: unknown;

        try {
            Object.defineProperty(Object.prototype, '0', {
                configurable: true,
                set: () => {
                    hits++;
                },
            });
            const proof = reserveLinuxEasyKeyForSession(f);
            consumeLinuxEasyKeySessionReservation({ ...f, reservation: proof });
            result = linuxEasyKeyState(f.token);
        } finally {
            restore('0', original);
            revokeLinuxEasyKey(f.token);
        }

        expect(hits).toBe(0);
        expect(result).toBe('empty');
    });
    it('keeps reservation atomic and account-bound despite an inherited reentrant setter', () => {
        const original = Object.getOwnPropertyDescriptor(Object.prototype, 'reservation');
        const first = fixture();
        const second = fixture('234567');
        let setterCalls = 0;
        let reentrySucceeded = false;
        let firstProof: ReturnType<typeof reserveLinuxEasyKeyForSession> | undefined;
        let secondProof: ReturnType<typeof reserveLinuxEasyKeyForSession> | undefined;
        let duplicateRejected = false;
        let crossAccountRejected = false;
        let bothConsumed = false;

        try {
            Object.defineProperty(Object.prototype, 'reservation', {
                configurable: true,
                set(_value: unknown) {
                    setterCalls++;

                    if (setterCalls === 1) {
                        reentrySucceeded = !rejected(() => reserveLinuxEasyKeyForSession(first));
                    }
                },
            });
            firstProof = reserveLinuxEasyKeyForSession(first);
            duplicateRejected = rejected(() => reserveLinuxEasyKeyForSession(first));
            secondProof = reserveLinuxEasyKeyForSession(second);
            crossAccountRejected = rejected(() =>
                consumeLinuxEasyKeySessionReservation({ ...second, reservation: firstProof! }),
            );
            consumeLinuxEasyKeySessionReservation({ ...first, reservation: firstProof });
            consumeLinuxEasyKeySessionReservation({ ...second, reservation: secondProof });
            bothConsumed = true;
        } finally {
            restore('reservation', original);
            revokeLinuxEasyKey(first.token);
            revokeLinuxEasyKey(second.token);
        }

        expect(setterCalls).toBe(0);
        expect(reentrySucceeded).toBe(false);
        expect(firstProof).toBeDefined();
        expect(secondProof).toBeDefined();
        expect(firstProof).not.toBe(secondProof);
        expect(duplicateRejected).toBe(true);
        expect(crossAccountRejected).toBe(true);
        expect(bothConsumed).toBe(true);
    });

    it('retains staged keys despite an inherited swallowing setter and decodes and commits separately', () => {
        const original = Object.getOwnPropertyDescriptor(Object.prototype, 'key');
        const first = fixture();
        const second = fixture('234567');
        const firstKey = Uint8Array.from(D2_KEY);
        const secondKey = new Uint8Array(16).fill(0x36);
        const command = 'Synthetic.FollowingFrame';
        const inner = Buffer.concat([
            field(
                Buffer.concat([
                    word(SEQUENCE),
                    word(0),
                    field(Buffer.alloc(0)),
                    field(Buffer.from(command)),
                    field(Buffer.alloc(0)),
                    word(0),
                    field(Buffer.alloc(0)),
                ]),
            ),
            field(Uint8Array.of(4, 5, 6)),
        ]);

        const makeFrame = (uin: string, key: Uint8Array): Uint8Array => {
            const encrypted = qqTeaEncrypt(inner, key, (length) =>
                new Uint8Array(length).fill(0x35),
            );
            const frame = Buffer.concat([
                word(0),
                word(12),
                Buffer.of(1, 0),
                field(Buffer.from(uin)),
                encrypted,
            ]);
            frame.writeUInt32BE(frame.length);
            return Uint8Array.from(frame);
        };

        const firstFrame = makeFrame(first.uin, firstKey);
        const secondFrame = makeFrame(second.uin, secondKey);
        const decoded: ReturnType<typeof decodeLinuxEasyServiceResponse>[] = [];
        const phases: string[] = [];
        let setterCalls = 0;

        try {
            Object.defineProperty(Object.prototype, 'key', {
                configurable: true,
                set(_value: unknown) {
                    setterCalls++;
                },
            });
            stageLinuxEasyKey({ ...first, sequence: SEQUENCE, key: firstKey });
            stageLinuxEasyKey({ ...second, sequence: SEQUENCE, key: secondKey });

            for (const [f, key, frame] of [
                [first, firstKey, firstFrame],
                [second, secondKey, secondFrame],
            ] as const) {
                assertLinuxEasyKeyTentative({ ...f, sequence: SEQUENCE });
                phases.push(linuxEasyKeyState(f.token));
                decoded.push(decodeLinuxEasyServiceResponse({ ...f, frame }));
                commitLinuxEasyKey({ ...f, sequence: SEQUENCE, comparisonKey: key });
                phases.push(linuxEasyKeyState(f.token));
                decoded.push(decodeLinuxEasyServiceResponse({ ...f, frame }));
            }
        } finally {
            restore('key', original);
            revokeLinuxEasyKey(first.token);
            revokeLinuxEasyKey(second.token);
            firstKey.fill(0);
            secondKey.fill(0);
            firstFrame.fill(0);
            secondFrame.fill(0);
        }

        try {
            expect(setterCalls).toBe(0);
            expect(phases).toEqual(['tentative', 'active', 'tentative', 'active']);
            expect(decoded).toHaveLength(4);

            for (const value of decoded) {
                expect(value.sequence).toBe(SEQUENCE);
                expect(value.command).toBe(command);
                expect(value.body).toEqual(Uint8Array.from(inner));
            }

            expect(decoded.map((value) => value.uin)).toEqual([
                first.uin,
                first.uin,
                second.uin,
                second.uin,
            ]);
        } finally {
            for (const value of decoded) {
                value.body.fill(0);
            }

            inner.fill(0);
        }
    });

    it.each(['getter', 'data'] as const)(
        'rejects reserve/consume accessor fields with inherited value %s and accepts data fields',
        (kind) => {
            const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
            const f = fixture();
            let inheritedReads = 0;
            let fieldReads = 0;
            const reserveRejected: boolean[] = [];
            const consumeRejected: boolean[] = [];
            let phase = '';
            let consumed = false;
            const key = new Uint8Array(16).fill(0x31);

            try {
                if (kind === 'getter') {
                    Object.defineProperty(Object.prototype, 'value', {
                        configurable: true,
                        get() {
                            inheritedReads++;
                            return f.token;
                        },
                    });
                } else {
                    Object.defineProperty(Object.prototype, 'value', {
                        configurable: true,
                        writable: true,
                        value: f.token,
                    });
                }

                for (const name of ['token', 'lease', 'uin']) {
                    const bad = { ...f };
                    accessor(bad, name, () => {
                        fieldReads++;
                    });
                    reserveRejected.push(rejected(() => reserveLinuxEasyKeyForSession(bad)));
                }

                const reservation = reserveLinuxEasyKeyForSession(f);
                const input = { ...f, reservation };

                for (const name of ['token', 'lease', 'uin', 'reservation']) {
                    const bad = { ...input };
                    accessor(bad, name, () => {
                        fieldReads++;
                    });
                    consumeRejected.push(
                        rejected(() => consumeLinuxEasyKeySessionReservation(bad)),
                    );
                }

                consumeLinuxEasyKeySessionReservation(input);
                consumed = true;
                stageLinuxEasyKey({ ...f, sequence: SEQUENCE, key });
                phase = linuxEasyKeyState(f.token);
            } finally {
                restore('value', original);
                revokeLinuxEasyKey(f.token);
                key.fill(0);
            }

            expect(reserveRejected).toEqual([true, true, true]);
            expect(consumeRejected).toEqual([true, true, true, true]);
            expect(consumed).toBe(true);
            expect(phase).toBe('tentative');
            expect(fieldReads).toBe(0);
            expect(inheritedReads).toBe(0);
        },
    );

    it.each(['getter', 'data'] as const)(
        'rejects binding and option accessors with inherited value %s before transport',
        async (kind) => {
            const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
            const fixtures = Array.from({ length: 8 }, () => fixture());
            let inheritedReads = 0;
            let fieldReads = 0;
            let transportCalls = 0;
            const outcomes: boolean[] = [];
            const states: string[] = [];
            const transport: Sso12RawTransport = {
                async transactRaw<C, T>(_raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                    transportCalls++;
                    throw new Error('unexpected transport');
                },
            };

            try {
                if (kind === 'getter') {
                    Object.defineProperty(Object.prototype, 'value', {
                        configurable: true,
                        get() {
                            inheritedReads++;
                            return fixtures[0].token;
                        },
                    });
                } else {
                    Object.defineProperty(Object.prototype, 'value', {
                        configurable: true,
                        writable: true,
                        value: fixtures[0].token,
                    });
                }

                let index = 0;

                for (const name of ['token', 'lease']) {
                    const f = fixtures[index++];
                    const binding = { token: f.token, lease: f.lease };
                    accessor(binding, name, () => {
                        fieldReads++;
                    });
                    outcomes.push(
                        await referenceLinuxEasyLoginWithKeyCapability(
                            transport,
                            options(),
                            binding,
                        ).then(
                            () => false,
                            () => true,
                        ),
                    );
                    states.push(linuxEasyKeyState(f.token));
                }

                for (const name of ['token', 'lease', 'reservation']) {
                    const f = fixtures[index++];
                    const reservation = reserveLinuxEasyKeyForSession(f);
                    const binding = { token: f.token, lease: f.lease, reservation };
                    accessor(binding, name, () => {
                        fieldReads++;
                    });
                    outcomes.push(
                        await referenceLinuxEasyLoginWithReservedKeyCapability(
                            transport,
                            options(),
                            binding,
                        ).then(
                            () => false,
                            () => true,
                        ),
                    );
                    states.push(linuxEasyKeyState(f.token));
                    consumeLinuxEasyKeySessionReservation({ ...f, reservation });
                }

                for (const name of ['uin', 'sessionKey', 'buildReserved']) {
                    const f = fixtures[index++];
                    const bad = options();
                    accessor(bad, name, () => {
                        fieldReads++;
                    });
                    outcomes.push(
                        await referenceLinuxEasyLoginWithKeyCapability(transport, bad, {
                            token: f.token,
                            lease: f.lease,
                        }).then(
                            () => false,
                            () => true,
                        ),
                    );
                    states.push(linuxEasyKeyState(f.token));
                }
            } finally {
                restore('value', original);

                for (const f of fixtures) {
                    revokeLinuxEasyKey(f.token);
                }
            }

            expect(outcomes).toEqual(Array(8).fill(true));
            expect(states).toEqual(Array(8).fill('empty'));
            expect(transportCalls).toBe(0);
            expect(fieldReads).toBe(0);
            expect(inheritedReads).toBe(0);
        },
    );

    it.each(['getter', 'data'] as const)(
        'guard rejects inherited-value accessor descriptors and accepts own data (%s)',
        async (kind) => {
            const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
            let inheritedReads = 0;
            let fieldReads = 0;
            const outputs: Sso12RawResult<string>[] = [];
            const identity = { uin: UIN, sequence: SEQUENCE };

            try {
                if (kind === 'getter') {
                    Object.defineProperty(Object.prototype, 'value', {
                        configurable: true,
                        get() {
                            inheritedReads++;
                            return 'response';
                        },
                    });
                } else {
                    Object.defineProperty(Object.prototype, 'value', {
                        configurable: true,
                        writable: true,
                        value: 'response',
                    });
                }

                for (const mode of ['identity', 'kind', 'value', 'valid'] as const) {
                    const transport: Sso12RawTransport = {
                        async transactRaw<C, T>(
                            raw: Sso12RawOptions<C, T>,
                        ): Promise<Sso12RawResult<T>> {
                            const supplied = { ...identity };

                            if (mode === 'identity') {
                                accessor(supplied, 'uin', () => {
                                    fieldReads++;
                                });
                            }

                            const built = await raw.buildRequest(supplied);
                            const candidate = Uint8Array.of(1, 2, 3);
                            await raw.verifyCandidate(candidate, built.context, identity);
                            const value = await raw.consumeCandidate(
                                candidate,
                                built.context,
                                identity,
                            );
                            const response: Sso12RawResult<T> = {
                                kind: 'response',
                                sequence: SEQUENCE,
                                value,
                                writeState: 'written',
                            };

                            if (mode === 'kind' || mode === 'value') {
                                accessor(response, mode, () => {
                                    fieldReads++;
                                });
                            }

                            return response;
                        },
                    };
                    const run = guardBorrowedTransport<object, string>(transport);
                    outputs.push(
                        await run({
                            buildRequest: () => ({ frame: Uint8Array.of(9), context: {} }),
                            verifyCandidate: () => true,
                            consumeCandidate: () => 'synthetic-result',
                        }),
                    );
                }
            } finally {
                restore('value', original);
            }

            expect(outputs.slice(0, 3).map((value) => value.kind)).toEqual([
                'failure',
                'failure',
                'failure',
            ]);
            expect(outputs[3]).toEqual({
                kind: 'response',
                sequence: SEQUENCE,
                value: 'synthetic-result',
                writeState: 'written',
            });
            expect(fieldReads).toBe(0);
            expect(inheritedReads).toBe(0);
        },
    );

    it.each(['claim', 'reservation'] as const)(
        'preserves a real decoded response and tentative key with inherited failure (%s)',
        async (mode) => {
            const original = Object.getOwnPropertyDescriptor(Object.prototype, 'failure');
            const f = fixture();
            const candidate = syntheticResponse();
            const input = options();
            const proof = mode === 'reservation' ? reserveLinuxEasyKeyForSession(f) : undefined;
            let builds = 0;
            let verifies = 0;
            let consumes = 0;
            let phase = '';
            let result:
                Awaited<ReturnType<typeof referenceLinuxEasyLoginWithKeyCapability>> | undefined;
            const transport: Sso12RawTransport = {
                async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                    const identity = { uin: UIN, sequence: SEQUENCE };
                    const built = await raw.buildRequest(identity);
                    builds++;

                    if (!(await raw.verifyCandidate(candidate.frame, built.context, identity))) {
                        throw new Error('synthetic verifier rejected');
                    }

                    verifies++;
                    const value = await raw.consumeCandidate(
                        candidate.frame,
                        built.context,
                        identity,
                    );
                    consumes++;
                    return { kind: 'response', sequence: SEQUENCE, value, writeState: 'written' };
                },
            };

            try {
                Object.defineProperty(Object.prototype, 'failure', {
                    configurable: true,
                    writable: true,
                    value: {
                        kind: 'failure',
                        code: 'synthetic-inherited-failure',
                        writeState: 'unknown',
                    },
                });
                result = proof
                    ? await referenceLinuxEasyLoginWithReservedKeyCapability(transport, input, {
                          token: f.token,
                          lease: f.lease,
                          reservation: proof,
                      })
                    : await referenceLinuxEasyLoginWithKeyCapability(transport, input, {
                          token: f.token,
                          lease: f.lease,
                      });
                phase = linuxEasyKeyState(f.token);
            } finally {
                restore('failure', original);
                revokeLinuxEasyKey(f.token);
                input.sessionKey.fill(0);
                candidate.frame.fill(0);
            }

            try {
                expect(result?.kind).toBe('response');
                expect(phase).toBe('tentative');
                expect([builds, verifies, consumes]).toEqual([1, 1, 1]);

                if (!result || result.kind !== 'response' || result.value.body === null) {
                    throw new Error('expected synthetic EasyLogin response body');
                }

                expect(result.sequence).toBe(SEQUENCE);
                expect(result.value.status).toEqual({ kind: 'code', codePresent: true, code: 0n });
                expect(result.value.body).toEqual(candidate.body);
                const decoded = decodeLinuxNTEasyLoginReferenceResponse(result.value.body);

                try {
                    expect(decoded.ticketsPresent).toBe(true);
                    expect(decoded.d2).toEqual(Uint8Array.of(0x41, 0x42));
                    expect(decoded.d2Key).toEqual(D2_KEY);
                } finally {
                    decoded.a1?.fill(0);
                    decoded.a2?.fill(0);
                    decoded.d2?.fill(0);
                    decoded.d2Key?.fill(0);
                }
            } finally {
                if (result?.kind === 'response') {
                    result.value.body?.fill(0);
                }

                candidate.body.fill(0);
            }
        },
    );
});
