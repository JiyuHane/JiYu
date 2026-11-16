import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CryptoCall = { algorithm: string; decimal?: string; encoding?: BufferEncoding };
type FailurePhase = 'create' | 'update' | 'digest';
type Guard = { mock: { calls: readonly unknown[] } };

const cryptoState = vi.hoisted(() => ({
    calls: [] as CryptoCall[],
    failAt: null as FailurePhase | null,
}));

// This wrapper observes the actual Node hash input; it does not calculate fixtures.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();

    return {
        ...actual,
        createHash(algorithm: string) {
            const call: CryptoCall = { algorithm };
            cryptoState.calls.push(call);

            if (cryptoState.failAt === 'create') {
                throw new Error('backend secret: 4294967295 and -1');
            }

            const hash = actual.createHash(algorithm);
            return {
                update(decimal: string, encoding: BufferEncoding) {
                    call.decimal = decimal;
                    call.encoding = encoding;

                    if (cryptoState.failAt === 'update') {
                        throw new Error('backend secret: 4294967295 and -1');
                    }

                    hash.update(decimal, encoding);
                    return this;
                },
                digest() {
                    if (cryptoState.failAt === 'digest') {
                        throw new Error('backend secret: 4294967295 and -1');
                    }

                    return hash.digest();
                },
            };
        },
    };
});

// Independently computed offline with Node crypto and .NET MD5 over these literals.
const vectors = [
    { bits: 0, decimal: '0', md5: 'cfcd208495d565ef66e7dff9f98764da' },
    { bits: 1, decimal: '1', md5: 'c4ca4238a0b923820dcc509a6f75849b' },
    { bits: 0x7fffffff, decimal: '2147483647', md5: 'c588c0a459f4ccc6f3dd26518d24707a' },
    { bits: 0x80000000, decimal: '-2147483648', md5: '034ff5946105f089278eea60c488a90b' },
    { bits: 0xffffffff, decimal: '-1', md5: '6bb61e3b7bce0931da574d19d1d82c88' },
] as const;

let candidate: (bits: number) => Uint8Array;
let effectGuards: Array<{ name: string; guard: Guard }> = [];
let logGuards: Array<{ name: string; guard: Guard }> = [];

function blockedEffect(): never {
    throw new Error('unexpected side effect');
}

function capturedError(operation: () => unknown): Error {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    return caught as Error;
}

beforeEach(async () => {
    cryptoState.calls.length = 0;
    cryptoState.failAt = null;
    vi.resetModules();

    // Block, rather than merely observe, side effects throughout module import and calls.
    effectGuards = [
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
            name: 'process.dlopen',
            guard: vi.spyOn(process, 'dlopen').mockImplementation(blockedEffect),
        },
    ];
    const fetchGuard = vi.fn(blockedEffect);
    const webSocketGuard = vi.fn(blockedEffect);
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    effectGuards.push(
        { name: 'fetch', guard: fetchGuard },
        { name: 'WebSocket', guard: webSocketGuard },
    );
    logGuards = [
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
    ];

    // Keep named builtin imports guarded as well as default-object properties.
    syncBuiltinESMExports();
    candidate = (await import('../../src/direct/target-signed-decimal-md5-candidate'))
        .targetSignedDecimalMd5Candidate;
});

afterEach(() => {
    try {
        for (const { name, guard } of [...effectGuards, ...logGuards]) {
            expect(guard.mock.calls, name).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        vi.unstubAllGlobals();
        effectGuards = [];
        logGuards = [];
    }
});

describe('offline signed-decimal MD5 intermediate candidate', () => {
    it('hashes the five fixed signed-decimal ASCII vectors to raw 16-byte results', () => {
        for (const vector of vectors) {
            const result = candidate(vector.bits);
            expect(result).toBeInstanceOf(Uint8Array);
            expect(Buffer.isBuffer(result)).toBe(false);
            expect(result.byteLength).toBe(16);
            expect(result).toEqual(Uint8Array.from(Buffer.from(vector.md5, 'hex')));
        }

        expect(cryptoState.calls).toEqual(
            vectors.map(({ decimal }) => ({ algorithm: 'md5', decimal, encoding: 'ascii' })),
        );
    });

    it('is stable and returns independently mutable backing memory', () => {
        const first = candidate(0xffffffff);
        const second = candidate(0xffffffff);
        const expected = Uint8Array.from(Buffer.from(vectors[4].md5, 'hex'));
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(first).not.toBe(second);
        expect(first.buffer).not.toBe(second.buffer);
        first[0] ^= 0xff;
        expect(second).toEqual(expected);
        expect(candidate(0xffffffff)).toEqual(expected);
    });

    it('rejects invalid primitives and objects without coercion or input leakage', () => {
        const coercion = vi.fn(() => {
            throw new Error('private-coercion-marker');
        });
        const hostile = { [Symbol.toPrimitive]: coercion, valueOf: coercion, toString: coercion };
        const proxy = new Proxy(hostile, { get: coercion, getPrototypeOf: coercion });
        const revoked = Proxy.revocable(hostile, {});
        revoked.revoke();
        const invalid: unknown[] = [
            NaN,
            Infinity,
            -Infinity,
            0.5,
            4294967295.5,
            -0,
            -1,
            -0.5,
            0x100000000,
            Number.MAX_SAFE_INTEGER,
            '0',
            'private-input-marker',
            0n,
            Object(1),
            Object(1n),
            true,
            false,
            null,
            undefined,
            Symbol('private-symbol'),
            [],
            hostile,
            proxy,
            revoked.proxy,
        ];

        for (const input of invalid) {
            const error = capturedError(() => candidate(input as number));
            expect(error).toBeInstanceOf(TypeError);
            expect(error.message).toBe('invalid candidate input');
            expect(error.cause).toBeUndefined();
            expect(error.stack ?? '').not.toContain('private-input-marker');
            expect(error.stack ?? '').not.toContain('private-coercion-marker');
        }

        expect(coercion).not.toHaveBeenCalled();
        expect(cryptoState.calls).toHaveLength(0);
    });

    it('returns one fixed input-free error for provider failures without fallback', () => {
        for (const phase of ['create', 'update', 'digest'] as const) {
            cryptoState.calls.length = 0;
            cryptoState.failAt = phase;
            const error = capturedError(() => candidate(0xffffffff));
            expect(error.message).toBe('target signed decimal MD5 candidate failed');
            expect(error.cause).toBeUndefined();
            expect(error.stack ?? '').not.toContain('backend secret');
            expect(error.stack ?? '').not.toContain('4294967295');
            expect(cryptoState.calls).toHaveLength(1);
            expect(cryptoState.calls[0].algorithm).toBe('md5');
        }
    });
});
