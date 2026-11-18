import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import * as zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectZipManifest, preflightZip } from '../src/webui/plugin-install/zip-preflight';
import {
    createManifestWorkerData,
    createManifestWorkerHandler,
    createPreflightWorkerData,
    createPreflightWorkerHandler,
} from '../src/webui/plugin-install/preflight-worker-protocol';

// Keep the real compressor/decompressor but expose the latter to vi.spyOn.
vi.mock('node:zlib', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:zlib')>();
    return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) };
});

type Entry = {
    name: string;
    data?: Uint8Array | string;
    method?: 0 | 8;
    flags?: number;
    localExtra?: Uint8Array;
    centralExtra?: Uint8Array;
    payload?: Uint8Array;
    descriptor?: boolean;
};

// This is a ZIP fixture writer, not an implementation of the parser under test.
class FixtureBytes {
    private readonly chunks: Buffer[] = [];
    length = 0;

    raw(bytes: Uint8Array): void {
        const chunk = Buffer.from(bytes);
        this.chunks.push(chunk);
        this.length += chunk.length;
    }

    u16(value: number): void {
        const chunk = Buffer.alloc(2);
        chunk.writeUInt16LE(value);
        this.raw(chunk);
    }

    u32(value: number): void {
        const chunk = Buffer.alloc(4);
        chunk.writeUInt32LE(value >>> 0);
        this.raw(chunk);
    }

    finish(): Buffer {
        return Buffer.concat(this.chunks);
    }
}

// Standard fixture CRC-32; this is intentionally independent of preflightZip.
function fixtureCrc(bytes: Uint8Array): number {
    let crc = 0xffffffff;

    for (const byte of bytes) {
        crc ^= byte;

        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function ut(mtime: number): Buffer {
    const field = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0]);
    field.writeUInt32LE(mtime >>> 0, 5);
    return field;
}

function pair(mtime: number): Pick<Entry, 'localExtra' | 'centralExtra'> {
    return { localExtra: ut(mtime), centralExtra: ut(mtime) };
}

function fixtureData(value: Entry['data']): Buffer {
    return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value ?? []);
}

function makeZip(entries: Entry[]): {
    bytes: Buffer;
    locals: number[];
    centrals: number[];
    centralStart: number;
    end: number;
    compressedSizes: number[];
} {
    const local = new FixtureBytes();
    const central = new FixtureBytes();
    const locals: number[] = [];
    const centralRelative: number[] = [];
    const compressedSizes: number[] = [];

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = fixtureData(entry.data);
        const localExtra = Buffer.from(entry.localExtra ?? []);
        const centralExtra = Buffer.from(entry.centralExtra ?? []);
        const method = entry.method ?? 0;
        const flags = (entry.flags ?? 0) | (entry.descriptor ? 8 : 0);
        const hasDescriptorFlag = (flags & 8) !== 0;
        const payload = Buffer.from(
            entry.payload ?? (method === 8 ? zlib.deflateRawSync(data) : data),
        );
        const crc = fixtureCrc(data);
        const offset = local.length;
        locals.push(offset);
        centralRelative.push(central.length);
        compressedSizes.push(payload.length);

        local.u32(0x04034b50);
        local.u16(20);
        local.u16(flags);
        local.u16(method);
        local.u16(0);
        local.u16(0);
        local.u32(hasDescriptorFlag ? 0 : crc);
        local.u32(hasDescriptorFlag ? 0 : payload.length);
        local.u32(hasDescriptorFlag ? 0 : data.length);
        local.u16(name.length);
        local.u16(localExtra.length);
        local.raw(name);
        local.raw(localExtra);
        local.raw(payload);

        if (entry.descriptor) {
            local.u32(0x08074b50);
            local.u32(crc);
            local.u32(payload.length);
            local.u32(data.length);
        }

        central.u32(0x02014b50);
        central.u16(20);
        central.u16(20);
        central.u16(flags);
        central.u16(method);
        central.u16(0);
        central.u16(0);
        central.u32(crc);
        central.u32(payload.length);
        central.u32(data.length);
        central.u16(name.length);
        central.u16(centralExtra.length);
        central.u16(0);
        central.u16(0);
        central.u16(0);
        central.u32(entry.name.endsWith('/') ? 0x10 : 0);
        central.u32(offset);
        central.raw(name);
        central.raw(centralExtra);
    }

    const centralStart = local.length;
    const end = centralStart + central.length;
    const eocd = new FixtureBytes();
    eocd.u32(0x06054b50);
    eocd.u16(0);
    eocd.u16(0);
    eocd.u16(entries.length);
    eocd.u16(entries.length);
    eocd.u32(central.length);
    eocd.u32(centralStart);
    eocd.u16(0);

    return {
        bytes: Buffer.concat([local.finish(), central.finish(), eocd.finish()]),
        locals,
        centrals: centralRelative.map((offset) => centralStart + offset),
        centralStart,
        end,
        compressedSizes,
    };
}

function expectRejected(bytes: Buffer, code: string): void {
    expect(preflightZip(bytes)).toEqual({ ok: false, code });
    expect(inspectZipManifest(bytes)).toEqual({ ok: false, code });
}

// Install throwing guards for every test, and assert that no guard was reached.
// No listener, client, fetch, WebSocket, native addon, or real service is started.
let blockedCalls: string[] = [];

function block(name: string): () => never {
    return function blocked(): never {
        blockedCalls.push(name);
        throw new Error(`unexpected side effect: ${name}`);
    };
}

beforeEach(() => {
    blockedCalls = [];
    vi.spyOn(net, 'connect').mockImplementation(block('net.connect'));
    vi.spyOn(net, 'createConnection').mockImplementation(block('net.createConnection'));
    vi.spyOn(net, 'createServer').mockImplementation(block('net.createServer'));
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(block('net.Socket.connect'));
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(block('net.Server.listen'));
    vi.spyOn(http, 'request').mockImplementation(block('http.request'));
    vi.spyOn(http, 'get').mockImplementation(block('http.get'));
    vi.spyOn(http, 'createServer').mockImplementation(block('http.createServer'));
    vi.spyOn(https, 'request').mockImplementation(block('https.request'));
    vi.spyOn(https, 'get').mockImplementation(block('https.get'));
    vi.spyOn(https, 'createServer').mockImplementation(block('https.createServer'));
    vi.spyOn(http2, 'connect').mockImplementation(block('http2.connect'));
    vi.spyOn(http2, 'createServer').mockImplementation(block('http2.createServer'));
    vi.spyOn(http2, 'createSecureServer').mockImplementation(block('http2.createSecureServer'));
    vi.spyOn(tls, 'connect').mockImplementation(block('tls.connect'));
    vi.spyOn(tls, 'createServer').mockImplementation(block('tls.createServer'));
    vi.spyOn(dgram, 'createSocket').mockImplementation(block('dgram.createSocket'));
    vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(block('dgram.Socket.bind'));
    vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(block('dgram.Socket.connect'));
    vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(block('dgram.Socket.send'));
    vi.spyOn(process, 'dlopen').mockImplementation(block('process.dlopen'));
    vi.stubGlobal('fetch', block('fetch'));
    vi.stubGlobal('WebSocket', block('WebSocket'));
});

afterEach(() => {
    try {
        expect(blockedCalls).toEqual([]);
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});

describe('synthetic ZIP32 paired UT extra', () => {
    it.each([false, true])('keeps mixed UT metadata (descriptors: %s)', (descriptor) => {
        const manifest = '{"type":"module","main":"index.mjs"}';
        const entries: Entry[] = [
            { name: 'package.json', data: manifest, method: 8, descriptor, ...pair(0) },
            { name: 'lib/', ...pair(0xffffffff) },
            {
                name: 'lib/data.bin',
                data: Buffer.from([0, 1, 0xff, 42]),
                descriptor,
                ...pair(1794272800),
            },
            { name: 'plain', data: 'stored without extra' },
            { name: 'empty/', ...pair(1) },
            { name: 'empty-stored', descriptor },
            { name: 'empty-file', method: 8, descriptor, ...pair(0xffffffff) },
        ];
        const fixture = makeZip(entries);
        const digest = createHash('sha256').update(fixture.bytes).digest('hex');
        const result = preflightZip(fixture.bytes);
        expect(result.ok).toBe(true);

        if (!result.ok) {
            throw new Error(`unexpected preflight result: ${result.code}`);
        }

        expect(result.sha256).toBe(digest);
        expect(result.entries).toEqual(
            entries.map((entry, index) => {
                const data = fixtureData(entry.data);
                return {
                    path: entry.name,
                    kind: entry.name.endsWith('/') ? 'directory' : 'file',
                    compressedSize: fixture.compressedSizes[index],
                    actualSize: data.length,
                    crc32: fixtureCrc(data),
                };
            }),
        );
        expect(result.totalSize).toBe(
            entries.reduce((sum, entry) => sum + fixtureData(entry.data).length, 0),
        );
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.entries)).toBe(true);
        expect(result.entries.every(Object.isFrozen)).toBe(true);
        const inspected = inspectZipManifest(fixture.bytes);
        expect(inspected).toEqual({
            ok: true,
            sha256: digest,
            manifest: { main: 'string', type: 'module' },
        });
        expect(Object.isFrozen(inspected)).toBe(true);

        if (!inspected.ok) {
            throw new Error(`unexpected manifest result: ${inspected.code}`);
        }

        expect(Object.isFrozen(inspected.manifest)).toBe(true);
        fixture.bytes.fill(0);
        expect(result.entries[0].actualSize).toBe(Buffer.byteLength(manifest));
        expect(result.sha256).toBe(digest);
        expect(inspected.sha256).toBe(digest);
    });

    it('projects UT metadata through one-shot v1 and v2 handlers using fake ports', () => {
        const fixture = makeZip([
            {
                name: 'package.json',
                data: '{"type":"module","main":"index.mjs"}',
                ...pair(1794272800),
            },
        ]);
        const invalid = Buffer.from(fixture.bytes);
        invalid[fixture.locals[0] + 30 + Buffer.byteLength('package.json') + 5] ^= 1;

        for (const bytes of [fixture.bytes, invalid]) {
            const expectedPreflight = preflightZip(bytes);
            const expectedManifest = inspectZipManifest(bytes);
            const expectedSha = createHash('sha256').update(bytes).digest('hex');
            const v1Port = { postMessage: vi.fn(), close: vi.fn() };
            const v1Input = createPreflightWorkerData(bytes);
            const v1 = createPreflightWorkerHandler(v1Port);
            expect(v1(v1Input)).toBe('sent');
            expect(v1Input.bytes.byteLength).toBe(0);
            expect(v1Port.postMessage).toHaveBeenCalledExactlyOnceWith({
                kind: 'result',
                result: expectedPreflight,
            });
            expect(v1Port.close).toHaveBeenCalledOnce();
            expect(v1(v1Input)).toBe('already_handled');
            expect(v1Port.postMessage).toHaveBeenCalledOnce();
            expect(Object.isFrozen(v1Port.postMessage.mock.calls[0][0].result)).toBe(true);

            const v2Port = { postMessage: vi.fn(), close: vi.fn() };
            const v2Input = createManifestWorkerData(bytes);
            const v2 = createManifestWorkerHandler(v2Port);
            expect(v2(v2Input)).toBe('sent');
            expect(v2Input.bytes.byteLength).toBe(0);
            expect(v2Port.postMessage).toHaveBeenCalledExactlyOnceWith({
                kind: 'zip-manifest-result',
                version: 2,
                sha256: expectedSha,
                result: expectedManifest,
            });
            expect(v2Port.close).toHaveBeenCalledOnce();
            expect(v2(v2Input)).toBe('already_handled');
            expect(v2Port.postMessage).toHaveBeenCalledOnce();
            expect(Object.isFrozen(v2Port.postMessage.mock.calls[0][0].result)).toBe(true);
        }
    });

    it('keeps the no-extra stored path and root manifest classification working', () => {
        const fixture = makeZip([{ name: 'package.json', data: '{"type":"commonjs","main":""}' }]);
        const preflight = preflightZip(fixture.bytes);
        expect(preflight.ok).toBe(true);
        expect(inspectZipManifest(fixture.bytes)).toEqual({
            ok: true,
            sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
            manifest: { main: 'empty', type: 'commonjs' },
        });
        expect(fixtureCrc(Buffer.from('123456789'))).toBe(0xcbf43926);
    });

    it('classifies only a valid root manifest, after validating the whole archive', () => {
        const nested = makeZip([{ name: 'nested/package.json', data: '{}', ...pair(0) }]);
        expect(inspectZipManifest(nested.bytes)).toEqual({ ok: false, code: 'manifest_missing' });
        const invalid = makeZip([{ name: 'package.json', data: '{', ...pair(0xffffffff) }]);
        expect(inspectZipManifest(invalid.bytes)).toEqual({ ok: false, code: 'manifest_invalid' });
        const scalar = makeZip([{ name: 'package.json', data: '[]', ...pair(2) }]);
        expect(inspectZipManifest(scalar.bytes)).toEqual({ ok: false, code: 'manifest_invalid' });
    });

    it.each([false, true])('treats PK-like payload as bytes (descriptors: %s)', (descriptor) => {
        const binary = Buffer.from(
            '00504b0304504b0102504b0506504b0606504b0708504b06075554050001ffffffff00504bff',
            'hex',
        );

        for (const method of [0, 8] as const) {
            const payload = method === 8 ? zlib.deflateRawSync(binary, { level: 0 }) : binary;
            expect(payload.includes(Buffer.from('504b0708', 'hex'))).toBe(true);
            const fixture = makeZip([
                { name: 'bytes.bin', data: binary, method, payload, descriptor, ...pair(7) },
            ]);
            const result = preflightZip(fixture.bytes);
            expect(result.ok).toBe(true);

            if (result.ok) {
                expect(result.entries[0].actualSize).toBe(binary.length);
                expect(result.entries[0].compressedSize).toBe(payload.length);
                expect(result.entries[0].crc32).toBe(fixtureCrc(binary));
                expect(result.sha256).toBe(
                    createHash('sha256').update(fixture.bytes).digest('hex'),
                );
            }
        }
    });

    it.each([false, true])('rejects unmatched UT mtimes (descriptors: %s)', (descriptor) => {
        const cases: Entry[] = [
            { name: 'x', centralExtra: ut(1) },
            { name: 'x', localExtra: ut(1) },
            { name: 'x', localExtra: ut(0), centralExtra: ut(0xffffffff) },
        ];

        for (const entry of cases) {
            expectRejected(makeZip([{ ...entry, descriptor }]).bytes, 'malformed');
        }
    });

    it('distinguishes truncated extra fields from unsupported complete fields', () => {
        const badTag = ut(5);
        badTag[0] ^= 1;
        const shortTime = ut(5);
        shortTime.writeUInt16LE(4, 2);
        const truncatedBody = ut(5);
        truncatedBody.writeUInt16LE(6, 2);
        const longTime = Buffer.concat([ut(5), Buffer.from([0])]);
        longTime.writeUInt16LE(6, 2);
        const flags = [0, 2, 3, 7, 0x81].map((flag) => {
            const field = ut(5);
            field[4] = flag;
            return field;
        });
        const zip64 = Buffer.from([0x01, 0x00, 0x00, 0x00]);
        const extraFields: Array<{ extra: Buffer; code: 'malformed' | 'unsupported' }> = [
            // The legacy one-byte extra is explicitly unsupported.
            { extra: Buffer.from([0x55]), code: 'unsupported' },
            { extra: ut(5).subarray(0, 8), code: 'malformed' },
            { extra: Buffer.concat([ut(5), Buffer.from([0])]), code: 'malformed' },
            { extra: shortTime, code: 'malformed' },
            { extra: truncatedBody, code: 'malformed' },
            { extra: longTime, code: 'unsupported' },
            { extra: Buffer.concat([ut(5), Buffer.alloc(32)]), code: 'unsupported' },
            { extra: badTag, code: 'unsupported' },
            ...flags.map((extra) => ({ extra, code: 'unsupported' as const })),
            { extra: Buffer.concat([ut(5), ut(5)]), code: 'unsupported' },
            { extra: Buffer.concat([ut(5), zip64]), code: 'unsupported' },
            { extra: Buffer.concat([zip64, ut(5)]), code: 'unsupported' },
            { extra: zip64, code: 'unsupported' },
        ];

        for (const { extra, code } of extraFields) {
            const entry = { name: 'x', localExtra: extra, centralExtra: extra };
            expectRejected(makeZip([entry]).bytes, code);
        }
    });

    it('checks the local extra independently after a valid central UT field', () => {
        const tag = ut(5);
        tag[1] ^= 1;
        const flag3 = ut(5);
        flag3[4] = 3;
        const flag7 = ut(5);
        flag7[4] = 7;
        const short = ut(5);
        short.writeUInt16LE(4, 2);
        const cases: Array<{ localExtra: Buffer; code: 'malformed' | 'unsupported' }> = [
            { localExtra: tag, code: 'unsupported' },
            { localExtra: flag3, code: 'unsupported' },
            { localExtra: flag7, code: 'unsupported' },
            { localExtra: short, code: 'malformed' },
            { localExtra: ut(5).subarray(0, 8), code: 'malformed' },
            { localExtra: Buffer.from([0x55]), code: 'unsupported' },
            { localExtra: Buffer.concat([ut(5), ut(5)]), code: 'unsupported' },
            { localExtra: Buffer.from([1, 0, 0, 0]), code: 'unsupported' },
        ];

        for (const { localExtra, code } of cases) {
            expectRejected(makeZip([{ name: 'x', centralExtra: ut(5), localExtra }]).bytes, code);
        }
    });

    it('rejects truncated records and extra lengths that extend past their bounds', () => {
        const fixture = makeZip([{ name: 'x', data: 'data', ...pair(42) }]);
        expectRejected(fixture.bytes.subarray(0, -1), 'malformed');
        const centralLength = Buffer.from(fixture.bytes);
        centralLength.writeUInt16LE(0xffff, fixture.centrals[0] + 30);
        expectRejected(centralLength, 'malformed');
        const localLength = Buffer.from(fixture.bytes);
        localLength.writeUInt16LE(0xffff, fixture.locals[0] + 28);
        expectRejected(localLength, 'malformed');
        const centralSize = Buffer.from(fixture.bytes);
        centralSize.writeUInt32LE(centralSize.readUInt32LE(fixture.end + 12) - 1, fixture.end + 12);
        expectRejected(centralSize, 'malformed');
    });

    it('preserves flag, unsafe path and collision checks with UT', () => {
        expectRejected(makeZip([{ name: 'x', flags: 8, ...pair(7) }]).bytes, 'malformed');

        for (const flags of [1, 0x2000]) {
            expectRejected(makeZip([{ name: 'x', flags, ...pair(7) }]).bytes, 'unsupported');
        }

        for (const name of ['é', '../x', 'a/../b', '/root']) {
            expectRejected(makeZip([{ name, ...pair(7) }]).bytes, 'unsafe_path');
            expectRejected(
                makeZip([{ name, flags: 0x800, descriptor: true, ...pair(7) }]).bytes,
                'unsafe_path',
            );
        }

        for (const names of [
            ['A/x', 'a/y'],
            ['x', 'x'],
            ['a', 'a/b'],
        ]) {
            for (const descriptor of [false, true]) {
                const entries = names.map((name) => ({ name, descriptor, ...pair(7) }));
                expectRejected(makeZip(entries).bytes, 'collision');
            }
        }
    });

    it('rejects EOCD comments, extra trailing payload, and mismatched local headers', () => {
        const fixture = makeZip([{ name: 'abc', data: 'ok', ...pair(8) }]);
        const declaredComment = Buffer.from(fixture.bytes);
        declaredComment.writeUInt16LE(1, fixture.end + 20);
        expectRejected(declaredComment, 'unsupported');
        const comment = Buffer.concat([declaredComment, Buffer.from([0x61])]);
        expectRejected(comment, 'malformed');
        const suffix = Buffer.concat([fixture.bytes, Buffer.from([0])]);
        expectRejected(suffix, 'malformed');
        const gap = Buffer.concat([
            fixture.bytes.subarray(0, fixture.centralStart),
            Buffer.from([0x99]),
            fixture.bytes.subarray(fixture.centralStart),
        ]);
        gap.writeUInt32LE(fixture.centralStart + 1, fixture.end + 1 + 16);
        expectRejected(gap, 'malformed');

        // Change only the local version/flags/method/time/date/CRC/sizes/name.
        for (const offset of [4, 6, 8, 10, 12, 14, 18, 22, 30]) {
            const mismatch = Buffer.from(fixture.bytes);
            mismatch[fixture.locals[0] + offset] ^= 1;
            expectRejected(mismatch, 'malformed');
        }
    });

    it.each([false, true])('checks content integrity (descriptors: %s)', (descriptor) => {
        const stored = makeZip([{ name: 'x', data: 'abc', descriptor, ...pair(0) }]);
        const corrupt = Buffer.from(stored.bytes);
        corrupt[stored.locals[0] + 30 + Buffer.byteLength('x') + 9] ^= 1;
        expectRejected(corrupt, 'integrity');
        const data = Buffer.from('abc');
        const entry = { name: 'x', data, method: 8 as const, descriptor, ...pair(3) };
        const payload = Buffer.concat([zlib.deflateRawSync(data), Buffer.from([0])]);
        expectRejected(makeZip([{ ...entry, payload }]).bytes, 'integrity');
        const wrongSize = makeZip([entry]);
        const sizeOffset = descriptor ? wrongSize.centralStart - 4 : wrongSize.locals[0] + 22;
        wrongSize.bytes.writeUInt32LE(data.length + 1, sizeOffset);
        wrongSize.bytes.writeUInt32LE(data.length + 1, wrongSize.centrals[0] + 24);
        expectRejected(wrongSize.bytes, 'integrity');
    });

    it('validates a later entry before any inflate call, including the runtime probe', () => {
        const fixture = makeZip([
            { name: 'first', data: 'compressed first', method: 8, ...pair(0) },
            { name: 'later', data: 'stored second', ...pair(0xffffffff) },
        ]);
        const badLocal = Buffer.from(fixture.bytes);
        badLocal[fixture.locals[1]] ^= 1;
        const badCentral = Buffer.from(fixture.bytes);
        badCentral[fixture.centrals[1]] ^= 1;
        const badExtra = Buffer.from(fixture.bytes);
        badExtra[fixture.centrals[1] + 46 + Buffer.byteLength('later') + 4] = 3;
        const mismatchedTime = Buffer.from(fixture.bytes);
        mismatchedTime[fixture.locals[1] + 30 + Buffer.byteLength('later') + 5] ^= 1;
        const badSize = Buffer.from(fixture.bytes);
        const secondSize = Buffer.byteLength('stored second') + 1;
        badSize.writeUInt32LE(secondSize, fixture.locals[1] + 22);
        badSize.writeUInt32LE(secondSize, fixture.centrals[1] + 24);
        const withDescriptor = makeZip([
            { name: 'package.json', data: '{}', method: 8, descriptor: true, ...pair(0) },
            { name: 'later', data: 'stored second', descriptor: true, ...pair(0xffffffff) },
        ]);
        const badDescriptor = Buffer.from(withDescriptor.bytes);
        badDescriptor[withDescriptor.centralStart - 12] ^= 1; // Later descriptor CRC.
        const inflate = vi.spyOn(zlib, 'inflateRawSync');

        for (const [bytes, code] of [
            [badLocal, 'malformed'],
            [badCentral, 'malformed'],
            [badExtra, 'unsupported'],
            [mismatchedTime, 'malformed'],
            [badSize, 'integrity'],
            [badDescriptor, 'malformed'],
        ] as const) {
            inflate.mockClear();
            expect(preflightZip(bytes)).toEqual({ ok: false, code });
            expect(inflate).not.toHaveBeenCalled();
            inflate.mockClear();
            expect(inspectZipManifest(bytes)).toEqual({ ok: false, code });
            expect(inflate).not.toHaveBeenCalled();
        }
    });
});
