// Offline static candidate scanner. No control-flow or runtime claims are made.
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_SECTIONS = 4096;
const MAX_TABLES = 4096;
const MAX_REFS = 100000;
const U64_END = 1n << 64n;
const fail = code => { throw new Error(code); };
const hex = n => `0x${n.toString(16)}`;

function limit(options, name, upper) {
    const value = options[name] ?? upper;
    if (!Number.isSafeInteger(value) || value < 0 || value > upper) fail('INVALID_OPTIONS');
    return value;
}

function aesTables() {
    function mul(a, b) {
        let r = 0;
        for (let i = 0; i < 8; i++) {
            if (b & 1) r ^= a;
            a = ((a << 1) ^ ((a & 128) ? 0x11b : 0)) & 255;
            b >>>= 1;
        }
        return r;
    }
    const forward = new Uint8Array(256);
    const inverse = new Uint8Array(256);
    for (let x = 0; x < 256; x++) {
        let a = 1, base = x, exponent = 254;
        while (exponent) {
            if (exponent & 1) a = mul(a, base);
            base = mul(base, base);
            exponent >>>= 1;
        }
        const rot = n => ((a << n) | (a >>> (8 - n))) & 255;
        const y = a ^ rot(1) ^ rot(2) ^ rot(3) ^ rot(4) ^ 0x63;
        forward[x] = y;
        inverse[y] = x;
    }
    return [forward, inverse];
}

// Typed-array accessors are called directly so own properties and proxies cannot
// forge the extent. Shared, detachable-resizable and detached inputs are rejected.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get;
const detachedGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached').get;
function snapshot(input) {
    if (types.isProxy(input) || !types.isUint8Array(input)) fail('INVALID_INPUT');
    let buffer, offset, length;
    try {
        buffer = bufferGetter.call(input);
        if (!types.isArrayBuffer(buffer) || resizableGetter.call(buffer) || detachedGetter.call(buffer)) fail('INVALID_INPUT');
        offset = offsetGetter.call(input);
        length = lengthGetter.call(input);
    } catch {
        fail('INVALID_INPUT');
    }
    if (length > MAX_FILE) fail('FILE_LIMIT');
    const result = new Uint8Array(length);
    try {
        Uint8Array.prototype.set.call(result, new Uint8Array(buffer, offset, length));
    } catch {
        fail('INVALID_INPUT');
    }
    return result;
}

/** Scan a bounded private snapshot of an in-memory ELF image. Limits may be lowered, never raised. */
export function scanAarch64AesSboxes(bytes, options = {}) {
    bytes = snapshot(bytes);
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS');
    const maxSections = limit(options, 'maxSections', MAX_SECTIONS);
    const maxTables = limit(options, 'maxTables', MAX_TABLES);
    const maxRefs = limit(options, 'maxRefs', MAX_REFS);
    if (bytes.length > MAX_FILE) fail('FILE_LIMIT');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const within = (off, size) => off >= 0 && size >= 0 && off <= bytes.length && size <= bytes.length - off;
    const number = n => { if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('ELF_RANGE'); return Number(n); };
    if (!within(0, 64)) fail('ELF_HEADER');
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || v.getUint16(16, true) !== 3 || v.getUint16(18, true) !== 183 || v.getUint32(20, true) !== 1 || v.getUint16(52, true) !== 64) fail('ELF_HEADER');
    const shoff = number(v.getBigUint64(40, true));
    const entsize = v.getUint16(58, true), count = v.getUint16(60, true), strindex = v.getUint16(62, true);
    if (count > maxSections) fail('SECTION_LIMIT');
    if (entsize !== 64 || count < 2 || strindex === 0 || strindex >= count || !within(shoff, count * 64)) fail('SECTION_HEADERS');
    const sections = [];
    for (let i = 0; i < count; i++) {
        const p = shoff + i * 64;
        const s = { name: v.getUint32(p, true), type: v.getUint32(p + 4, true), flags: v.getBigUint64(p + 8, true), va: v.getBigUint64(p + 16, true), offset: v.getBigUint64(p + 24, true), size: v.getBigUint64(p + 32, true), align: v.getBigUint64(p + 48, true) };
        if (s.offset + s.size > U64_END || s.va + s.size > U64_END) fail('ELF_RANGE');
        if (s.type !== 8 && s.size && !within(number(s.offset), number(s.size))) fail('SECTION_RANGE');
        sections.push(s);
    }
    const strings = sections[strindex];
    if (strings.type !== 3 || strings.size === 0n) fail('STRING_TABLE');
    const st = number(strings.offset), sl = number(strings.size);
    if (bytes[st] !== 0 || bytes[st + sl - 1] !== 0) fail('STRING_TABLE');
    const named = new Map();
    for (const s of sections) {
        if (s.name >= sl) fail('STRING_TABLE');
        // The last string-table byte is NUL, so every in-range name terminates.
        // Inspect at most eight bytes per name even for hostile giant strings.
        const start = st + s.name;
        let end = start;
        while (end < st + sl && end - start <= 7 && bytes[end] !== 0) end++;
        if (end < st + sl && bytes[end] === 0 && (end - start === 5 || end - start === 7)) {
            const name = String.fromCharCode(...bytes.subarray(start, end));
            if (name === '.text' || name === '.rodata') {
                if (named.has(name)) fail('SECTION_DUPLICATE');
                named.set(name, s);
            }
        }
    }
    const text = named.get('.text'), ro = named.get('.rodata');
    if (!text || !ro) fail('SECTION_MISSING');
    for (const [s, expected] of [[text, 6n], [ro, 2n]]) {
        if (s.type !== 1 || (s.flags & 7n) !== expected || (s.flags & 0x800n) !== 0n || s.size === 0n || (s.align && ((s.align & (s.align - 1n)) !== 0n || s.va % s.align !== 0n || s.offset % s.align !== 0n))) fail('SECTION_ATTRIBUTES');
        if (s.offset < 64n || (s.offset < BigInt(shoff + count * 64) && BigInt(shoff) < s.offset + s.size)) fail('SECTION_OVERLAP');
    }
    if ((text.va & 3n) || (text.offset & 3n) || (text.size & 3n)) fail('TEXT_ALIGNMENT');
    // Target sections must not overlap any other file-backed section or allocated VA range.
    for (const target of [text, ro]) {
        for (const s of sections) {
            if (s === target || s.size === 0n || s.type === 0) continue;
            if (s.type !== 8 && target.offset < s.offset + s.size && s.offset < target.offset + target.size) fail('SECTION_OVERLAP');
            if ((s.flags & 2n) && target.va < s.va + s.size && s.va < target.va + target.size) fail('SECTION_OVERLAP');
        }
    }
    const [forward, inverse] = aesTables();
    const tables = [], byAddress = new Map();
    const start = number(ro.offset), end = start + number(ro.size);
    for (let p = start; p + 256 <= end; p++) {
        for (const [kind, table] of [['sbox', forward], ['inverse', inverse]]) {
            if (bytes[p] !== table[0]) continue;
            let j = 1;
            while (j < 256 && bytes[p + j] === table[j]) j++;
            if (j !== 256) continue;
            if (tables.length >= maxTables) fail('TABLE_LIMIT');
            const address = ro.va + BigInt(p - start);
            tables.push({ kind, fileOffset: hex(BigInt(p)), va: hex(address) });
            byAddress.set(address, kind);
        }
    }
    const refs = [];
    const textStart = number(text.offset), textEnd = textStart + number(text.size);
    const signed21 = word => { const n = (((word >>> 5) & 0x7ffff) * 4) + ((word >>> 29) & 3); return BigInt(n >= 0x100000 ? n - 0x200000 : n); };
    for (let p = textStart; p < textEnd; p += 4) {
        const word = v.getUint32(p, true), pc = text.va + BigInt(p - textStart);
        let target, kind;
        if (((word & 0x9f000000) >>> 0) === 0x10000000 && (word & 31) !== 31) {
            target = BigInt.asUintN(64, pc + signed21(word)); kind = 'ADR';
        } else if (((word & 0x9f000000) >>> 0) === 0x90000000 && p + 8 <= textEnd && (word & 31) !== 31) {
            const add = v.getUint32(p + 4, true);
            if (((add & 0xff800000) >>> 0) !== 0x91000000 || ((add >>> 5) & 31) !== (word & 31)) continue;
            const page = BigInt.asUintN(64, (pc & ~0xfffn) + signed21(word) * 4096n);
            target = BigInt.asUintN(64, page + BigInt((add >>> 10) & 0xfff) * ((add & 0x400000) ? 4096n : 1n));
            kind = 'ADRP+ADD';
        } else continue;
        if (!byAddress.has(target)) continue;
        if (refs.length >= maxRefs) fail('REFERENCE_LIMIT');
        refs.push({ kind, pc: hex(pc), target: hex(target) });
    }
    const section = s => ({ fileStart: hex(s.offset), fileEnd: hex(s.offset + s.size), vaStart: hex(s.va), vaEnd: hex(s.va + s.size) });
    return { sha256: createHash('sha256').update(bytes).digest('hex'), sections: { text: section(text), rodata: section(ro) }, tables, references: refs };
}

function main() {
    let fd;
    try {
        if (process.argv.length !== 3 || !process.argv[2]) fail('USAGE');
        fd = openSync(process.argv[2], 'r');
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile()) fail('NOT_REGULAR_FILE');
        if (before.size > BigInt(MAX_FILE)) fail('FILE_LIMIT');
        const data = Buffer.allocUnsafe(MAX_FILE + 1);
        let read = 0;
        while (read < data.length) {
            const n = readSync(fd, data, read, data.length - read, null);
            if (!n) break;
            read += n;
        }
        const after = fstatSync(fd, { bigint: true });
        if (read > MAX_FILE) fail('FILE_LIMIT');
        if (before.size !== BigInt(read) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== after.ino || before.dev !== after.dev) fail('FILE_CHANGED');
        process.stdout.write(`${JSON.stringify(scanAarch64AesSboxes(data.subarray(0, read)))}\n`);
    } catch (e) {
        const allowed = new Set(['USAGE', 'NOT_REGULAR_FILE', 'FILE_LIMIT', 'FILE_CHANGED', 'INVALID_INPUT', 'INVALID_OPTIONS', 'ELF_HEADER', 'ELF_RANGE', 'SECTION_LIMIT', 'SECTION_HEADERS', 'SECTION_RANGE', 'STRING_TABLE', 'SECTION_DUPLICATE', 'SECTION_MISSING', 'SECTION_ATTRIBUTES', 'TEXT_ALIGNMENT', 'SECTION_OVERLAP', 'TABLE_LIMIT', 'REFERENCE_LIMIT']);
        const code = allowed.has(e?.message) ? e.message : 'IO_ERROR';
        process.stderr.write(`${JSON.stringify({ error: code })}\n`);
        process.exitCode = 1;
    } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch { process.exitCode = 1; } }
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
