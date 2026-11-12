import { describe, expect, it } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { encodeTargetServiceBusiness } from '../../src/direct/target-service-business';
import {
    encodeTargetServiceRequest,
    type TargetBasicBranch,
    type TargetServiceRequest,
    type TargetSourceCommand,
} from '../../src/direct/target-service-request';
import { encodeTargetSso12Head, type TargetSso12Head } from '../../src/direct/target-sso12-head';
import {
    encodeTargetSso12Reserve,
    type TargetSso12ReserveInput,
} from '../../src/direct/target-sso12-reserve';

// Public, synthetic fixtures only; the test key is fictional. These are not
// captures and do not establish target runtime or server interoperability.
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const body = Uint8Array.of(0x01, 0xff, 0x00, 0x72, 0x90);
const fixedRandom = (length: number): Uint8Array => new Uint8Array(length).fill(0x51);

function headInput(arg8 = 0x7f): TargetSso12Head {
    return {
        sequence: 0x01020304,
        arg0: 0xa1a2a3a4,
        arg4: 0x11223344,
        arg8,
        a2: Uint8Array.of(0xaa, 0xbb),
        requestCommand: Uint8Array.of(0x00, 0xff, 0x41),
        this8: Uint8Array.of(0x80),
        arg28: new Uint8Array(),
        this20: Uint8Array.of(0x11, 0x22),
        versionArg10: Uint8Array.of(0, 1),
        reserved: Uint8Array.of(0xde, 0xad, 0xbe),
    };
}

function request(
    head: Uint8Array,
    sourceCommand: TargetSourceCommand,
    basicBranch: TargetBasicBranch,
): TargetServiceRequest {
    return {
        sourceCommand,
        basicBranch,
        virtualProtocol: 0x01020304,
        requestObjectByte: 0x7f,
        uin: '42é',
        head,
        busi: body.slice(),
        targetTeaKey: key.slice(),
        randomSource: fixedRandom,
    };
}

function parseFrame(frame: Uint8Array, branch: TargetBasicBranch) {
    const bytes = Buffer.from(frame);
    const spanLength = branch.kind === 'span' ? branch.span.length : 0;
    const objectOffset = 13 + spanLength;
    const uinLength = bytes.readUInt32BE(objectOffset + 1);
    const ciphertextOffset = objectOffset + 1 + uinLength;
    return { bytes, objectOffset, uinLength, ciphertextOffset };
}

const commands: TargetSourceCommand[] = ['wtlogin64.trans_emp', 'wtlogin64.login'];
const branches: TargetBasicBranch[] = [
    { virtualResultByte: 0xff, kind: 'value', value: 0x11223344 },
    { virtualResultByte: 0, kind: 'span', span: Uint8Array.of(0xaa, 0xbb, 0xcc) },
];

describe('synthetic target SSO12 head and service request integration', () => {
    it.each(commands.flatMap((command) => branches.map((branch) => [command, branch] as const)))(
        'encodes %s with the %s branch and preserves the inclusive head',
        (command, branch) => {
            const head = encodeTargetSso12Head(headInput());
            const input = request(head, command, branch);
            const frame = encodeTargetServiceRequest(input);
            const { bytes, objectOffset, uinLength, ciphertextOffset } = parseFrame(frame, branch);
            const uinBytes = Buffer.from(input.uin, 'utf8');
            const plaintext = Buffer.from(qqTeaDecrypt(frame.subarray(ciphertextOffset), key));
            const headLength = plaintext.readUInt32BE(0);

            expect(bytes.readUInt32BE(0)).toBe(bytes.length);
            expect(bytes.readUInt32BE(4)).toBe(input.virtualProtocol);
            expect(bytes[8]).toBe(2);
            expect(bytes.readUInt32BE(9)).toBe(
                branch.kind === 'value' ? branch.value : branch.span.length + 4,
            );

            if (branch.kind === 'span') {
                expect(bytes.subarray(13, objectOffset)).toEqual(Buffer.from(branch.span));
            }

            expect(bytes[objectOffset]).toBe(input.requestObjectByte);
            expect(uinLength).toBe(uinBytes.length + 4);
            expect(bytes.subarray(objectOffset + 5, ciphertextOffset)).toEqual(uinBytes);
            expect(ciphertextOffset).toBe(
                18 + (branch.kind === 'span' ? branch.span.length : 0) + uinBytes.length,
            );
            expect(bytes.length - ciphertextOffset).toBe(
                Math.ceil((head.length + body.length + 10) / 8) * 8,
            );
            expect(headLength).toBe(head.length);
            expect(plaintext.subarray(0, headLength)).toEqual(Buffer.from(head));
            expect(plaintext.subarray(headLength)).toEqual(Buffer.from(body));
            expect(plaintext.length).toBe(headLength + body.length);
            // Target-static offsets are relative to the decrypted head, not the outer frame.
            expect(plaintext[0x10]).toBe(0);
            expect(plaintext[0x1a]).toBe(0x7f);
        },
    );

    it.each([0, 1, 0x80, 0xff])('keeps the dynamic head byte %# as %i', (arg8) => {
        const head = encodeTargetSso12Head(headInput(arg8));
        const branch = branches[0];
        const frame = encodeTargetServiceRequest(request(head, commands[0], branch));
        const { ciphertextOffset } = parseFrame(frame, branch);
        const plaintext = qqTeaDecrypt(frame.subarray(ciphertextOffset), key);
        expect(plaintext[0x10]).toBe(0);
        expect(plaintext[0x1a]).toBe(arg8);
        expect(Buffer.from(plaintext.subarray(0, head.length))).toEqual(Buffer.from(head));
    });

    it.each([
        {
            name: 'presence, explicit empty and zero',
            fields: {
                field12: Uint8Array.of(0xaa, 0xbb),
                field13: new Uint8Array(),
                field21Enabled: true,
                field24: {
                    field1: Uint8Array.of(0x11),
                    field2: Uint8Array.of(0, 0xff),
                    field3: new Uint8Array(),
                },
                field26: 0,
            } satisfies TargetSso12ReserveInput,
            expected: '6202aabb6a00a80120c201070a0111120200ffd00100',
        },
        {
            name: 'field12 alone does not activate serialization',
            fields: { field12: Uint8Array.of(0xaa, 0xbb) } satisfies TargetSso12ReserveInput,
            expected: '',
        },
    ])(
        'uses the Proton reserve encoder inside the encrypted head: $name',
        ({ fields, expected }) => {
            // Static synthetic fixture only: neither target execution nor interoperability evidence.
            const reserved = encodeTargetSso12Reserve(fields);
            const expectedReserve = Buffer.from(expected, 'hex');
            expect(Buffer.from(reserved)).toEqual(expectedReserve);
            const head = encodeTargetSso12Head({ ...headInput(), reserved });
            const branch = branches[1];
            const input = request(head, commands[1], branch);
            const frame = encodeTargetServiceRequest(input);
            const { bytes, ciphertextOffset } = parseFrame(frame, branch);
            expect(bytes.readUInt32BE(0)).toBe(bytes.length);
            expect(bytes[8]).toBe(2);
            const plain = Buffer.from(qqTeaDecrypt(frame.subarray(ciphertextOffset), key));
            const headLength = plain.readUInt32BE(0);
            expect(headLength).toBe(head.length);
            expect(plain.subarray(0, headLength)).toEqual(Buffer.from(head));
            expect(plain.subarray(headLength)).toEqual(Buffer.from(body));

            // Parse the five inclusive u32 fields and inclusive u16 version field.
            let offset = 28;

            for (let i = 0; i < 5; i++) {
                const length = plain.readUInt32BE(offset);
                expect(length).toBeGreaterThanOrEqual(4);
                offset += length;
            }

            const versionLength = plain.readUInt16BE(offset);
            expect(versionLength).toBe(2 + headInput().versionArg10.length);
            offset += versionLength;
            const reserveLength = plain.readUInt32BE(offset);
            expect(reserveLength).toBe(4 + expectedReserve.length);
            expect(offset + reserveLength).toBe(headLength);
            expect(plain.subarray(offset + 4, offset + reserveLength)).toEqual(expectedReserve);

            if (expectedReserve.length === 0) {
                expect(plain.subarray(offset, offset + 4).toString('hex')).toBe('00000004');
            }
        },
    );

    it('preserves an empty-field reserve and length-framed nonempty business through encryption', () => {
        const reserved = encodeTargetSso12Reserve({
            field13: new Uint8Array(),
            field23: [{ field1: new Uint8Array(), field2: new Uint8Array() }],
        });
        const expectedReserve = Buffer.from('6a00ba01040a001200', 'hex');
        expect(Buffer.from(reserved)).toEqual(expectedReserve);

        const head = encodeTargetSso12Head({ ...headInput(), reserved });
        const business = encodeTargetServiceBusiness(body);
        const branch = branches[1];
        const frame = encodeTargetServiceRequest({
            ...request(head, commands[1], branch),
            busi: business,
        });
        const { ciphertextOffset } = parseFrame(frame, branch);
        const plain = Buffer.from(qqTeaDecrypt(frame.subarray(ciphertextOffset), key));
        const headLength = plain.readUInt32BE(0);
        const businessLength = plain.readUInt32BE(headLength);

        expect(headLength).toBe(head.length);
        expect(plain.subarray(0, headLength)).toEqual(Buffer.from(head));
        expect(plain.readUInt32BE(headLength - expectedReserve.length - 4)).toBe(
            expectedReserve.length + 4,
        );
        expect(plain.subarray(headLength - expectedReserve.length, headLength)).toEqual(
            expectedReserve,
        );
        expect(businessLength).toBe(body.length + 4);
        expect(businessLength).toBe(business.length);
        expect(plain.subarray(headLength, headLength + businessLength)).toEqual(
            Buffer.from(business),
        );
        expect(plain.subarray(headLength + 4)).toEqual(Buffer.from(body));
        expect(plain.length).toBe(headLength + businessLength);
    });

    it('snapshots the encoded head, branch, business bytes and key before the callback', () => {
        const fields = headInput();
        const head = encodeTargetSso12Head(fields);
        const savedHead = head.slice();
        const savedBody = body.slice();
        const branch: TargetBasicBranch = {
            virtualResultByte: 0,
            kind: 'span',
            span: Uint8Array.of(4, 5),
        };
        const input = request(head, commands[1], branch);
        const baseline = encodeTargetServiceRequest(input);

        input.randomSource = (length) => {
            fields.a2.fill(0);
            fields.arg8 = 0;
            head.fill(0);
            input.busi.fill(0);
            input.targetTeaKey.fill(0);
            branch.span.fill(0);
            input.uin = 'changed';
            input.requestObjectByte = 0;
            return fixedRandom(length);
        };

        const frame = encodeTargetServiceRequest(input);
        expect(frame).toEqual(baseline);
        // The offset is fixed from the pre-callback span and UTF-8 bytes.
        const decrypted = qqTeaDecrypt(frame.subarray(18 + 2 + Buffer.byteLength('42é')), key);
        expect(Buffer.from(decrypted)).toEqual(Buffer.concat([savedHead, savedBody]));
        expect(key).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i));
    });

    it('surfaces invalid head and service inputs without invoking encryption', () => {
        expect(() => encodeTargetSso12Head({ ...headInput(), arg8: 256 })).toThrow();
        const head = encodeTargetSso12Head(headInput());
        const good = request(head, commands[0], branches[0]);
        let calls = 0;

        const randomSource = (length: number) => {
            calls++;
            return fixedRandom(length);
        };

        for (const invalid of [
            { ...good, sourceCommand: 'other' as TargetSourceCommand },
            { ...good, targetTeaKey: new Uint8Array(15) },
            { ...good, head: undefined as unknown as Uint8Array },
            { ...good, busi: undefined as unknown as Uint8Array },
            {
                ...good,
                basicBranch: { virtualResultByte: 0, kind: 'value', value: 1 } as TargetBasicBranch,
            },
        ]) {
            expect(() => encodeTargetServiceRequest({ ...invalid, randomSource })).toThrow();
        }

        expect(calls).toBe(0);
        expect(Buffer.from(head)).toEqual(Buffer.from(encodeTargetSso12Head(headInput())));
    });
});
