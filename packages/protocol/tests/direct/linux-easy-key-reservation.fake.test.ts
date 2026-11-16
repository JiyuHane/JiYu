import { afterEach, describe, expect, it } from 'vitest';
import {
    assertLinuxEasyKeyTentative,
    claimLinuxEasyKeyForLogin,
    commitLinuxEasyKey,
    consumeLinuxEasyKeySessionReservation,
    createLinuxEasyKeyCapability,
    linuxEasyKeyState,
    reserveLinuxEasyKeyForSession,
    revokeLinuxEasyKey,
    stageLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';

// Synthetic identities and keys only; this suite performs no transport I/O.
const FIRST_UIN = '123456';
const SECOND_UIN = '234567';
const SEQUENCE = 7;
type Binding = Parameters<typeof reserveLinuxEasyKeyForSession>[0];
type Consumption = Parameters<typeof consumeLinuxEasyKeySessionReservation>[0];
type Tentative = Parameters<typeof assertLinuxEasyKeyTentative>[0];

function fixture(uin = FIRST_UIN) {
    const lease = {};
    const token = createLinuxEasyKeyCapability({ lease, uin, generation: {} });
    const key = new Uint8Array(16).fill(uin === FIRST_UIN ? 0x31 : 0x72);
    return { token, lease, uin, key };
}

type Fixture = ReturnType<typeof fixture>;
const fixtures: Fixture[] = [];

function makeFixture(uin = FIRST_UIN): Fixture {
    const value = fixture(uin);
    fixtures.push(value);
    return value;
}

afterEach(() => {
    for (const value of fixtures.splice(0)) {
        try {
            revokeLinuxEasyKey(value.token);
        } finally {
            value.key.fill(0);
        }
    }
});

function binding(value: Fixture): Binding {
    return { token: value.token, lease: value.lease, uin: value.uin };
}

function reserveFailure(input: unknown): void {
    expect(() => reserveLinuxEasyKeyForSession(input as Binding)).toThrow();
}

function consumeFailure(input: unknown): void {
    expect(() => consumeLinuxEasyKeySessionReservation(input as Consumption)).toThrow();
}

function stage(value: Fixture): void {
    stageLinuxEasyKey({ ...binding(value), sequence: SEQUENCE, key: value.key });
}

function commit(value: Fixture): void {
    const comparisonKey = Uint8Array.from(value.key);

    try {
        commitLinuxEasyKey({ ...binding(value), sequence: SEQUENCE, comparisonKey });
    } finally {
        comparisonKey.fill(0);
    }
}

function trappingProxy<T extends object>(target: T, onTrap: () => void): T {
    return new Proxy(target, {
        get(targetValue, property, receiver) {
            onTrap();
            return Reflect.get(targetValue, property, receiver);
        },
        getPrototypeOf(targetValue) {
            onTrap();
            return Reflect.getPrototypeOf(targetValue);
        },
        getOwnPropertyDescriptor(targetValue, property) {
            onTrap();
            return Reflect.getOwnPropertyDescriptor(targetValue, property);
        },
    });
}

describe('Linux easy key reservation with synthetic identities', () => {
    it('reserves once, consumes once, then stages and commits with caller-owned key bytes', () => {
        const f = makeFixture();
        const args = binding(f);
        const reservation = reserveLinuxEasyKeyForSession(args);
        expect(reservation).not.toBeNull();
        expect(typeof reservation).toBe('object');
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        reserveFailure(args);
        expect(() => claimLinuxEasyKeyForLogin(args)).toThrow();
        expect(consumeLinuxEasyKeySessionReservation({ ...args, reservation })).toBeUndefined();
        consumeFailure({ ...args, reservation });
        reserveFailure(args);
        expect(() => claimLinuxEasyKeyForLogin(args)).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        stage(f);
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        commit(f);
        expect(linuxEasyKeyState(f.token)).toBe('active');
        consumeFailure({ ...args, reservation });
        expect(linuxEasyKeyState(f.token)).toBe('active');
    });

    it('makes claim and reservation permanently exclusive in both orders', () => {
        const claimed = makeFixture();
        const reserved = makeFixture();
        expect(claimLinuxEasyKeyForLogin(binding(claimed))).toBeUndefined();
        reserveFailure(binding(claimed));
        expect(linuxEasyKeyState(claimed.token)).toBe('empty');
        const proof = reserveLinuxEasyKeyForSession(binding(reserved));
        expect(() => claimLinuxEasyKeyForLogin(binding(reserved))).toThrow();
        expect(
            consumeLinuxEasyKeySessionReservation({ ...binding(reserved), reservation: proof }),
        ).toBeUndefined();
        expect(() => claimLinuxEasyKeyForLogin(binding(reserved))).toThrow();
        reserveFailure(binding(reserved));
        expect(linuxEasyKeyState(reserved.token)).toBe('empty');
    });

    it('rejects wrong reservation identities without claiming any of the slots', () => {
        const a = makeFixture();
        const b = makeFixture(SECOND_UIN);
        const sameUin = makeFixture();
        const invalid: unknown[] = [
            { ...binding(a), token: {} },
            { ...binding(a), token: null },
            { ...binding(a), token: b.token },
            { ...binding(a), token: sameUin.token },
            { ...binding(a), lease: {} },
            { ...binding(a), lease: b.lease },
            { ...binding(a), lease: sameUin.lease },
            { ...binding(a), uin: SECOND_UIN },
            { ...binding(a), uin: 123456 },
            { token: a.token, lease: b.lease, uin: b.uin },
            { token: b.token, lease: a.lease, uin: a.uin },
        ];

        for (const input of invalid) {
            reserveFailure(input);

            for (const f of [a, b, sameUin]) {
                expect(linuxEasyKeyState(f.token)).toBe('empty');
            }
        }

        for (const f of [a, b, sameUin]) {
            const reservation = reserveLinuxEasyKeyForSession(binding(f));
            expect(
                consumeLinuxEasyKeySessionReservation({ ...binding(f), reservation }),
            ).toBeUndefined();
        }
    });

    it('rejects forged and cross-bound proofs without consuming either account or a same-uin lease', () => {
        const a = makeFixture();
        const b = makeFixture(SECOND_UIN);
        const sameUin = makeFixture();
        const proofA = reserveLinuxEasyKeyForSession(binding(a));
        const proofB = reserveLinuxEasyKeyForSession(binding(b));
        const proofSame = reserveLinuxEasyKeyForSession(binding(sameUin));
        expect(proofA).not.toBe(proofB);
        expect(proofA).not.toBe(proofSame);
        const invalid: unknown[] = [
            { ...binding(a), reservation: {} },
            { ...binding(a), reservation: null },
            { ...binding(a), reservation: proofB },
            { ...binding(a), reservation: proofSame },
            { ...binding(a), token: {}, reservation: proofA },
            { ...binding(a), token: b.token, reservation: proofA },
            { ...binding(a), token: sameUin.token, reservation: proofA },
            { ...binding(a), lease: b.lease, reservation: proofA },
            { ...binding(a), lease: sameUin.lease, reservation: proofA },
            { ...binding(a), uin: b.uin, reservation: proofA },
            { ...binding(b), reservation: proofA },
            { token: b.token, lease: a.lease, uin: a.uin, reservation: proofA },
        ];

        for (const input of invalid) {
            consumeFailure(input);

            for (const f of [a, b, sameUin]) {
                expect(linuxEasyKeyState(f.token)).toBe('empty');
            }
        }

        for (const [f, reservation] of [
            [a, proofA],
            [b, proofB],
            [sameUin, proofSame],
        ] as const) {
            expect(
                consumeLinuxEasyKeySessionReservation({ ...binding(f), reservation }),
            ).toBeUndefined();
            consumeFailure({ ...binding(f), reservation });
        }
    });

    it('does not read accessors or trigger proxy traps in either operation', () => {
        const f = makeFixture();
        let calls = 0;

        const touch = () => {
            calls++;
        };

        const args = binding(f);
        reserveFailure(trappingProxy(args, touch));
        reserveFailure({ ...args, token: trappingProxy(f.token, touch) });
        reserveFailure({ ...args, lease: trappingProxy(f.lease, touch) });

        for (const name of ['token', 'lease', 'uin'] as const) {
            const bad = { ...args };
            Object.defineProperty(bad, name, {
                get() {
                    touch();
                    return args[name];
                },
            });
            reserveFailure(bad);
        }

        expect(calls).toBe(0);
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        const reservation = reserveLinuxEasyKeyForSession(args);
        const consumed = { ...args, reservation };
        consumeFailure(trappingProxy(consumed, touch));
        consumeFailure({ ...consumed, token: trappingProxy(f.token, touch) });
        consumeFailure({ ...consumed, lease: trappingProxy(f.lease, touch) });
        consumeFailure({ ...consumed, reservation: trappingProxy(reservation, touch) });

        for (const name of ['token', 'lease', 'uin', 'reservation'] as const) {
            const bad = { ...consumed };
            Object.defineProperty(bad, name, {
                get() {
                    touch();
                    return consumed[name];
                },
            });
            consumeFailure(bad);
        }

        expect(calls).toBe(0);
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        expect(consumeLinuxEasyKeySessionReservation(consumed)).toBeUndefined();
    });

    it('treats bound identities and unrelated properties as opaque, never invoking their getters', () => {
        let reads = 0;
        const lease = Object.defineProperty({}, 'unrelated', {
            get() {
                reads++;
                throw Error();
            },
        });
        const token = createLinuxEasyKeyCapability({ lease, uin: FIRST_UIN, generation: {} });
        const f: Fixture = { token, lease, uin: FIRST_UIN, key: new Uint8Array(16).fill(0x31) };
        fixtures.push(f);
        const args = Object.defineProperty(binding(f), 'extra', {
            get() {
                reads++;
                throw Error();
            },
        });
        const reservation = reserveLinuxEasyKeyForSession(args);
        const input = Object.defineProperty({ ...binding(f), reservation }, 'extra', {
            get() {
                reads++;
                throw Error();
            },
        });
        expect(consumeLinuxEasyKeySessionReservation(input)).toBeUndefined();
        expect(reads).toBe(0);
    });

    it.each(['tentative', 'active'] as const)(
        'rejects reserve or consume while %s without revoking or changing another proof',
        (phase) => {
            const reserved = makeFixture();
            const other = makeFixture(SECOND_UIN);
            const proof = reserveLinuxEasyKeyForSession(binding(reserved));
            const otherProof = reserveLinuxEasyKeyForSession(binding(other));
            stage(reserved);

            if (phase === 'active') {
                commit(reserved);
            }

            reserveFailure(binding(reserved));
            consumeFailure({ ...binding(reserved), reservation: proof });
            expect(linuxEasyKeyState(reserved.token)).toBe(phase);
            expect(linuxEasyKeyState(other.token)).toBe('empty');
            expect(
                consumeLinuxEasyKeySessionReservation({
                    ...binding(other),
                    reservation: otherProof,
                }),
            ).toBeUndefined();

            if (phase === 'tentative') {
                commit(reserved);
                expect(linuxEasyKeyState(reserved.token)).toBe('active');
            }
        },
    );

    it('checks tentative metadata without changing phase, ownership, or caller-owned key bytes', () => {
        const a = makeFixture();
        const b = makeFixture(SECOND_UIN);
        const sameUin = makeFixture();
        const proof = reserveLinuxEasyKeyForSession(binding(a));
        const proofB = reserveLinuxEasyKeyForSession(binding(b));
        const proofSame = reserveLinuxEasyKeyForSession(binding(sameUin));
        const args = { ...binding(a), sequence: SEQUENCE };

        const checkFailure = (input: unknown) => {
            expect(() => assertLinuxEasyKeyTentative(input as Tentative)).toThrow();
        };

        checkFailure(args);
        expect(linuxEasyKeyState(a.token)).toBe('empty');
        expect(
            consumeLinuxEasyKeySessionReservation({ ...binding(a), reservation: proof }),
        ).toBeUndefined();
        stage(a);
        stage(b);
        stage(sameUin);
        const invalid: unknown[] = [
            { ...args, token: {} },
            { ...args, token: b.token },
            { ...args, token: sameUin.token },
            { ...args, lease: {} },
            { ...args, lease: b.lease },
            { ...args, lease: sameUin.lease },
            { ...args, uin: b.uin },
            { ...args, uin: 123456 },
            ...[-1, 0, SEQUENCE + 1, 0x100000000, 1.5, NaN, '7', null].map((sequence) => ({
                ...args,
                sequence,
            })),
        ];

        for (const input of invalid) {
            checkFailure(input);
            expect(linuxEasyKeyState(a.token)).toBe('tentative');
            expect(linuxEasyKeyState(b.token)).toBe('tentative');
            expect(linuxEasyKeyState(sameUin.token)).toBe('tentative');
        }

        for (const f of [a, b, sameUin]) {
            const valid = { ...binding(f), sequence: SEQUENCE };
            expect(assertLinuxEasyKeyTentative(valid)).toBeUndefined();
            expect(assertLinuxEasyKeyTentative(valid)).toBeUndefined();
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
            expect(Array.from(f.key)).toEqual(
                new Array(16).fill(f.uin === FIRST_UIN ? 0x31 : 0x72),
            );
        }

        // Staging makes pending reservations unusable without changing the tentative phase.
        consumeFailure({ ...binding(b), reservation: proofB });
        consumeFailure({ ...binding(sameUin), reservation: proofSame });
        commit(a);
        checkFailure(args);
        expect(linuxEasyKeyState(a.token)).toBe('active');
        revokeLinuxEasyKey(b.token);
        checkFailure({ ...binding(b), sequence: SEQUENCE });
        expect(linuxEasyKeyState(b.token)).toBe('revoked');
        expect(
            assertLinuxEasyKeyTentative({ ...binding(sameUin), sequence: SEQUENCE }),
        ).toBeUndefined();
        commit(sameUin);
        expect(linuxEasyKeyState(sameUin.token)).toBe('active');
    });

    it('checks tentative input without invoking getters or proxy traps', () => {
        const f = makeFixture();
        stage(f);
        const args = { ...binding(f), sequence: SEQUENCE };
        let calls = 0;

        const touch = () => {
            calls++;
        };

        const checkFailure = (input: unknown) => {
            expect(() => assertLinuxEasyKeyTentative(input as Tentative)).toThrow();
        };

        checkFailure(trappingProxy(args, touch));
        checkFailure({ ...args, token: trappingProxy(f.token, touch) });
        checkFailure({ ...args, lease: trappingProxy(f.lease, touch) });
        checkFailure({ ...args, uin: trappingProxy({}, touch) });
        checkFailure({ ...args, sequence: trappingProxy({}, touch) });
        const opaque = Object.defineProperty({}, 'valueOf', {
            get() {
                touch();
                throw Error();
            },
        });
        checkFailure({ ...args, uin: opaque });
        checkFailure({ ...args, sequence: opaque });

        for (const name of ['token', 'lease', 'uin', 'sequence'] as const) {
            const bad = { ...args };
            Object.defineProperty(bad, name, {
                get() {
                    touch();
                    return args[name];
                },
            });
            checkFailure(bad);
        }

        const extra = Object.defineProperty({ ...args }, 'extra', {
            get() {
                touch();
                throw Error();
            },
        });
        expect(assertLinuxEasyKeyTentative(extra)).toBeUndefined();
        expect(calls).toBe(0);
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        commit(f);
        expect(linuxEasyKeyState(f.token)).toBe('active');
    });

    it('blocks reservation and consumption after revoke, before or after a successful consume', () => {
        const before = makeFixture();
        const pending = makeFixture();
        const consumed = makeFixture();
        const other = makeFixture(SECOND_UIN);
        const pendingProof = reserveLinuxEasyKeyForSession(binding(pending));
        const consumedProof = reserveLinuxEasyKeyForSession(binding(consumed));
        const otherProof = reserveLinuxEasyKeyForSession(binding(other));
        expect(
            consumeLinuxEasyKeySessionReservation({
                ...binding(consumed),
                reservation: consumedProof,
            }),
        ).toBeUndefined();

        for (const f of [before, pending, consumed]) {
            revokeLinuxEasyKey(f.token);
            reserveFailure(binding(f));
            expect(() => claimLinuxEasyKeyForLogin(binding(f))).toThrow();
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
        }

        consumeFailure({ ...binding(pending), reservation: pendingProof });
        consumeFailure({ ...binding(consumed), reservation: consumedProof });
        consumeFailure({ ...binding(other), reservation: pendingProof });
        expect(linuxEasyKeyState(other.token)).toBe('empty');
        expect(
            consumeLinuxEasyKeySessionReservation({ ...binding(other), reservation: otherProof }),
        ).toBeUndefined();
        stage(other);
        commit(other);
        expect(linuxEasyKeyState(other.token)).toBe('active');
    });
});
