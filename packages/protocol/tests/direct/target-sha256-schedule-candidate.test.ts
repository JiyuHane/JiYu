import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import * as builtinTypes from 'node:util/types';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Candidate = (block: Uint8Array) => Uint32Array;
type Guard = { mock: { calls: readonly unknown[] } };
type ResizableBuffer = ArrayBuffer & { resize(length: number): void };
type ResizableBufferConstructor = new (
    length: number,
    options: { maxByteLength: number },
) => ResizableBuffer;

const INPUT_ERROR = 'invalid SHA-256 schedule candidate input';
const PRIVATE_MARKER = 'private-synthetic-input-do-not-echo';
const INITIAL_HASH = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

// Published SHA-256 abc message-schedule words, independent of the candidate.
// This is a mathematical fixture, not a measurement of a native target.
const ABC_PREFIX = [
    0x61626380, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00000018, 0x61626380, 0x000f0000,
    0x7da86405, 0x600003c6, 0x3e9d7b78, 0x0183fc00,
] as const;

let candidate: Candidate;
let guards: Array<{ name: string; guard: Guard }> = [];

function blockedEffect(): never {
    throw new Error('unexpected side effect');
}

function captureError(operation: () => unknown): unknown {
    try {
        operation();
        return undefined;
    } catch (error) {
        return error;
    }
}

function invalid(input: unknown): void {
    const reference = captureError(() => candidate(new Uint8Array(63)));
    const caught = captureError(() => candidate(input as Uint8Array));
    expect(reference).toBeInstanceOf(TypeError);
    expect(caught).toBeInstanceOf(TypeError);
    const error = caught as Error;
    expect(error.message).toBe(INPUT_ERROR);
    expect(error.message).toBe((reference as Error).message);
    expect(error.message).not.toContain(PRIVATE_MARKER);
    expect(error.stack ?? '').not.toContain(PRIVATE_MARKER);
    expect(error.cause).toBeUndefined();
}

function abcBlock(): Uint8Array {
    const block = new Uint8Array(64);
    block.set([0x61, 0x62, 0x63, 0x80]);
    block[63] = 24;
    return block;
}

// A fixed-seed generator makes varied synthetic byte fixtures reproducible; it
// is neither a randomness test nor a source of secrets.
function fixtureBytes(length: number, seed: number): Uint8Array {
    let state = seed >>> 0;
    const result = new Uint8Array(length);

    for (let index = 0; index < length; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        result[index] = state >>> 24;
    }

    return result;
}

// The schedule under test is NOT repeated here. Derive the standard round
// constants exactly from integer cube roots of the first 64 primes, then feed
// the candidate's words into an otherwise independent SHA-256 compression model.
// Comparing its digest with Node crypto checks all supplied words indirectly.
function floorCbrt(value: bigint): bigint {
    let lower = 0n;
    // The largest input is 311 << 96, whose cube root is below 2^35.
    let upper = 1n << 35n;

    while (lower + 1n < upper) {
        const middle = (lower + upper) >> 1n;

        if (middle * middle * middle <= value) {
            lower = middle;
        } else {
            upper = middle;
        }
    }

    return lower;
}

function roundConstants(): number[] {
    const constants: number[] = [];

    // The 64th prime is 311; the loop and cube-root search are both bounded.
    for (let n = 2; n <= 311 && constants.length < 64; n++) {
        let prime = true;

        for (let divisor = 2; divisor * divisor <= n; divisor++) {
            if (n % divisor === 0) {
                prime = false;
                break;
            }
        }

        if (prime) {
            constants.push(Number(floorCbrt(BigInt(n) << 96n) & 0xffffffffn));
        }
    }

    if (constants.length !== 64) {
        throw new Error('round constant fixture generation failed');
    }

    return constants;
}

function rotateRight(value: number, shift: number): number {
    return (value >>> shift) | (value << (32 - shift));
}

function digestUsingCandidate(message: Uint8Array, constants: readonly number[]): string {
    const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(message);
    padded[message.length] = 0x80;
    new DataView(padded.buffer).setBigUint64(paddedLength - 8, BigInt(message.length) * 8n, false);
    const before = padded.slice();
    const hash: number[] = [...INITIAL_HASH];

    for (let offset = 0; offset < paddedLength; offset += 64) {
        const words = candidate(padded.subarray(offset, offset + 64));
        expect(words).toBeInstanceOf(Uint32Array);
        expect(words.length).toBe(64);
        let [a, b, c, d, e, f, g, h] = hash;

        for (let round = 0; round < 64; round++) {
            const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const first =
                (h + (bigSigma1 >>> 0) + (choice >>> 0) + constants[round] + words[round]) >>> 0;
            const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const second = ((bigSigma0 >>> 0) + (majority >>> 0)) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + first) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (first + second) >>> 0;
        }

        const working = [a, b, c, d, e, f, g, h];

        for (let index = 0; index < 8; index++) {
            hash[index] = (hash[index] + working[index]) >>> 0;
        }
    }

    expect(padded).toEqual(before);
    return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

beforeEach(async () => {
    vi.resetModules();
    guards = [
        { name: 'net.connect', guard: vi.spyOn(net, 'connect').mockImplementation(blockedEffect) },
        {
            name: 'net.createConnection',
            guard: vi.spyOn(net, 'createConnection').mockImplementation(blockedEffect),
        },
        {
            name: 'net.createServer',
            guard: vi.spyOn(net, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'net.Socket.connect',
            guard: vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blockedEffect),
        },
        {
            name: 'net.Server.listen',
            guard: vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blockedEffect),
        },
        {
            name: 'http.request',
            guard: vi.spyOn(http, 'request').mockImplementation(blockedEffect),
        },
        { name: 'http.get', guard: vi.spyOn(http, 'get').mockImplementation(blockedEffect) },
        {
            name: 'http.createServer',
            guard: vi.spyOn(http, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'https.request',
            guard: vi.spyOn(https, 'request').mockImplementation(blockedEffect),
        },
        { name: 'https.get', guard: vi.spyOn(https, 'get').mockImplementation(blockedEffect) },
        {
            name: 'https.createServer',
            guard: vi.spyOn(https, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'http2.connect',
            guard: vi.spyOn(http2, 'connect').mockImplementation(blockedEffect),
        },
        {
            name: 'http2.createServer',
            guard: vi.spyOn(http2, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'http2.createSecureServer',
            guard: vi.spyOn(http2, 'createSecureServer').mockImplementation(blockedEffect),
        },
        { name: 'tls.connect', guard: vi.spyOn(tls, 'connect').mockImplementation(blockedEffect) },
        {
            name: 'tls.createServer',
            guard: vi.spyOn(tls, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.createSocket',
            guard: vi.spyOn(dgram, 'createSocket').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.bind',
            guard: vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.connect',
            guard: vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.send',
            guard: vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blockedEffect),
        },
        {
            name: 'process.dlopen',
            guard: vi.spyOn(process, 'dlopen').mockImplementation(blockedEffect),
        },
        { name: 'console.log', guard: vi.spyOn(console, 'log').mockImplementation(() => {}) },
        { name: 'console.info', guard: vi.spyOn(console, 'info').mockImplementation(() => {}) },
        { name: 'console.warn', guard: vi.spyOn(console, 'warn').mockImplementation(() => {}) },
        { name: 'console.error', guard: vi.spyOn(console, 'error').mockImplementation(() => {}) },
        { name: 'console.debug', guard: vi.spyOn(console, 'debug').mockImplementation(() => {}) },
        {
            name: 'process.stdout.write',
            guard: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
        },
        {
            name: 'process.stderr.write',
            guard: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
        },
    ];
    const fetchGuard = vi.fn(blockedEffect);
    const webSocketGuard = vi.fn(blockedEffect);
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards.push({ name: 'fetch', guard: fetchGuard }, { name: 'WebSocket', guard: webSocketGuard });
    syncBuiltinESMExports();
    candidate = (await import('../../src/direct/target-sha256-schedule-candidate'))
        .targetSha256ScheduleCandidate;
});

afterEach(() => {
    try {
        for (const { name, guard } of guards) {
            expect(guard.mock.calls, name).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        vi.unstubAllGlobals();
        guards = [];
    }
});

describe('offline SHA-256 block schedule synthetic model', () => {
    it('expands an all-zero block to 64 zero words', () => {
        const input = new Uint8Array(64);
        const result = candidate(input);
        expect(result).toBeInstanceOf(Uint32Array);
        expect(result).toEqual(new Uint32Array(64));
        expect(input).toEqual(new Uint8Array(64));
    });

    it('matches the known abc message block and its early schedule words', () => {
        const block = abcBlock();
        const before = block.slice();
        const result = candidate(block);
        expect(result.length).toBe(64);
        expect(Array.from(result.subarray(0, ABC_PREFIX.length))).toEqual(ABC_PREFIX);
        expect(block).toEqual(before);
    });

    it('reads all first 16 words as big-endian, including a non-aligned view', () => {
        const block = fixtureBytes(64, 0x2468ace0);
        const backing = new Uint8Array(79).fill(0xa5);
        backing.set(block, 7);
        const before = backing.slice();
        const view = backing.subarray(7, 71);
        const firstWords = new DataView(block.buffer, block.byteOffset, block.byteLength);
        const result = candidate(view);

        for (let index = 0; index < 16; index++) {
            expect(result[index]).toBe(firstWords.getUint32(index * 4, false));
        }

        expect(backing).toEqual(before);
    });

    it('feeds its words into an independent SHA-256 compressor matching Node crypto', () => {
        const constants = roundConstants();
        expect(constants.slice(0, 4)).toEqual([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5]);
        expect(constants[63]).toBe(0xc67178f2);
        const messages = [
            new Uint8Array(0),
            Uint8Array.of(0x61, 0x62, 0x63),
            ...[1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 257].map((length) =>
                fixtureBytes(length, 0x9e3779b9 ^ length),
            ),
        ];

        for (const message of messages) {
            const before = message.slice();
            const expected = createHash('sha256').update(message).digest('hex');
            expect(digestUsingCandidate(message, constants)).toBe(expected);
            expect(message).toEqual(before);
        }

        expect(createHash('sha256').update('abc', 'ascii').digest('hex')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
        expect(fixtureBytes(129, 123)).toEqual(fixtureBytes(129, 123));
    });

    it('returns independent fresh arrays without changing or aliasing input', () => {
        const backing = new Uint8Array(320).fill(0x5a);
        const input = backing.subarray(17, 81);
        input.set(fixtureBytes(64, 0x12345678));
        const before = backing.slice();
        const first = candidate(input);
        const second = candidate(input);
        const expected = second.slice();
        expect(first).toBeInstanceOf(Uint32Array);
        expect(Object.getPrototypeOf(first)).toBe(Uint32Array.prototype);
        expect(first.length).toBe(64);
        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(first.buffer).not.toBe(second.buffer);
        expect(first.buffer).not.toBe(backing.buffer);
        expect(second.buffer).not.toBe(backing.buffer);
        expect(backing).toEqual(before);
        first.fill(0xffffffff);
        expect(second).toEqual(expected);
        expect(backing).toEqual(before);
        input.fill(0);
        expect(second).toEqual(expected);
        expect(candidate(input)).toEqual(new Uint32Array(64));
    });

    it('accepts exactly 64-byte Buffer and foreign-realm byte views', () => {
        const expected = candidate(abcBlock());
        const backing = Buffer.alloc(75, 0xee);
        backing.set(abcBlock(), 4);
        const before = Buffer.from(backing);
        expect(candidate(backing.subarray(4, 68))).toEqual(expected);
        expect(backing).toEqual(before);
        const foreign = runInNewContext(
            'Uint8Array.from([97,98,99,128,...Array(59).fill(0),24])',
        ) as Uint8Array;
        expect(candidate(foreign)).toEqual(expected);
    });

    it('rejects wrong sizes, non-byte inputs and proxies without coercion or input leakage', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const hostile = Object.defineProperties(
            {},
            {
                length: { get: trap },
                buffer: { get: trap },
                byteLength: { get: trap },
                [Symbol.iterator]: { get: trap },
                [Symbol.toPrimitive]: { get: trap },
            },
        );
        const array = new Array(64).fill(0);
        Object.defineProperty(array, '0', { get: trap });
        const proxy = new Proxy(new Uint8Array(64), {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        });
        const revoked = Proxy.revocable(new Uint8Array(64), {});
        revoked.revoke();
        const values: unknown[] = [
            null,
            undefined,
            PRIVATE_MARKER,
            64,
            true,
            Symbol(PRIVATE_MARKER),
            hostile,
            array,
            new ArrayBuffer(64),
            new Uint16Array(64),
            new Uint8ClampedArray(64),
            new DataView(new ArrayBuffer(64)),
            new Uint8Array(0),
            new Uint8Array(1),
            new Uint8Array(63),
            new Uint8Array(65),
            new Uint8Array(128),
            proxy,
            revoked.proxy,
        ];

        for (const value of values) {
            invalid(value);
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects a detached 64-byte view with the same fixed input error', () => {
        const detached = new Uint8Array(64);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        invalid(detached);
    });

    it.skipIf(typeof SharedArrayBuffer === 'undefined')('rejects shared backing storage', () => {
        const shared = new Uint8Array(new SharedArrayBuffer(80), 8, 64);
        invalid(shared);
    });

    it.skipIf(
        typeof Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resize')?.value !==
            'function',
    )('rejects in-bounds and out-of-bounds resizable-buffer views', () => {
        const RAB = ArrayBuffer as unknown as ResizableBufferConstructor;
        const backing = new RAB(80, { maxByteLength: 128 });
        const fixed = new Uint8Array(backing, 16, 64);
        const trackingBuffer = new RAB(64, { maxByteLength: 128 });
        const tracking = new Uint8Array(trackingBuffer);
        invalid(fixed);
        invalid(tracking);
        backing.resize(15);
        trackingBuffer.resize(63);
        invalid(fixed);
        invalid(tracking);
        backing.resize(80);
        trackingBuffer.resize(64);
        invalid(fixed);
        invalid(tracking);
    });

    it('does not invoke own accessors, iterators, constructors or species', () => {
        const getter = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const expected = candidate(abcBlock());
        const keys: PropertyKey[] = [
            'buffer',
            'byteLength',
            'byteOffset',
            'length',
            'constructor',
            Symbol.iterator,
            Symbol.toStringTag,
            Symbol.toPrimitive,
            Symbol('unrelated'),
            'unrelated',
        ];

        for (const key of keys) {
            const input = abcBlock();
            Object.defineProperty(input, key, { configurable: true, get: getter });
            expect(candidate(input)).toEqual(expected);
        }

        const input = abcBlock();
        const constructor = Object.defineProperty({}, Symbol.species, { get: getter });
        Object.defineProperty(input, 'constructor', { configurable: true, value: constructor });
        expect(candidate(input)).toEqual(expected);
        expect(getter).not.toHaveBeenCalled();
    });

    it('retains the imported byte inspectors after hostile live-binding replacement', () => {
        // beforeEach has already imported the candidate. Node's supported CJS
        // builtin mutation plus syncBuiltinESMExports updates ESM live bindings.
        const require = createRequire(import.meta.url);
        const types = require('node:util/types') as typeof import('node:util/types');
        const proxyDescriptor = Object.getOwnPropertyDescriptor(types, 'isProxy');
        const byteDescriptor = Object.getOwnPropertyDescriptor(types, 'isUint8Array');

        if (
            !proxyDescriptor ||
            !('value' in proxyDescriptor) ||
            !byteDescriptor ||
            !('value' in byteDescriptor)
        ) {
            throw new Error('unexpected util/types fixture descriptors');
        }

        const input = fixtureBytes(64, 0x76543210);
        const before = input.slice();
        const expected = candidate(input);
        const proxyReplacement = vi.fn(() => {
            input.fill(0xa5);
            return false;
        });
        const byteReplacement = vi.fn(() => {
            input.fill(0x5a);
            return false;
        });
        let bindingsChanged: boolean[] = [];
        let actual: Uint32Array | undefined;
        let caught: unknown;

        try {
            Object.defineProperty(types, 'isProxy', {
                ...proxyDescriptor,
                value: proxyReplacement,
            });
            Object.defineProperty(types, 'isUint8Array', {
                ...byteDescriptor,
                value: byteReplacement,
            });
            syncBuiltinESMExports();
            bindingsChanged = [
                Object.is(builtinTypes.isProxy, proxyReplacement),
                Object.is(builtinTypes.isUint8Array, byteReplacement),
            ];

            try {
                actual = candidate(input);
            } catch (error) {
                caught = error;
            }
        } finally {
            try {
                Object.defineProperty(types, 'isProxy', proxyDescriptor);
            } finally {
                try {
                    Object.defineProperty(types, 'isUint8Array', byteDescriptor);
                } finally {
                    syncBuiltinESMExports();
                }
            }
        }

        expect(bindingsChanged).toEqual([true, true]);
        expect(proxyReplacement).not.toHaveBeenCalled();
        expect(byteReplacement).not.toHaveBeenCalled();
        expect(caught).toBeUndefined();
        expect(input).toEqual(before);
        expect(actual).toEqual(expected);
    });

    it('retains the imported TypeError constructor after a global replacement', () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'TypeError');

        if (!descriptor || !('value' in descriptor)) {
            throw new Error('unexpected TypeError fixture descriptor');
        }

        const OriginalTypeError = globalThis.TypeError;
        const replacement = vi.fn(function HostileTypeError() {
            throw new Error(PRIVATE_MARKER);
        });
        let caught: unknown;

        try {
            Object.defineProperty(globalThis, 'TypeError', { ...descriptor, value: replacement });
            caught = captureError(() => candidate(new Uint8Array(63)));
        } finally {
            Object.defineProperty(globalThis, 'TypeError', descriptor);
        }

        expect(replacement).not.toHaveBeenCalled();
        expect(caught).toBeInstanceOf(OriginalTypeError);
        expect((caught as Error).message).toBe(INPUT_ERROR);
        expect((caught as Error).cause).toBeUndefined();
        expect((caught as Error).stack ?? '').not.toContain(PRIVATE_MARKER);
    });

    it.skipIf(
        Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.configurable === false,
    )('reports unavailable if the resizable intrinsic is missing at module import', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable');
        const input = abcBlock();
        const before = input.slice();
        let caught: unknown;

        try {
            vi.resetModules();

            if (!Reflect.deleteProperty(ArrayBuffer.prototype, 'resizable')) {
                throw new Error('fixture setup failed');
            }

            // This is deliberate pre-import fault injection, not a claim about
            // behavior after hostile modification of primordial intrinsics.
            const instrumented = (await import('../../src/direct/target-sha256-schedule-candidate'))
                .targetSha256ScheduleCandidate;

            if (descriptor) {
                Object.defineProperty(ArrayBuffer.prototype, 'resizable', descriptor);
            }

            caught = captureError(() => instrumented(input));
        } finally {
            try {
                if (descriptor) {
                    Object.defineProperty(ArrayBuffer.prototype, 'resizable', descriptor);
                } else {
                    Reflect.deleteProperty(ArrayBuffer.prototype, 'resizable');
                }
            } finally {
                vi.resetModules();
            }
        }

        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(TypeError);
        expect((caught as Error).message).toBe('SHA-256 schedule candidate unavailable');
        expect((caught as Error).cause).toBeUndefined();
        expect((caught as Error).stack ?? '').not.toContain(PRIVATE_MARKER);
        expect(input).toEqual(before);
    });

    it.skipIf(Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set')?.configurable === false)(
        'reports a fixed failure when the captured snapshot copy fails',
        async () => {
            const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
            const originalSet = Uint8Array.prototype.set;
            const input = abcBlock();
            const before = input.slice();
            const failure = vi.fn(() => {
                throw new Error(PRIVATE_MARKER);
            });
            let active = false;
            let caught: unknown;

            const replacement = function (
                this: Uint8Array,
                ...args: Parameters<Uint8Array['set']>
            ) {
                if (active) {
                    return failure();
                }

                return Reflect.apply(originalSet, this, args);
            };

            const restore = () => {
                if (descriptor) {
                    Object.defineProperty(Uint8Array.prototype, 'set', descriptor);
                } else {
                    Reflect.deleteProperty(Uint8Array.prototype, 'set');
                }
            };

            try {
                vi.resetModules();
                Object.defineProperty(Uint8Array.prototype, 'set', {
                    configurable: true,
                    writable: true,
                    value: replacement,
                });
                const instrumented = (
                    await import('../../src/direct/target-sha256-schedule-candidate')
                ).targetSha256ScheduleCandidate;
                restore();
                active = true;
                caught = captureError(() => instrumented(input));
            } finally {
                try {
                    restore();
                } finally {
                    vi.resetModules();
                }
            }

            expect(failure).toHaveBeenCalledTimes(1);
            expect(caught).toBeInstanceOf(Error);
            expect(caught).not.toBeInstanceOf(TypeError);
            expect((caught as Error).message).toBe('SHA-256 schedule candidate failed');
            expect((caught as Error).cause).toBeUndefined();
            expect((caught as Error).stack ?? '').not.toContain(PRIVATE_MARKER);
            expect(input).toEqual(before);
        },
    );

    it.skipIf(
        Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'values')?.configurable === false,
    )('reports a fixed failure for a non-TypeError from view validation', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'values');
        const originalValues = Uint8Array.prototype.values;
        const input = abcBlock();
        const before = input.slice();
        const failure = vi.fn(() => {
            throw new RangeError(PRIVATE_MARKER);
        });
        let active = false;
        let caught: unknown;

        const replacement = function (this: Uint8Array) {
            if (active) {
                return failure();
            }

            return Reflect.apply(originalValues, this, []);
        };

        const restore = () => {
            if (descriptor) {
                Object.defineProperty(Uint8Array.prototype, 'values', descriptor);
            } else {
                Reflect.deleteProperty(Uint8Array.prototype, 'values');
            }
        };

        try {
            vi.resetModules();
            // Fault injection at module load simulates a resource failure. It
            // does not claim support for hostile pre-import intrinsic changes.
            Object.defineProperty(Uint8Array.prototype, 'values', {
                configurable: true,
                writable: true,
                value: replacement,
            });
            const instrumented = (await import('../../src/direct/target-sha256-schedule-candidate'))
                .targetSha256ScheduleCandidate;
            restore();
            active = true;
            caught = captureError(() => instrumented(input));
        } finally {
            try {
                restore();
            } finally {
                vi.resetModules();
            }
        }

        expect(failure).toHaveBeenCalledTimes(1);
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(TypeError);
        expect((caught as Error).message).toBe('SHA-256 schedule candidate failed');
        expect((caught as Error).cause).toBeUndefined();
        expect((caught as Error).stack ?? '').not.toContain(PRIVATE_MARKER);
        expect(input).toEqual(before);
    });

    it.skipIf(
        Object.getOwnPropertyDescriptor(TypeError, Symbol.hasInstance)?.configurable === false,
    )('does not consult a TypeError hasInstance accessor added after import', () => {
        const OriginalTypeError = globalThis.TypeError;
        const descriptor = Object.getOwnPropertyDescriptor(OriginalTypeError, Symbol.hasInstance);
        const callback = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const getter = vi.fn(() => callback);
        let caught: unknown;

        try {
            // Post-import intrinsic pollution is a targeted regression fixture,
            // not a same-process isolation claim.
            Object.defineProperty(OriginalTypeError, Symbol.hasInstance, {
                configurable: true,
                get: getter,
            });
            caught = captureError(() => candidate(new Uint8Array(63)));
        } finally {
            if (descriptor) {
                Object.defineProperty(OriginalTypeError, Symbol.hasInstance, descriptor);
            } else {
                Reflect.deleteProperty(OriginalTypeError, Symbol.hasInstance);
            }
        }

        expect(getter).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        expect(caught).toBeDefined();
        expect(caught).not.toBeNull();
        expect(Object.getPrototypeOf(caught as object)).toBe(OriginalTypeError.prototype);
        expect((caught as Error).message).toBe(INPUT_ERROR);
        expect((caught as Error).cause).toBeUndefined();
        expect((caught as Error).stack ?? '').not.toContain(PRIVATE_MARKER);
    });

    it.skipIf(
        Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'fill')?.configurable === false,
    )('clears the unreturned output and fails when snapshot cleanup throws', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'fill');
        const originalFill = Uint8Array.prototype.fill;
        const input = abcBlock();
        const before = input.slice();
        const scratchFailure = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const outputWipes: Uint32Array[] = [];
        let outputBefore: number[] = [];
        let active = false;
        let returned = false;
        let caught: unknown;

        const replacement = function (
            this: Uint8Array | Uint32Array,
            ...args: Parameters<Uint8Array['fill']>
        ) {
            if (active && this instanceof Uint8Array && this.length === 64) {
                return scratchFailure();
            }

            if (active && this instanceof Uint32Array && this.length === 64) {
                outputWipes.push(this);
                outputBefore = Array.from(this);
            }

            return Reflect.apply(originalFill, this, args) as typeof this;
        };

        const restore = () => {
            if (descriptor) {
                Object.defineProperty(Uint8Array.prototype, 'fill', descriptor);
            } else if (!Reflect.deleteProperty(Uint8Array.prototype, 'fill')) {
                throw new Error('fixture restoration failed');
            }
        };

        try {
            vi.resetModules();
            // This models a captured intrinsic throwing internally. It does not
            // establish physical-memory erasure or pre-import trust guarantees.
            Object.defineProperty(Uint8Array.prototype, 'fill', {
                configurable: true,
                writable: true,
                value: replacement,
            });
            const instrumented = (await import('../../src/direct/target-sha256-schedule-candidate'))
                .targetSha256ScheduleCandidate;
            restore();
            active = true;

            try {
                instrumented(input);
                returned = true;
            } catch (error) {
                caught = error;
            }
        } finally {
            try {
                restore();
            } finally {
                vi.resetModules();
            }
        }

        expect(returned).toBe(false);
        expect(scratchFailure).toHaveBeenCalledTimes(1);
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(TypeError);
        expect((caught as Error).message).toBe('SHA-256 schedule candidate failed');
        expect((caught as Error).cause).toBeUndefined();
        expect((caught as Error).stack ?? '').not.toContain(PRIVATE_MARKER);
        expect(outputWipes).toHaveLength(1);
        expect(outputBefore).toHaveLength(64);
        expect(outputBefore[0]).toBe(0x61626380);
        expect(Array.from(outputWipes[0])).toEqual(Array(64).fill(0));
        expect(input).toEqual(before);
    });
});
