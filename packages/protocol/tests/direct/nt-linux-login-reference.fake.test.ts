import { createDecipheriv } from 'node:crypto';
import type {
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceHead,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode, protobuf_getUnknownFields } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import {
    encodeLinuxNTLoginReferenceRequest,
    type LinuxNTLoginReferenceInput,
} from '../../src/direct/nt-linux-login-reference';

// All material is synthetic. Fixed nonces are exclusively for deterministic fixtures;
// this GCM operation does not authenticate the outer ticket or establish peer identity.
const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

type WireField = { number: number; wire: number; value: bigint | Uint8Array };

// Independent bounded parser: keep empty values and all occurrences, not just decoded defaults.
function parseWire(data: Uint8Array): WireField[] {
    let pos = 0;

    const readVarint = (): bigint => {
        let value = 0n;

        for (let i = 0; i < 10; i++) {
            if (pos >= data.length) {
                throw new Error('truncated varint');
            }

            const part = data[pos++];

            if (i === 9 && part > 1) {
                throw new Error('varint overflow');
            }

            value |= BigInt(part & 127) << BigInt(7 * i);

            if ((part & 128) === 0) {
                return value;
            }
        }

        throw new Error('varint overflow');
    };

    const result: WireField[] = [];

    while (pos < data.length) {
        const key = readVarint();
        const number = Number(key >> 3n);
        const wire = Number(key & 7n);

        if (number < 1 || number > 0x1fffffff) {
            throw new Error('invalid field number');
        }

        if (wire === 0) {
            result.push({ number, wire, value: readVarint() });
        } else if (wire === 2) {
            const size = readVarint();

            if (size > BigInt(data.length - pos)) {
                throw new Error('truncated field');
            }

            const end = pos + Number(size);
            result.push({ number, wire, value: Uint8Array.from(data.subarray(pos, end)) });
            pos = end;
        } else {
            throw new Error('unexpected wire type');
        }
    }

    return result;
}

function field(fields: WireField[], number: number, wire: number): bigint | Uint8Array {
    const matches = fields.filter((item) => item.number === number);
    expect(matches).toHaveLength(1);
    expect(matches[0].wire).toBe(wire);
    return matches[0].value;
}

function blob(fields: WireField[], number: number): Uint8Array {
    return field(fields, number, 2) as Uint8Array;
}

function fixture(keyLength = 16): LinuxNTLoginReferenceInput {
    return {
        sessionKey: Uint8Array.from({ length: keyLength }, (_, i) => i),
        sessionTicket: bytes('fe001122'),
        nonce: bytes('000102030405060708090a0b'),
        loginBody: bytes('00ff001020'),
        account: '123456',
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        guid: bytes('00112233445566778899aabbccddeeff'),
        version: '1.2.3',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        cookie: 'fixture-cookie',
    };
}

function decrypt(wrapped: Uint8Array, key: Uint8Array, aad?: Uint8Array): Uint8Array {
    expect(wrapped.length).toBeGreaterThanOrEqual(28);
    const cipher = createDecipheriv(`aes-${key.length * 8}-gcm`, key, wrapped.subarray(0, 12));

    if (aad !== undefined) {
        cipher.setAAD(aad);
    }

    cipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
    return Uint8Array.from(
        Buffer.concat([cipher.update(wrapped.subarray(12, -16)), cipher.final()]),
    );
}

function inspect(input: LinuxNTLoginReferenceInput) {
    const encoded = encodeLinuxNTLoginReferenceRequest(input);
    const forwardFields = parseWire(encoded);
    const forward = protobuf_decode<LinuxNTLoginReferenceForward>(encoded);
    const wrapped = blob(forwardFields, 3);
    const plain = decrypt(wrapped, input.sessionKey);
    const commonFields = parseWire(plain);
    const headBytes = blob(commonFields, 1);
    const headFields = parseWire(headBytes);
    const common = protobuf_decode<LinuxNTLoginReferenceCommon>(plain);
    const head = protobuf_decode<LinuxNTLoginReferenceHead>(headBytes);
    return {
        encoded,
        forwardFields,
        forward,
        wrapped,
        plain,
        commonFields,
        headFields,
        common,
        head,
    };
}

function expectNumbers(fields: WireField[], numbers: number[]) {
    // Ordering is regression coverage for this implementation, not a protobuf requirement.
    expect(fields.map((item) => item.number)).toEqual(numbers);
}

function expectText(fields: WireField[], number: number, value: string) {
    expect(Buffer.from(blob(fields, number)).toString('utf8')).toBe(value);
}

describe('synthetic Linux NT reference request', () => {
    for (const keyLength of [16, 24, 32]) {
        it(`encodes and independently authenticates AES-${keyLength * 8}-GCM`, () => {
            const input = fixture(keyLength);
            const r = inspect(input);
            expectNumbers(r.forwardFields, [1, 3, 4]);
            expect(blob(r.forwardFields, 1)).toEqual(input.sessionTicket);
            expect(field(r.forwardFields, 4, 0)).toBe(1n);
            expect(r.forwardFields.some((entry) => entry.number === 5)).toBe(false);
            expect(r.forward).toMatchObject({ sessionTicket: input.sessionTicket, type: 1 });
            expect(r.wrapped.subarray(0, 12)).toEqual(input.nonce);
            expect(() => decrypt(r.wrapped, input.sessionKey, Uint8Array.of(1))).toThrow();
            expect(decrypt(r.wrapped, input.sessionKey, new Uint8Array())).toEqual(r.plain);

            expectNumbers(r.commonFields, [1, 2]);
            expect(blob(r.commonFields, 2)).toEqual(input.loginBody);
            expect(r.common.body).toEqual(input.loginBody);
            expectNumbers(r.headFields, [1, 2, 3, 5, 7]);
            const user = parseWire(blob(r.headFields, 1));
            const client = parseWire(blob(r.headFields, 2));
            const app = parseWire(blob(r.headFields, 3));
            const cookie = parseWire(blob(r.headFields, 5));
            const sdk = parseWire(blob(r.headFields, 7));
            expectNumbers(user, [1]);
            expectText(user, 1, input.account);
            expectNumbers(client, [1, 2, 3, 4]);
            expectText(client, 1, input.deviceType);
            expectText(client, 2, input.deviceName);
            expect(field(client, 3, 0)).toBe(7n);
            expect(blob(client, 4)).toEqual(input.guid);
            expectNumbers(app, [1, 2, 3, 5]);
            expectText(app, 1, input.version);
            expect(field(app, 2, 0)).toBe(42n);
            expectText(app, 3, input.appName);
            expectText(app, 5, input.qua);
            expectNumbers(cookie, [1]);
            expectText(cookie, 1, input.cookie!);
            expectNumbers(sdk, [1]);
            expect(field(sdk, 1, 0)).toBe(1n);
            expect(r.head).toMatchObject({
                user: { account: input.account },
                client: {
                    deviceType: input.deviceType,
                    deviceName: input.deviceName,
                    platform: 7,
                    guid: input.guid,
                },
                app: {
                    version: input.version,
                    appId: input.appId,
                    appName: input.appName,
                    qua: input.qua,
                },
                cookie: { cookieContent: input.cookie },
                sdk: { version: 1 },
            });
            expect(protobuf_getUnknownFields(r.forward)).toEqual([]);
            expect(protobuf_getUnknownFields(r.common)).toEqual([]);
            expect(protobuf_getUnknownFields(r.head)).toEqual([]);
        });
    }

    it('matches an independently calculated short fixed vector and preserves empty body', () => {
        const input = {
            ...fixture(),
            account: '1',
            deviceType: 't',
            deviceName: 'n',
            guid: bytes('ff'),
            version: 'v',
            appId: 1,
            appName: 'a',
            qua: 'q',
            cookie: 'c',
            loginBody: new Uint8Array(),
        };
        const r = inspect(input);
        expect(hex(r.plain)).toBe(
            '0a280a030a0131120b0a017412016e18072201ff1a0b0a017610011a01612a01712a030a01633a0208011200',
        );
        expect(hex(r.wrapped)).toBe(
            '000102030405060708090a0b9944adcd6c1ac64640d860fe24a21e10b4041b1949e6f7f79031f0371525886df48ed8fdf5e38de148f51be7a3c4c7b09130b34b329ab4e17808b07d',
        );
        expect(blob(r.commonFields, 2)).toHaveLength(0);
        expect(r.common.body).toEqual(new Uint8Array());
        expect(encodeLinuxNTLoginReferenceRequest(input)).toEqual(r.encoded);
    });

    it('distinguishes absent cookie from explicitly empty and preserves other empty fields', () => {
        const input = {
            ...fixture(),
            deviceName: '',
            deviceType: '',
            version: '',
            appId: 0,
            appName: '',
            qua: '',
            loginBody: new Uint8Array(),
            cookie: '',
        };
        const present = inspect(input);
        const missingInput = { ...input } as LinuxNTLoginReferenceInput;
        delete missingInput.cookie;
        const missing = inspect(missingInput);
        // Local API uses undefined/absence for the empty cookie message; null is rejected.
        // This projection does not claim general source-level V2 input compatibility.
        const undefinedCookie = inspect({ ...missingInput, cookie: undefined });
        expect(undefinedCookie.encoded).toEqual(missing.encoded);
        expect(() =>
            encodeLinuxNTLoginReferenceRequest({ ...missingInput, cookie: null as never }),
        ).toThrow();
        expect(encodeLinuxNTLoginReferenceRequest(missingInput)).toEqual(missing.encoded);
        const cookiePresent = parseWire(blob(present.headFields, 5));
        expectNumbers(cookiePresent, [1]);
        expect(blob(cookiePresent, 1)).toHaveLength(0);
        expect(blob(missing.headFields, 5)).toHaveLength(0);
        expect(parseWire(blob(missing.headFields, 5))).toEqual([]);
        expect(present.head.cookie.cookieContent).toBe('');
        expect(missing.head.cookie.cookieContent == null).toBe(true);
        expect(blob(present.commonFields, 2)).toHaveLength(0);
        const client = parseWire(blob(present.headFields, 2));
        expectNumbers(client, [1, 2, 3, 4]);
        expect(blob(client, 1)).toHaveLength(0);
        expect(blob(client, 2)).toHaveLength(0);
        const app = parseWire(blob(present.headFields, 3));
        expectNumbers(app, [1, 3, 5]);

        for (const n of [1, 3, 5]) {
            expect(blob(app, n)).toHaveLength(0);
        }
    });

    it('limits GCM claims to its ciphertext and tag, not the external ticket', () => {
        const input = fixture();
        const r = inspect(input);

        for (const offset of [0, 12, r.wrapped.length - 1]) {
            const damaged = r.wrapped.slice();
            damaged[offset] ^= 1;
            expect(() => decrypt(damaged, input.sessionKey)).toThrow();
        }

        const wrongKey = Uint8Array.from(input.sessionKey);
        wrongKey[0] ^= 1;
        expect(() => decrypt(r.wrapped, wrongKey)).toThrow();

        const altered = Buffer.from(r.encoded);
        const ticket = Buffer.from(input.sessionTicket);
        const at = altered.indexOf(ticket);
        expect(at).toBeGreaterThanOrEqual(0);
        altered[at] ^= 1;
        const alteredFields = parseWire(altered);
        expect(blob(alteredFields, 1)).not.toEqual(input.sessionTicket);
        expect(decrypt(blob(alteredFields, 3), input.sessionKey)).toEqual(r.plain);
        // AEAD integrity of this ciphertext proves neither a signed ticket nor peer authentication.
    });

    it('bounds unknown and optional wire data to their containing frame', () => {
        const input = fixture();
        const r = inspect(input);
        const withUnknown = Uint8Array.from(Buffer.concat([r.plain, bytes('980607')])); // field 99
        const decoded = protobuf_decode<LinuxNTLoginReferenceCommon>(withUnknown);
        expect(decoded.body).toEqual(input.loginBody);
        expect(protobuf_getUnknownFields(decoded)).toEqual([
            { fieldNumber: 99, wireType: 0, count: 1, totalByteLength: 1 },
        ]);
        expectNumbers(parseWire(withUnknown), [1, 2, 99]);
        // The inner message declares two bytes but has only one inside its frame;
        // bytes belonging to the following outer body must not rescue it.
        const nestedTruncated = bytes('0a030a02011200');
        expect(() => parseWire(blob(parseWire(nestedTruncated), 1))).toThrow();
        expect(() => protobuf_decode<LinuxNTLoginReferenceCommon>(nestedTruncated)).toThrow();

        for (const malformed of [bytes('0a0201'), bytes('1201'), bytes('980680'), bytes('00')]) {
            expect(() => parseWire(malformed)).toThrow();
            expect(() => protobuf_decode<LinuxNTLoginReferenceCommon>(malformed)).toThrow();
        }
    });

    it('rejects invalid scalar and byte values, and recovers after every failure', () => {
        const baseline = fixture();
        const expected = encodeLinuxNTLoginReferenceRequest(baseline);
        const cases: Array<[string, unknown]> = [
            ...[
                '',
                '0',
                '01',
                '-1',
                '+1',
                ' 1',
                '1 ',
                '1.0',
                '9223372036854775808',
                '10000000000000000000',
                '１２３',
            ].map((value): [string, unknown] => ['account', value]),
            ...[-1, 0x80000000, 0.5, NaN, Infinity, '1'].map((value): [string, unknown] => [
                'appId',
                value,
            ]),
            ...[0, 1, 15, 17, 23, 25, 31, 33].map((n): [string, unknown] => [
                'sessionKey',
                new Uint8Array(n),
            ]),
            ...[0, 11, 13].map((n): [string, unknown] => ['nonce', new Uint8Array(n)]),
            ['sessionTicket', new Uint8Array()],
            ['guid', new Uint8Array()],
            ['guid', new ArrayBuffer(16)],
            ['guid', [1]],
            ['loginBody', null],
            ['deviceName', '\ud800'],
            ['qua', '\udc00'],
            ['cookie', null],
            ['deviceType', 1],
            ['extra', 'not in schema'],
        ];

        for (const [name, value] of cases) {
            const invalid = { ...baseline, [name]: value };
            expect(
                () => encodeLinuxNTLoginReferenceRequest(invalid as LinuxNTLoginReferenceInput),
                name,
            ).toThrow();
            expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
        }

        // This UTF-16 validation is a local input rule, not a claim about V2.
        const unicode = inspect({ ...baseline, deviceName: 'fixture-😀' });
        expect(unicode.head.client.deviceName).toBe('fixture-😀');
        expectText(parseWire(blob(unicode.headFields, 2)), 2, 'fixture-😀');

        for (const account of ['1', '9223372036854775807']) {
            expect(inspect({ ...baseline, account }).head.user.account).toBe(account);
        }

        for (const appId of [0, 0x7fffffff]) {
            const r = inspect({ ...baseline, appId });
            expect(r.head.app.appId ?? 0).toBe(appId);
        }

        for (const guid of [Uint8Array.of(1), new Uint8Array(17).fill(2)]) {
            expect(inspect({ ...baseline, guid }).head.client.guid).toEqual(guid);
        }
    });

    it('rejects proxy and accessor input without invoking traps or getters', () => {
        const baseline = fixture();
        const expected = encodeLinuxNTLoginReferenceRequest(baseline);
        let called = 0;
        const proxy = new Proxy(baseline, {
            ownKeys() {
                called++;
                throw new Error('trap');
            },
        });
        expect(() => encodeLinuxNTLoginReferenceRequest(proxy)).toThrow();
        expect(called).toBe(0);
        expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
        const accessor = { ...baseline };
        Object.defineProperty(accessor, 'account', {
            get() {
                called++;
                throw new Error('getter');
            },
        });
        expect(() => encodeLinuxNTLoginReferenceRequest(accessor)).toThrow();
        expect(called).toBe(0);
        expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
        const viewProxy = new Proxy(baseline.guid, {
            get() {
                called++;
                throw new Error('view trap');
            },
        });
        expect(() =>
            encodeLinuxNTLoginReferenceRequest({ ...baseline, guid: viewProxy }),
        ).toThrow();
        expect(called).toBe(0);
        expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
        expect(() =>
            encodeLinuxNTLoginReferenceRequest({ ...baseline, [Symbol('extra')]: 1 }),
        ).toThrow();
        expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
    });

    it('rejects shared, resizable and detached backing stores and remains reentrant', () => {
        const baseline = fixture();
        const expected = encodeLinuxNTLoginReferenceRequest(baseline);
        const shared = new Uint8Array(new SharedArrayBuffer(16));
        expect(() => encodeLinuxNTLoginReferenceRequest({ ...baseline, guid: shared })).toThrow();
        expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
        const resizable = Reflect.construct(ArrayBuffer, [
            16,
            { maxByteLength: 32 },
        ]) as ArrayBuffer;
        expect((resizable as ArrayBuffer & { resizable: boolean }).resizable).toBe(true);
        expect(() =>
            encodeLinuxNTLoginReferenceRequest({ ...baseline, guid: new Uint8Array(resizable) }),
        ).toThrow();
        expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
        const backing = new ArrayBuffer(16);
        const detached = new Uint8Array(backing);
        structuredClone(backing, { transfer: [backing] });
        expect(() => encodeLinuxNTLoginReferenceRequest({ ...baseline, guid: detached })).toThrow();
        expect(encodeLinuxNTLoginReferenceRequest(baseline)).toEqual(expected);
    });

    it('bounds bytes and UTF-8 total using the implementation framing budget', () => {
        const input = fixture();
        const expected = encodeLinuxNTLoginReferenceRequest(input);
        const limit = 1024 * 1024;

        for (const key of ['loginBody', 'sessionTicket', 'guid'] as const) {
            expect(() =>
                encodeLinuxNTLoginReferenceRequest({ ...input, [key]: new Uint8Array(limit + 1) }),
            ).toThrow();
            expect(encodeLinuxNTLoginReferenceRequest(input)).toEqual(expected);
        }

        expect(() =>
            encodeLinuxNTLoginReferenceRequest({ ...input, deviceName: 'x'.repeat(limit + 1) }),
        ).toThrow();
        expect(encodeLinuxNTLoginReferenceRequest(input)).toEqual(expected);
        const textBytes = [
            input.account,
            input.deviceName,
            input.deviceType,
            input.version,
            input.appName,
            input.qua,
            input.cookie!,
        ].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
        const available = limit - 256 - textBytes - input.sessionTicket.length - input.guid.length;
        // One limit-sized buffer and one AES operation, not a loop of large allocations.
        const boundary = new Uint8Array(available + 1);
        expect(() =>
            encodeLinuxNTLoginReferenceRequest({ ...input, loginBody: boundary }),
        ).toThrow();
        expect(encodeLinuxNTLoginReferenceRequest(input)).toEqual(expected);
        const accepted = encodeLinuxNTLoginReferenceRequest({
            ...input,
            loginBody: boundary.subarray(0, available),
        });
        expect(blob(parseWire(accepted), 3).length).toBeLessThanOrEqual(limit);
        expect(encodeLinuxNTLoginReferenceRequest(input)).toEqual(expected);
    });

    it('does not alter caller-owned bytes on success or failure, including subarray views', () => {
        const outer = new Uint8Array(50).fill(0xa5);
        const input = {
            ...fixture(),
            sessionKey: outer.subarray(3, 19),
            nonce: outer.subarray(22, 34),
            guid: outer.subarray(40, 42),
        };
        const snapshots = [outer, input.sessionTicket, input.loginBody].map((v) =>
            Uint8Array.from(v),
        );
        const first = encodeLinuxNTLoginReferenceRequest(input);
        expect(encodeLinuxNTLoginReferenceRequest(input)).toEqual(first);
        expect(() => encodeLinuxNTLoginReferenceRequest({ ...input, account: '0' })).toThrow();
        expect(outer).toEqual(snapshots[0]);
        expect(input.sessionTicket).toEqual(snapshots[1]);
        expect(input.loginBody).toEqual(snapshots[2]);
        expect(encodeLinuxNTLoginReferenceRequest(input)).toEqual(first);
    });
});
