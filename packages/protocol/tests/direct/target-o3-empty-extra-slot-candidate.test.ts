import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeTargetO3EmptyExtraSlotCandidate as place } from '../../src/direct/target-o3-empty-extra-slot-candidate';
import { placeTargetSignedDecimalMd5SlotCandidate as placeMd5 } from '../../src/direct/target-signed-decimal-md5-slot-candidate';

// Synthetic model only: the caller asserts the O3 empty-body branch. No branch
// reachability, actual target output, or complete signer is established here.
const OUTPUT_LENGTH = 0x300;
const GLOBAL_LENGTH = 160;
const ERROR = 'target O3 empty extra slot candidate failed';
const PRIVATE = 'synthetic-private-marker';
const originalSet = Uint8Array.prototype.set;
const originalFill = Uint8Array.prototype.fill;
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function outputFixture(): Uint8Array {
    return Uint8Array.from({ length: OUTPUT_LENGTH }, (_, i) => (i * 73 + 0x81) & 0xff);
}

function globalFixture(): Uint8Array {
    const globalState = new Uint8Array(GLOBAL_LENGTH);
    globalState[0] = 1;

    for (let i = 0; i < 32; i++) {
        globalState[0x28 + i] = i;
    }

    return globalState;
}

function expectedOutput(output: Uint8Array, globalState: Uint8Array): Uint8Array {
    const expected = Uint8Array.from(output);
    expected[0x100] = 0x0a;
    expected[0x101] = 0x20;

    for (let i = 0; i < 32; i++) {
        expected[0x102 + i] = globalState[0x28 + i];
    }

    expected[0x1ff] = 34;
    return expected;
}

function expectFailure(operation: () => unknown): void {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toBe(ERROR);
    expect(error.cause).toBeUndefined();
    expect(error.stack ?? '').not.toContain(PRIVATE);
}

function blocked(): never {
    throw new Error('unexpected effect');
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

describe('offline O3 empty-body extra slot candidate', () => {
    it('places 0a20 and the exact 00..1f vector while preserving every other byte', () => {
        const output = outputFixture();
        const globalState = globalFixture();
        const beforeOutput = Uint8Array.from(output);
        const beforeGlobal = Uint8Array.from(globalState);
        const result = place(output, globalState);
        expect(result).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(result)).toBe(false);
        expect(result).toHaveLength(0x300);
        expect(Buffer.from(result.subarray(0x100, 0x122)).toString('hex')).toBe(
            '0a20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        );
        expect(result[0x1ff]).toBe(34);
        expect(result).toEqual(expectedOutput(beforeOutput, beforeGlobal));
        expect(output).toEqual(beforeOutput);
        expect(globalState).toEqual(beforeGlobal);
        expect(result.buffer).not.toBe(output.buffer);
        expect(result.buffer).not.toBe(globalState.buffer);
    });

    it('accepts each individual nonzero position across all 160 global bytes', () => {
        const output = outputFixture();

        for (let i = 0; i < GLOBAL_LENGTH; i++) {
            const globalState = new Uint8Array(GLOBAL_LENGTH);
            globalState[i] = 0xa5;
            expect(place(output, globalState)).toEqual(expectedOutput(output, globalState));
        }
    });

    it('accepts a nonzero byte outside the selected field and copies 32 zero bytes', () => {
        for (const position of [0, 0x27, 0x48, 159]) {
            const globalState = new Uint8Array(GLOBAL_LENGTH);
            globalState[position] = 1;
            const output = outputFixture();
            const result = place(output, globalState);
            expect(result.subarray(0x100, 0x122)).toEqual(
                Uint8Array.of(0x0a, 0x20, ...new Uint8Array(32)),
            );
            expect(result).toEqual(expectedOutput(output, globalState));
        }
    });

    it('returns independent snapshots and leaves both input buffers untouched', () => {
        const output = outputFixture();
        const globalState = globalFixture();
        const beforeOutput = Uint8Array.from(output);
        const beforeGlobal = Uint8Array.from(globalState);
        const expected = expectedOutput(output, globalState);
        const a = place(output, globalState);
        const b = place(output, globalState);
        expect(a.buffer).not.toBe(b.buffer);
        expect(a.buffer).not.toBe(output.buffer);
        expect(a.buffer).not.toBe(globalState.buffer);
        a.fill(0x55);
        expect(b).toEqual(expected);
        expect(output).toEqual(beforeOutput);
        expect(globalState).toEqual(beforeGlobal);
        output.fill(0xee);
        globalState.fill(0xdd);
        expect(b).toEqual(expected);
    });

    it('accepts unaligned Buffer and Uint8Array subviews, preserving backing sentinels', () => {
        const backingOutput = Buffer.alloc(OUTPUT_LENGTH + 9, 0xe1);
        const backingGlobal = new Uint8Array(GLOBAL_LENGTH + 11).fill(0xe2);
        const output = backingOutput.subarray(3, 3 + OUTPUT_LENGTH);
        const globalState = backingGlobal.subarray(5, 5 + GLOBAL_LENGTH);
        output.set(outputFixture());
        globalState.set(globalFixture());
        const beforeOutput = Buffer.from(backingOutput);
        const beforeGlobal = Uint8Array.from(backingGlobal);
        const result = place(output, globalState);
        expect(result).toEqual(expectedOutput(output, globalState));
        expect(backingOutput).toEqual(beforeOutput);
        expect(backingGlobal).toEqual(beforeGlobal);
        expect(result.buffer).not.toBe(backingOutput.buffer);
        expect(result.buffer).not.toBe(backingGlobal.buffer);
    });

    it('accepts cross-realm views without reading hostile own accessors', () => {
        const output = runInNewContext(
            `new Uint8Array(${OUTPUT_LENGTH + 2}).map((_, i) => (i * 17 + 128) & 255).subarray(1, ${OUTPUT_LENGTH + 1})`,
        ) as Uint8Array;
        const globalState = runInNewContext(
            `new Uint8Array(${GLOBAL_LENGTH + 2}).subarray(1, ${GLOBAL_LENGTH + 1})`,
        ) as Uint8Array;
        globalState[0] = 1;

        for (let i = 0; i < 32; i++) {
            globalState[0x28 + i] = i;
        }

        const expected = expectedOutput(output, globalState);
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const value of [output, globalState]) {
            for (const key of [
                'length',
                'byteLength',
                'byteOffset',
                'buffer',
                'constructor',
                'set',
                'fill',
                Symbol.iterator,
                Symbol.toStringTag,
            ]) {
                Object.defineProperty(value, key, { get: trap, configurable: false });
            }

            Object.preventExtensions(value);
        }

        expect(place(output, globalState)).toEqual(expected);
        expect(trap).not.toHaveBeenCalled();
    });

    it('accepts zero output with valid global state and overlapping input views', () => {
        const globalState = globalFixture();
        const zero = new Uint8Array(OUTPUT_LENGTH);
        expect(place(zero, globalState)).toEqual(expectedOutput(zero, globalState));

        const backing = outputFixture();
        const sharedView = backing.subarray(0x100, 0x100 + GLOBAL_LENGTH);
        const before = Uint8Array.from(backing);
        const expected = expectedOutput(backing, sharedView);
        const result = place(backing, sharedView);
        expect(result).toEqual(expected);
        expect(result.buffer).not.toBe(backing.buffer);
        expect(backing).toEqual(before);
    });

    it('ignores inherited getters and proxy prototype traps on genuine views', () => {
        const output = outputFixture();
        const globalState = globalFixture();
        const expected = expectedOutput(output, globalState);
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        Object.setPrototypeOf(
            output,
            Object.create(Uint8Array.prototype, {
                length: { get: trap },
                buffer: { get: trap },
            }),
        );
        Object.setPrototypeOf(
            globalState,
            new Proxy(Uint8Array.prototype, {
                get: trap,
                getPrototypeOf: trap,
                ownKeys: trap,
                getOwnPropertyDescriptor: trap,
            }),
        );
        expect(place(output, globalState)).toEqual(expected);
        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects both zero output with zero global and nonzero output with zero global', () => {
        for (const output of [new Uint8Array(OUTPUT_LENGTH), outputFixture()]) {
            const before = Uint8Array.from(output);
            const globalState = new Uint8Array(GLOBAL_LENGTH);
            expectFailure(() => place(output, globalState));
            expect(output).toEqual(before);
            expect(globalState).toEqual(new Uint8Array(GLOBAL_LENGTH));
        }
    });

    it('rejects wrong sizes, wrong types, proxy and revoked proxy in either position', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        const proxy = new Proxy(new Uint8Array(OUTPUT_LENGTH), {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
        });
        const revoked = Proxy.revocable(new Uint8Array(GLOBAL_LENGTH), {});
        revoked.revoke();
        const common: unknown[] = [
            null,
            undefined,
            {},
            [],
            'private',
            0,
            new ArrayBuffer(160),
            new DataView(new ArrayBuffer(160)),
            new Uint8ClampedArray(160),
            new Int8Array(160),
            proxy,
            revoked.proxy,
        ];

        for (const value of common) {
            expectFailure(() => place(value as Uint8Array, globalFixture()));
            expectFailure(() => place(outputFixture(), value as Uint8Array));
        }

        for (const size of [0, 1, OUTPUT_LENGTH - 1, OUTPUT_LENGTH + 1]) {
            expectFailure(() => place(new Uint8Array(size), globalFixture()));
        }

        for (const size of [0, 1, GLOBAL_LENGTH - 1, GLOBAL_LENGTH + 1]) {
            expectFailure(() => place(outputFixture(), new Uint8Array(size)));
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects shared, detached and resizable out-of-bounds views in both positions', () => {
        for (const size of [OUTPUT_LENGTH, GLOBAL_LENGTH]) {
            const detached = new Uint8Array(size);
            structuredClone(detached.buffer, { transfer: [detached.buffer] });
            const backing = new ArrayBuffer(size, { maxByteLength: size + 1 });
            const oob = new Uint8Array(backing, 0, size);
            backing.resize(size - 1);
            const values = [
                new Uint8Array(new SharedArrayBuffer(size)),
                runInNewContext(`new Uint8Array(new SharedArrayBuffer(${size}))`) as Uint8Array,
                detached,
                oob,
            ];

            for (const value of values) {
                if (size === OUTPUT_LENGTH) {
                    expectFailure(() => place(value, globalFixture()));
                } else {
                    expectFailure(() => place(outputFixture(), value));
                }
            }
        }
    });

    it('composes the two independent candidate slots in either order without changing the token region', () => {
        const source = outputFixture();
        const globalState = globalFixture();
        const beforeSource = Uint8Array.from(source);
        const beforeGlobal = Uint8Array.from(globalState);
        const o3First = place(source, globalState);
        const both = placeMd5(o3First, 0xffffffff);
        const md5First = placeMd5(source, 0xffffffff);
        const reverse = place(md5First, globalState);
        const expected = expectedOutput(source, globalState);
        expected.set(Buffer.from('6bb61e3b7bce0931da574d19d1d82c88', 'hex'), 0x200);
        expected[0x2ff] = 16;
        expect(both).toEqual(expected);
        expect(reverse).toEqual(expected);
        expect(both[0x1ff]).toBe(34);
        expect(both[0x2ff]).toBe(16);
        expect(both.subarray(0, 0x100)).toEqual(source.subarray(0, 0x100));
        expect(source).toEqual(beforeSource);
        expect(globalState).toEqual(beforeGlobal);
        expect(o3First).toEqual(expectedOutput(source, globalState));
        expect(md5First.subarray(0x100, 0x200)).toEqual(source.subarray(0x100, 0x200));
    });

    it('sanitizes a snapshot-copy exception and attempts to clear owned copies', async () => {
        const output = outputFixture();
        const globalState = globalFixture();
        const beforeOutput = Uint8Array.from(output);
        const beforeGlobal = Uint8Array.from(globalState);
        const owned: Uint8Array[] = [];
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            bytes,
            offset,
        ) {
            originalSet.call(this, bytes, offset);

            if (
                this !== output &&
                this !== globalState &&
                (this.length === OUTPUT_LENGTH || this.length === GLOBAL_LENGTH)
            ) {
                owned.push(this);

                if (owned.length === 2) {
                    throw new Error(PRIVATE);
                }
            }
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-o3-empty-extra-slot-candidate');
            expectFailure(() => fresh.placeTargetO3EmptyExtraSlotCandidate(output, globalState));
        } finally {
            spy.mockRestore();
        }

        expect(owned).toHaveLength(2);

        for (const value of owned) {
            expect(value).toEqual(new Uint8Array(value.length));
        }

        expect(output).toEqual(beforeOutput);
        expect(globalState).toEqual(beforeGlobal);
    });

    it('clears the failed result and both snapshots after a partial third copy', async () => {
        const output = outputFixture();
        const globalState = globalFixture();
        const beforeOutput = Uint8Array.from(output);
        const beforeGlobal = Uint8Array.from(globalState);
        const owned: Uint8Array[] = [];
        const attempted: Uint8Array[] = [];
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            bytes,
            offset,
        ) {
            if (
                this !== output &&
                this !== globalState &&
                (this.length === OUTPUT_LENGTH || this.length === GLOBAL_LENGTH)
            ) {
                owned.push(this);

                if (owned.length === 3) {
                    const source = bytes as Uint8Array;
                    originalSet.call(this, source.subarray(0, 0x80), offset);
                    throw new Error(PRIVATE);
                }
            }

            originalSet.call(this, bytes, offset);
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (owned.includes(this)) {
                attempted.push(this);
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-o3-empty-extra-slot-candidate');
            expectFailure(() => fresh.placeTargetO3EmptyExtraSlotCandidate(output, globalState));
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
        }

        expect(owned).toHaveLength(3);
        expect(new Set(owned).size).toBe(3);
        expect(attempted).toHaveLength(3);

        for (const allocation of owned) {
            expect(attempted.some((entry) => entry === allocation)).toBe(true);
            expect(allocation).toEqual(new Uint8Array(allocation.length));
        }

        expect(output).toEqual(beforeOutput);
        expect(globalState).toEqual(beforeGlobal);
    });

    it('still attempts other cleanup and keeps the uniform error if a cleanup fails', async () => {
        const output = outputFixture();
        const globalState = globalFixture();
        const beforeOutput = Uint8Array.from(output);
        const beforeGlobal = Uint8Array.from(globalState);
        const owned: Uint8Array[] = [];
        const attempted: Uint8Array[] = [];
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            bytes,
            offset,
        ) {
            originalSet.call(this, bytes, offset);

            if (
                this !== output &&
                this !== globalState &&
                (this.length === OUTPUT_LENGTH || this.length === GLOBAL_LENGTH)
            ) {
                owned.push(this);

                if (owned.length === 2) {
                    throw new Error(PRIVATE);
                }
            }
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (owned.includes(this)) {
                attempted.push(this);

                if (this === owned[0]) {
                    throw new Error(PRIVATE);
                }
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-o3-empty-extra-slot-candidate');
            expectFailure(() => fresh.placeTargetO3EmptyExtraSlotCandidate(output, globalState));
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();

            for (const value of owned) {
                originalFill.call(value, 0);
            }
        }

        expect(owned).toHaveLength(2);
        expect(attempted).toHaveLength(2);
        expect(attempted).toContain(owned[0]);
        expect(attempted).toContain(owned[1]);
        expect(output).toEqual(beforeOutput);
        expect(globalState).toEqual(beforeGlobal);
    });

    it('preserves a successful result if owned temporary cleanup throws', async () => {
        const output = outputFixture();
        const globalState = globalFixture();
        const expected = expectedOutput(output, globalState);
        const attempted: Uint8Array[] = [];
        let clearedSecond = false;
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (this !== output && this !== globalState) {
                attempted.push(this);

                if (attempted.length === 1) {
                    throw new Error(PRIVATE);
                }
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-o3-empty-extra-slot-candidate');
            expect(fresh.placeTargetO3EmptyExtraSlotCandidate(output, globalState)).toEqual(
                expected,
            );

            if (attempted.length === 2) {
                clearedSecond = attempted[1].every((value) => value === 0);
            }
        } finally {
            spy.mockRestore();

            for (const value of attempted) {
                originalFill.call(value, 0);
            }
        }

        expect(attempted).toHaveLength(2);
        expect(attempted[0]).not.toBe(attempted[1]);
        expect(clearedSecond).toBe(true);
        expect(output).toEqual(outputFixture());
        expect(globalState).toEqual(globalFixture());
    });
});
