import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { preflightZip } from '../src/webui/plugin-install/zip-preflight';

vi.mock('node:zlib', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:zlib')>();
    return { ...original, inflateRawSync: vi.fn(original.inflateRawSync) };
});

type FixtureEntry = {
    name: string;
    data?: Uint8Array;
    payload?: Uint8Array;
    host?: number;
    mode?: number;
    flags?: number;
    method?: number;
    extra?: Uint8Array;
};

function crc32(bytes: Uint8Array): number {
    let value = 0xffffffff;

    for (const byte of bytes) {
        value ^= byte;

        for (let bit = 0; bit < 8; bit++) {
            value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
        }
    }

    return (value ^ 0xffffffff) >>> 0;
}

function zip(entries: FixtureEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.from(entry.data ?? []);
        const extra = Buffer.from(entry.extra ?? []);
        const directory = entry.name.endsWith('/');
        const flags = entry.flags ?? 0;
        const method = entry.method ?? 0;
        const payload = Buffer.from(
            entry.payload ?? (method === 8 ? zlib.deflateRawSync(data) : data),
        );
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(extra.length, 28);
        locals.push(local, name, extra, payload);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(((entry.host ?? 0) << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc32(data), 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(extra.length, 30);
        const attr = (((entry.mode ?? 0) << 16) | (directory ? 0x10 : 0)) >>> 0;
        central.writeUInt32LE(attr, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name, extra);
        offset += local.length + name.length + extra.length + payload.length;
    }

    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

function cdOffset(input: Buffer): number {
    return input.readUInt32LE(input.length - 6);
}

function rejected(input: unknown, code: string): void {
    expect(preflightZip(input)).toEqual({ ok: false, code });
}

describe('ZIP32 stored preflight', () => {
    it('accepts files and explicit/implicit empty directories with frozen metadata', () => {
        const archive = zip([
            { name: 'dir/' },
            { name: 'dir/test.bin', data: Uint8Array.of(0, 255, 13) },
            { name: 'empty/' },
            { name: 'other/a' },
        ]);
        const result = preflightZip(archive);
        expect(result.ok).toBe(true);

        if (!result.ok) {
            throw new Error('fixture failed');
        }

        expect(result.entries).toEqual([
            { path: 'dir/', kind: 'directory', compressedSize: 0, actualSize: 0, crc32: 0 },
            {
                path: 'dir/test.bin',
                kind: 'file',
                compressedSize: 3,
                actualSize: 3,
                crc32: crc32(Uint8Array.of(0, 255, 13)),
            },
            { path: 'empty/', kind: 'directory', compressedSize: 0, actualSize: 0, crc32: 0 },
            { path: 'other/a', kind: 'file', compressedSize: 0, actualSize: 0, crc32: 0 },
        ]);
        expect(result.totalSize).toBe(3);
        expect(result.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
        expect(
            Object.isFrozen(result) &&
                Object.isFrozen(result.entries) &&
                result.entries.every(Object.isFrozen),
        ).toBe(true);
        archive.fill(0);
        expect(result.entries[1].actualSize).toBe(3);
    });
    it('rejects archives without a file entry', () => {
        rejected(zip([]), 'malformed');
        rejected(zip([{ name: 'empty/' }]), 'malformed');
    });
    it('checks the standard CRC32 vector with a sliced input view', () => {
        const payload = Buffer.from('123456789');
        expect(crc32(payload)).toBe(0xcbf43926);
        const archive = zip([{ name: 'x', data: payload }]);
        const wrapped = Buffer.concat([Buffer.from([9]), archive, Buffer.from([8])]);
        const result = preflightZip(wrapped.subarray(1, -1));
        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.entries[0].crc32).toBe(0xcbf43926);
            expect(result.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
        }
    });
    it('treats PK signatures inside binary payload as bytes', () => {
        const payload = Buffer.from('504b0304504b0102504b050600ff', 'hex');
        const result = preflightZip(zip([{ name: 'bytes', data: payload }]));
        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.entries[0].crc32).toBe(crc32(payload));
            expect(JSON.stringify(result)).not.toContain(payload.toString('hex'));
        }
    });
    it('rejects truncation, concatenation, prefixes and suffixes', () => {
        const one = zip([{ name: 'a' }]);

        for (const item of [
            one.subarray(0, -1),
            Buffer.concat([one, one]),
            Buffer.concat([Buffer.from([1]), one]),
            Buffer.concat([one, Buffer.from([1])]),
        ]) {
            rejected(item, 'malformed');
        }
    });
    it('rejects aliased local offsets and overlap', () => {
        const z = zip([{ name: 'a' }, { name: 'b' }]);
        const cd = cdOffset(z);
        z.writeUInt32LE(0, cd + 47 + 42);
        rejected(z, 'malformed');
        z.writeUInt32LE(1, cd + 47 + 42);
        rejected(z, 'malformed');
    });
    it('rejects a gap before the central directory and mismatched central lengths', () => {
        const z = zip([{ name: 'a' }]);
        const cd = cdOffset(z);
        const hole = Buffer.concat([z.subarray(0, cd), Buffer.from([0]), z.subarray(cd)]);
        hole.writeUInt32LE(cd + 1, hole.length - 6);
        rejected(hole, 'malformed');
        z.writeUInt32LE(z.readUInt32LE(z.length - 10) - 1, z.length - 10);
        rejected(z, 'malformed');
    });
    it('rejects central versus local header and name mismatches', () => {
        for (const offset of [4, 6, 8, 10, 12, 14, 18, 22, 30]) {
            const z = zip([{ name: 'abc', data: Uint8Array.of(1) }]);
            z[offset] ^= 1;
            expect(preflightZip(z).ok).toBe(false);
        }
    });
    it('detects data CRC and stored size inconsistency', () => {
        const z = zip([{ name: 'a', data: Uint8Array.of(1, 2) }]);
        z[31] ^= 1;
        rejected(z, 'integrity');
        const size = zip([{ name: 'a', data: Uint8Array.of(1, 2) }]);
        size.writeUInt32LE(1, 22);
        size.writeUInt32LE(1, cdOffset(size) + 24);
        rejected(size, 'integrity');
    });
    it('rejects descriptor, encrypted, unknown flags, unsupported methods and extras', () => {
        for (const entry of [
            { flags: 8 },
            { flags: 1 },
            { flags: 0x2000 },
            { method: 9 },
            { extra: Uint8Array.of(1) },
        ]) {
            rejected(zip([{ name: 'x', ...entry }]), 'unsupported');
        }
    });
    it('rejects ZIP64, multi-disk and unsupported creator hosts', () => {
        const z = zip([{ name: 'x' }]);
        z.writeUInt32LE(0xffffffff, cdOffset(z) + 24);
        rejected(z, 'unsupported');
        const disk = zip([]);
        disk.writeUInt16LE(1, disk.length - 18);
        rejected(disk, 'unsupported');
        rejected(zip([{ name: 'x', host: 7 }]), 'unsupported');
    });
    it('validates Unix file types, special modes and DOS attributes', () => {
        expect(
            preflightZip(
                zip([
                    { name: 'x', host: 3, mode: 0x81a4 },
                    { name: 'd/', host: 3, mode: 0x41ed },
                ]),
            ).ok,
        ).toBe(true);

        for (const mode of [0xa1ff, 0x11a4, 0x21a4, 0x61a4, 0xc1a4, 0x89a4, 0x85a4, 0x83a4, 0]) {
            rejected(zip([{ name: 'x', host: 3, mode }]), 'unsupported');
        }

        const attr = zip([{ name: 'x' }]);
        attr.writeUInt32LE(0x10, cdOffset(attr) + 38);
        rejected(attr, 'unsupported');
        rejected(zip([{ name: 'd/', data: Uint8Array.of(1) }]), 'malformed');
    });
    it('rejects dangerous path components and reserved names', () => {
        for (const name of [
            '/a',
            '../a',
            'a//b',
            'a/./b',
            'a/../b',
            'a\\b',
            'C:/x',
            'a:b',
            'a.',
            'a ',
            'CON.txt',
            'aux',
            'COM9.x',
            'lpt1',
            'é',
            'a/'.repeat(17) + 'x',
            'a'.repeat(101),
        ]) {
            rejected(zip([{ name }]), 'unsafe_path');
        }
    });
    it('rejects explicit duplicates, case variants, and file-directory conflicts', () => {
        for (const names of [
            ['a', 'a'],
            ['A/x', 'a/y'],
            ['a', 'a/b'],
            ['a/b', 'a'],
            ['a/', 'a'],
            ['a', 'a/'],
            ['a/', 'a/'],
        ]) {
            rejected(zip(names.map((name) => ({ name }))), 'collision');
        }

        expect(preflightZip(zip([{ name: 'a/b' }, { name: 'a/' }])).ok).toBe(true);
    });
    it('rejects oversized input, records and declared file size', () => {
        rejected(new Uint8Array(32 * 1024 * 1024 + 1), 'limit');
        rejected(zip(Array.from({ length: 513 }, (_, i) => ({ name: `f${i}` }))), 'limit');
        const z = zip([{ name: 'x' }]);
        z.writeUInt32LE(8 * 1024 * 1024 + 1, cdOffset(z) + 24);
        rejected(z, 'limit');
    });
    it('rejects shared buffers, proxy and non-byte inputs without invoking getters', () => {
        rejected(new Uint8Array(new SharedArrayBuffer(32)), 'invalid_input');
        rejected(new Proxy(new Uint8Array(0), {}), 'invalid_input');
        rejected(new Uint16Array(3), 'invalid_input');
        rejected({}, 'invalid_input');
        const z = zip([{ name: 'x' }]);

        for (const key of ['buffer', 'byteOffset', 'byteLength', 'constructor', 'slice']) {
            Object.defineProperty(z, key, {
                get() {
                    throw new Error('getter called');
                },
            });
        }

        expect(preflightZip(z).ok).toBe(true);
    });
    it('accepts mixed compressed, incompressible, empty and signature-bearing data', () => {
        const random = Buffer.alloc(65536);
        let state = 123456789;

        for (let i = 0; i < random.length; i++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            random[i] = state & 255;
        }

        const signature = Buffer.from('504b0304504b0102504b0506', 'hex');
        const archive = zip([
            { name: 'd/' },
            { name: 'd/a', method: 8, data: Buffer.from('hello '.repeat(100)) },
            { name: 'b', method: 8, data: random },
            { name: 'empty', method: 8 },
            {
                name: 'sig',
                method: 8,
                data: signature,
                payload: zlib.deflateRawSync(signature, { level: 0 }),
            },
            { name: 'stored', data: Buffer.from('stored') },
        ]);
        expect(archive.includes(signature)).toBe(true);
        const result = preflightZip(archive);
        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.totalSize).toBe(600 + random.length + signature.length + 6);
            expect(result.entries.map((entry) => entry.actualSize)).toEqual([
                0,
                600,
                random.length,
                0,
                signature.length,
                6,
            ]);
            expect(Object.isFrozen(result)).toBe(true);
            expect(Object.isFrozen(result.entries)).toBe(true);
            expect(result.entries.every(Object.isFrozen)).toBe(true);
            expect(Object.keys(result.entries[0]).sort()).toEqual([
                'actualSize',
                'compressedSize',
                'crc32',
                'kind',
                'path',
            ]);
            expect(result.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
            archive.fill(0);
            expect(result.entries[1].actualSize).toBe(600);
        }
    });
    it('rejects trailing bytes, concatenated streams, truncation and invalid streams', () => {
        const data = Buffer.from('abcdef');
        const compressed = zlib.deflateRawSync(data);

        for (const payload of [
            Buffer.concat([compressed, Buffer.from([0])]),
            Buffer.concat([compressed, compressed]),
            compressed.subarray(0, -1),
            Buffer.alloc(0),
            Buffer.from([0xff, 0xff]),
        ]) {
            rejected(zip([{ name: 'x', method: 8, data, payload }]), 'integrity');
        }
    });
    it('rejects deflate CRC, declared size, method version and directory violations', () => {
        const make = () => zip([{ name: 'x', method: 8, data: Buffer.from('abc') }]);
        const crc = make();
        crc.writeUInt32LE(0, 14);
        crc.writeUInt32LE(0, cdOffset(crc) + 16);
        rejected(crc, 'integrity');

        for (const size of [2, 4]) {
            const z = make();
            z.writeUInt32LE(size, 22);
            z.writeUInt32LE(size, cdOffset(z) + 24);
            rejected(z, 'integrity');
        }

        const version = make();
        version.writeUInt16LE(10, 4);
        version.writeUInt16LE(10, cdOffset(version) + 6);
        rejected(version, 'unsupported');
        rejected(zip([{ name: 'd/', method: 8 }]), 'unsupported');
    });
    it('validates every structure before calling inflate, including the probe', () => {
        const mock = vi.mocked(zlib.inflateRawSync);
        mock.mockClear();
        const z = zip([{ name: 'a', method: 8, data: Buffer.from('first') }, { name: 'b' }]);
        const second = 30 + 1 + z.readUInt32LE(18);
        z[second] ^= 1;
        rejected(z, 'malformed');
        expect(mock).not.toHaveBeenCalled();
    });
    it('rejects a later stored size mismatch before any inflate or probe', () => {
        const z = zip([
            { name: 'a', method: 8, data: Buffer.from('first') },
            { name: 'b', data: Buffer.from([1]) },
        ]);
        const second = 31 + z.readUInt32LE(18);
        z.writeUInt32LE(2, second + 22);
        z.writeUInt32LE(2, cdOffset(z) + 47 + 24);
        const mock = vi.mocked(zlib.inflateRawSync);
        mock.mockClear();
        rejected(z, 'integrity');
        expect(mock).not.toHaveBeenCalled();
    });
    it('fails closed when the runtime probe fails without affecting stored archives', () => {
        const mock = vi.mocked(zlib.inflateRawSync);
        mock.mockImplementationOnce(() => {
            throw new Error('private probe detail');
        });
        rejected(zip([{ name: 'x', method: 8 }]), 'unsupported');
        mock.mockClear();
        expect(preflightZip(zip([{ name: 'x', data: Buffer.from('ok') }])).ok).toBe(true);
        expect(mock).not.toHaveBeenCalled();
        expect(preflightZip(zip([{ name: 'x', method: 8 }])).ok).toBe(true);
    });
    it('snapshots the inflate result once before checking trailing bytes', async () => {
        const original = await vi.importActual<typeof import('node:zlib')>('node:zlib');
        const mock = vi.mocked(zlib.inflateRawSync);
        const data = Buffer.from('123456789');
        const compressed = zlib.deflateRawSync(data);
        expect(compressed.length).toBe(11);
        const archive = zip([
            { name: 'x', method: 8, data, payload: Buffer.concat([compressed, Buffer.from([0])]) },
        ]);
        let buffers = 0;
        let engines = 0;
        let reads = 0;

        try {
            for (let i = 0; i < 5; i++) {
                mock.mockImplementationOnce(original.inflateRawSync);
            }

            mock.mockImplementationOnce(
                () =>
                    ({
                        get buffer() {
                            buffers++;
                            return data;
                        },
                        get engine() {
                            engines++;
                            return {
                                get bytesWritten() {
                                    return ++reads === 1 ? 11 : 12;
                                },
                            };
                        },
                    }) as never,
            );
            rejected(archive, 'integrity');
            expect([buffers, engines, reads]).toEqual([1, 1, 1]);
        } finally {
            mock.mockReset();
        }
    });
    it('classifies throwing info getters as unsupported for probes and internal for entries', async () => {
        const original = await vi.importActual<typeof import('node:zlib')>('node:zlib');
        const mock = vi.mocked(zlib.inflateRawSync);
        const archive = zip([{ name: 'x', method: 8, data: Buffer.from('x') }]);
        const poison = () =>
            ({
                buffer: Buffer.from('x'),
                engine: {
                    get bytesWritten() {
                        throw 'integrity';
                    },
                },
            }) as never;

        try {
            mock.mockImplementationOnce(poison);
            rejected(archive, 'unsupported');

            for (let i = 0; i < 5; i++) {
                mock.mockImplementationOnce(original.inflateRawSync);
            }

            mock.mockImplementationOnce(poison);
            rejected(archive, 'internal');
        } finally {
            mock.mockReset();
        }
    });
    it('classifies actual inflate errors and malformed engine info without leaking details', async () => {
        const original = await vi.importActual<typeof import('node:zlib')>('node:zlib');
        const mock = vi.mocked(zlib.inflateRawSync);
        const archive = zip([{ name: 'x', method: 8, data: Buffer.from('x') }]);
        const failures: Array<{ result?: unknown; code?: string; expected: string }> = [
            { code: 'ERR_BUFFER_TOO_LARGE', expected: 'limit' },
            { code: 'Z_DATA_ERROR', expected: 'integrity' },
            { code: 'Z_BUF_ERROR', expected: 'integrity' },
            { code: 'UNEXPECTED_PRIVATE_DETAIL', expected: 'internal' },
            {
                result: { buffer: new Uint8Array(1), engine: { bytesWritten: 3 } },
                expected: 'internal',
            },
            {
                result: { buffer: Buffer.from('x'), engine: { bytesWritten: NaN } },
                expected: 'internal',
            },
            {
                result: { buffer: Buffer.from('x'), engine: { bytesWritten: 1000 } },
                expected: 'internal',
            },
            { result: { buffer: Buffer.from('x') }, expected: 'internal' },
        ];

        try {
            for (const failure of failures) {
                for (let i = 0; i < 5; i++) {
                    mock.mockImplementationOnce(original.inflateRawSync);
                }

                mock.mockImplementationOnce(() => {
                    if (failure.code) {
                        throw Object.assign(new Error('private detail'), { code: failure.code });
                    }

                    return failure.result as never;
                });
                rejected(archive, failure.expected);
            }
        } finally {
            mock.mockReset();
        }
    });
    it('enforces per-item and aggregate budgets, including empty streams with zero remaining', () => {
        const max = 8 * 1024 * 1024;
        const block = Buffer.alloc(max, 0x61);
        const four = Array.from({ length: 4 }, (_, i) => ({
            name: `x${i}`,
            method: 8,
            data: block,
        }));
        const full = zip([...four, { name: 'empty', method: 8 }]);
        const result = preflightZip(full);
        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.totalSize).toBe(32 * 1024 * 1024);
        }

        rejected(zip([{ name: 'x', method: 8, data: Buffer.alloc(max + 1) }]), 'limit');
        rejected(
            zip([{ name: 'x', method: 8, payload: zlib.deflateRawSync(Buffer.alloc(max + 1)) }]),
            'limit',
        );
        rejected(zip([...four, { name: 'extra', method: 8, data: Buffer.from([1]) }]), 'limit');
        const oversizedCompressed = zip([
            { name: 'x', method: 8, data: Buffer.alloc(max), payload: Buffer.alloc(max + 1) },
        ]);
        rejected(oversizedCompressed, 'limit');
        // Declared empty but actual non-empty after the total budget is exhausted.
        const sneaky = zip([
            ...four,
            { name: 'empty', method: 8, payload: zlib.deflateRawSync(Buffer.from([1])) },
        ]);
        rejected(sneaky, 'limit');
    }, 30000);
    it('does not access filesystem, network or fetch during parsing', () => {
        const read = vi.spyOn(fs, 'readFileSync');
        const connect = vi.spyOn(net, 'connect');
        const fetcher = vi.spyOn(globalThis, 'fetch');

        try {
            expect(preflightZip(zip([{ name: 'x' }])).ok).toBe(true);
            expect(read).not.toHaveBeenCalled();
            expect(connect).not.toHaveBeenCalled();
            expect(fetcher).not.toHaveBeenCalled();
        } finally {
            read.mockRestore();
            connect.mockRestore();
            fetcher.mockRestore();
        }
    });
});
