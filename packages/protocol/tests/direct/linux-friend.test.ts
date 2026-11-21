import { afterEach, describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode, type bytes } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    LinuxFriendAddUinBody,
    LinuxFriendSettingUinBody,
    LinuxFriendAddResponseBody,
    LinuxFriendSettingUinResponseBody,
} from '@snowluma/proto-defs/linux-friend';
import {
    encodeLinuxFriendAddRequest,
    encodeLinuxFriendSettingRequest,
    LINUX_FRIEND_ADD_COMMAND,
    LINUX_FRIEND_SETTING_COMMAND,
    type LinuxFriendAddInput,
} from '../../src/direct/linux-friend-request';
import {
    decodeLinuxFriendAddResponse,
    decodeLinuxFriendSettingResponse,
    disposeLinuxFriendAddResponse,
    LINUX_FRIEND_MAX_RESPONSE_BYTES,
} from '../../src/direct/linux-friend-response';

const input = () => ({ selfUin: 1n, peerUin: 2n, sourceId: 0, sourceSub: 0 });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const decodeAdd = (bytes: Uint8Array) => protobuf_decode<OidbBase<LinuxFriendAddUinBody>>(bytes);
const decodeSetting = (bytes: Uint8Array) =>
    protobuf_decode<OidbBase<LinuxFriendSettingUinBody>>(bytes);
afterEach(() => vi.restoreAllMocks());

describe('Linux native UIN friend request encoders', () => {
    it('uses the two exact native OIDB command names', () => {
        expect(LINUX_FRIEND_SETTING_COMMAND).toBe('OidbSvcTrpcTcp.0x7c1_1');
        expect(LINUX_FRIEND_ADD_COMMAND).toBe('OidbSvcTrpcTcp.0x7c2_5');
    });
    it('matches an independently laid out setting envelope including zero sources', () => {
        expect(hex(encodeLinuxFriendSettingRequest(input()))).toBe(
            '08c10f1001220a080110011802200028006001',
        );
    });
    it('matches an independently laid out application envelope including native scalar defaults', () => {
        // Present zero fields 3/5/20: 18 00, 28 00, a0 01 00; body length is 15.
        expect(hex(encodeLinuxFriendAddRequest(input()))).toBe(
            '08c20f1005220f080110021800280058006000a001006001',
        );
    });
    it.each<[string, Partial<LinuxFriendAddInput>]>([
        ['omitted', {}],
        ['undefined', { addSetting: undefined, groupId: undefined, cardSwitch: undefined }],
        ['explicit zero', { addSetting: 0, groupId: 0, cardSwitch: 0 }],
    ])('retains native zero presence for %s scalars, not true optionals', (_name, fields) => {
        const encoded = encodeLinuxFriendAddRequest({ ...input(), ...fields });
        expect(hex(encoded)).toBe('08c20f1005220f080110021800280058006000a001006001');
        const body = decodeAdd(encoded).body!;
        expect(body).toMatchObject({ addSetting: 0, groupId: 0, cardSwitch: 0 });

        for (const field of [
            'myAllowFlag',
            'answer',
            'srcFlag',
            'autoSend',
            'sig',
            'name',
            'name1',
            'sourceDescription',
            'friendSourceDescription',
            'remark',
            'token',
            'verify',
            'secureTips',
            'supportAddRelief',
            'ext',
            'bytesSig',
            'clientExt',
        ] as const) {
            expect(body[field]).toBeNull();
        }
    });
    it.each<[string, Partial<LinuxFriendAddInput>, string]>([
        ['addSetting', { addSetting: 1 }, '080110021801280058006000a00100'],
        ['myAllowFlag', { myAllowFlag: 1 }, '0801100218002001280058006000a00100'],
        ['groupId', { groupId: 11 }, '080110021800280b58006000a00100'],
        ['answer', { answer: 'a' }, '08011002180028003a016158006000a00100'],
        ['srcFlag', { srcFlag: 1 }, '0801100218002800400158006000a00100'],
        ['autoSend', { autoSend: 1 }, '0801100218002800480158006000a00100'],
        ['sig', { sig: Uint8Array.of(1) }, '080110021800280052010158006000a00100'],
        ['name', { name: 'a' }, '0801100218002800580060006a0161a00100'],
        ['name1', { name1: 'a' }, '080110021800280058006000720161a00100'],
        ['sourceDescription', { sourceDescription: 'a' }, '0801100218002800580060007a0161a00100'],
        [
            'friendSourceDescription',
            { friendSourceDescription: 'a' },
            '08011002180028005800600082010161a00100',
        ],
        ['remark', { remark: 'a' }, '08011002180028005800600092010161a00100'],
        ['cardSwitch', { cardSwitch: 1 }, '080110021800280058006000a00101'],
        ['token', { token: Uint8Array.of(1) }, '080110021800280058006000a00100ca010101'],
        ['verify', { verify: Uint8Array.of(1) }, '080110021800280058006000a00100d2010101'],
        ['secureTips', { secureTips: true }, '080110021800280058006000a00100e00101'],
        ['supportAddRelief', { supportAddRelief: true }, '080110021800280058006000a00100e80101'],
        ['ext', { ext: Uint8Array.of(1) }, '080110021800280058006000a00100f2010101'],
        ['bytesSig', { bytesSig: Uint8Array.of(1) }, '080110021800280058006000a00100fa010101'],
        ['clientExt', { clientExt: Uint8Array.of(1) }, '080110021800280058006000a0010082020101'],
    ])('matches the independently laid out %s field', (_name, fields, expected) => {
        const encoded = encodeLinuxFriendAddRequest({ ...input(), ...fields });
        const outer = protobuf_decode<OidbBase<bytes>>(encoded);
        expect(hex(outer.body!)).toBe(expected);
    });
    it('preserves present query names including an empty string', () => {
        const encoded = encodeLinuxFriendSettingRequest({ ...input(), name: 'a', name1: '' });
        const outer = protobuf_decode<OidbBase<bytes>>(encoded);
        expect(hex(outer.body!)).toBe('080110011802200028003201613a00');
    });
    it.each(['addSetting', 'groupId', 'cardSwitch'] as const)(
        'rejects invalid %s instead of replacing it with a default',
        (field) => {
            const outOfRange =
                field === 'groupId' ? [-1, 0x1_0000_0000] : [-0x8000_0001, 0x8000_0000];

            for (const value of [
                null,
                false,
                true,
                '0',
                0n,
                {},
                NaN,
                Infinity,
                -Infinity,
                0.5,
                ...outOfRange,
            ]) {
                expect(() =>
                    encodeLinuxFriendAddRequest({
                        ...input(),
                        [field]: value,
                    } as unknown as LinuxFriendAddInput),
                ).toThrow();
            }
        },
    );
    it('rejects out-of-range optional integers and non-boolean flags', () => {
        const invalid: unknown[] = [
            { addSetting: -0x8000_0001 },
            { cardSwitch: 0x8000_0000 },
            { myAllowFlag: -1 },
            { groupId: 1.5 },
            { srcFlag: NaN },
            { autoSend: Infinity },
            { secureTips: null },
            { supportAddRelief: 'false' },
        ];

        for (const fields of invalid) {
            expect(() =>
                encodeLinuxFriendAddRequest({ ...input(), ...(fields as object) }),
            ).toThrow();
        }
    });
    it('retains all 64 identity bits and never coerces the high u32 bit to signed', () => {
        const value = { ...input(), selfUin: 0x8000_0001n, peerUin: 0xffff_ffff_ffff_fffen };
        const setting = decodeSetting(encodeLinuxFriendSettingRequest(value));
        const add = decodeAdd(encodeLinuxFriendAddRequest(value));

        for (const body of [setting.body, add.body]) {
            expect(BigInt(body!.selfUin!)).toBe(value.selfUin);
            expect(BigInt(body!.peerUin!)).toBe(value.peerUin);
        }

        expect(setting.reserved).toBe(1);
        expect(add.reserved).toBe(1);
    });
    it('distinguishes true optional absence from explicit zero, false and empty values', () => {
        const absent = decodeAdd(encodeLinuxFriendAddRequest(input())).body!;
        const present = decodeAdd(
            encodeLinuxFriendAddRequest({
                ...input(),
                addSetting: 0,
                myAllowFlag: 0,
                srcFlag: 0,
                autoSend: 0,
                sig: new Uint8Array(0),
                token: new Uint8Array(0),
                verify: new Uint8Array(0),
                answer: '',
                secureTips: false,
                supportAddRelief: false,
            }),
        ).body!;
        expect(absent.addSetting).toBe(0);
        expect(absent.groupId).toBe(0);
        expect(absent.cardSwitch).toBe(0);
        expect(absent.myAllowFlag).toBeNull();
        expect(absent.token).toBeNull();
        expect(absent.answer).toBeNull();
        expect(present.addSetting).toBe(0);
        expect(present.myAllowFlag).toBe(0);
        expect(present.srcFlag).toBe(0);
        expect(present.autoSend).toBe(0);
        expect(present.sig).toEqual(new Uint8Array(0));
        expect(present.token).toEqual(new Uint8Array(0));
        expect(present.verify).toEqual(new Uint8Array(0));
        expect(present.answer).toBe('');
        expect(present.secureTips).toBe(false);
        expect(present.supportAddRelief).toBe(false);
        expect(
            hex(encodeLinuxFriendAddRequest({ ...input(), token: new Uint8Array(0) })),
        ).toContain('ca0100');
    });
    it('preserves the signed enum while uint fields preserve their full range', () => {
        const body = decodeAdd(
            encodeLinuxFriendAddRequest({
                ...input(),
                addSetting: -1,
                cardSwitch: -0x8000_0000,
                myAllowFlag: 0xffff_ffff,
                sourceId: 0xffff_ffff,
            }),
        ).body!;
        expect(body.addSetting).toBe(-1);
        expect(body.cardSwitch).toBe(-0x8000_0000);
        expect(body.myAllowFlag).toBe(0xffff_ffff);
        expect(body.sourceId).toBe(0xffff_ffff);

        for (const fields of [
            { addSetting: -0x8000_0000, groupId: 0xffff_ffff, cardSwitch: 0x7fff_ffff },
            { addSetting: 0x7fff_ffff, groupId: 0, cardSwitch: -0x8000_0000 },
        ]) {
            expect(
                decodeAdd(encodeLinuxFriendAddRequest({ ...input(), ...fields })).body,
            ).toMatchObject(fields);
        }
    });
    it('encodes Unicode exactly and owns both the output and verification snapshots', () => {
        const sig = Uint8Array.of(3, 4, 5);
        const first = encodeLinuxFriendAddRequest({ ...input(), answer: '你好😀', sig });
        const baseline = Uint8Array.from(first);
        sig.fill(9);
        const second = encodeLinuxFriendAddRequest({ ...input(), answer: 'second' });
        expect(first).toEqual(baseline);
        expect(decodeAdd(first).body!.sig).toEqual(Uint8Array.of(3, 4, 5));
        expect(decodeAdd(first).body!.answer).toBe('你好😀');
        first.fill(0);
        expect(decodeAdd(second).body!.answer).toBe('second');
        expect(sig).toEqual(Uint8Array.of(9, 9, 9));
    });
    it.each([0n, -1n, 0x1_0000_0000_0000_0000n, 1, '1', null])(
        'rejects invalid peer identity %s',
        (peerUin) => {
            expect(() =>
                encodeLinuxFriendAddRequest({ ...input(), peerUin } as LinuxFriendAddInput),
            ).toThrow();
        },
    );
    it.each([-1, 0x1_0000_0000, 1.5, NaN, Infinity, '0', undefined])(
        'rejects invalid source %s without defaulting',
        (sourceId) => {
            expect(() =>
                encodeLinuxFriendAddRequest({ ...input(), sourceId } as LinuxFriendAddInput),
            ).toThrow();
        },
    );
    it.each(['\ud800', '\udc00', '\ud800x', '中'.repeat(1366), 'x'.repeat(4097)])(
        'rejects malformed or overlong text',
        (answer) => {
            expect(() => encodeLinuxFriendAddRequest({ ...input(), answer })).toThrow();
        },
    );
    it('rejects unknown fields and accessors without invoking caller code', () => {
        expect(() =>
            encodeLinuxFriendAddRequest({ ...input(), command: 'other' } as LinuxFriendAddInput),
        ).toThrow();
        const get = vi.fn(() => 'unexpected');
        const hostile = Object.defineProperty(input(), 'answer', { get });
        expect(() => encodeLinuxFriendAddRequest(hostile)).toThrow();
        expect(get).not.toHaveBeenCalled();
        const trap = vi.fn();
        expect(() => encodeLinuxFriendAddRequest(new Proxy(input(), { get: trap }))).toThrow();
        expect(trap).not.toHaveBeenCalled();
        expect(() =>
            encodeLinuxFriendAddRequest(Object.assign(Object.create({ inherited: true }), input())),
        ).toThrow();
        expect(() =>
            encodeLinuxFriendSettingRequest({
                ...input(),
                answer: 'not a setting field',
            } as LinuxFriendAddInput),
        ).toThrow();
    });
    it('rejects non-byte, shared, resizable, detached and metadata-accessor buffers', () => {
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const getter = vi.fn(() => 1);
        const metadata = Object.defineProperty(new Uint8Array(1), 'byteLength', { get: getter });
        const buffers: unknown[] = [
            new Int8Array(1),
            new DataView(new ArrayBuffer(1)),
            new Uint8Array(new SharedArrayBuffer(1)),
            new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 })),
            detached,
            metadata,
            new Uint8Array(16385),
            null,
        ];

        for (const sig of buffers) {
            expect(() =>
                encodeLinuxFriendAddRequest({ ...input(), sig } as LinuxFriendAddInput),
            ).toThrow();
        }

        expect(getter).not.toHaveBeenCalled();
    });
    it('wipes already-owned verification copies when a later aggregate bound fails', () => {
        const original = Uint8Array.from;
        const snapshots: Uint8Array[] = [];
        vi.spyOn(Uint8Array, 'from').mockImplementation(function (
            this: Uint8ArrayConstructor,
            ...args
        ) {
            const copy = Reflect.apply(original, this, args) as ReturnType<typeof original>;
            snapshots.push(copy);
            return copy;
        });
        const sig = new Uint8Array(16384).fill(7);
        expect(() =>
            encodeLinuxFriendAddRequest({ ...input(), sig, token: sig, verify: sig, ext: sig }),
        ).toThrow();
        expect(snapshots).toHaveLength(3);
        expect(snapshots.every((snapshot) => snapshot.every((byte) => byte === 0))).toBe(true);
        expect(sig.every((byte) => byte === 7)).toBe(true);
    });
    it('wipes verification snapshots on later semantic validation failure', () => {
        const original = Uint8Array.from;
        const snapshots: Uint8Array[] = [];
        vi.spyOn(Uint8Array, 'from').mockImplementation(function (
            this: Uint8ArrayConstructor,
            ...args
        ) {
            const copy = Reflect.apply(original, this, args) as ReturnType<typeof original>;
            snapshots.push(copy);
            return copy;
        });
        const sig = Uint8Array.of(1, 2, 3);
        expect(() =>
            encodeLinuxFriendAddRequest({
                ...input(),
                sig,
                secureTips: 1,
            } as unknown as LinuxFriendAddInput),
        ).toThrow();
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toEqual(new Uint8Array(3));
        expect(sig).toEqual(Uint8Array.of(1, 2, 3));
    });
});

const settingFixture = (body: LinuxFriendSettingUinResponseBody) =>
    Uint8Array.from(
        protobuf_encode<OidbBase<LinuxFriendSettingUinResponseBody>>({
            command: 0x7c1,
            subCommand: 1,
            body,
        }),
    );
const applicationFixture = (body: LinuxFriendAddResponseBody) =>
    Uint8Array.from(
        protobuf_encode<OidbBase<LinuxFriendAddResponseBody>>({
            command: 0x7c2,
            subCommand: 5,
            body,
        }),
    );
const applicationRaw = (body: Uint8Array) =>
    Uint8Array.from(protobuf_encode<OidbBase<bytes>>({ command: 0x7c2, subCommand: 5, body }));

describe('Linux native friend response projections', () => {
    it('reads independent query fields without replacing present zero or false', () => {
        const raw = Buffer.from(
            '08c10f1001180022171081808080081801220151280030004800708180808008',
            'hex',
        );
        const baseline = Buffer.from(raw);
        const result = decodeLinuxFriendSettingResponse(raw);
        expect(result).toEqual({
            kind: 'settings',
            peerUin: 0x8000_0001n,
            returnedUin: 0x8000_0001n,
            setting: 1,
            result: 0,
            errorCode: 0,
            isContactFriend: false,
            questions: ['Q'],
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(raw).toEqual(baseline);
    });
    it('reads independent application fields, retaining opaque verification bytes', () => {
        const raw = Buffer.from('08c20f100522121801200028003000380042004a0201026200', 'hex');
        const result = decodeLinuxFriendAddResponse(raw);
        expect(result).toEqual({
            kind: 'application',
            friendSetting: 1,
            myAllowFlag: 0,
            groupId: 0,
            result: 0,
            errorCode: 0,
            errorMessage: '',
            sig: Uint8Array.of(1, 2),
            verify: new Uint8Array(0),
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toHaveProperty('success');
        raw.fill(0);

        if (result.kind !== 'application') {
            throw new Error('expected projection');
        }

        expect(result.sig).toEqual(Uint8Array.of(1, 2));
        disposeLinuxFriendAddResponse(result);
        expect(result.sig).toEqual(Uint8Array.of(0, 0));
        expect(result.result).toBe(0);
        disposeLinuxFriendAddResponse(result);
    });
    it('does not infer a result or friendship from an empty body and outer zero', () => {
        const setting = decodeLinuxFriendSettingResponse(Buffer.from('08c10f100118002200', 'hex'));
        const add = decodeLinuxFriendAddResponse(Buffer.from('08c20f100518002200', 'hex'));
        expect(setting.kind).toBe('settings');
        expect(add.kind).toBe('application');

        if (setting.kind !== 'settings' || add.kind !== 'application') {
            throw new Error('expected projection');
        }

        expect(setting.result).toBeUndefined();
        expect(setting.setting).toBeUndefined();
        expect(setting.isContactFriend).toBeUndefined();
        expect(add.result).toBeUndefined();
        expect(add.sig).toBeUndefined();
        expect(add.verify).toBeUndefined();
    });
    it('returns an outer error without interpreting its unrelated opaque body', () => {
        const result = decodeLinuxFriendAddResponse(Buffer.from('08c20f100518052201ff', 'hex'));
        expect(result).toEqual({ kind: 'oidb-error', errorCode: 5, errorMessage: undefined });
        disposeLinuxFriendAddResponse(result);
    });
    it('requires a successful outer frame to contain its business body', () => {
        expect(() => decodeLinuxFriendAddResponse(Buffer.from('08c20f10051800', 'hex'))).toThrow(
            /body missing/,
        );
        expect(() =>
            decodeLinuxFriendSettingResponse(Buffer.from('08c10f10011800', 'hex')),
        ).toThrow(/body missing/);
    });
    it('checks present OIDB association fields before projecting business fields', () => {
        expect(() => decodeLinuxFriendSettingResponse(applicationFixture({ result: 0 }))).toThrow(
            /association/,
        );
        expect(() => decodeLinuxFriendAddResponse(settingFixture({ result: 0 }))).toThrow(
            /association/,
        );
        expect(() =>
            decodeLinuxFriendAddResponse(Buffer.from('08c20f100122023000', 'hex')),
        ).toThrow(/association/);
    });
    it('keeps elided envelope metadata separate from caller-owned SSO association', () => {
        const result = decodeLinuxFriendAddResponse(Buffer.from('22023000', 'hex'));
        expect(result.kind).toBe('application');

        if (result.kind !== 'application') {
            throw new Error('expected projection');
        }

        expect(result.result).toBe(0);
    });
    it('accepts canonical signed results and unsigned high-bit errors losslessly', () => {
        const result = decodeLinuxFriendAddResponse(
            applicationRaw(Buffer.from('30ffffffffffffffffff0138ffffffff0f', 'hex')),
        );

        if (result.kind !== 'application') {
            throw new Error('expected projection');
        }

        expect(result.result).toBe(-1);
        expect(result.errorCode).toBe(0xffff_ffff);
    });
    it('preserves question text including a leading BOM, without parsing a nested message', () => {
        const result = decodeLinuxFriendSettingResponse(
            settingFixture({
                setting: 3,
                result: 0,
                questions: [Buffer.from('\ufeffQuestion?', 'utf8'), Buffer.from('你是谁', 'utf8')],
            }),
        );

        if (result.kind !== 'settings') {
            throw new Error('expected projection');
        }

        expect(result.questions).toEqual(['\ufeffQuestion?', '你是谁']);
        expect(Object.isFrozen(result.questions)).toBe(true);
    });
    it('bounds question counts and text size and rejects invalid UTF-8', () => {
        expect(() =>
            decodeLinuxFriendSettingResponse(
                settingFixture({ questions: Array.from({ length: 17 }, () => Uint8Array.of(65)) }),
            ),
        ).toThrow(/too many/);
        expect(() =>
            decodeLinuxFriendSettingResponse(settingFixture({ questions: [new Uint8Array(4097)] })),
        ).toThrow(/text/);
        expect(() =>
            decodeLinuxFriendSettingResponse(settingFixture({ questions: [Uint8Array.of(255)] })),
        ).toThrow();
        expect(() =>
            decodeLinuxFriendAddResponse(applicationFixture({ errorMessage: Uint8Array.of(255) })),
        ).toThrow();
    });
    it('does not infer a real UID from a generically string-convertible identity field', () => {
        const result = decodeLinuxFriendAddResponse(
            applicationRaw(Buffer.from('1208755f3132333435363000', 'hex')),
        );
        expect(result.kind).toBe('application');
        expect(result).not.toHaveProperty('uid');
        expect(result).not.toHaveProperty('peerUid');
    });
    it('handles an offset view and leaves the whole borrowed frame unchanged', () => {
        const frame = Buffer.concat([
            Buffer.from([1, 2]),
            applicationFixture({ result: 0 }),
            Buffer.from([3, 4]),
        ]);
        const baseline = Buffer.from(frame);
        const result = decodeLinuxFriendAddResponse(frame.subarray(2, -2));
        expect(result.kind).toBe('application');
        expect(frame).toEqual(baseline);
    });
    it('rejects malformed protobuf and oversized frames without a success fallback', () => {
        for (const raw of [
            Uint8Array.of(0xff),
            Buffer.from('220230', 'hex'),
            Buffer.from('22010f', 'hex'),
            new Uint8Array(LINUX_FRIEND_MAX_RESPONSE_BYTES + 1),
        ]) {
            expect(() => decodeLinuxFriendAddResponse(raw)).toThrow();
        }
    });
    it('rejects hostile views without invoking metadata accessors', () => {
        const getter = vi.fn(() => 1);
        const hostile = Object.defineProperty(Uint8Array.of(0), 'buffer', { get: getter });
        expect(() => decodeLinuxFriendAddResponse(hostile)).toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(() =>
            decodeLinuxFriendAddResponse(new Uint8Array(new SharedArrayBuffer(1))),
        ).toThrow();
        expect(() =>
            decodeLinuxFriendAddResponse(new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 }))),
        ).toThrow();
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        expect(() => decodeLinuxFriendAddResponse(detached)).toThrow();
    });
    it('clears the borrowed-frame copy and partial opaque copies after a later failure', () => {
        const raw = applicationFixture({
            result: 0,
            sig: Uint8Array.of(7, 8),
            verify: new Uint8Array(16385),
        });
        const baseline = Uint8Array.from(raw);
        const original = Uint8Array.from;
        const snapshots: Uint8Array[] = [];
        vi.spyOn(Uint8Array, 'from').mockImplementation(function (
            this: Uint8ArrayConstructor,
            ...args
        ) {
            const copy = Reflect.apply(original, this, args) as ReturnType<typeof original>;
            snapshots.push(copy);
            return copy;
        });
        expect(() => decodeLinuxFriendAddResponse(raw)).toThrow(/bytes/);
        expect(snapshots).toHaveLength(2);
        expect(snapshots.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
        expect(raw).toEqual(baseline);
    });
});
