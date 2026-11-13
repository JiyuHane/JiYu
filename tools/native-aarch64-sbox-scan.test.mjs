import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scanAarch64AesSboxes as scan } from './native-aarch64-sbox-scan.mjs';

// FIPS 197 known-answer table, independent of the scanner's generation algorithm.
const sbox = Buffer.from(
    '637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0' +
    'b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275' +
    '09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf' +
    'd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2' +
    'cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb' +
    'e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08' +
    'ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e' +
    'e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16', 'hex');
const inverse = Buffer.alloc(256);
for (let i = 0; i < 256; i++) inverse[sbox[i]] = i;
assert.equal(inverse.subarray(0, 16).toString('hex'), '52096ad53036a538bf40a39e81f3d7fb');

function fixture({ textVA = 0x10000n, roVA = 0xf123n, rodata = sbox, words = [] } = {}) {
    const buf = Buffer.alloc(0x900);
    buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    buf.writeUInt16LE(3, 16); buf.writeUInt16LE(183, 18); buf.writeUInt32LE(1, 20);
    buf.writeBigUInt64LE(0x700n, 40); buf.writeUInt16LE(64, 52);
    buf.writeUInt16LE(64, 58); buf.writeUInt16LE(4, 60); buf.writeUInt16LE(1, 62);
    const names = Buffer.from('\0.shstrtab\0.text\0.rodata\0'); names.copy(buf, 0x100);
    function section(i, name, type, flags, va, offset, size, align) {
        const p = 0x700 + i * 64;
        buf.writeUInt32LE(name, p); buf.writeUInt32LE(type, p + 4);
        buf.writeBigUInt64LE(flags, p + 8); buf.writeBigUInt64LE(va, p + 16);
        buf.writeBigUInt64LE(offset, p + 24); buf.writeBigUInt64LE(size, p + 32);
        buf.writeBigUInt64LE(align, p + 48);
    }
    section(1, 1, 3, 0n, 0n, 0x100n, BigInt(names.length), 1n);
    section(2, 11, 1, 6n, textVA, 0x200n, 0x100n, 4n);
    section(3, 17, 1, 2n, roVA, 0x400n, BigInt(rodata.length), 1n);
    rodata.copy(buf, 0x400);
    words.forEach((w, i) => buf.writeUInt32LE(w >>> 0, 0x200 + i * 4));
    return buf;
}
function adr(pc, target, rd = 1, page = false) {
    const delta = page ? (target >> 12n) - (pc >> 12n) : target - pc;
    assert(delta >= -(1n << 20n) && delta < (1n << 20n));
    const imm = Number(BigInt.asUintN(21, delta));
    return ((page ? 0x90000000 : 0x10000000) | ((imm & 3) << 29) | ((imm >>> 2) << 5) | rd) >>> 0;
}
function add(rn, imm, shift = false, rd = 2, wide = true) {
    return ((wide ? 0x91000000 : 0x11000000) | (shift ? 0x400000 : 0) | (imm << 10) | (rn << 5) | rd) >>> 0;
}
function code(fn, expected) { assert.throws(fn, e => e.message === expected); }

test('full forward/inverse tables and direct ADR with negative displacement', () => {
    const ro = Buffer.concat([sbox, inverse]);
    const b = fixture({ rodata: ro, words: [adr(0x10000n, 0xf123n), adr(0x10004n, 0xf223n)] });
    const result = scan(b);
    assert.deepEqual(result.tables, [
        { kind: 'sbox', fileOffset: '0x400', va: '0xf123' },
        { kind: 'inverse', fileOffset: '0x500', va: '0xf223' },
    ]);
    assert.deepEqual(result.references, [
        { kind: 'ADR', pc: '0x10000', target: '0xf123' },
        { kind: 'ADR', pc: '0x10004', target: '0xf223' },
    ]);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    b[0x410] ^= 1;
    assert.deepEqual(scan(b).tables.map(x => x.kind), ['inverse']);
});

test('ADRP negative page, adjacency, base register and 64-bit ADD', () => {
    const pc = 0x10000n, dest = 0xf123n;
    const pair = [adr(pc, dest, 5, true), add(5, 0x123)];
    assert.deepEqual(scan(fixture({ words: pair })).references, [{ kind: 'ADRP+ADD', pc: '0x10000', target: '0xf123' }]);
    assert.equal(scan(fixture({ words: [pair[0], add(4, 0x123)] })).references.length, 0);
    assert.equal(scan(fixture({ words: [pair[0], 0xd503201f, pair[1]] })).references.length, 0);
    assert.equal(scan(fixture({ words: [pair[0], add(5, 0x123, false, 2, false)] })).references.length, 0);
    assert.equal(scan(fixture({ words: [adr(pc, dest, 31, true), add(31, 0x123)] })).references.length, 0);
});

test('ADR to XZR discards its result and is excluded', () => {
    const b = fixture({ words: [adr(0x10000n, 0xf123n, 31)] });
    assert.equal(scan(b).tables.length, 1);
    assert.deepEqual(scan(b).references, []);
});

test('unaligned bytes and references to table interiors are excluded', () => {
    const b = fixture();
    b.writeUInt32LE(adr(0x10000n, 0xf123n), 0x201);
    assert.deepEqual(scan(b).references, []);
    const interior = fixture({ words: [adr(0x10000n, 0xf124n)] });
    assert.deepEqual(scan(interior).references, []);
});

test('ADRP ADD shift 12 and signed displacement extremes', () => {
    const b = fixture({ roVA: 0x14000n, words: [adr(0x10000n, 0x11000n, 7, true), add(7, 3, true)] });
    assert.equal(scan(b).references[0].target, '0x14000');
    const backward = fixture({ textVA: 0x400000000n, roVA: 0x300000000n, words: [adr(0x400000000n, 0x300000000n, 0, true), add(0, 0)] });
    assert.equal(scan(backward).references[0].target, '0x300000000');
    const forward = fixture({ textVA: 0x100000n, roVA: 0x1ffffcn, words: [adr(0x100000n, 0x1ffffcn)] });
    assert.equal(scan(forward).references[0].target, '0x1ffffc');
});

test('ADR and ADRP plus ADD wrap at the 64-bit address boundary', () => {
    const top = 1n << 64n;
    const adrHigh = fixture({ textVA: top - 0x100n, roVA: 0x20n, words: [adr(top - 0x100n, top + 0x20n)] });
    assert.equal(scan(adrHigh).references[0].target, '0x20');
    const adrLow = fixture({ textVA: 0x100n, roVA: top - 0x100n, words: [adr(0x100n, -0x100n)] });
    assert.equal(scan(adrLow).references[0].target, '0xffffffffffffff00');
    const pageHigh = fixture({ textVA: top - 0x2000n, roVA: 0x1000n, words: [adr(top - 0x2000n, top + 0x1000n, 1, true), add(1, 0)] });
    assert.equal(scan(pageHigh).references[0].target, '0x1000');
    const pageLow = fixture({ textVA: 0x1000n, roVA: top - 0x1000n, words: [adr(0x1000n, -0x1000n, 1, true), add(1, 0)] });
    assert.equal(scan(pageLow).references[0].target, '0xfffffffffffff000');
    const addWrap = fixture({ textVA: 0x1000n, roVA: 0x2000n, words: [adr(0x1000n, -0x1000n, 1, true), add(1, 3, true)] });
    assert.equal(scan(addWrap).references[0].target, '0x2000');
});

test('malformed headers and ranges are rejected consistently', () => {
    code(() => scan(Buffer.alloc(63)), 'ELF_HEADER');
    for (const [off, val] of [[4, 1], [5, 2], [6, 0], [18, 0]]) {
        const b = fixture(); b[off] = val; code(() => scan(b), 'ELF_HEADER');
    }
    let b = fixture(); b.writeBigUInt64LE(0xfffffffffffffff0n, 40); code(() => scan(b), 'ELF_RANGE');
    b = fixture(); b.writeBigUInt64LE(0xfffffffffffffff0n, 0x700 + 3 * 64 + 24); code(() => scan(b), 'ELF_RANGE');
    b = fixture(); b.writeBigUInt64LE(0x8ffn, 0x700 + 3 * 64 + 24); code(() => scan(b), 'SECTION_RANGE');
    b = fixture(); b.writeUInt32LE(11, 0x700 + 3 * 64); code(() => scan(b), 'SECTION_DUPLICATE');
    b = fixture(); b.writeUInt32LE(1, 0x700 + 3 * 64); code(() => scan(b), 'SECTION_MISSING');
    b = fixture(); b.writeUInt32LE(8, 0x700 + 3 * 64 + 4); code(() => scan(b), 'SECTION_ATTRIBUTES');
    b = fixture(); b.writeBigUInt64LE(0x802n, 0x700 + 3 * 64 + 8); code(() => scan(b), 'SECTION_ATTRIBUTES');
    b = fixture(); b.writeBigUInt64LE(0x700n, 0x700 + 3 * 64 + 24); code(() => scan(b), 'SECTION_OVERLAP');
    b = fixture(); b.writeBigUInt64LE(0x204n, 0x700 + 3 * 64 + 24); code(() => scan(b), 'SECTION_OVERLAP');
    b = fixture(); b.writeBigUInt64LE(0x10004n, 0x700 + 3 * 64 + 16); code(() => scan(b), 'SECTION_OVERLAP');
    b = fixture(); b.writeBigUInt64LE(0x10002n, 0x700 + 2 * 64 + 16); code(() => scan(b), 'SECTION_ATTRIBUTES');
    b = fixture(); b.writeBigUInt64LE(1n, 0x700 + 2 * 64 + 48); b.writeBigUInt64LE(0x10002n, 0x700 + 2 * 64 + 16); code(() => scan(b), 'TEXT_ALIGNMENT');
    b = fixture(); b.writeUInt32LE(10000, 0x700 + 3 * 64); code(() => scan(b), 'STRING_TABLE');
});

test('limits fail closed, and memory input stays unchanged', () => {
    const b = fixture({ words: [adr(0x10000n, 0xf123n)] });
    const before = Buffer.from(b);
    code(() => scan(b, { maxTables: 0 }), 'TABLE_LIMIT');
    code(() => scan(b, { maxRefs: 0 }), 'REFERENCE_LIMIT');
    code(() => scan(b, { maxSections: 3 }), 'SECTION_LIMIT');
    code(() => scan(b, { maxRefs: 100001 }), 'INVALID_OPTIONS');
    code(() => scan(new Uint8Array(32 * 1024 * 1024 + 1)), 'FILE_LIMIT');
    assert.deepEqual(b, before);
});

test('private snapshot binds output to bytes before option getters mutate input', () => {
    const data = fixture({ words: [adr(0x10000n, 0xf123n)] });
    const original = Buffer.from(data);
    const options = { get maxSections() { data[0x400] ^= 1; return 4096; } };
    const result = scan(data, options);
    assert.equal(result.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(result.tables.length, 1);
    assert.equal(result.references.length, 1);
    assert.equal(scan(data).tables.length, 0);
});

test('typed-array subviews use native extent; unstable buffers and proxies fail', () => {
    const original = fixture();
    const envelope = new Uint8Array(original.length + 16);
    envelope.set(original, 8);
    const view = envelope.subarray(8, 8 + original.length);
    Object.defineProperty(view, 'length', { get() { throw Error('spoofed'); } });
    Object.defineProperty(view, 'byteLength', { value: 1 });
    assert.equal(scan(view).sha256, createHash('sha256').update(original).digest('hex'));
    code(() => scan(new Uint8Array(new SharedArrayBuffer(original.length))), 'INVALID_INPUT');
    code(() => scan(new Proxy(view, {})), 'INVALID_INPUT');
    code(() => scan(new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 }))), 'INVALID_INPUT');
    const detached = new Uint8Array(8);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    code(() => scan(detached), 'INVALID_INPUT');
});

test('CLI redacts explicit nonexistent paths and usage errors', () => {
    const cli = new URL('./native-aarch64-sbox-scan.mjs', import.meta.url);
    const missing = 'Z:\\secret-fixture\\not-present.elf';
    for (const args of [[fileURLToPath(cli), missing], [fileURLToPath(cli)]]) {
        const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
        assert.equal(child.status, 1);
        assert.equal(child.stdout, '');
        assert(!child.stderr.includes(missing));
        assert.match(child.stderr, /^\{"error":"(?:IO_ERROR|USAGE)"\}\s*$/);
    }
});
