import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { targetSignPresenceMaskCandidate as presence } from '../../src/direct/target-sign-presence-candidate';

// Local synthetic model only: this does not establish a real signature, wire
// format, tag, QQ interoperability, or the native callback's actual identity.
const ERROR = 'target sign presence mask candidate failed';
const PRIVATE = 'synthetic-private-marker';
const COMBINATIONS = [
    [false, false, false, 0x00],
    [true, false, false, 0x01],
    [false, true, false, 0x02],
    [true, true, false, 0x03],
    [false, false, true, 0x04],
    [true, false, true, 0x05],
    [false, true, true, 0x06],
    [true, true, true, 0x07],
] as const;

let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function blocked(): never {
    throw new Error('unexpected effect');
}

function expectFailure(operation: () => unknown): void {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(ERROR);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).stack ?? '').not.toContain(PRIVATE);
}

function withInvalidSlot(index: number, value: unknown, mask = 0): number {
    const fields: unknown[] = [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)];
    fields[index] = value;
    return presence(
        fields[0] as Uint8Array,
        fields[1] as Uint8Array,
        fields[2] as Uint8Array,
        mask,
    );
}

beforeEach(() => {
    guards = [
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const fetch = vi.fn(blocked);
    const webSocket = vi.fn(blocked);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', webSocket);
    guards.push(fetch, webSocket);
    syncBuiltinESMExports();
});

afterEach(() => {
    try {
        for (const guard of guards) {
            expect(guard.mock.calls).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        syncBuiltinESMExports();
        guards = [];
    }
});

describe('offline target sign presence mask candidate', () => {
    it.each(COMBINATIONS)(
        'maps sign=%s token=%s extra=%s to 0x%s even when present bytes are zero',
        (hasSign, hasToken, hasExtra, expected) => {
            const sign = hasSign ? Uint8Array.of(0) : new Uint8Array(0);
            const token = hasToken ? Uint8Array.of(0) : new Uint8Array(0);
            const extra = hasExtra ? Uint8Array.of(0) : new Uint8Array(0);
            expect(presence(sign, token, extra, 0)).toBe(expected);
        },
    );

    it('preserves every initially set bit for all 256 masks and all eight combinations', () => {
        for (const [hasSign, hasToken, hasExtra, bits] of COMBINATIONS) {
            const sign = new Uint8Array(hasSign ? 1 : 0);
            const token = new Uint8Array(hasToken ? 1 : 0);
            const extra = new Uint8Array(hasExtra ? 1 : 0);

            for (let initial = 0; initial <= 0xff; initial++) {
                const result = presence(sign, token, extra, initial);
                expect(result).toBe(initial | bits);
                expect(result & initial).toBe(initial);
            }
        }
    });

    it('uses view lengths only and leaves even overlapping inputs and their backing intact', () => {
        const backing = Uint8Array.of(0xaa, 0x00, 0x44, 0xbb);
        const before = Uint8Array.from(backing);
        const sign = backing.subarray(1, 2);
        const token = backing.subarray(1, 3);
        const extra = backing.subarray(2, 2);
        const result = presence(sign, token, extra, 0x80);

        expect(result).toBe(0x83);
        expect(typeof result).toBe('number');
        expect(backing).toEqual(before);
        expect(presence(sign, sign, sign, 0)).toBe(0x07);
        expect(backing).toEqual(before);

        // A returned number retains no alias to any input or backing store.
        backing.fill(0xff);
        expect(result).toBe(0x83);
        expect(presence(Uint8Array.of(0xff), Uint8Array.of(0, 0), new Uint8Array(0), 0x80)).toBe(
            result,
        );
    });

    it('places no slot-size ceiling on otherwise-valid inputs', () => {
        const sign = new Uint8Array(0x100);
        const token = new Uint8Array(0x301);
        const extra = new Uint8Array(0x10000);
        expect(presence(sign, token, extra, 0x80)).toBe(0x87);
    });

    it('does not advance the validation iterator or read elements through it', () => {
        const sign = Uint8Array.of(0);
        const empty = new Uint8Array(0);
        const iteratorPrototype = Object.getPrototypeOf(sign.values()) as object;
        const originalNext = Object.getOwnPropertyDescriptor(iteratorPrototype, 'next')!;
        let hits = 0;
        let result: number | undefined;

        try {
            Object.defineProperty(iteratorPrototype, 'next', {
                ...originalNext,
                value: () => {
                    hits++;
                    throw new Error(PRIVATE);
                },
            });
            result = presence(sign, empty, empty, 0x40);
        } finally {
            Object.defineProperty(iteratorPrototype, 'next', originalNext);
        }

        expect(result).toBe(0x41);
        expect(hits).toBe(0);
    });

    it('accepts Buffer, unaligned subviews, and cross-realm arrays independently in every slot', () => {
        const buffer = Buffer.from([0x7f, 0, 0x7f]).subarray(1, 2);
        const view = new Uint8Array([0x7f, 0x7f, 0, 0x7f]).subarray(2, 3);
        const foreign = runInNewContext(
            'new Uint8Array([0x7f, 0, 0x7f]).subarray(1, 2)',
        ) as Uint8Array;
        const foreignEmpty = runInNewContext('new Uint8Array(0)') as Uint8Array;
        const empty = new Uint8Array(0);
        const originals = [buffer, view, foreign].map((value) => Array.from(value));

        expect(foreign instanceof Uint8Array).toBe(false);

        for (const item of [buffer, view, foreign]) {
            expect(presence(item, empty, empty, 0)).toBe(1);
            expect(presence(empty, item, empty, 0)).toBe(2);
            expect(presence(empty, empty, item, 0)).toBe(4);
        }

        expect(presence(buffer, view, foreign, 0x10)).toBe(0x17);
        expect(presence(foreignEmpty, empty, empty, 0xa5)).toBe(0xa5);
        expect([buffer, view, foreign].map((value) => Array.from(value))).toEqual(originals);
    });

    it('accepts valid resizable-buffer views including zero-length boundary views', () => {
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const fixed = new Uint8Array(backing, 1, 2);
        const tracking = new Uint8Array(backing, 3);
        const emptyAtBoundary = new Uint8Array(backing, 4, 0);
        backing.resize(4);
        expect(presence(fixed, tracking, emptyAtBoundary, 0)).toBe(3);
        backing.resize(3);
        expect(presence(fixed, tracking, new Uint8Array(0), 0)).toBe(1);
    });

    it('ignores hostile own accessors and methods on each genuine input', () => {
        const views = [
            Buffer.from([0]),
            new Uint8Array(0),
            runInNewContext('new Uint8Array([0])') as Uint8Array,
        ];
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const view of views) {
            for (const key of [
                'length',
                'byteLength',
                'byteOffset',
                'buffer',
                'constructor',
                'values',
                'set',
                'subarray',
                'valueOf',
                'toString',
                Symbol.iterator,
                Symbol.toStringTag,
                Symbol.toPrimitive,
            ]) {
                Object.defineProperty(view, key, { get: trap, configurable: false });
            }

            Object.preventExtensions(view);
        }

        expect(presence(views[0], views[1], views[2], 0)).toBe(5);
        expect(trap).not.toHaveBeenCalled();
    });

    it('keeps using captured intrinsics after their public properties are replaced', () => {
        const sign = Uint8Array.of(0);
        const empty = new Uint8Array(0);
        const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
        const properties: Array<[object, PropertyKey]> = [
            [typedPrototype, 'buffer'],
            [typedPrototype, 'byteLength'],
            [typedPrototype, 'values'],
            [ArrayBuffer.prototype, 'byteLength'],
            [Reflect, 'apply'],
            [Number, 'isInteger'],
        ];
        const originals = properties.map(([owner, key]) =>
            Object.getOwnPropertyDescriptor(owner, key)!,
        );
        let hits = 0;

        const poison = () => {
            hits++;
            throw new Error(PRIVATE);
        };

        let result: number | undefined;

        try {
            properties.forEach(([owner, key], index) => {
                const descriptor = originals[index];
                Object.defineProperty(
                    owner,
                    key,
                    descriptor.get
                        ? { ...descriptor, get: poison }
                        : { ...descriptor, value: poison },
                );
            });
            result = presence(sign, empty, empty, 0x80);
        } finally {
            properties.forEach(([owner, key], index) =>
                Object.defineProperty(owner, key, originals[index]),
            );
        }

        expect(result).toBe(0x81);
        expect(hits).toBe(0);
    });

    it('rejects proxies, revoked proxies, fake views and other types in each slot without invoking traps', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        const proxy = new Proxy(new Uint8Array(1), {
            get: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
            ownKeys: trap,
            has: trap,
        });
        const revoked = Proxy.revocable(new Uint8Array(1), {});
        revoked.revoke();
        const fake = Object.create(Uint8Array.prototype) as object;
        Object.defineProperty(fake, Symbol.toStringTag, { get: trap });
        Object.defineProperty(fake, 'buffer', { get: trap });
        const foreignFake = runInNewContext('Object.create(Uint8Array.prototype)') as object;
        const invalid: unknown[] = [
            proxy,
            new Proxy(Buffer.from([0]), { get: trap }),
            revoked.proxy,
            fake,
            foreignFake,
            null,
            undefined,
            {},
            [],
            'private',
            1,
            false,
            new ArrayBuffer(1),
            new DataView(new ArrayBuffer(1)),
            new Uint8ClampedArray(1),
            new Int8Array(1),
            new Uint16Array(1),
            new Float32Array(1),
        ];

        for (let slot = 0; slot < 3; slot++) {
            for (const value of invalid) {
                expectFailure(() => withInvalidSlot(slot, value));
                // Even an already-full mask must validate every field.
                expectFailure(() => withInvalidSlot(slot, value, 0xff));
            }
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects shared backing, detached views, and fixed or tracking OOB views in each slot', () => {
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const detachedEmpty = new Uint8Array(0);
        structuredClone(detachedEmpty.buffer, { transfer: [detachedEmpty.buffer] });
        const foreignDetached = runInNewContext('new Uint8Array(1)') as Uint8Array;
        const foreignBuffer = foreignDetached.buffer as ArrayBuffer;
        structuredClone(foreignBuffer, { transfer: [foreignBuffer] });
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const fixedOob = new Uint8Array(backing, 2, 6);
        const trackingOob = new Uint8Array(backing, 7);
        backing.resize(1);
        const foreignOob = runInNewContext(`
            const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
            const view = new Uint8Array(buffer, 1, 3);
            buffer.resize(1);
            view;
        `) as Uint8Array;
        const invalid = [
            new Uint8Array(new SharedArrayBuffer(0)),
            new Uint8Array(new SharedArrayBuffer(2)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(2))') as Uint8Array,
            detached,
            detachedEmpty,
            foreignDetached,
            fixedOob,
            trackingOob,
            foreignOob,
        ];

        for (let slot = 0; slot < 3; slot++) {
            for (const value of invalid) {
                expectFailure(() => withInvalidSlot(slot, value));
            }
        }
    });

    it('rejects every invalid initial mask without coercion or input disclosure', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        const hostile = { valueOf: trap, toString: trap, [Symbol.toPrimitive]: trap };
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const invalid: unknown[] = [
            -1,
            -0.5,
            0.5,
            255.5,
            256,
            Number.MAX_SAFE_INTEGER,
            NaN,
            Infinity,
            -Infinity,
            1n,
            '1',
            true,
            null,
            undefined,
            Symbol(PRIVATE),
            new Number(1),
            hostile,
            new Proxy(hostile, { get: trap }),
            revoked.proxy,
        ];
        const empty = new Uint8Array(0);

        for (const mask of invalid) {
            expectFailure(() => presence(empty, empty, empty, mask as number));
        }

        expect(presence(empty, empty, empty, -0)).toBe(0);
        expect(presence(empty, empty, empty, 255)).toBe(255);
        expect(trap).not.toHaveBeenCalled();
    });
});
