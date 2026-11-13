import { createHash } from 'node:crypto';
import { types } from 'node:util';

export type ZipPreflightError =
    | 'malformed'
    | 'unsupported'
    | 'unsafe_path'
    | 'collision'
    | 'integrity'
    | 'limit'
    | 'invalid_input'
    | 'internal';
export interface ZipEntryMetadata {
    readonly path: string;
    readonly kind: 'file' | 'directory';
    readonly compressedSize: number;
    readonly actualSize: number;
    readonly crc32: number;
}
export type ZipPreflightResult =
    | Readonly<{
          ok: true;
          entries: readonly ZipEntryMetadata[];
          totalSize: number;
          sha256: string;
      }>
    | Readonly<{ ok: false; code: ZipPreflightError }>;

const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const copyBytes = Uint8Array.prototype.set;

function fail(code: ZipPreflightError): never {
    throw code;
}

function crc32(data: Uint8Array, start: number, length: number): number {
    let crc = 0xffffffff;

    for (let i = start; i < start + length; i++) {
        crc ^= data[i];

        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

type Tree = { spelling: string; explicit: boolean; file: boolean; children: Map<string, Tree> };

function addPath(root: Tree, path: string, directory: boolean): void {
    if (
        path.length === 0 ||
        path.length > 512 ||
        !/^[A-Za-z0-9._/-]+$/.test(path) ||
        path.startsWith('/')
    ) {
        fail('unsafe_path');
    }

    const parts = (directory ? path.slice(0, -1) : path).split('/');

    if (
        parts.length > 16 ||
        parts.some(
            (part) =>
                part.length === 0 ||
                part.length > 100 ||
                part === '.' ||
                part === '..' ||
                part.endsWith('.') ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        )
    ) {
        fail('unsafe_path');
    }

    let node = root;

    for (let i = 0; i < parts.length; i++) {
        if (node.file) {
            fail('collision');
        }

        const part = parts[i];
        const key = part.toLowerCase();
        let child = node.children.get(key);

        if (child && child.spelling !== part) {
            fail('collision');
        }

        if (!child) {
            child = { spelling: part, explicit: false, file: false, children: new Map() };
            node.children.set(key, child);
        }

        if (i === parts.length - 1) {
            if (child.explicit || (!directory && child.children.size !== 0)) {
                fail('collision');
            }

            child.explicit = true;
            child.file = !directory;
        }

        node = child;
    }
}

interface RecordMetadata {
    name: string;
    flags: number;
    method: number;
    version: number;
    time: number;
    date: number;
    crc: number;
    compressed: number;
    size: number;
    offset: number;
    directory: boolean;
}

/**
 * Synchronous preflight of a strict ZIP32 stored-only subset, suited to synthetic
 * fixtures. An archive with no file entries is malformed in this subset.
 * Common archives using DEFLATE or extra fields are unsupported. The
 * result establishes neither plugin compatibility, provenance, permission nor
 * filesystem safety; this function performs no extraction or installation.
 * Work is bounded by one input snapshot, entry count and declared output limits;
 * no wall-clock or process RSS bound is promised.
 */
export function preflightZip(input: unknown): ZipPreflightResult {
    let bytes: Uint8Array;

    try {
        if (types.isProxy(input) || !types.isUint8Array(input)) {
            return Object.freeze({ ok: false, code: 'invalid_input' });
        }

        const buffer: unknown = typedBuffer.call(input);
        const offset: number = typedOffset.call(input);
        const length: number = typedLength.call(input);

        if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) {
            return Object.freeze({ ok: false, code: 'invalid_input' });
        }

        if (length > MAX_ARCHIVE) {
            return Object.freeze({ ok: false, code: 'limit' });
        }

        const source = new Uint8Array(buffer as ArrayBuffer, offset, length);
        bytes = new Uint8Array(length);
        copyBytes.call(bytes, source);
    } catch {
        return Object.freeze({ ok: false, code: 'invalid_input' });
    }

    try {
        const view = new DataView(bytes.buffer);

        const bound = (offset: number, length: number, end = bytes.length): void => {
            if (offset < 0 || length < 0 || offset > end || length > end - offset) {
                fail('malformed');
            }
        };

        const u16 = (offset: number): number => view.getUint16(offset, true);
        const u32 = (offset: number): number => view.getUint32(offset, true);

        if (bytes.length < 22) {
            fail('malformed');
        }

        const end = bytes.length - 22;

        if (u32(end) !== 0x06054b50) {
            fail('malformed');
        }

        const disk = u16(end + 4);
        const cdDisk = u16(end + 6);
        const diskCount = u16(end + 8);
        const count = u16(end + 10);
        const centralSize = u32(end + 12);
        const centralStart = u32(end + 16);

        if (
            disk !== 0 ||
            cdDisk !== 0 ||
            diskCount !== count ||
            count === 0xffff ||
            centralSize === 0xffffffff ||
            centralStart === 0xffffffff ||
            u16(end + 20) !== 0
        ) {
            fail('unsupported');
        }

        if (count > MAX_ENTRIES) {
            fail('limit');
        }

        bound(centralStart, centralSize, end);

        if (centralSize !== end - centralStart) {
            fail('malformed');
        }

        const records: RecordMetadata[] = [];
        const root: Tree = { spelling: '', explicit: true, file: false, children: new Map() };
        let cursor = centralStart;
        let total = 0;

        for (let i = 0; i < count; i++) {
            bound(cursor, 46, end);

            if (u32(cursor) !== 0x02014b50) {
                fail('malformed');
            }

            const made = u16(cursor + 4);
            const version = u16(cursor + 6);
            const flags = u16(cursor + 8);
            const method = u16(cursor + 10);
            const time = u16(cursor + 12);
            const date = u16(cursor + 14);
            const crc = u32(cursor + 16);
            const compressed = u32(cursor + 20);
            const size = u32(cursor + 24);
            const nameLength = u16(cursor + 28);
            const extra = u16(cursor + 30);
            const comment = u16(cursor + 32);
            const startDisk = u16(cursor + 34);
            const internal = u16(cursor + 36);
            const external = u32(cursor + 38);
            const offset = u32(cursor + 42);

            if (
                compressed === 0xffffffff ||
                size === 0xffffffff ||
                offset === 0xffffffff ||
                startDisk !== 0 ||
                extra !== 0 ||
                comment !== 0 ||
                internal !== 0 ||
                (flags & ~0x800) !== 0 ||
                method !== 0 ||
                (version !== 10 && version !== 20) ||
                ((made & 0xff) !== 10 && (made & 0xff) !== 20)
            ) {
                fail('unsupported');
            }

            if (size > MAX_FILE || compressed > MAX_FILE || size > MAX_ARCHIVE - total) {
                fail('limit');
            }

            if (nameLength === 0 || nameLength > 512) {
                fail('unsafe_path');
            }

            bound(cursor + 46, nameLength, end);
            let name = '';

            for (let j = 0; j < nameLength; j++) {
                name += String.fromCharCode(bytes[cursor + 46 + j]);
            }

            const directory = name.endsWith('/');
            addPath(root, name, directory);
            const host = made >>> 8;
            const dos = external & 0xffff;

            if ((dos & ~0x37) !== 0 || ((dos & 0x10) !== 0) !== directory) {
                fail('unsupported');
            }

            if (host === 0) {
                if (external >>> 16 !== 0) {
                    fail('unsupported');
                }
            } else if (host === 3) {
                const mode = external >>> 16;

                if ((mode & 0xf000) !== (directory ? 0x4000 : 0x8000) || (mode & 0x0e00) !== 0) {
                    fail('unsupported');
                }
            } else {
                fail('unsupported');
            }

            if (directory && (compressed !== 0 || size !== 0 || crc !== 0)) {
                fail('malformed');
            }

            total += size;
            records.push({
                name,
                flags,
                method,
                version,
                time,
                date,
                crc,
                compressed,
                size,
                offset,
                directory,
            });
            cursor += 46 + nameLength;
        }

        if (cursor !== end) {
            fail('malformed');
        }

        const sorted = [...records].sort((a, b) => a.offset - b.offset);
        let localCursor = 0;

        for (const record of sorted) {
            if (record.offset !== localCursor) {
                fail('malformed');
            }

            bound(localCursor, 30, centralStart);

            if (u32(localCursor) !== 0x04034b50) {
                fail('malformed');
            }

            const nameLength = u16(localCursor + 26);

            if (u16(localCursor + 28) !== 0) {
                fail('unsupported');
            }

            if (
                u16(localCursor + 4) !== record.version ||
                u16(localCursor + 6) !== record.flags ||
                u16(localCursor + 8) !== record.method ||
                u16(localCursor + 10) !== record.time ||
                u16(localCursor + 12) !== record.date ||
                u32(localCursor + 14) !== record.crc ||
                u32(localCursor + 18) !== record.compressed ||
                u32(localCursor + 22) !== record.size ||
                nameLength !== record.name.length
            ) {
                fail('malformed');
            }

            bound(localCursor + 30, nameLength, centralStart);

            for (let j = 0; j < nameLength; j++) {
                if (bytes[localCursor + 30 + j] !== record.name.charCodeAt(j)) {
                    fail('malformed');
                }
            }

            const dataStart = localCursor + 30 + nameLength;
            bound(dataStart, record.compressed, centralStart);

            if (
                record.compressed !== record.size ||
                crc32(bytes, dataStart, record.compressed) !== record.crc
            ) {
                fail('integrity');
            }

            localCursor = dataStart + record.compressed;
        }

        if (localCursor !== centralStart || !records.some((record) => !record.directory)) {
            fail('malformed');
        }

        const entries = Object.freeze(
            records.map((record) =>
                Object.freeze({
                    path: record.name,
                    kind: record.directory ? ('directory' as const) : ('file' as const),
                    compressedSize: record.compressed,
                    actualSize: record.size,
                    crc32: record.crc,
                }),
            ),
        );
        return Object.freeze({
            ok: true,
            entries,
            totalSize: total,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        });
    } catch (error) {
        const codes: readonly unknown[] = [
            'malformed',
            'unsupported',
            'unsafe_path',
            'collision',
            'integrity',
            'limit',
            'invalid_input',
        ];
        return Object.freeze({
            ok: false,
            code: codes.includes(error) ? (error as ZipPreflightError) : 'internal',
        });
    }
}
