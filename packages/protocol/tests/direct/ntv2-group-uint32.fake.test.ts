import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import type { NTV2GroupInfo as HighwayGroupInfo } from '@snowluma/proto-defs/highway';
import type { NTV2GroupInfo as OidbGroupInfo } from '@snowluma/proto-defs/oidb-actions/media';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Guard = { mock: { calls: readonly unknown[] } };
type NamedGuard = { name: string; guard: Guard };

// These are two distinct schema declarations with the same field shape.
// The Proton calls are compiled by the protocol Vitest plugin, not a test encoder.
const codecs = [
    {
        name: 'highway',
        encode: (value: HighwayGroupInfo) => protobuf_encode<HighwayGroupInfo>(value),
        decode: (bytes: Uint8Array) => protobuf_decode<HighwayGroupInfo>(bytes),
    },
    {
        name: 'oidb media',
        encode: (value: OidbGroupInfo) => protobuf_encode<OidbGroupInfo>(value),
        decode: (bytes: Uint8Array) => protobuf_decode<OidbGroupInfo>(bytes),
    },
] as const;

let guards: NamedGuard[] = [];

function blockedEffect(): never {
    throw new Error('unexpected side effect in synthetic schema test');
}

// Schema-only fixtures: no networking, child processes, native loading or workers.
// Fail even if a guarded effect is attempted and its error is subsequently caught.
beforeEach(() => {
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
        { name: 'dns.lookup', guard: vi.spyOn(dns, 'lookup').mockImplementation(blockedEffect) },
        { name: 'dns.resolve', guard: vi.spyOn(dns, 'resolve').mockImplementation(blockedEffect) },
        {
            name: 'dns.resolve4',
            guard: vi.spyOn(dns, 'resolve4').mockImplementation(blockedEffect),
        },
        {
            name: 'dns.resolve6',
            guard: vi.spyOn(dns, 'resolve6').mockImplementation(blockedEffect),
        },
        { name: 'dns.reverse', guard: vi.spyOn(dns, 'reverse').mockImplementation(blockedEffect) },
        {
            name: 'dns.promises.lookup',
            guard: vi.spyOn(dns.promises, 'lookup').mockImplementation(blockedEffect),
        },
        {
            name: 'dns.promises.resolve',
            guard: vi.spyOn(dns.promises, 'resolve').mockImplementation(blockedEffect),
        },
        {
            name: 'dns.promises.resolve4',
            guard: vi.spyOn(dns.promises, 'resolve4').mockImplementation(blockedEffect),
        },
        {
            name: 'dns.promises.resolve6',
            guard: vi.spyOn(dns.promises, 'resolve6').mockImplementation(blockedEffect),
        },
        {
            name: 'dns.promises.reverse',
            guard: vi.spyOn(dns.promises, 'reverse').mockImplementation(blockedEffect),
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
            name: 'process.dlopen',
            guard: vi.spyOn(process, 'dlopen').mockImplementation(blockedEffect),
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
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    vi.stubGlobal('XMLHttpRequest', xhrGuard);
    vi.stubGlobal('EventSource', eventSourceGuard);
    guards.push(
        { name: 'fetch', guard: fetchGuard },
        { name: 'WebSocket', guard: webSocketGuard },
        { name: 'XMLHttpRequest', guard: xhrGuard },
        { name: 'EventSource', guard: eventSourceGuard },
    );
    syncBuiltinESMExports();
});

afterEach(() => {
    try {
        for (const { name, guard } of guards) {
            expect(guard.mock.calls, name).toHaveLength(0);
        }
    } finally {
        try {
            vi.restoreAllMocks();
            syncBuiltinESMExports();
        } finally {
            vi.unstubAllGlobals();
            guards = [];
        }
    }
});

describe('synthetic NTV2GroupInfo uint32 schema encoding', () => {
    it.each(codecs)('$name narrows 2^32 + 42 to the same bytes as 42', ({ encode, decode }) => {
        const ordinary = { groupUin: 42 };
        const overUint32 = { groupUin: 4294967338 };
        const maxUint32 = { groupUin: 4294967295 };
        const ordinaryBytes = encode(ordinary);
        const overBytes = encode(overUint32);
        const maxBytes = encode(maxUint32);

        expect(ordinaryBytes).toEqual(Uint8Array.of(0x08, 0x2a));
        expect(overBytes).toEqual(ordinaryBytes);
        expect(decode(ordinaryBytes).groupUin).toBe(42);
        expect(decode(overBytes).groupUin).toBe(42);
        expect(maxBytes).toEqual(Uint8Array.of(0x08, 0xff, 0xff, 0xff, 0xff, 0x0f));
        expect(decode(maxBytes).groupUin).toBe(4294967295);
    });

    it.each(codecs)('$name decodes a nonzero 2^32 input as zero', ({ encode, decode }) => {
        const wrappedZero = { groupUin: 4294967296 };
        // The original value is nonzero, so it may encode as an explicit tag/zero.
        // Do not equate its bytes with an unset or zero-valued field.
        expect(decode(encode(wrappedZero)).groupUin).toBe(0);
    });
});
