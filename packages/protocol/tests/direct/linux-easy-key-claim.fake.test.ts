import { describe, expect, it } from 'vitest';
import {
    claimLinuxEasyKeyForLogin,
    commitLinuxEasyKey,
    createLinuxEasyKeyCapability,
    linuxEasyKeyState,
    revokeLinuxEasyKey,
    stageLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';

// Synthetic identities and bytes only. No transport or peer identity is checked here.
const UIN = '123456';
const OTHER_UIN = '234567';
const ERROR = 'invalid Linux EasyLogin key capability';
type ClaimInput = Parameters<typeof claimLinuxEasyKeyForLogin>[0];

function fixture(uin = UIN, generation: object = {}) {
    const lease = {};
    const token = createLinuxEasyKeyCapability({ lease, uin, generation });
    return { token, lease, uin };
}

function expectFailure(input: unknown): void {
    expect(() => claimLinuxEasyKeyForLogin(input as ClaimInput)).toThrowError(new Error(ERROR));
}

function stage(input: ClaimInput): void {
    const key = new Uint8Array(16).fill(0x31);

    try {
        stageLinuxEasyKey({ ...input, sequence: 7, key });
    } finally {
        key.fill(0);
    }
}

function commit(input: ClaimInput): void {
    const comparisonKey = new Uint8Array(16).fill(0x31);

    try {
        commitLinuxEasyKey({ ...input, sequence: 7, comparisonKey });
    } finally {
        comparisonKey.fill(0);
    }
}

describe('Linux easy key login claim with synthetic identities', () => {
    it('claims once without changing phase and still allows stage and commit', () => {
        const f = fixture();
        expect(claimLinuxEasyKeyForLogin(f)).toBeUndefined();
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        expectFailure(f);
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        stage(f);
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        expectFailure(f);
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        commit(f);
        expect(linuxEasyKeyState(f.token)).toBe('active');
        expectFailure(f);
        expect(linuxEasyKeyState(f.token)).toBe('active');
        revokeLinuxEasyKey(f.token);
        expectFailure(f);
        expect(linuxEasyKeyState(f.token)).toBe('revoked');
    });

    it('rejects each invalid account while leaving the exact claim available', () => {
        const invalid = [
            '',
            '0',
            '01',
            '+1',
            '-1',
            ' 123456',
            '123456 ',
            '123456.0',
            '4294967296',
            '123x',
            OTHER_UIN,
            null,
            123456,
        ];

        for (const uin of invalid) {
            const f = fixture();
            expectFailure({ ...f, uin });
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(claimLinuxEasyKeyForLogin(f)).toBeUndefined();
            expectFailure(f);
            revokeLinuxEasyKey(f.token);
        }

        for (const uin of ['1', '4294967295']) {
            const f = fixture(uin);
            expect(claimLinuxEasyKeyForLogin(f)).toBeUndefined();
            revokeLinuxEasyKey(f.token);
        }
    });

    it('rejects wrong and proxied tokens or leases without consuming either account', () => {
        const a = fixture();
        const b = fixture(OTHER_UIN);
        const sameAccount = fixture(UIN);
        const invalid = [
            { ...a, token: {} },
            { ...a, token: null },
            { ...a, token: new Proxy(a.token, {}) },
            { ...a, lease: {} },
            { ...a, lease: null },
            { ...a, lease: new Proxy(a.lease, {}) },
            { ...a, token: b.token },
            { ...a, lease: b.lease },
            { ...a, lease: sameAccount.lease },
            { ...a, token: sameAccount.token },
            { token: a.token, lease: b.lease, uin: b.uin },
            { token: b.token, lease: a.lease, uin: a.uin },
        ];

        for (const input of invalid) {
            expectFailure(input);
            expect(linuxEasyKeyState(a.token)).toBe('empty');
            expect(linuxEasyKeyState(b.token)).toBe('empty');
            expect(linuxEasyKeyState(sameAccount.token)).toBe('empty');
        }

        for (const f of [a, b, sameAccount]) {
            expect(claimLinuxEasyKeyForLogin(f)).toBeUndefined();
            expectFailure(f);
            revokeLinuxEasyKey(f.token);
        }
    });

    it('does not alter tentative, active or revoked slots when an unclaimed slot is claimed', () => {
        for (const phase of ['tentative', 'active', 'revoked'] as const) {
            const f = fixture();
            const other = fixture(OTHER_UIN);

            if (phase === 'revoked') {
                revokeLinuxEasyKey(f.token);
            } else {
                stage(f);

                if (phase === 'active') {
                    commit(f);
                }
            }

            expect(linuxEasyKeyState(f.token)).toBe(phase);
            expectFailure(f);
            expect(linuxEasyKeyState(f.token)).toBe(phase);
            expect(linuxEasyKeyState(other.token)).toBe('empty');
            expect(claimLinuxEasyKeyForLogin(other)).toBeUndefined();
            expectFailure(other);

            if (phase === 'tentative') {
                commit(f);
                expect(linuxEasyKeyState(f.token)).toBe('active');
            }

            revokeLinuxEasyKey(f.token);
            revokeLinuxEasyKey(other.token);
        }
    });

    it('rejects accessor fields without reading them and preserves a later valid claim', () => {
        for (const name of ['token', 'lease', 'uin'] as const) {
            const f = fixture();
            let reads = 0;
            const bad = { ...f };
            Object.defineProperty(bad, name, {
                get() {
                    reads++;
                    return f[name];
                },
            });
            expectFailure(bad);
            expect(reads).toBe(0);
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(claimLinuxEasyKeyForLogin(f)).toBeUndefined();
            expectFailure(f);
            revokeLinuxEasyKey(f.token);
        }
    });

    it('rejects proxy records without invoking traps and preserves a later valid claim', () => {
        const f = fixture();
        let traps = 0;
        const proxy = new Proxy(f, {
            get(target, property, receiver) {
                traps++;
                return Reflect.get(target, property, receiver);
            },
            getPrototypeOf(target) {
                traps++;
                return Reflect.getPrototypeOf(target);
            },
            getOwnPropertyDescriptor(target, property) {
                traps++;
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });
        expectFailure(proxy);
        expect(traps).toBe(0);
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        expect(claimLinuxEasyKeyForLogin(f)).toBeUndefined();
        expectFailure(f);
        revokeLinuxEasyKey(f.token);
    });

    it('rejects absent and inherited fields without consuming the token', () => {
        for (const name of ['token', 'lease', 'uin'] as const) {
            const f = fixture();
            const bad: Partial<ClaimInput> = { ...f };
            delete bad[name];
            expectFailure(bad);
            expectFailure(Object.assign(Object.create({ [name]: f[name] }), bad));
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(claimLinuxEasyKeyForLogin(f)).toBeUndefined();
            revokeLinuxEasyKey(f.token);
        }
    });

    it('retains generation identity without interpreting it or validating freshness', () => {
        let reads = 0;
        const generation = Object.defineProperty({}, 'current', {
            get() {
                reads++;
                throw new Error('generation must remain opaque');
            },
        });
        const a = fixture(UIN, generation);
        const b = fixture(OTHER_UIN, generation);
        expect(claimLinuxEasyKeyForLogin(a)).toBeUndefined();
        expect(claimLinuxEasyKeyForLogin(b)).toBeUndefined();
        expect(reads).toBe(0);
        revokeLinuxEasyKey(a.token);
        revokeLinuxEasyKey(b.token);
    });
});
