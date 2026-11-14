import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createSsoReserveBuilder } from '../../src/direct/sso-reserve';
import { projectWtLoginUid } from '../../src/direct/wt-login-keystore';
import { decodeWtLoginResponse } from '../../src/direct/wt-login-response';
import { encodeWtTlv, type WtTlvEntry } from '../../src/direct/wt-tlv';

const entry = (value: Uint8Array): WtTlvEntry => ({ tag: 0x543, value });
const bytes = (...values: number[]) => Uint8Array.from(values);
const concat = (...values: Uint8Array[]) => Uint8Array.from(Buffer.concat(values));

const field = (key: number, value: Uint8Array) => {
    if (value.length >= 128) {
        throw new Error('synthetic fixture too large');
    }

    return concat(bytes(key, value.length), value);
};

const common = (value: Uint8Array) => field(0x4a, value);
const nt = (value: Uint8Array) => field(0x5a, value);
const uid = (value: Uint8Array) => field(0x0a, value);
const text = (value: string) => new TextEncoder().encode(value);
const nested = (value: Uint8Array) => common(nt(uid(value)));
const project = (value: Uint8Array) => projectWtLoginUid([entry(value)]);

describe('WT login UID projection', () => {
    it('distinguishes absence from a present empty message or missing layers', () => {
        expect(projectWtLoginUid([])).toEqual({ status: 'absent' });

        for (const value of [bytes(), common(bytes()), common(nt(bytes())), nested(bytes())]) {
            expect(project(value)).toEqual({ status: 'present', uid: '' });
        }
    });

    it('uses real Proton decoding and ignores valid unknown fields', () => {
        const encoded = protobuf_encode<DirectThirdPartyLoginResponse>({
            commonInfo: { rspNT: { uid: 'synthetic-uid-测试' } },
        });
        const withUnknown = concat(bytes(0x10, 0x42), encoded, bytes(0x25, 1, 2, 3, 4));
        expect(project(withUnknown)).toEqual({ status: 'present', uid: 'synthetic-uid-测试' });
    });

    it('replaces duplicate nested messages and repeated scalar values with the last', () => {
        expect(project(concat(common(nt(uid(text('first')))), common(nt(bytes()))))).toEqual({
            status: 'present',
            uid: '',
        });
        expect(project(common(concat(nt(uid(text('first'))), nt(uid(text('last'))))))).toEqual({
            status: 'present',
            uid: 'last',
        });
        expect(project(common(nt(concat(uid(text('first')), uid(text('last'))))))).toEqual({
            status: 'present',
            uid: 'last',
        });
    });

    it('rejects duplicate TLVs and validates bounds even for unselected entries', () => {
        const invalid = [
            [entry(bytes()), entry(bytes())],
            [{ tag: -1, value: bytes() }],
            [{ tag: 65536, value: bytes() }],
            [{ tag: 1.5, value: bytes() }],
            [{ tag: 1, value: new Uint8Array(65536) }],
            [{ tag: 1, value: new Uint8Array(65530) }],
            Array.from({ length: 1025 }, () => ({ tag: 1, value: bytes() })),
        ];

        for (const values of invalid) {
            expect(() => projectWtLoginUid(values)).toThrow('invalid WT login keystore projection');
        }

        expect(projectWtLoginUid([{ tag: 1, value: new Uint8Array(65529) }])).toEqual({
            status: 'absent',
        });
        expect(
            projectWtLoginUid(Array.from({ length: 1024 }, () => ({ tag: 1, value: bytes() }))),
        ).toEqual({ status: 'absent' });
    });

    it.each([
        bytes(0x48, 0),
        common(bytes(0x58, 0)),
        common(nt(bytes(0x08, 1))),
        bytes(0x4a, 0x80),
        bytes(0x4a, 0x05, 1),
        bytes(0x80, 0x80, 0x80, 0x80, 0x80),
        bytes(0x0f),
        bytes(0x0b),
        nested(bytes(0xff)),
        concat(nested(bytes(0xff)), nested(text('later'))),
    ])('fails closed on malformed protobuf or UTF-8 without leaking values', (value) => {
        expect(() => project(value)).toThrowError('invalid WT login keystore projection');
    });

    it('documents Proton BOM handling, unlike a .NET UTF-8 string', () => {
        const value = nested(concat(bytes(0xef, 0xbb, 0xbf), text('uid')));
        expect(project(value)).toEqual({ status: 'present', uid: 'uid' });
        expect(
            new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes(0xef, 0xbb, 0xbf, 0x61)),
        ).toBe('\ufeffa');
    });

    it.each([nested(text('synthetic')), nested(bytes(0xff))])(
        'wipes its selected snapshot on success or failure and preserves caller input',
        (value) => {
            const before = Uint8Array.from(value);
            const copies: Uint8Array[] = [];
            const originalSet = Uint8Array.prototype.set;
            const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source: ArrayLike<number>,
                offset?: number,
            ) {
                copies.push(this);
                originalSet.call(this, source, offset);
            });

            try {
                try {
                    project(value);
                } catch {
                    // Expected for the malformed case.
                }

                expect(copies).toHaveLength(1);
                expect(copies[0]).toEqual(new Uint8Array(value.length));
                expect(copies[0]).not.toBe(value);
                expect(value).toEqual(before);
            } finally {
                set.mockRestore();
            }
        },
    );

    it('wipes the snapshot if a later entry fails validation', () => {
        const copies: Uint8Array[] = [];
        const originalSet = Uint8Array.prototype.set;
        const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            offset?: number,
        ) {
            copies.push(this);
            originalSet.call(this, source, offset);
        });

        try {
            const value = nested(text('synthetic'));
            expect(() => projectWtLoginUid([entry(value), { tag: -1, value: bytes() }])).toThrow(
                'invalid WT login keystore projection',
            );
            expect(copies).toHaveLength(1);
            expect(copies[0]).toEqual(new Uint8Array(value.length));
        } finally {
            set.mockRestore();
        }
    });

    it('uses intrinsic byte bounds rather than a spoofed byteLength', () => {
        const oversized = new Uint8Array(65536);
        Object.defineProperty(oversized, 'byteLength', { value: 0 });
        expect(() => project(oversized)).toThrow('invalid WT login keystore projection');
    });

    it('does not invoke byte or array iterators, even infinite ones', () => {
        const value = nested(text('bounded'));
        const byteIterator = vi.fn(function* () {
            for (;;) {
                yield 0;
            }
        });
        Object.defineProperty(value, Symbol.iterator, { value: byteIterator });
        const entries = [entry(value)];
        const arrayIterator = vi.fn(function* () {
            for (;;) {
                yield entry(bytes());
            }
        });
        Object.defineProperty(entries, Symbol.iterator, { value: arrayIterator });
        expect(projectWtLoginUid(entries)).toEqual({ status: 'present', uid: 'bounded' });
        expect(byteIterator).not.toHaveBeenCalled();
        expect(arrayIterator).not.toHaveBeenCalled();
    });

    it('rejects accessor entries and sparse or accessor array slots without invoking getters', () => {
        const get = vi.fn(() => bytes());
        const badEntry = {
            tag: 0x543,
            get value() {
                return get();
            },
        };
        const badTag = {
            get tag() {
                return get();
            },
            value: bytes(),
        };
        const sparse = new Array<WtTlvEntry>(1);
        const accessor: WtTlvEntry[] = [entry(bytes())];
        Object.defineProperty(accessor, '0', { get });

        for (const values of [[badEntry], [badTag as unknown as WtTlvEntry], sparse, accessor]) {
            expect(() => projectWtLoginUid(values)).toThrow('invalid WT login keystore projection');
        }

        expect(get).not.toHaveBeenCalled();
    });

    it('rejects proxies without triggering their traps', () => {
        const trap = vi.fn(() => {
            throw new Error('trap');
        });
        const values = [entry(bytes())];
        const proxyArray = new Proxy(values, { get: trap, getOwnPropertyDescriptor: trap });
        const proxyEntry = new Proxy(entry(bytes()), { get: trap, getOwnPropertyDescriptor: trap });
        const proxyValue = new Proxy(bytes(), { get: trap, getOwnPropertyDescriptor: trap });

        for (const input of [proxyArray, [proxyEntry], [entry(proxyValue)]]) {
            expect(() => projectWtLoginUid(input)).toThrow('invalid WT login keystore projection');
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects shared, detached and resizable/out-of-bounds backing buffers', () => {
        const shared = new Uint8Array(new SharedArrayBuffer(4));
        const backing = new ArrayBuffer(4);
        const detached = new Uint8Array(backing);
        structuredClone(backing, { transfer: [backing] });
        const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(resizable, 0, 4);
        resizable.resize(0);

        for (const value of [shared, detached, outOfBounds]) {
            expect(() => project(value)).toThrow('invalid WT login keystore projection');
        }
    });

    it('accepts Buffer and ordinary typed-array subviews without reading adjacent bytes', () => {
        const payload = nested(text('view-uid'));
        const backing = Buffer.concat([Buffer.from([0xff]), payload, Buffer.from([0xff])]);
        const view = backing.subarray(1, backing.length - 1);
        expect(project(view)).toEqual({ status: 'present', uid: 'view-uid' });
        expect(project(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))).toEqual({
            status: 'present',
            uid: 'view-uid',
        });
    });

    it('projects synthetic WT tickets and explicitly passes UID into real SSO reserve', async () => {
        const key = new Uint8Array(16).fill(0x42);
        const inner: WtTlvEntry[] = [
            { tag: 0x143, value: bytes(1) },
            { tag: 0x305, value: new Uint8Array(16).fill(2) },
            { tag: 0x10a, value: bytes(3) },
            { tag: 0x106, value: bytes(4) },
            entry(nested(text('synthetic-uid'))),
        ];
        const ciphertext = qqTeaEncrypt(
            encodeWtTlv(inner),
            key,
            (length) => new Uint8Array(length),
        );
        const body = concat(bytes(0, 9, 0), encodeWtTlv([{ tag: 0x119, value: ciphertext }]));
        const result = decodeWtLoginResponse(body, key);
        expect(result.status).toBe('tickets');

        if (result.status !== 'tickets') {
            throw new Error('unexpected synthetic result');
        }

        const projection = projectWtLoginUid(result.innerTlvs);
        expect(projection).toEqual({ status: 'present', uid: 'synthetic-uid' });

        if (projection.status !== 'present' || !projection.uid) {
            throw new Error('unexpected synthetic projection');
        }

        const reserve = createSsoReserveBuilder({
            uin: '123',
            uid: projection.uid,
            classifySigning: () => 'unsigned',
            createTraceParent: () => 'trace',
        });
        const encoded = await reserve({ uin: '123', command: 'test', sequence: 1, body: bytes() });
        expect(protobuf_decode<DirectSsoReserve>(encoded).uid).toBe('synthetic-uid');
    });
});
