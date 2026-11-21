/// <reference lib="es2024.arraybuffer" />
import { describe, expect, it, vi } from 'vitest';
import {
    cloneWtPersistedSession,
    decodeWtPersistedSession,
    disposeWtPersistedSession,
    encodeWtPersistedSession,
    MAX_WT_PERSISTED_SESSION_BYTES,
    type WtPersistedSessionV1,
} from '../../src/direct/wt-persisted-session';

const fixture = (): WtPersistedSessionV1 => ({
    version: 1,
    uin: '123',
    uid: 'synthetic-uid-中🙂',
    guid: new Uint8Array(16).fill(3),
    tickets: {
        d2: Uint8Array.of(1, 2, 3),
        d2Key: new Uint8Array(16).fill(7),
        a1: Uint8Array.of(8, 9),
        a2: Uint8Array.of(10),
    },
});
const buffers = (value: WtPersistedSessionV1) => [value.guid, ...Object.values(value.tickets)];

describe('WT persisted binary credentials, using synthetic bytes only', () => {
    it('round trips strict UTF-8 and creates independent frozen records', () => {
        const input = fixture();
        const encoded = encodeWtPersistedSession(input);
        expect(Array.from(encoded.subarray(0, 8))).toEqual([0x4a, 0x59, 0x57, 0x54, 1, 0, 0, 0]);
        const decoded = decodeWtPersistedSession(encoded);
        expect(decoded).toEqual(input);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.tickets)).toBe(true);
        const cloned = cloneWtPersistedSession(decoded);

        buffers(input).forEach((buffer) => buffer.fill(0));
        encoded.fill(0);
        expect(decoded.tickets.d2[0]).toBe(1);
        expect(cloned.tickets.d2[0]).toBe(1);
        disposeWtPersistedSession(decoded);
        disposeWtPersistedSession(decoded);
        expect(buffers(decoded).every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
        expect(cloned.tickets.d2[0]).toBe(1);
        disposeWtPersistedSession(cloned);
    });

    it('preserves an initial BOM rather than silently normalizing an identity', () => {
        const input = { ...fixture(), uid: '\ufeffsynthetic' };
        const bytes = encodeWtPersistedSession(input);
        const result = decodeWtPersistedSession(bytes);
        expect(result.uid).toBe(input.uid);
        disposeWtPersistedSession(result);
        bytes.fill(0);
    });

    it('accepts bounded Buffer subviews without modifying adjacent bytes', () => {
        const parent = Buffer.alloc(22, 9);
        const input = { ...fixture(), guid: parent.subarray(3, 19) };
        const result = cloneWtPersistedSession(input);
        disposeWtPersistedSession(result);
        expect(parent.every((byte) => byte === 9)).toBe(true);
        disposeWtPersistedSession(input);
        expect(parent.subarray(3, 19).every((byte) => byte === 0)).toBe(true);
        expect(parent.subarray(0, 3).every((byte) => byte === 9)).toBe(true);
        expect(parent.subarray(19).every((byte) => byte === 9)).toBe(true);
    });

    it.each(['0', '01', '-1', '1.2', '4294967296', '1e3', '１２３', ''])(
        'rejects invalid UIN %j',
        (uin) => {
            expect(() => encodeWtPersistedSession({ ...fixture(), uin })).toThrow(
                'invalid WT persisted session',
            );
        },
    );

    it.each(['', '\ud800', '\udfff', 'a'.repeat(65536)])(
        'rejects malformed or oversized UID %#',
        (uid) => {
            expect(() => cloneWtPersistedSession({ ...fixture(), uid })).toThrow(
                'invalid WT persisted session',
            );
        },
    );

    it('validates every ticket and its exact or bounded length', () => {
        for (const name of ['d2', 'a1', 'a2'] as const) {
            for (const bytes of [new Uint8Array(), new Uint8Array(65536), 'bytes']) {
                const input = fixture();
                expect(() =>
                    cloneWtPersistedSession({
                        ...input,
                        tickets: { ...input.tickets, [name]: bytes },
                    }),
                ).toThrow('invalid WT persisted session');
            }
        }

        for (const size of [0, 15, 17]) {
            const input = fixture();
            expect(() =>
                cloneWtPersistedSession({ ...input, guid: new Uint8Array(size) }),
            ).toThrow();
            expect(() =>
                cloneWtPersistedSession({
                    ...input,
                    tickets: { ...input.tickets, d2Key: new Uint8Array(size) },
                }),
            ).toThrow();
        }

        expect(() => cloneWtPersistedSession({ ...fixture(), version: 2 })).toThrow();
        expect(() => cloneWtPersistedSession({ ...fixture(), extra: true })).toThrow();
    });

    it('checks maximal aggregate size before decoding and accepts the defined maximum', () => {
        const input = fixture();
        const maximal = {
            ...input,
            uin: '4294967295',
            uid: 'a'.repeat(65535),
            tickets: {
                ...input.tickets,
                d2: new Uint8Array(65535),
                a1: new Uint8Array(65535),
                a2: new Uint8Array(65535),
            },
        };
        const bytes = encodeWtPersistedSession(maximal);
        expect(bytes.length).toBe(MAX_WT_PERSISTED_SESSION_BYTES);
        expect(MAX_WT_PERSISTED_SESSION_BYTES).toBeLessThanOrEqual(1024 * 1024);
        const decoded = decodeWtPersistedSession(bytes);
        expect(decoded.uin).toBe('4294967295');
        disposeWtPersistedSession(decoded);
        bytes.fill(0);
        expect(() =>
            decodeWtPersistedSession(new Uint8Array(MAX_WT_PERSISTED_SESSION_BYTES + 1)),
        ).toThrow();
    });

    it('rejects proxy/getter/inherited or symbol-bearing records without evaluating them', () => {
        const trap = vi.fn(() => {
            throw new Error('trap');
        });
        const input = fixture();
        const getter = Object.defineProperty({ ...input }, 'uid', { get: trap });
        const bad = [
            new Proxy(input, { ownKeys: trap, get: trap, getPrototypeOf: trap }),
            getter,
            Object.create(input) as unknown,
            { ...input, [Symbol('hidden')]: true },
            { ...input, tickets: Object.defineProperty({ ...input.tickets }, 'd2', { get: trap }) },
        ];

        for (const value of bad) {
            expect(() => cloneWtPersistedSession(value)).toThrow('invalid WT persisted session');
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects shared/resizable/detached and accessor-decorated bytes', () => {
        const getter = vi.fn(() => 16);
        const decorated = Object.defineProperty(new Uint8Array(16), 'byteLength', { get: getter });
        const detached = new Uint8Array(16);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const inputs = [
            new Uint8Array(new SharedArrayBuffer(16)),
            new Uint8Array(new ArrayBuffer(16, { maxByteLength: 32 })),
            detached,
            decorated,
            new Proxy(new Uint8Array(16), { get: getter }),
        ];

        for (const guid of inputs) {
            expect(() => cloneWtPersistedSession({ ...fixture(), guid })).toThrow(
                'invalid WT persisted session',
            );
        }

        expect(getter).not.toHaveBeenCalled();
    });

    it('rejects magic, version, reserved, length, truncation, trailing and malformed UTF-8', () => {
        const original = encodeWtPersistedSession({ ...fixture(), uid: 'abc' });
        const bad: Uint8Array[] = [];

        for (const offset of [0, 4, 5, 6, 7]) {
            const bytes = original.slice();
            bytes[offset] ^= 1;
            bad.push(bytes);
        }

        const badLength = original.slice();
        new DataView(badLength.buffer).setUint32(12, 0xffffffff, false);
        bad.push(badLength);
        const invalidUtf8 = original.slice();
        invalidUtf8[36 + 3] = 0xff;
        bad.push(invalidUtf8);
        bad.push(original.subarray(0, original.length - 1));
        bad.push(Uint8Array.from([...original, 0]));
        bad.push(new Uint8Array(35));

        for (const bytes of bad) {
            expect(() => decodeWtPersistedSession(bytes)).toThrow('invalid WT persisted session');
        }

        const result = decodeWtPersistedSession(original);
        expect(result.uid).toBe('abc');
        disposeWtPersistedSession(result);
        original.fill(0);
    });
});
