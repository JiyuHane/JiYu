import { describe, expect, it } from 'vitest';
import {
    commitLinuxEasyKey,
    createLinuxEasyKeyCapability,
    decodeLinuxEasyServiceResponse,
    linuxEasyKeyState,
    revokeLinuxEasyKey,
    stageLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { MAX_SERVICE_FRAME_BYTES } from '../../src/direct/service-frame';

// Synthetic identities and bytes only. No network, sockets, live account or signer.
const UIN = '123456';
const OTHER_UIN = '234567';
const SEQUENCE = 0xf0000001;
const COMMAND = 'Synthetic.Test';
const PAYLOAD = Uint8Array.of(0x11, 0x00, 0xfe, 0x42);
const KEY = Uint8Array.from({ length: 16 }, (_, index) => index + 0x10);
const OTHER_KEY = Uint8Array.from({ length: 16 }, (_, index) => index + 0x80);

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

function field(bytes: Uint8Array): Buffer {
    return Buffer.concat([word(bytes.length + 4), bytes]);
}

function innerResponse(sequence = SEQUENCE, command = COMMAND, retCode = 0): Uint8Array {
    const header = Buffer.concat([
        word(sequence),
        word(retCode),
        field(new Uint8Array()),
        field(Buffer.from(command, 'utf8')),
        field(new Uint8Array()),
        word(0),
        field(new Uint8Array()),
    ]);
    return Uint8Array.from(Buffer.concat([field(header), field(PAYLOAD)]));
}

// A response header is deliberately assembled separately from request encoding.
function response(
    key = KEY,
    options: {
        uin?: string;
        protocol?: number;
        flag?: number;
        dummy?: number;
        inner?: Uint8Array;
    } = {},
): Uint8Array {
    const ciphertext = qqTeaEncrypt(options.inner ?? innerResponse(), key, (length) =>
        new Uint8Array(length).fill(0x35),
    );
    const frame = Buffer.concat([
        word(0),
        word(options.protocol ?? 12),
        Buffer.of(options.flag ?? 1, options.dummy ?? 0),
        field(Buffer.from(options.uin ?? UIN, 'ascii')),
        ciphertext,
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function fixture(uin = UIN, key = KEY) {
    const lease = {};
    const generation = {};
    const token = createLinuxEasyKeyCapability({ lease, uin, generation });
    const stage = (sequence = SEQUENCE, value = Uint8Array.from(key)) =>
        stageLinuxEasyKey({ token, lease, uin, sequence, key: value });
    const commit = (sequence = SEQUENCE, value = Uint8Array.from(key)) =>
        commitLinuxEasyKey({ token, lease, uin, sequence, comparisonKey: value });
    const decode = (frame: Uint8Array) =>
        decodeLinuxEasyServiceResponse({ token, lease, uin, frame });
    return { lease, generation, token, uin, stage, commit, decode };
}

function detached(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return bytes;
}

function invalidKeys(): unknown[] {
    class KeySubclass extends Uint8Array {}
    return [
        null,
        {},
        new Uint8Array(15),
        new Uint8Array(17),
        new Uint16Array(8),
        Buffer.alloc(16),
        new KeySubclass(16),
        new Proxy(new Uint8Array(16), {}),
        new Uint8Array(new SharedArrayBuffer(16)),
        new Uint8Array(new ArrayBuffer(16, { maxByteLength: 32 })),
        detached(16),
    ];
}

describe('Linux easy key capability with synthetic response bytes', () => {
    it('moves empty to tentative to active, then revokes idempotently', () => {
        const f = fixture();
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        expect(() => f.decode(response())).toThrow();
        expect(() => f.commit()).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        f.stage();
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        const tentative = f.decode(response());
        expect(tentative).toMatchObject({
            uin: UIN,
            protocol: 12,
            encryption: 'd2',
            dummy: 0,
            sequence: SEQUENCE,
            command: COMMAND,
            retCode: 0,
        });
        expect(tentative.body).toEqual(innerResponse());
        tentative.body.fill(0); // Successful output belongs to the caller.
        f.commit();
        expect(linuxEasyKeyState(f.token)).toBe('active');
        expect(f.decode(response()).body).toEqual(innerResponse());
        revokeLinuxEasyKey(f.token);
        expect(linuxEasyKeyState(f.token)).toBe('revoked');
        expect(() => f.decode(response())).toThrow();
        expect(() => f.stage()).toThrow();
        expect(() => f.commit()).toThrow();
        revokeLinuxEasyKey(f.token);
        expect(linuxEasyKeyState(f.token)).toBe('revoked');
    });

    it('snapshots stage and comparison keys rather than retaining caller bytes', () => {
        const f = fixture();
        const source = Uint8Array.from(KEY);
        const comparison = Uint8Array.from(KEY);
        const frame = response();
        f.stage(SEQUENCE, source);
        expect(source).toEqual(KEY);
        source.fill(0xee);
        expect(f.decode(frame).body).toEqual(innerResponse());
        f.commit(SEQUENCE, comparison);
        expect(comparison).toEqual(KEY);
        comparison.fill(0xbb);
        const first = f.decode(frame);
        expect(first.body).toEqual(innerResponse());
        first.body.fill(0);
        expect(f.decode(frame).body).toEqual(innerResponse());
        revokeLinuxEasyKey(f.token);
        expect(source).toEqual(new Uint8Array(16).fill(0xee));
        expect(comparison).toEqual(new Uint8Array(16).fill(0xbb));
    });

    it('claims each exact lease once for its entire lifetime', () => {
        const lease = {};
        const generation = {};
        const token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation });
        expect(() =>
            createLinuxEasyKeyCapability({ lease, uin: OTHER_UIN, generation: {} }),
        ).toThrow();
        revokeLinuxEasyKey(token);
        expect(() => createLinuxEasyKeyCapability({ lease, uin: UIN, generation })).toThrow();
        const other = createLinuxEasyKeyCapability({ lease: {}, uin: UIN, generation });
        expect(linuxEasyKeyState(other)).toBe('empty');
    });

    it('rejects invalid identities at the factory without claiming a valid lease', () => {
        for (const uin of ['', '0', '01', '+1', '-1', ' 1', '1.0', '4294967296', '123x']) {
            const lease = {};
            expect(() => createLinuxEasyKeyCapability({ lease, uin, generation: {} })).toThrow();
            expect(
                linuxEasyKeyState(
                    createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} }),
                ),
            ).toBe('empty');
        }

        for (const lease of [null, 1, 'lease', new Proxy({}, {})]) {
            expect(() =>
                createLinuxEasyKeyCapability({
                    lease: lease as unknown as object,
                    uin: UIN,
                    generation: {},
                }),
            ).toThrow();
        }

        for (const generation of [null, 1, 'generation', new Proxy({}, {})]) {
            expect(() =>
                createLinuxEasyKeyCapability({
                    lease: {},
                    uin: UIN,
                    generation: generation as unknown as object,
                }),
            ).toThrow();
        }

        const max = fixture('4294967295');
        expect(linuxEasyKeyState(max.token)).toBe('empty');
    });

    it('rejects forged and proxied tokens, proxy option records and accessor fields', () => {
        const f = fixture();
        const forged = {} as typeof f.token;
        const proxied = new Proxy(f.token, {});
        expect(() => linuxEasyKeyState(forged)).toThrow();
        expect(() => linuxEasyKeyState(proxied)).toThrow();
        expect(() => revokeLinuxEasyKey(forged)).toThrow();
        const args = {
            token: f.token,
            lease: f.lease,
            uin: UIN,
            sequence: SEQUENCE,
            key: Uint8Array.from(KEY),
        };
        expect(() => stageLinuxEasyKey(new Proxy(args, {}))).toThrow();
        let reads = 0;
        const accessor = {
            ...args,
            get key() {
                reads++;
                return Uint8Array.from(KEY);
            },
        };
        expect(() => stageLinuxEasyKey(accessor)).toThrow();
        expect(reads).toBe(0);
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        f.stage();
        expect(() =>
            decodeLinuxEasyServiceResponse(
                new Proxy({ token: f.token, lease: f.lease, uin: UIN, frame: response() }, {}),
            ),
        ).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
    });

    it('requires exact lease and account on stage, commit, and decode', () => {
        const f = fixture();
        const foreignLease = {};
        const key = Uint8Array.from(KEY);
        expect(() =>
            stageLinuxEasyKey({
                token: f.token,
                lease: foreignLease,
                uin: UIN,
                sequence: SEQUENCE,
                key,
            }),
        ).toThrow();
        expect(() =>
            stageLinuxEasyKey({
                token: f.token,
                lease: f.lease,
                uin: OTHER_UIN,
                sequence: SEQUENCE,
                key,
            }),
        ).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('empty');
        f.stage();
        expect(() => f.decode(response(OTHER_KEY, { uin: OTHER_UIN }))).toThrow();
        const decodeArgs = { token: f.token, lease: f.lease, uin: UIN, frame: response() };
        expect(() =>
            decodeLinuxEasyServiceResponse({ ...decodeArgs, lease: foreignLease }),
        ).toThrow();
        expect(() => decodeLinuxEasyServiceResponse({ ...decodeArgs, uin: OTHER_UIN })).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        f.commit();
    });

    it('leaves an empty slot usable after stage errors and rejects duplicate stage', () => {
        const f = fixture();

        for (const sequence of [-1, 0x100000000, 1.5, NaN, Infinity]) {
            expect(() => f.stage(sequence)).toThrow();
            expect(linuxEasyKeyState(f.token)).toBe('empty');
        }

        f.stage();
        expect(() => f.stage()).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        f.commit();
        expect(() => f.stage()).toThrow();
        expect(() => f.commit()).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('active');
        expect(f.decode(response()).body).toEqual(innerResponse());
    });

    it('revokes a tentative key on each resolved commit identity, sequence or key error', () => {
        for (const failure of ['lease', 'uin', 'sequence', 'out-of-range', 'key'] as const) {
            const f = fixture();
            const source = Uint8Array.from(KEY);
            const comparison = Uint8Array.from(failure === 'key' ? OTHER_KEY : KEY);
            const comparisonBefore = Uint8Array.from(comparison);
            f.stage(SEQUENCE, source);
            expect(() =>
                commitLinuxEasyKey({
                    token: f.token,
                    lease: failure === 'lease' ? {} : f.lease,
                    uin: failure === 'uin' ? OTHER_UIN : UIN,
                    sequence:
                        failure === 'sequence'
                            ? SEQUENCE + 1
                            : failure === 'out-of-range'
                              ? -1
                              : SEQUENCE,
                    comparisonKey: comparison,
                }),
            ).toThrow();
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(source).toEqual(KEY);
            expect(comparison).toEqual(comparisonBefore);
            expect(() => f.commit()).toThrow();
            expect(() => f.decode(response())).toThrow();
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
        }
    });

    it('revokes after resolving a token when a commit field is absent or an accessor', () => {
        for (const kind of ['missing', 'accessor'] as const) {
            const f = fixture();
            f.stage();
            let reads = 0;
            const input = {
                token: f.token,
                lease: f.lease,
                uin: UIN,
                sequence: SEQUENCE,
            };

            if (kind === 'accessor') {
                Object.defineProperty(input, 'comparisonKey', {
                    get() {
                        reads++;
                        return Uint8Array.from(KEY);
                    },
                });
                reads = 0;
            }

            expect(() =>
                commitLinuxEasyKey(input as Parameters<typeof commitLinuxEasyKey>[0]),
            ).toThrow();
            expect(reads).toBe(0);
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(() => f.commit()).toThrow();
            expect(() => f.decode(response())).toThrow();
        }
    });

    it('leaves a tentative slot alone when a commit token cannot be resolved', () => {
        const f = fixture();
        f.stage();
        const input = {
            token: f.token,
            lease: f.lease,
            uin: UIN,
            sequence: SEQUENCE,
            comparisonKey: Uint8Array.from(KEY),
        };
        expect(() => commitLinuxEasyKey(new Proxy(input, {}))).toThrow();
        expect(() => commitLinuxEasyKey({ ...input, token: {} as typeof f.token })).toThrow();
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
        f.commit();
        expect(linuxEasyKeyState(f.token)).toBe('active');
    });

    it('accepts both uint32 sequence endpoints', () => {
        for (const sequence of [0, 0xffffffff]) {
            const f = fixture();
            f.stage(sequence);
            f.commit(sequence);
            expect(linuxEasyKeyState(f.token)).toBe('active');
        }
    });

    it('rejects non-ordinary, shared, resizable, detached, proxied and wrong-length keys', () => {
        const f = fixture();

        for (const candidate of invalidKeys()) {
            expect(() => f.stage(SEQUENCE, candidate as Uint8Array)).toThrow();
            expect(linuxEasyKeyState(f.token)).toBe('empty');
        }

        f.stage();
        f.commit();

        for (const candidate of invalidKeys()) {
            const next = fixture();
            const source = Uint8Array.from(KEY);
            next.stage(SEQUENCE, source);
            expect(() => next.commit(SEQUENCE, candidate as Uint8Array)).toThrow();
            expect(linuxEasyKeyState(next.token)).toBe('revoked');
            expect(source).toEqual(KEY);
            expect(() => next.commit()).toThrow();
            expect(() => next.decode(response())).toThrow();
        }
    });

    it('parses metadata from the decrypted SSO while returning the complete owned SSO bytes', () => {
        const f = fixture();
        f.stage();
        const inner = innerResponse(0xffffffff, 'Fixture.Nonzero', -7);
        const frame = response(KEY, { inner });
        const before = Uint8Array.from(frame);
        const result = f.decode(frame);
        expect(result).toMatchObject({
            sequence: 0xffffffff,
            command: 'Fixture.Nonzero',
            retCode: -7,
        });
        expect(result.body).toEqual(inner);
        expect(result.body.buffer).not.toBe(frame.buffer);
        expect(frame).toEqual(before);
        result.body.fill(0);
        expect(f.decode(frame).body).toEqual(inner);
    });

    it('rejects response account, protocol, encryption, dummy, malformed and overlong frames', () => {
        const f = fixture();
        f.stage();
        const good = response();
        const lengthMismatch = Uint8Array.from(good);
        new DataView(lengthMismatch.buffer).setUint32(0, good.length + 1);
        const invalidUinField = Uint8Array.from(good);
        new DataView(invalidUinField.buffer).setUint32(10, 0xffffffff);
        const invalidUinBytes = Uint8Array.from(good);
        invalidUinBytes[14] = 0xff;
        const shortCiphertext = Uint8Array.from(good.subarray(0, 14 + UIN.length + 8));
        new DataView(shortCiphertext.buffer).setUint32(0, shortCiphertext.length);
        const malformedSso = response(KEY, { inner: Uint8Array.of(1, 2, 3) });
        const cases = [
            response(KEY, { uin: OTHER_UIN }),
            response(KEY, { uin: '0123456' }),
            response(KEY, { protocol: 13 }),
            response(KEY, { protocol: 14 }),
            response(KEY, { flag: 0 }),
            response(KEY, { flag: 2 }),
            response(KEY, { flag: 255 }),
            response(KEY, { dummy: 1 }),
            new Uint8Array(),
            good.subarray(0, 13),
            lengthMismatch,
            invalidUinField,
            invalidUinBytes,
            shortCiphertext,
            malformedSso,
            new Uint8Array(MAX_SERVICE_FRAME_BYTES + 1),
        ];

        for (const frame of cases) {
            expect(() => f.decode(frame)).toThrow();
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
        }

        expect(f.decode(good).body).toEqual(innerResponse());
    });

    it('rejects invalid frame types and backing stores without revoking', () => {
        const f = fixture();
        f.stage();
        const good = response();
        const shared = new Uint8Array(new SharedArrayBuffer(good.length));
        shared.set(good);
        const resizable = new Uint8Array(
            new ArrayBuffer(good.length, { maxByteLength: good.length + 1 }),
        );
        resizable.set(good);

        for (const frame of [
            null,
            {},
            new Proxy(good, {}),
            shared,
            resizable,
            detached(good.length),
        ]) {
            expect(() => f.decode(frame as Uint8Array)).toThrow();
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
        }

        expect(f.decode(good).body).toEqual(innerResponse());
        const bufferFrame = Buffer.from(good);
        const decoded = f.decode(bufferFrame);
        expect(decoded.body).toEqual(innerResponse());
        decoded.body.fill(0);
    });

    it('keeps separate accounts and leases independent across revocation', () => {
        const a = fixture(UIN, KEY);
        const b = fixture(OTHER_UIN, OTHER_KEY);
        a.stage();
        b.stage();
        const frameA = response(KEY);
        const frameB = response(OTHER_KEY, { uin: OTHER_UIN });
        expect(a.decode(frameA).body).toEqual(innerResponse());
        expect(b.decode(frameB).body).toEqual(innerResponse());
        expect(() => a.decode(frameB)).toThrow();
        expect(() => b.decode(frameA)).toThrow();
        a.commit();
        b.commit();
        revokeLinuxEasyKey(a.token);
        expect(() => a.decode(frameA)).toThrow();
        expect(linuxEasyKeyState(b.token)).toBe('active');
        expect(b.decode(frameB).body).toEqual(innerResponse());
    });
});
