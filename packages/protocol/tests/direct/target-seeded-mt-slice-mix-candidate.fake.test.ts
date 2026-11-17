import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import Module, { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import * as builtinTypes from 'node:util/types';
import { runInNewContext } from 'node:vm';
import workerThreads from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Candidate = (initial: Uint8Array, pSeed: number, qSeed: number) => Uint8Array;
type Guard = { mock: { calls: readonly unknown[] } };
type NamedGuard = { name: string; guard: Guard };
type ProcessListener = (...args: unknown[]) => void;
type ResizableBuffer = ArrayBuffer & { readonly resizable: boolean; resize(length: number): void };
type ResizableBufferConstructor = new (
    length: number,
    options: { maxByteLength: number },
) => ResizableBuffer;

const INPUT_ERROR = 'invalid seeded MT slice-mix candidate input';
const INTERNAL_ERROR = 'seeded MT slice-mix candidate failed';
const PRIVATE_MARKER = 'private-input-marker-do-not-echo';
const SECRET_SEED = 3141592654;
const INITIAL = Uint8Array.of(
    0x00,
    0xff,
    0x80,
    0x01,
    0x42,
    0x7f,
    0xa5,
    0x5a,
    0x11,
    0xee,
    0x22,
    0xdd,
    0x33,
    0xcc,
    0x44,
    0xbb,
    0x55,
    0xaa,
    0x66,
    0x99,
    0x77,
    0x88,
    0x10,
    0x20,
    0x30,
    0x40,
    0x50,
    0x60,
    0x70,
    0x90,
    0xb0,
    0xd0,
);

// Independent, synthetic first-eight MT19937 outputs: Zig-hosted C++
// std::mt19937 and NumPy 2.5.4 legacy RandomState agree on these words.
// They are model fixtures, not measurements of a target or a signature.
const WORDS_0 = [
    2357136044, 2546248239, 3071714933, 3626093760, 2588848963, 3684848379, 2340255427, 3638918503,
] as const;
const WORDS_1 = [
    1791095845, 4282876139, 3093770124, 4005303368, 491263, 550290313, 1298508491, 4290846341,
] as const;
const WORDS_5489 = [
    3499211612, 581869302, 3890346734, 3586334585, 545404204, 4161255391, 3922919429, 949333985,
] as const;
const WORDS_HIGH = [
    652847386, 1439962116, 3524204305, 1548966947, 3330739781, 696863241, 2323887284, 1716297117,
] as const;
const WORDS_MAX = [
    419326371, 479346978, 3918654476, 2416749639, 3388880820, 2260532800, 3350089942, 3309765114,
] as const;
const PAIRS = [
    { p: 0, q: 1, pWords: WORDS_0, qWords: WORDS_1 },
    { p: 0, q: 5489, pWords: WORDS_0, qWords: WORDS_5489 },
    { p: 0x80000000, q: 0, pWords: WORDS_HIGH, qWords: WORDS_0 },
    { p: 1, q: 0xffffffff, pWords: WORDS_1, qWords: WORDS_MAX },
] as const;

let candidate: Candidate;
let guards: NamedGuard[] = [];
let listenersBefore = new Map<string | symbol, ReturnType<typeof process.rawListeners>>();

function blockedEffect(): never {
    throw new Error('unexpected side effect');
}

// This is byte packing and XOR of externally supplied numbers, not an MT
// implementation and not a call to the candidate to construct its own oracle.
function expectedMix(
    initial: Uint8Array,
    pWords: readonly number[],
    qWords: readonly number[],
): Uint8Array {
    const p = Buffer.alloc(32);
    const q = Buffer.alloc(32);

    for (let index = 0; index < 8; index++) {
        p.writeUInt32LE(pWords[index], index * 4);
        q.writeUInt32LE(qWords[index], index * 4);
    }

    return Uint8Array.from(initial, (value, index) => value ^ p[index] ^ q[index]);
}

function thrown(operation: () => unknown): void {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    const error = caught as Error;
    expect(error.message).toBe(INPUT_ERROR);
    expect(error.cause).toBeUndefined();
    expect(error.stack ?? '').not.toContain(PRIVATE_MARKER);
    expect(error.stack ?? '').not.toContain(String(SECRET_SEED));
}

function captureError(operation: () => unknown): unknown {
    try {
        operation();
        return undefined;
    } catch (error) {
        return error;
    }
}

function expectInternalFailure(caught: unknown): void {
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    const error = caught as Error;
    expect(error.message).toBe(INTERNAL_ERROR);
    expect(error.cause).toBeUndefined();
    expect(error.stack ?? '').not.toContain(PRIVATE_MARKER);
    expect(error.stack ?? '').not.toContain(String(SECRET_SEED));
}

function snapshotProcessListeners(): Map<string | symbol, ReturnType<typeof process.rawListeners>> {
    return new Map(process.eventNames().map((event) => [event, process.rawListeners(event)]));
}

// Keep pre-existing listener identities/counts and remove additions even when an
// assertion or import fails. Restoring a removed listener is best effort only.
function restoreProcessListeners(): void {
    const events = new Set([...listenersBefore.keys(), ...process.eventNames()]);

    for (const event of events) {
        const original = listenersBefore.get(event) ?? [];
        const remaining = original.slice();

        for (const listener of process.rawListeners(event)) {
            const index = remaining.indexOf(listener);

            if (index !== -1) {
                remaining.splice(index, 1);
            } else {
                try {
                    process.removeListener(event, listener as ProcessListener);
                } catch {
                    // Continue cleaning other listener registrations.
                }
            }
        }

        for (const listener of remaining) {
            try {
                process.on(event, listener as ProcessListener);
            } catch {
                // Listener restoration is best effort.
            }
        }
    }
}

beforeEach(async () => {
    vi.resetModules();
    listenersBefore = snapshotProcessListeners();
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
            name: 'dgram.Socket.connect',
            guard: vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.send',
            guard: vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.bind',
            guard: vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blockedEffect),
        },
        {
            name: 'process.dlopen',
            guard: vi.spyOn(process, 'dlopen').mockImplementation(blockedEffect),
        },
        {
            name: 'child_process.exec',
            guard: vi.spyOn(childProcess, 'exec').mockImplementation(blockedEffect),
        },
        {
            name: 'child_process.execFile',
            guard: vi.spyOn(childProcess, 'execFile').mockImplementation(blockedEffect),
        },
        {
            name: 'child_process.spawn',
            guard: vi.spyOn(childProcess, 'spawn').mockImplementation(blockedEffect),
        },
        {
            name: 'child_process.fork',
            guard: vi.spyOn(childProcess, 'fork').mockImplementation(blockedEffect),
        },
        {
            name: 'child_process.execSync',
            guard: vi.spyOn(childProcess, 'execSync').mockImplementation(blockedEffect),
        },
        {
            name: 'child_process.execFileSync',
            guard: vi.spyOn(childProcess, 'execFileSync').mockImplementation(blockedEffect),
        },
        {
            name: 'child_process.spawnSync',
            guard: vi.spyOn(childProcess, 'spawnSync').mockImplementation(blockedEffect),
        },
        {
            name: 'worker_threads.Worker',
            guard: vi.spyOn(workerThreads, 'Worker').mockImplementation(blockedEffect),
        },
    ];

    const fetchGuard = vi.fn(blockedEffect);
    const webSocketGuard = vi.fn(blockedEffect);
    const xhrGuard = vi.fn(blockedEffect);
    const eventSourceGuard = vi.fn(blockedEffect);
    const moduleGuard = vi.fn(blockedEffect);
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    vi.stubGlobal('XMLHttpRequest', xhrGuard);
    vi.stubGlobal('EventSource', eventSourceGuard);
    guards.push(
        { name: 'fetch', guard: fetchGuard },
        { name: 'WebSocket', guard: webSocketGuard },
        { name: 'XMLHttpRequest', guard: xhrGuard },
        { name: 'EventSource', guard: eventSourceGuard },
        { name: 'CommonJS ws/Hook/native module load', guard: moduleGuard },
    );

    // Guard CommonJS loading of common transport, Hook and native interfaces;
    // their process/network effects are independently guarded above.
    const loader = Module as unknown as { _load: (...args: unknown[]) => unknown };
    const originalLoad = loader._load;
    vi.spyOn(loader, '_load').mockImplementation(function (this: unknown, ...args: unknown[]) {
        const request = args[0];

        if (
            typeof request === 'string' &&
            (request === 'ws' ||
                request.startsWith('ws/') ||
                /[/\\]ws[/\\]/.test(request) ||
                /(?:^|[/\\])(?:hook(?:[-_./\\]|$)|frida(?:[-_./\\]|$)|ffi-napi(?:[/\\]|$))/i.test(
                    request,
                ) ||
                /\.node$/i.test(request))
        ) {
            return moduleGuard();
        }

        return Reflect.apply(originalLoad, this, args);
    });

    guards.push(
        { name: 'console.log', guard: vi.spyOn(console, 'log').mockImplementation(() => {}) },
        { name: 'console.info', guard: vi.spyOn(console, 'info').mockImplementation(() => {}) },
        { name: 'console.warn', guard: vi.spyOn(console, 'warn').mockImplementation(() => {}) },
        { name: 'console.error', guard: vi.spyOn(console, 'error').mockImplementation(() => {}) },
        { name: 'console.debug', guard: vi.spyOn(console, 'debug').mockImplementation(() => {}) },
        { name: 'console.dir', guard: vi.spyOn(console, 'dir').mockImplementation(() => {}) },
        { name: 'console.trace', guard: vi.spyOn(console, 'trace').mockImplementation(() => {}) },
        {
            name: 'process.stdout.write',
            guard: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
        },
        {
            name: 'process.stderr.write',
            guard: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
        },
    );

    syncBuiltinESMExports();
    candidate = (await import('../../src/direct/target-seeded-mt-slice-mix-candidate'))
        .targetSeededMtSliceMixCandidate;
});

afterEach(() => {
    try {
        for (const { name, guard } of guards) {
            expect(guard.mock.calls, name).toHaveLength(0);
        }

        const events = new Set([...listenersBefore.keys(), ...process.eventNames()]);

        for (const event of events) {
            expect(process.rawListeners(event), `process listeners: ${String(event)}`).toEqual(
                listenersBefore.get(event) ?? [],
            );
        }
    } finally {
        try {
            restoreProcessListeners();
        } finally {
            try {
                vi.restoreAllMocks();
                syncBuiltinESMExports();
            } finally {
                vi.unstubAllGlobals();
                guards = [];
                listenersBefore.clear();
            }
        }
    }
});

describe('offline seeded MT slice-mix synthetic model', () => {
    it('uses both independently seeded word streams in little-endian order', () => {
        const inputs = [
            new Uint8Array(32),
            Uint8Array.from({ length: 32 }, (_, index) => index),
            INITIAL,
        ];
        const zeroInputOutputs: string[] = [];

        for (const { p, q, pWords, qWords } of PAIRS) {
            for (const input of inputs) {
                const before = input.slice();
                const expected = expectedMix(before, pWords, qWords);
                const actual = candidate(input, p, q);
                expect(actual).toEqual(expected);
                expect(input).toEqual(before);
            }

            zeroInputOutputs.push(
                Buffer.from(expectedMix(inputs[0], pWords, qWords)).toString('hex'),
            );
        }

        expect(new Set(zeroInputOutputs).size).toBe(PAIRS.length);
    });

    it('matches an independently computed synthetic full-slice vector', () => {
        const input = Uint8Array.from({ length: 32 }, (_, index) => index);
        const result = candidate(input, 0, 5489);
        expect(Buffer.from(result).toString('hex')).toBe(
            'f0b0ec5fdd316cb29355fd5bb5deec027f97dea930f0b334de6fb4799acf6eff',
        );
    });

    it('returns fresh ordinary Uint8Arrays and never modifies or aliases caller storage', () => {
        const input = INITIAL.slice();
        const before = input.slice();
        const expected = expectedMix(before, WORDS_0, WORDS_1);
        const first = candidate(input, 0, 1);
        const second = candidate(input, 0, 1);
        expect(first).toBeInstanceOf(Uint8Array);
        expect(Object.getPrototypeOf(first)).toBe(Uint8Array.prototype);
        expect(Buffer.isBuffer(first)).toBe(false);
        expect(first.byteLength).toBe(32);
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(first).not.toBe(second);
        expect(first.buffer).not.toBe(input.buffer);
        expect(second.buffer).not.toBe(input.buffer);
        expect(first.buffer).not.toBe(second.buffer);
        expect(input).toEqual(before);

        first.fill(0x5a);
        expect(second).toEqual(expected);
        expect(input).toEqual(before);
        input.fill(0xa5);
        expect(second).toEqual(expected);
    });

    it('is commutative and cancels equal seeds only as a property of this model', () => {
        for (const { p, q, pWords, qWords } of PAIRS) {
            const expected = expectedMix(INITIAL, pWords, qWords);
            expect(candidate(INITIAL, p, q)).toEqual(expected);
            expect(candidate(INITIAL, q, p)).toEqual(expected);
        }

        for (const seed of [0, 1, 5489, 0xffffffff]) {
            const initial = INITIAL.slice();
            const result = candidate(initial, seed, seed);
            expect(result).toEqual(initial);
            expect(result.buffer).not.toBe(initial.buffer);
        }
    });

    it('accepts negative zero as positive zero in either independent seed', () => {
        const expected = expectedMix(INITIAL, WORDS_0, WORDS_1);
        expect(candidate(INITIAL, -0, 1)).toEqual(expected);
        expect(candidate(INITIAL, 1, -0)).toEqual(expected);
        expect(candidate(INITIAL, -0, 0)).toEqual(INITIAL);
        expect(candidate(INITIAL, 0, -0)).toEqual(INITIAL);
    });

    it('accepts cross-realm bytes and non-aligned Uint8Array and Buffer subviews', () => {
        const foreign = runInNewContext(
            `Uint8Array.from([${Array.from(INITIAL).join(',')}])`,
        ) as Uint8Array;
        const backing = Buffer.alloc(47, 0xe5);
        const view = backing.subarray(7, 39);
        view.set(INITIAL);
        const before = Buffer.from(backing);
        const byteBacking = new Uint8Array(41).fill(0xa5);
        byteBacking.set(INITIAL, 3);
        const byteView = byteBacking.subarray(3, 35);
        const byteBefore = byteBacking.slice();
        const expected = expectedMix(INITIAL, WORDS_0, WORDS_5489);
        expect(candidate(foreign, 0, 5489)).toEqual(expected);
        const result = candidate(view, 0, 5489);
        expect(result).toEqual(expected);
        expect(result.buffer).not.toBe(view.buffer);
        expect(backing).toEqual(before);
        const byteResult = candidate(byteView, 0, 5489);
        expect(byteResult).toEqual(expected);
        expect(byteResult.buffer).not.toBe(byteView.buffer);
        expect(byteBacking).toEqual(byteBefore);
        expect(Array.from(foreign)).toEqual(Array.from(INITIAL));
    });

    it('rejects invalid seeds in both positions without coercion or disclosure', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const hostile = { [Symbol.toPrimitive]: trap, valueOf: trap, toString: trap };
        const proxy = new Proxy(hostile, { get: trap, getPrototypeOf: trap, ownKeys: trap });
        const revoked = Proxy.revocable(hostile, {});
        revoked.revoke();
        const invalid: unknown[] = [
            NaN,
            Infinity,
            -Infinity,
            -1,
            -0.5,
            0.5,
            0xffffffff + 0.5,
            0x100000000,
            Number.MAX_SAFE_INTEGER,
            '0',
            PRIVATE_MARKER,
            0n,
            true,
            false,
            null,
            undefined,
            Symbol(PRIVATE_MARKER),
            Object(1),
            [],
            hostile,
            proxy,
            revoked.proxy,
        ];

        for (const value of invalid) {
            thrown(() => candidate(INITIAL, value as number, SECRET_SEED));
            thrown(() => candidate(INITIAL, SECRET_SEED, value as number));
        }

        expect(trap).not.toHaveBeenCalled();
        expect(INITIAL).toEqual(
            Uint8Array.of(
                0x00,
                0xff,
                0x80,
                0x01,
                0x42,
                0x7f,
                0xa5,
                0x5a,
                0x11,
                0xee,
                0x22,
                0xdd,
                0x33,
                0xcc,
                0x44,
                0xbb,
                0x55,
                0xaa,
                0x66,
                0x99,
                0x77,
                0x88,
                0x10,
                0x20,
                0x30,
                0x40,
                0x50,
                0x60,
                0x70,
                0x90,
                0xb0,
                0xd0,
            ),
        );
    });

    it('rejects non-byte inputs, proxies, detached views, and incorrect lengths', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const fake = Object.defineProperties(
            {},
            {
                length: { get: trap },
                byteLength: { get: trap },
                buffer: { get: trap },
                [Symbol.iterator]: { get: trap },
            },
        );
        const array = new Array(32).fill(0);
        Object.defineProperty(array, '0', { get: trap });
        const proxy = new Proxy(INITIAL.slice(), {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        });
        const revoked = Proxy.revocable(INITIAL.slice(), {});
        revoked.revoke();
        const detached = new Uint8Array(32);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const invalid: unknown[] = [
            null,
            undefined,
            PRIVATE_MARKER,
            fake,
            array,
            new ArrayBuffer(32),
            new Uint16Array(32),
            new Uint8ClampedArray(32),
            new DataView(new ArrayBuffer(32)),
            new Uint8Array(0),
            new Uint8Array(31),
            new Uint8Array(33),
            proxy,
            revoked.proxy,
            detached,
        ];

        for (const value of invalid) {
            thrown(() => candidate(value as Uint8Array, 0, SECRET_SEED));
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it.skipIf(typeof SharedArrayBuffer === 'undefined')('rejects shared backing storage', () => {
        const shared = new Uint8Array(new SharedArrayBuffer(48), 7, 32);
        thrown(() => candidate(shared, 0, SECRET_SEED));
    });

    it.skipIf(
        typeof Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resize')?.value !==
            'function',
    )('rejects in-bounds, tracking and out-of-bounds views of resizable storage', () => {
        const RAB = ArrayBuffer as unknown as ResizableBufferConstructor;
        const backing = new RAB(48, { maxByteLength: 96 });
        expect(backing.resizable).toBe(true);
        const fixed = new Uint8Array(backing, 16, 32);
        const trackingBuffer = new RAB(32, { maxByteLength: 96 });
        const tracking = new Uint8Array(trackingBuffer);
        thrown(() => candidate(fixed, 0, SECRET_SEED));
        thrown(() => candidate(tracking, 0, SECRET_SEED));
        backing.resize(8);
        thrown(() => candidate(fixed, 0, SECRET_SEED));
        trackingBuffer.resize(31);
        thrown(() => candidate(tracking, 0, SECRET_SEED));
        backing.resize(48);
        thrown(() => candidate(fixed, 0, SECRET_SEED));
    });

    it.skipIf(
        Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.configurable === false,
    )('reports an internal error if the resizable getter is missing at import', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable');
        const input = INITIAL.slice();
        const before = input.slice();
        let caught: unknown;

        try {
            vi.resetModules();

            if (!Reflect.deleteProperty(ArrayBuffer.prototype, 'resizable')) {
                throw new Error('fixture setup failed');
            }

            // Deliberate pre-import instrumentation, not a claim of primordial protection.
            const instrumented = (
                await import('../../src/direct/target-seeded-mt-slice-mix-candidate')
            ).targetSeededMtSliceMixCandidate;

            if (descriptor !== undefined) {
                Object.defineProperty(ArrayBuffer.prototype, 'resizable', descriptor);
            }

            caught = captureError(() => instrumented(input, 0, SECRET_SEED));
        } finally {
            try {
                if (descriptor === undefined) {
                    Reflect.deleteProperty(ArrayBuffer.prototype, 'resizable');
                } else {
                    Object.defineProperty(ArrayBuffer.prototype, 'resizable', descriptor);
                }
            } finally {
                vi.resetModules();
            }
        }

        expectInternalFailure(caught);
        expect(input).toEqual(before);
    });

    it('reports an internal error on an injected post-validation allocation failure', async () => {
        const original = globalThis.Uint32Array;
        const constructor = vi.fn(function () {
            throw new Error(PRIVATE_MARKER);
        });
        const input = INITIAL.slice();
        const before = input.slice();
        let caught: unknown;

        try {
            vi.resetModules();
            // Deliberate pre-import instrumentation, not a primordial-tampering guarantee.
            vi.stubGlobal('Uint32Array', constructor);
            const instrumented = (
                await import('../../src/direct/target-seeded-mt-slice-mix-candidate')
            ).targetSeededMtSliceMixCandidate;
            vi.stubGlobal('Uint32Array', original);
            thrown(() => instrumented(new Uint8Array(31), 0, SECRET_SEED));
            expect(constructor.mock.calls).toHaveLength(0);
            caught = captureError(() => instrumented(input, 0, SECRET_SEED));
        } finally {
            try {
                vi.stubGlobal('Uint32Array', original);
            } finally {
                vi.resetModules();
            }
        }

        expect(constructor.mock.calls).toHaveLength(1);
        expectInternalFailure(caught);
        expect(input).toEqual(before);
    });

    it('clears instrumented private MT arrays after a successful computation', async () => {
        const Original = globalThis.Uint32Array;
        const arrays: Uint32Array[] = [];
        const factory = vi.fn(function (length: number) {
            const created = new Original(length);
            created.fill(0xcccccccc);
            arrays.push(created);
            return created;
        });
        const input = INITIAL.slice();
        const before = input.slice();
        let result: Uint8Array | undefined;

        try {
            vi.resetModules();
            // Pre-import allocation instrumentation is a test seam, not a trust guarantee.
            vi.stubGlobal('Uint32Array', factory);
            const instrumented = (
                await import('../../src/direct/target-seeded-mt-slice-mix-candidate')
            ).targetSeededMtSliceMixCandidate;
            vi.stubGlobal('Uint32Array', Original);
            arrays.length = 0;
            factory.mockClear();
            result = instrumented(input, 0, 5489);
        } finally {
            vi.stubGlobal('Uint32Array', Original);
            vi.resetModules();
        }

        expect(result).toEqual(expectedMix(before, WORDS_0, WORDS_5489));
        expect(input).toEqual(before);
        expect(arrays.map((array) => array.length)).toEqual([624, 624, 8, 8]);
        expect(arrays.every((array) => array.every((word) => word === 0))).toBe(true);
    });

    it('clears a previously allocated state when a later allocation fails', async () => {
        const Original = globalThis.Uint32Array;
        const arrays: Uint32Array[] = [];
        let failOnSecond = false;
        const factory = vi.fn(function (length: number) {
            if (failOnSecond && arrays.length !== 0) {
                throw new Error(PRIVATE_MARKER);
            }

            const created = new Original(length);
            created.fill(0xcccccccc);
            arrays.push(created);
            return created;
        });
        const input = INITIAL.slice();
        const before = input.slice();
        let caught: unknown;

        try {
            vi.resetModules();
            vi.stubGlobal('Uint32Array', factory);
            const instrumented = (
                await import('../../src/direct/target-seeded-mt-slice-mix-candidate')
            ).targetSeededMtSliceMixCandidate;
            vi.stubGlobal('Uint32Array', Original);
            arrays.length = 0;
            factory.mockClear();
            failOnSecond = true;
            caught = captureError(() => instrumented(input, 0, SECRET_SEED));
        } finally {
            vi.stubGlobal('Uint32Array', Original);
            vi.resetModules();
        }

        expectInternalFailure(caught);
        expect(input).toEqual(before);
        expect(factory.mock.calls).toHaveLength(2);
        expect(arrays).toHaveLength(1);
        expect(arrays[0].length).toBe(624);
        expect(arrays[0].every((word) => word === 0)).toBe(true);
    });

    it('clears an unreturned partial output and snapshot after an injected mixing failure', async () => {
        const OriginalBytes = globalThis.Uint8Array;
        const OriginalWords = globalThis.Uint32Array;
        const byteArrays: Uint8Array[] = [];
        let active = false;
        let wordAllocations = 0;
        let partial: number[] = [];
        let caught: unknown;

        const byteFactory = function (...args: unknown[]) {
            const result = Reflect.construct(OriginalBytes, args) as Uint8Array;

            if (active && args.length === 1 && args[0] === 32) {
                byteArrays.push(result);
            }

            return result;
        };

        Object.setPrototypeOf(byteFactory, OriginalBytes);
        Object.defineProperty(byteFactory, 'prototype', { value: OriginalBytes.prototype });

        const wordFactory = function (length: number) {
            const result = new OriginalWords(length);

            if (active && ++wordAllocations === 3) {
                // The artificial proxy fails after a real result has received its first word.
                return new Proxy(result, {
                    get(target, key) {
                        if (key === '1') {
                            partial = Array.from(byteArrays[1].subarray(0, 4));
                            throw new Error(PRIVATE_MARKER);
                        }

                        return Reflect.get(target, key, target);
                    },
                });
            }

            return result;
        };

        const input = INITIAL.slice();
        const before = input.slice();

        try {
            vi.resetModules();
            // Pre-import mock constructors are a fault-injection seam, not an isolation claim.
            vi.stubGlobal('Uint8Array', byteFactory);
            vi.stubGlobal('Uint32Array', wordFactory);
            const instrumented = (
                await import('../../src/direct/target-seeded-mt-slice-mix-candidate')
            ).targetSeededMtSliceMixCandidate;
            vi.stubGlobal('Uint8Array', OriginalBytes);
            vi.stubGlobal('Uint32Array', OriginalWords);
            active = true;
            caught = captureError(() => instrumented(input, 0, 5489));
        } finally {
            vi.stubGlobal('Uint8Array', OriginalBytes);
            vi.stubGlobal('Uint32Array', OriginalWords);
            vi.resetModules();
        }

        expectInternalFailure(caught);
        expect(input).toEqual(before);
        expect(partial.some((value) => value !== 0)).toBe(true);
        expect(byteArrays).toHaveLength(2);
        expect(byteArrays[0].every((value) => value === 0)).toBe(true);
        expect(byteArrays[1].every((value) => value === 0)).toBe(true);
    });

    it('does not read own accessors, iterators, constructors or species', () => {
        const getter = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
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
        const expected = expectedMix(INITIAL, WORDS_0, WORDS_1);

        for (const key of keys) {
            const input = INITIAL.slice();
            Object.defineProperty(input, key, { configurable: true, get: getter });
            expect(candidate(input, 0, 1)).toEqual(expected);
        }

        const input = INITIAL.slice();
        const constructor = Object.defineProperty({}, Symbol.species, { get: getter });
        Object.defineProperty(input, 'constructor', { configurable: true, value: constructor });
        expect(candidate(input, 0, 1)).toEqual(expected);
        expect(getter).not.toHaveBeenCalled();
    });

    it('does not traverse inherited accessors or a proxy prototype while inspecting bytes', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const expected = expectedMix(INITIAL, WORDS_1, WORDS_MAX);
        const inherited = INITIAL.slice();
        const prototype = Object.create(Uint8Array.prototype, {
            buffer: { get: trap },
            byteLength: { get: trap },
            byteOffset: { get: trap },
            length: { get: trap },
            constructor: { get: trap },
            [Symbol.iterator]: { get: trap },
        });
        Object.setPrototypeOf(inherited, prototype);
        expect(candidate(inherited, 1, 0xffffffff)).toEqual(expected);

        const proxyPrototypeInput = INITIAL.slice();
        Object.setPrototypeOf(
            proxyPrototypeInput,
            new Proxy(Uint8Array.prototype, {
                get: trap,
                ownKeys: trap,
                getPrototypeOf: trap,
                getOwnPropertyDescriptor: trap,
            }),
        );
        expect(candidate(proxyPrototypeInput, 1, 0xffffffff)).toEqual(expected);
        expect(trap).not.toHaveBeenCalled();
    });

    it('retains the byte-type inspectors captured at import after later builtin replacement', () => {
        const nodeRequire = createRequire(import.meta.url);
        const utilTypes = nodeRequire('node:util/types') as typeof import('node:util/types');
        const expected = expectedMix(INITIAL, WORDS_0, WORDS_1);
        const replacedProxy = vi.spyOn(utilTypes, 'isProxy').mockImplementation(blockedEffect);
        const replacedBytes = vi.spyOn(utilTypes, 'isUint8Array').mockImplementation(blockedEffect);
        let result: Uint8Array;
        let calls: number[] = [];
        let bindingsChanged: boolean[] = [];

        try {
            // This probes post-import changes only, not prior modification of builtins.
            syncBuiltinESMExports();
            bindingsChanged = [
                Object.is(builtinTypes.isProxy, replacedProxy),
                Object.is(builtinTypes.isUint8Array, replacedBytes),
            ];
            result = candidate(INITIAL, 0, 1);
        } finally {
            calls = [replacedProxy.mock.calls.length, replacedBytes.mock.calls.length];
            replacedProxy.mockRestore();
            replacedBytes.mockRestore();
            syncBuiltinESMExports();
        }

        expect(result).toEqual(expected);
        expect(bindingsChanged).toEqual([true, true]);
        expect(calls).toEqual([0, 0]);
    });

    it('does not consult ambient clock or random APIs during a candidate call', () => {
        const expected = expectedMix(INITIAL, WORDS_0, WORDS_1);
        const date = globalThis.Date;
        const dateConstructor = vi.fn(blockedEffect);
        const dateNow = vi.spyOn(date, 'now').mockImplementation(blockedEffect);
        const mathRandom = vi.spyOn(Math, 'random').mockImplementation(blockedEffect);
        const randomBytes = vi.spyOn(crypto, 'randomBytes').mockImplementation(blockedEffect);
        const randomFill = vi.spyOn(crypto, 'randomFill').mockImplementation(blockedEffect);
        const randomFillSync = vi.spyOn(crypto, 'randomFillSync').mockImplementation(blockedEffect);
        const randomInt = vi.spyOn(crypto, 'randomInt').mockImplementation(blockedEffect);
        const randomUUID = vi.spyOn(crypto, 'randomUUID').mockImplementation(blockedEffect);
        const webRandom = vi
            .spyOn(crypto.webcrypto, 'getRandomValues')
            .mockImplementation(blockedEffect);
        const clock = vi.spyOn(performance, 'now').mockImplementation(blockedEffect);
        const highResolutionClock = vi.spyOn(process, 'hrtime').mockImplementation(blockedEffect);
        Object.assign(dateConstructor, { now: dateNow, parse: date.parse, UTC: date.UTC });
        const clockAndRandomGuards = [
            dateConstructor,
            dateNow,
            mathRandom,
            randomBytes,
            randomFill,
            randomFillSync,
            randomInt,
            randomUUID,
            webRandom,
            clock,
            highResolutionClock,
        ];
        let result: Uint8Array;
        let baselineCounts: number[] = [];
        let callCounts: number[] = [];

        try {
            syncBuiltinESMExports();
            vi.stubGlobal('Date', dateConstructor);
            baselineCounts = clockAndRandomGuards.map((guard) => guard.mock.calls.length);
            result = candidate(INITIAL, 0, 1);
        } finally {
            // mockRestore resets spy history; count only the synchronous call window.
            callCounts = clockAndRandomGuards.map(
                (guard, index) => guard.mock.calls.length - (baselineCounts[index] ?? 0),
            );
            vi.stubGlobal('Date', date);
            dateNow.mockRestore();
            mathRandom.mockRestore();
            randomBytes.mockRestore();
            randomFill.mockRestore();
            randomFillSync.mockRestore();
            randomInt.mockRestore();
            randomUUID.mockRestore();
            webRandom.mockRestore();
            clock.mockRestore();
            highResolutionClock.mockRestore();
            syncBuiltinESMExports();
        }

        expect(result).toEqual(expected);
        expect(callCounts).toEqual(clockAndRandomGuards.map(() => 0));
    });
});
