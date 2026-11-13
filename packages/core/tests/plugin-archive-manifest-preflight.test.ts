import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { inspectZipManifest, preflightZip } from '../src/webui/plugin-install/zip-preflight';

vi.mock('node:zlib', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:zlib')>();
    return { ...original, inflateRawSync: vi.fn(original.inflateRawSync) };
});

type Entry = { name: string; data?: Uint8Array; method?: 0 | 8; payload?: Uint8Array };

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;

    for (const byte of bytes) {
        crc ^= byte;

        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function archive(entries: Entry[]): {
    bytes: Buffer;
    dataOffsets: number[];
    localOffsets: number[];
} {
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    const dataOffsets: number[] = [];
    const localOffsets: number[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name);
        const data = Buffer.from(entry.data ?? []);
        const method = entry.method ?? 0;
        const payload = Buffer.from(
            entry.payload ?? (method === 8 ? zlib.deflateRawSync(data) : data),
        );
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(crc32(data), 14);
        lh.writeUInt32LE(payload.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt32LE(crc32(data), 16);
        ch.writeUInt32LE(payload.length, 20);
        ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(entry.name.endsWith('/') ? 0x10 : 0, 38);
        ch.writeUInt32LE(offset, 42);
        localOffsets.push(offset);
        dataOffsets.push(offset + 30 + name.length);
        local.push(lh, name, payload);
        central.push(ch, name);
        offset += 30 + name.length + payload.length;
    }

    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return { bytes: Buffer.concat([...local, cd, end]), dataOffsets, localOffsets };
}

const bytes = (value: string) => Buffer.from(value, 'utf8');

const expectedError = (data: unknown, code: string) => {
    const result = inspectZipManifest(data);
    expect(result).toEqual({ ok: false, code });
    expect(Object.isFrozen(result)).toBe(true);
};

describe('offline archive manifest classification', () => {
    it.each([0, 8] as const)(
        'classifies a root manifest with method %i and frozen result',
        (method) => {
            const zip = archive([
                {
                    name: 'package.json',
                    method,
                    data: bytes('{"main":"index.js","type":"module"}'),
                },
            ]).bytes;
            const result = inspectZipManifest(zip);
            expect(result).toEqual({
                ok: true,
                sha256: createHash('sha256').update(zip).digest('hex'),
                manifest: { main: 'string', type: 'module' },
            });
            expect(Object.isFrozen(result)).toBe(true);

            if (result.ok) {
                expect(Object.isFrozen(result.manifest)).toBe(true);
            }
        },
    );
    it('requires the exact root file rather than a nested name, case variant or directory', () => {
        for (const entries of [
            [{ name: 'x/package.json', data: bytes('{}') }],
            [{ name: 'Package.json', data: bytes('{}') }],
            [{ name: 'package.json/' }, { name: 'x' }],
            [{ name: 'x' }],
        ]) {
            expectedError(archive(entries).bytes, 'manifest_missing');
        }

        expectedError(
            archive([{ name: 'package.json' }, { name: 'Package.json' }]).bytes,
            'collision',
        );
    });
    it.each([
        ['{}', 'absent', 'absent'],
        ['{"main":"","type":"commonjs"}', 'empty', 'commonjs'],
        ['{"main":"private/path","type":"secret"}', 'string', 'other_string'],
        ['{"main":null,"type":false}', 'non_string', 'non_string'],
        ['{"main":42,"type":""}', 'non_string', 'other_string'],
    ])('classifies own properties of %s without exposing values', (json, main, type) => {
        const result = inspectZipManifest(
            archive([{ name: 'package.json', data: bytes(json) }]).bytes,
        );
        expect(result).toMatchObject({ ok: true, manifest: { main, type } });
        expect(JSON.stringify(result)).not.toContain('private/path');
        expect(JSON.stringify(result)).not.toContain('secret');
    });
    it('uses JSON last duplicate key and keeps __proto__ as data', () => {
        const json =
            '{"__proto__":{"main":"secret"},"main":null,"main":"x","type":"module","type":1}';
        const result = inspectZipManifest(
            archive([{ name: 'package.json', data: bytes(json) }]).bytes,
        );
        expect(result).toMatchObject({
            ok: true,
            manifest: { main: 'string', type: 'non_string' },
        });
        expect(({} as { main?: unknown }).main).toBeUndefined();
        const protoOnly = inspectZipManifest(
            archive([{ name: 'package.json', data: bytes('{"__proto__":{"main":"secret"}}') }])
                .bytes,
        );
        expect(protoOnly).toMatchObject({ ok: true, manifest: { main: 'absent', type: 'absent' } });
    });
    it('accepts a UTF-8 BOM according to TextDecoder semantics', () => {
        const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('{"type":"module"}')]);
        expect(inspectZipManifest(archive([{ name: 'package.json', data }]).bytes)).toMatchObject({
            ok: true,
            manifest: { main: 'absent', type: 'module' },
        });
    });
    it('rejects invalid UTF-8, malformed JSON and non-object root values', () => {
        for (const data of [
            Buffer.from([0xc0, 0xaf]),
            bytes('{'),
            bytes('null'),
            bytes('[]'),
            bytes('1'),
            bytes('"x"'),
        ]) {
            expectedError(archive([{ name: 'package.json', data }]).bytes, 'manifest_invalid');
        }
    });
    it('enforces exact manifest length boundary after ZIP integrity', () => {
        const max = Buffer.concat([bytes('{}'), Buffer.alloc(65534, 32)]);
        expect(inspectZipManifest(archive([{ name: 'package.json', data: max }]).bytes).ok).toBe(
            true,
        );
        expectedError(
            archive([{ name: 'package.json', data: Buffer.concat([max, bytes(' ')]) }]).bytes,
            'manifest_too_large',
        );
    });
    it('lets later CRC, structure and deflate failures precede manifest errors', () => {
        for (const data of [bytes('{'), Buffer.alloc(65537, 32)]) {
            const fixture = archive([
                { name: 'package.json', data },
                { name: 'later', data: bytes('x') },
            ]);
            const brokenCrc = Buffer.from(fixture.bytes);
            brokenCrc[fixture.dataOffsets[1]] ^= 1;
            expectedError(brokenCrc, 'integrity');
            const brokenHeader = Buffer.from(fixture.bytes);
            brokenHeader[fixture.localOffsets[1]] ^= 1;
            expectedError(brokenHeader, 'malformed');
            const trailing = archive([
                { name: 'package.json', data },
                {
                    name: 'later',
                    method: 8,
                    data: bytes('x'),
                    payload: Buffer.concat([zlib.deflateRawSync(bytes('x')), Buffer.from([0])]),
                },
            ]);
            expectedError(trailing.bytes, 'integrity');
        }
    });
    it('withholds a valid manifest when a later entry fails CRC', () => {
        const marker = 'private-marker-123';
        const fixture = archive([
            { name: 'package.json', data: bytes(JSON.stringify({ main: marker, type: 'module' })) },
            { name: 'later', data: bytes('x') },
        ]);
        const originalHash = createHash('sha256').update(fixture.bytes).digest('hex');
        fixture.bytes[fixture.dataOffsets[1]] ^= 1;
        const result = inspectZipManifest(fixture.bytes);
        expect(result).toEqual({ ok: false, code: 'integrity' });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(marker);
        expect(serialized).not.toContain(originalHash);
        expect(serialized).not.toContain('sha256');
        expect(serialized).not.toContain('manifest');
        expect(serialized).not.toContain('main');
        expect(serialized).not.toContain('type');
    });
    it('passes through ZIP failure results and preserves existing preflight semantics', () => {
        const good = archive([
            { name: 'package.json', data: bytes('{}') },
            { name: 'x', method: 8, data: bytes('content') },
        ]).bytes;
        const before = preflightZip(good);
        expect(inspectZipManifest(good).ok).toBe(true);
        expect(preflightZip(good)).toEqual(before);

        for (const input of [Buffer.alloc(0), new Uint8Array(new SharedArrayBuffer(1)), null]) {
            expect(inspectZipManifest(input)).toEqual(preflightZip(input));
        }
    });
    it('inflates each entry at most once in addition to the fixed probe', () => {
        const data = archive([
            { name: 'package.json', method: 8, data: bytes('{}') },
            { name: 'x', method: 8, data: bytes('x') },
        ]).bytes;
        const inflate = vi.mocked(zlib.inflateRawSync);
        inflate.mockClear();
        expect(inspectZipManifest(data).ok).toBe(true);
        expect(inflate).toHaveBeenCalledTimes(7);
    });
    it('keeps a private subview snapshot despite later mutation during inflate', async () => {
        const data = archive([
            { name: 'package.json', method: 8, data: bytes('{"main":"x"}') },
        ]).bytes;
        const wrapped = Buffer.concat([Buffer.from([1]), data, Buffer.from([2])]);
        const input = wrapped.subarray(1, -1);
        const hash = createHash('sha256').update(data).digest('hex');
        const original = await vi.importActual<typeof import('node:zlib')>('node:zlib');
        const mock = vi.mocked(zlib.inflateRawSync);
        mock.mockImplementationOnce((...args) => {
            input.fill(0);
            return original.inflateRawSync(...args);
        });
        const result = inspectZipManifest(input);
        expect(result).toEqual({
            ok: true,
            sha256: hash,
            manifest: { main: 'string', type: 'absent' },
        });
    });
    it('does not touch filesystem, network or fetch and does not execute content', () => {
        const read = vi.spyOn(fs, 'readFileSync');
        const connect = vi.spyOn(net, 'connect');
        const fetcher = vi.spyOn(globalThis, 'fetch');
        const key = '__zip_preflight_fixture_executed__';

        try {
            const data = archive([
                { name: 'package.json', data: bytes('{"main":"secret"}') },
                { name: 'index.js', data: bytes(`globalThis.${key}=true`) },
            ]).bytes;
            const result = inspectZipManifest(data);
            expect(result.ok).toBe(true);
            expect(JSON.stringify(result)).not.toContain('secret');
            expect((globalThis as Record<string, unknown>)[key]).toBeUndefined();
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
