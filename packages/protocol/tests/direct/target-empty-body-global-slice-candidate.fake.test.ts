import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import Module, { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Candidate = (
    command: Uint8Array,
    expected: Uint8Array,
    bodyLength: number,
    block: Uint8Array,
) => Uint8Array | null;
type Guard = { mock: { calls: readonly unknown[] } };

const INPUT_ERROR = 'invalid empty-body global-slice candidate input';
const PRIVATE_MARKER = 'private-input-marker-do-not-echo';
const command = Uint8Array.of(0x41, 0x00, 0x42, 0xff);
const expectedSlice = Uint8Array.of(
    0x29,
    0x2a,
    0x2b,
    0x2c,
    0x2d,
    0x2e,
    0x2f,
    0x30,
    0x31,
    0x32,
    0x33,
    0x34,
    0x35,
    0x36,
    0x37,
    0x38,
    0x39,
    0x3a,
    0x3b,
    0x3c,
    0x3d,
    0x3e,
    0x3f,
    0x40,
    0x41,
    0x42,
    0x43,
    0x44,
    0x45,
    0x46,
    0x47,
    0x48,
);

let candidate: Candidate;
let guards: Array<{ name: string; guard: Guard }> = [];

function blockedEffect(): never {
    throw new Error('unexpected side effect');
}

function blockFixture(): Uint8Array {
    return Uint8Array.from({ length: 160 }, (_, index) => index + 1);
}

function thrown(operation: () => unknown): Error {
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
    return error;
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
    ];

    const fetchGuard = vi.fn(blockedEffect);
    const webSocketGuard = vi.fn(blockedEffect);
    const wsModuleGuard = vi.fn(blockedEffect);
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards.push(
        { name: 'fetch', guard: fetchGuard },
        { name: 'WebSocket', guard: webSocketGuard },
        { name: 'ws module load', guard: wsModuleGuard },
    );

    // Guard CommonJS ws loading as well as the native WebSocket and underlying
    // network entry points. The original loader still handles unrelated modules.
    const moduleLoader = Module as unknown as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    vi.spyOn(moduleLoader, '_load').mockImplementation(function (
        this: unknown,
        ...args: unknown[]
    ) {
        const request = args[0];

        if (
            typeof request === 'string' &&
            (request === 'ws' || request.startsWith('ws/') || /[/\\]ws[/\\]/.test(request))
        ) {
            return wsModuleGuard();
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
    candidate = (await import('../../src/direct/target-empty-body-global-slice-candidate'))
        .targetEmptyBodyGlobalSliceCandidate;
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

describe('offline empty-body global-slice branch candidate', () => {
    it('returns the explicit 0x28..0x47 fixture with independent fresh storage', () => {
        const input = command.slice();
        const expected = command.slice();
        const block = blockFixture();
        const before = [input.slice(), expected.slice(), block.slice()];
        const first = candidate(input, expected, 0, block)!;
        const second = candidate(input, expected, 0, block)!;

        expect(first).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(first)).toBe(false);
        expect(first).toEqual(expectedSlice);
        expect(second).toEqual(expectedSlice);
        expect(first).not.toBe(second);
        expect(first.buffer).not.toBe(second.buffer);
        expect(first.buffer).not.toBe(block.buffer);
        expect(input).toEqual(before[0]);
        expect(expected).toEqual(before[1]);
        expect(block).toEqual(before[2]);

        first.fill(0);
        expect(second).toEqual(expectedSlice);
        expect(block).toEqual(before[2]);
        block.fill(0xff);
        input.fill(0);
        expected.fill(0);
        expect(second).toEqual(expectedSlice);
    });

    it('returns 32 zero bytes when the only nonzero byte is outside the slice', () => {
        for (const position of [0, 0x27, 0x48, 159]) {
            const block = new Uint8Array(160);
            block[position] = 7;
            const before = block.slice();
            const result = candidate(command, command.slice(), 0, block);
            expect(result).not.toBeNull();
            expect(result).toEqual(new Uint8Array(32));
            expect(block).toEqual(before);
        }
    });

    it('checks all 160 block positions and includes both slice boundaries', () => {
        for (let position = 0; position < 160; position++) {
            const block = new Uint8Array(160);
            block[position] = 0xa5;
            const wanted = new Uint8Array(32);

            if (position >= 0x28 && position <= 0x47) {
                wanted[position - 0x28] = 0xa5;
            }

            expect(candidate(command, command.slice(), 0, block)).toEqual(wanted);
        }
    });

    it('uses byte equality including NUL and permits the empty command', () => {
        const block = blockFixture();
        expect(
            candidate(Uint8Array.of(0x41, 0, 0x42), Uint8Array.of(0x41, 0, 0x42), 0, block),
        ).toEqual(expectedSlice);
        expect(
            candidate(Uint8Array.of(0x41, 0, 0x42), Uint8Array.of(0x41, 0, 0x43), 0, block),
        ).toBeNull();
        expect(candidate(Uint8Array.of(0x41, 0, 0x42), Uint8Array.of(0x41), 0, block)).toBeNull();
        expect(candidate(new Uint8Array(0), new Uint8Array(0), -0, block)).toEqual(expectedSlice);
    });

    it('returns unresolved null for every other valid branch', () => {
        const block = blockFixture();
        expect(candidate(command, command.slice(), 0, new Uint8Array(160))).toBeNull();
        expect(candidate(command, command.slice(), 1, block)).toBeNull();
        expect(candidate(command, command.slice(), Number.MAX_SAFE_INTEGER, block)).toBeNull();
        expect(candidate(command, Uint8Array.of(0x41, 0, 0x42, 0xfe), 0, block)).toBeNull();
        expect(candidate(command, Uint8Array.of(0x41, 0), 0, block)).toBeNull();
        expect(block).toEqual(blockFixture());
    });

    it('honors non-aligned subviews, Buffer inputs and their backing boundaries', () => {
        const aBacking = new Uint8Array(10).fill(0xe1);
        const bBacking = Buffer.alloc(12, 0xe2);
        const blockBacking = new Uint8Array(166).fill(0xe3);
        aBacking.set(command, 3);
        bBacking.set(command, 5);
        blockBacking.set(blockFixture(), 3);
        const beforeA = aBacking.slice();
        const beforeB = Buffer.from(bBacking);
        const beforeBlock = blockBacking.slice();
        const result = candidate(
            aBacking.subarray(3, 7),
            bBacking.subarray(5, 9),
            0,
            blockBacking.subarray(3, 163),
        );
        expect(result).toEqual(expectedSlice);
        expect(result?.byteLength).toBe(32);
        expect(aBacking).toEqual(beforeA);
        expect(bBacking).toEqual(beforeB);
        expect(blockBacking).toEqual(beforeBlock);
    });

    it('accepts foreign-realm byte arrays without consulting their methods', () => {
        const foreign = runInNewContext('new Uint8Array([65, 0, 66, 255])') as Uint8Array;
        expect(candidate(foreign, command, 0, blockFixture())).toEqual(expectedSlice);
    });

    it('accepts exactly 4096 command bytes and rejects longer views', () => {
        const exact = new Uint8Array(4096).fill(0x61);
        exact[2048] = 0;
        const copy = exact.slice();
        expect(candidate(exact, copy, 0, blockFixture())).toEqual(expectedSlice);
        copy[4095] ^= 1;
        expect(candidate(exact, copy, 0, blockFixture())).toBeNull();
        const over = new Uint8Array(4097);
        thrown(() => candidate(over, exact, 0, blockFixture()));
        thrown(() => candidate(exact, over, 0, blockFixture()));
        expect(exact[2048]).toBe(0);
    });

    it('rejects every invalid body length without coercion or leaking data', () => {
        const coercion = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const hostile = { [Symbol.toPrimitive]: coercion, valueOf: coercion, toString: coercion };
        const proxy = new Proxy(hostile, { get: coercion, getPrototypeOf: coercion });
        const bad: unknown[] = [
            NaN,
            Infinity,
            -Infinity,
            -1,
            -0.5,
            0.5,
            Number.MAX_SAFE_INTEGER + 1,
            '0',
            PRIVATE_MARKER,
            0n,
            true,
            null,
            undefined,
            Symbol(PRIVATE_MARKER),
            Object(0),
            hostile,
            proxy,
        ];

        for (const value of bad) {
            thrown(() => candidate(command, command, value as number, blockFixture()));
        }

        expect(coercion).not.toHaveBeenCalled();
    });

    it('rejects arrays, other views, proxy, shared and detached data in every byte position', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const proxy = new Proxy(Uint8Array.of(1), {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        });
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const maliciousArray = [1];
        Object.defineProperty(maliciousArray, '0', { configurable: true, get: trap });
        const detached = new Uint8Array(0);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const invalid: unknown[] = [
            null,
            undefined,
            PRIVATE_MARKER,
            [1],
            maliciousArray,
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            new Uint8Array(new SharedArrayBuffer(1)),
            proxy,
            revoked.proxy,
            detached,
        ];

        for (const value of invalid) {
            thrown(() => candidate(value as Uint8Array, command, 0, blockFixture()));
            thrown(() => candidate(command, value as Uint8Array, 0, blockFixture()));
            thrown(() => candidate(command, command, 0, value as Uint8Array));
        }

        // Validation does not stop at an otherwise unresolved branch.
        thrown(() => candidate(command, command, 1, proxy));
        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects wrong block sizes and shared block storage even for null branches', () => {
        for (const length of [0, 1, 159, 161, 4096]) {
            thrown(() => candidate(command, command, 0, new Uint8Array(length)));
            thrown(() => candidate(command, new Uint8Array(), 1, new Uint8Array(length)));
        }

        thrown(() => candidate(command, command, 0, new Uint8Array(new SharedArrayBuffer(160))));
    });

    it('does not consult own string or symbol getters on genuine byte views', () => {
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
            Symbol('unrelated'),
            'unrelated',
        ];

        for (const key of keys) {
            const value = Uint8Array.of(1);
            const block = blockFixture();
            Object.defineProperty(value, key, { configurable: true, get: getter });
            Object.defineProperty(block, key, { configurable: true, get: getter });
            expect(candidate(value, Uint8Array.of(1), 0, block)).toEqual(expectedSlice);
            expect(candidate(Uint8Array.of(1), value, 0, block)).toEqual(expectedSlice);
        }

        expect(getter).not.toHaveBeenCalled();
    });

    it('does not consult inherited getters or proxy prototype traps', () => {
        const getter = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const value = Uint8Array.of(1);
        const prototype = Object.create(Uint8Array.prototype, {
            length: { configurable: true, get: getter },
        });
        Object.setPrototypeOf(value, prototype);
        expect(candidate(value, Uint8Array.of(1), 0, blockFixture())).toEqual(expectedSlice);

        const proxyTrap = vi.fn(() => {
            throw new Error(PRIVATE_MARKER);
        });
        const other = Uint8Array.of(1);
        Object.setPrototypeOf(
            other,
            new Proxy(Uint8Array.prototype, {
                get: proxyTrap,
                ownKeys: proxyTrap,
                getPrototypeOf: proxyTrap,
                getOwnPropertyDescriptor: proxyTrap,
            }),
        );
        expect(candidate(other, Uint8Array.of(1), 0, blockFixture())).toEqual(expectedSlice);
        expect(getter).not.toHaveBeenCalled();
        expect(proxyTrap).not.toHaveBeenCalled();
    });

    it('uses the captured byte-copy builtin after later prototype replacement', () => {
        const block = blockFixture();
        const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(() => {
            throw new Error(PRIVATE_MARKER);
        });
        let result: Uint8Array | null;

        try {
            result = candidate(command, command.slice(), 0, block);
        } finally {
            set.mockRestore();
        }

        expect(result).toEqual(expectedSlice);
    });
});
