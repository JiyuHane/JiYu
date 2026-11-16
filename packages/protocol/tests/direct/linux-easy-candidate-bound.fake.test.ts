import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    createLinuxEasyKeyCapability,
    decodeLinuxEasyServiceResponse,
    linuxEasyKeyState,
    revokeLinuxEasyKey,
    stageLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeSsoResponse, MAX_SSO_BYTES } from '../../src/direct/sso';

// Synthetic bytes only; the frame is constructed locally without a transport.
const UIN = '123456';
const SEQUENCE = 12345;
const COMMAND = 'Synthetic.Candidate';
const KEY = Uint8Array.from({ length: 16 }, (_, index) => index + 0x20);
const BOUND = 65536;
const CAP_ERROR = 'invalid Linux EasyLogin key capability';

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

function field(value: Uint8Array): Buffer {
    return Buffer.concat([word(value.length + 4), value]);
}

function ssoResponse(body: Uint8Array, flag: 0 | 1 | 4): Uint8Array {
    const header = Buffer.concat([
        word(SEQUENCE),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(COMMAND)),
        field(Buffer.alloc(0)),
        word(flag),
        field(Buffer.alloc(0)),
    ]);
    const encoded = flag === 1 ? deflateSync(body) : body;
    return Uint8Array.from(Buffer.concat([field(header), field(encoded)]));
}

function serviceFrame(inner: Uint8Array): Uint8Array {
    const encrypted = qqTeaEncrypt(inner, KEY, (length) => new Uint8Array(length).fill(0x35));
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from(UIN, 'ascii')),
        encrypted,
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function fixture() {
    const lease = {};
    const token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} });
    const key = Uint8Array.from(KEY);

    try {
        stageLinuxEasyKey({ token, lease, uin: UIN, sequence: SEQUENCE, key });
    } finally {
        key.fill(0);
    }

    return { token, lease, uin: UIN };
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
    const actualView = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
    const expectedView = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
    expect(actualView.equals(expectedView)).toBe(true);
}

function expectAndWipe(actual: Uint8Array, expected: Uint8Array): void {
    try {
        expectBytes(actual, expected);
    } finally {
        actual.fill(0);
    }
}

function expectSsoAndWipe(
    result: ReturnType<typeof decodeSsoResponse>,
    expected: Uint8Array,
): void {
    try {
        expectBytes(result.body, expected);
    } finally {
        result.body.fill(0);
        result.cookie.fill(0);
        result.reserved.fill(0);
        result.headerExtension.fill(0);
    }
}

function thrown(operation: () => unknown): unknown {
    try {
        operation();
    } catch (error) {
        return error;
    }

    throw new Error('expected operation to throw');
}

function restore(name: string, descriptor: PropertyDescriptor | undefined): void {
    delete (Object.prototype as Record<string, unknown>)[name];

    if (descriptor) {
        Object.defineProperty(Object.prototype, name, descriptor);
    }
}

describe('synthetic Linux Easy candidate SSO body limits', () => {
    it.each([0, 4] as const)(
        'accepts the exact uncompressed bound and rejects bound plus one (flag %i)',
        (flag) => {
            const exact = new Uint8Array(BOUND).fill(0x41);
            const over = new Uint8Array(BOUND + 1).fill(0x42);
            const inner = ssoResponse(exact, flag);
            const tooLarge = ssoResponse(over, flag);
            const frame = serviceFrame(inner);
            const largeFrame = serviceFrame(tooLarge);
            const f = fixture();

            try {
                expectSsoAndWipe(decodeSsoResponse(inner, BOUND), exact);
                expect(() => decodeSsoResponse(tooLarge, BOUND)).toThrow();
                const decoded = decodeLinuxEasyServiceResponse({
                    ...f,
                    frame,
                    maxSsoBodyBytes: BOUND,
                });

                try {
                    expect(decoded).toMatchObject({
                        sequence: SEQUENCE,
                        command: COMMAND,
                        retCode: 0,
                    });
                    expectBytes(decoded.body, inner);
                } finally {
                    decoded.body.fill(0);
                }

                expect(() =>
                    decodeLinuxEasyServiceResponse({
                        ...f,
                        frame: largeFrame,
                        maxSsoBodyBytes: BOUND,
                    }),
                ).toThrow(CAP_ERROR);
                expect(linuxEasyKeyState(f.token)).toBe('tentative');
            } finally {
                revokeLinuxEasyKey(f.token);
            }
        },
    );

    it('bounds genuine zlib output rather than the much smaller encrypted frame', () => {
        const exact = new Uint8Array(BOUND).fill(0x61);
        const over = new Uint8Array(BOUND + 1).fill(0x62);
        const inner = ssoResponse(exact, 1);
        const tooLarge = ssoResponse(over, 1);
        const frame = serviceFrame(inner);
        const largeFrame = serviceFrame(tooLarge);
        const f = fixture();

        try {
            expect(frame.length).toBeLessThan(BOUND / 10);
            expect(largeFrame.length).toBeLessThan(BOUND / 10);
            expectSsoAndWipe(decodeSsoResponse(inner, BOUND), exact);
            expect(() => decodeSsoResponse(tooLarge, BOUND)).toThrow();
            expectAndWipe(
                decodeLinuxEasyServiceResponse({ ...f, frame, maxSsoBodyBytes: BOUND }).body,
                inner,
            );
            expect(() =>
                decodeLinuxEasyServiceResponse({ ...f, frame: largeFrame, maxSsoBodyBytes: BOUND }),
            ).toThrow(CAP_ERROR);
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
        } finally {
            revokeLinuxEasyKey(f.token);
        }
    });

    it('keeps omitted and explicitly undefined limits at the legacy default', () => {
        const body = new Uint8Array(BOUND + 1).fill(0x73);
        const f = fixture();

        try {
            for (const flag of [0, 1, 4] as const) {
                const inner = ssoResponse(body, flag);
                const frame = serviceFrame(inner);
                expectSsoAndWipe(decodeSsoResponse(inner), body);
                expectSsoAndWipe(decodeSsoResponse(inner, undefined), body);
                expectSsoAndWipe(decodeSsoResponse(inner, MAX_SSO_BYTES), body);
                expectAndWipe(decodeLinuxEasyServiceResponse({ ...f, frame }).body, inner);
                expectAndWipe(
                    decodeLinuxEasyServiceResponse({
                        ...f,
                        frame,
                        maxSsoBodyBytes: undefined,
                    } as Parameters<typeof decodeLinuxEasyServiceResponse>[0]).body,
                    inner,
                );
            }
        } finally {
            revokeLinuxEasyKey(f.token);
        }
    });

    it('rejects invalid limits before reading SSO bytes and without invoking bound proxies', () => {
        let byteReads = 0;
        let boundTraps = 0;
        const bytes = new Proxy(new Uint8Array(), {
            get() {
                byteReads++;
                throw new Error('bytes accessed');
            },
        });
        const proxyBound = new Proxy(
            {},
            {
                get() {
                    boundTraps++;
                    throw new Error('bound accessed');
                },
            },
        );
        const invalid: unknown[] = [
            0,
            -1,
            1.5,
            NaN,
            Infinity,
            -Infinity,
            MAX_SSO_BYTES + 1,
            null,
            '5',
            1n,
            proxyBound,
        ];
        const errors: unknown[] = [];

        for (const bound of invalid) {
            errors.push(thrown(() => decodeSsoResponse(bytes, bound as number)));
        }

        expect(byteReads).toBe(0);
        expect(boundTraps).toBe(0);
        expect(errors.every((error) => error instanceof Error)).toBe(true);
        expect(new Set(errors.map((error) => (error as Error).message)).size).toBe(1);
    });

    it('rejects invalid capability limits with a fixed error, without changing the slot', () => {
        const f = fixture();
        const frame = serviceFrame(ssoResponse(Uint8Array.of(1), 0));
        const before = Uint8Array.from(frame);
        let boundTraps = 0;
        const proxyBound = new Proxy(
            {},
            {
                get() {
                    boundTraps++;
                    throw new Error('bound accessed');
                },
            },
        );

        try {
            for (const bound of [
                0,
                -1,
                1.5,
                NaN,
                Infinity,
                -Infinity,
                MAX_SSO_BYTES + 1,
                null,
                '5',
                1n,
                proxyBound,
            ]) {
                const input = { ...f, frame, maxSsoBodyBytes: bound };
                expect(() =>
                    decodeLinuxEasyServiceResponse(
                        input as Parameters<typeof decodeLinuxEasyServiceResponse>[0],
                    ),
                ).toThrow(CAP_ERROR);
                expect(linuxEasyKeyState(f.token)).toBe('tentative');
            }

            expect(boundTraps).toBe(0);
            expect(frame).toEqual(before);
            expectAndWipe(
                decodeLinuxEasyServiceResponse({ ...f, frame, maxSsoBodyBytes: 1 }).body,
                ssoResponse(Uint8Array.of(1), 0),
            );
        } finally {
            revokeLinuxEasyKey(f.token);
        }
    });

    it('keeps input and output bytes caller-owned on success and rejection', () => {
        const body = new Uint8Array(BOUND + 1).fill(0x6a);
        const f = fixture();

        try {
            for (const flag of [0, 1, 4] as const) {
                const inner = ssoResponse(body, flag);
                const beforeInner = Uint8Array.from(inner);
                const frame = serviceFrame(inner);
                const beforeFrame = Uint8Array.from(frame);
                const decoded = decodeSsoResponse(inner, body.length);
                expectSsoAndWipe(decoded, body);
                expect(inner).toEqual(beforeInner);
                expectSsoAndWipe(decodeSsoResponse(inner, body.length), body);
                expect(() => decodeSsoResponse(inner, BOUND)).toThrow();
                expect(inner).toEqual(beforeInner);
                const outer = decodeLinuxEasyServiceResponse({
                    ...f,
                    frame,
                    maxSsoBodyBytes: body.length,
                });

                try {
                    expect(frame).toEqual(beforeFrame);
                    expectBytes(outer.body, inner);
                } finally {
                    outer.body.fill(0);
                }

                expect(frame).toEqual(beforeFrame);
                expectAndWipe(
                    decodeLinuxEasyServiceResponse({ ...f, frame, maxSsoBodyBytes: body.length })
                        .body,
                    inner,
                );
                expect(() =>
                    decodeLinuxEasyServiceResponse({ ...f, frame, maxSsoBodyBytes: BOUND }),
                ).toThrow(CAP_ERROR);
                expect(frame).toEqual(beforeFrame);
            }
        } finally {
            revokeLinuxEasyKey(f.token);
        }
    });

    it('rejects an accessor or proxy options without invoking their traps', () => {
        const f = fixture();
        const frame = serviceFrame(ssoResponse(Uint8Array.of(1), 0));
        const input = { ...f, frame };
        let reads = 0;
        let traps = 0;
        const accessor = Object.create(null) as PropertyDescriptor;
        accessor.configurable = true;

        accessor.get = () => {
            reads++;
            return 1;
        };

        Object.defineProperty(input, 'maxSsoBodyBytes', accessor);
        const proxy = new Proxy(
            { ...f, frame, maxSsoBodyBytes: 1 },
            {
                get() {
                    traps++;
                    throw new Error('options accessed');
                },
                getOwnPropertyDescriptor() {
                    traps++;
                    throw new Error('options descriptor accessed');
                },
            },
        );

        try {
            expect(() => decodeLinuxEasyServiceResponse(input)).toThrow(CAP_ERROR);
            expect(() => decodeLinuxEasyServiceResponse(proxy)).toThrow(CAP_ERROR);
            expect(reads).toBe(0);
            expect(traps).toBe(0);
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
        } finally {
            revokeLinuxEasyKey(f.token);
        }
    });

    it('ignores inherited cap getters and rejects an own accessor despite polluted descriptor value', () => {
        const f = fixture();
        const frame = serviceFrame(ssoResponse(Uint8Array.of(1, 2), 0));
        const defaultInput = { ...f, frame };
        const badInput = { ...f, frame };
        const descriptor = Object.create(null) as PropertyDescriptor;
        let ownReads = 0;
        let inheritedReads = 0;
        descriptor.configurable = true;

        descriptor.get = () => {
            ownReads++;
            return 1;
        };

        Object.defineProperty(badInput, 'maxSsoBodyBytes', descriptor);
        const oldCap = Object.getOwnPropertyDescriptor(Object.prototype, 'maxSsoBodyBytes');
        const oldValue = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
        let validResult: ReturnType<typeof decodeLinuxEasyServiceResponse> | undefined;
        let badError: unknown;

        try {
            const pollutedCap = Object.create(null) as PropertyDescriptor;
            pollutedCap.configurable = true;

            pollutedCap.get = () => {
                inheritedReads++;
                return 1;
            };

            Object.defineProperty(Object.prototype, 'maxSsoBodyBytes', pollutedCap);
            const pollutedValue = Object.create(null) as PropertyDescriptor;
            pollutedValue.configurable = true;
            pollutedValue.writable = true;
            pollutedValue.value = 1;
            Object.defineProperty(Object.prototype, 'value', pollutedValue);
            validResult = decodeLinuxEasyServiceResponse(defaultInput);
            badError = thrown(() => decodeLinuxEasyServiceResponse(badInput));
        } finally {
            restore('value', oldValue);
            restore('maxSsoBodyBytes', oldCap);
            revokeLinuxEasyKey(f.token);
        }

        expect(validResult).toBeDefined();

        if (validResult) {
            expectAndWipe(validResult.body, ssoResponse(Uint8Array.of(1, 2), 0));
        }

        expect(badError).toBeInstanceOf(Error);
        expect((badError as Error).message).toBe(CAP_ERROR);
        expect(ownReads).toBe(0);
        expect(inheritedReads).toBe(0);
    });
});
