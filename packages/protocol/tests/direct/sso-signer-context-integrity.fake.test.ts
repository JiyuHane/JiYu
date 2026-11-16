import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_decode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { createSsoReserveBuilder, type SsoSigningRequest } from '../../src/direct/sso-reserve';
import {
    referenceRegisterOnTransport,
    type SsoReferenceRegisterBorrowedOptions,
} from '../../src/direct/sso-reference-register-flow';
import {
    referenceSendTextOnTransport,
    type SsoReferenceSendTextOptions,
} from '../../src/direct/sso-reference-send-text-flow';
import type { Sso12RawOptions, Sso12RawTransport } from '../../src/direct/sso12-packet-client';

// In-memory fake transport and synthetic data only. A successful local check says
// nothing about signature authenticity, a peer, or actual message delivery.
const sequence = 0xf0000001;
const identity = { uin: '123', sequence };
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
type ReferenceRequest = Parameters<SsoReferenceRegisterBorrowedOptions['buildReserved']>[0];
type ContextField = keyof ReferenceRequest;
type Mutation = 'write' | 'delete' | 'accessor';

function mutate(
    request: SsoSigningRequest | ReferenceRequest,
    field: ContextField,
    mode: Mutation,
) {
    const object = request as unknown as Record<string, unknown>;
    const original = object[field];

    if (mode === 'delete') {
        delete object[field];
    } else if (mode === 'accessor') {
        // Even a getter returning exactly the old value is not an own data property.
        Object.defineProperty(object, field, { configurable: true, get: () => original });
    } else {
        const replacement =
            field === 'body'
                ? Uint8Array.from(original as Uint8Array)
                : field === 'sequence'
                  ? sequence - 1
                  : 'different-synthetic-value';
        object[field] = replacement;
    }
}

function reserveRequest(): SsoSigningRequest {
    return { uin: '123', command: 'synthetic.command', sequence, body: Uint8Array.of(1, 2, 3) };
}

function reserveBuilder(
    sign: (request: SsoSigningRequest) => Promise<{
        sign: Uint8Array;
        token: Uint8Array;
        extra: Uint8Array;
    }>,
) {
    return createSsoReserveBuilder({
        uin: '123',
        classifySigning: () => 'sign',
        createTraceParent: () => 'trace',
        sign,
    });
}

const signature = () => ({
    sign: Uint8Array.of(9),
    token: Uint8Array.of(8),
    extra: Uint8Array.of(7),
});

function shared() {
    return {
        login: {
            status: 'tickets' as const,
            uin: '123',
            tickets: {
                d2: Uint8Array.of(3, 4),
                d2Key: Uint8Array.from(key),
                a1: Uint8Array.of(5),
                a2: Uint8Array.of(6, 7),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
        timeoutMs: 5000,
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

function registerOptions(): SsoReferenceRegisterBorrowedOptions {
    return {
        ...shared(),
        registration: {
            uid: 'fixture-uid',
            version: 'build-v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
    };
}

function sendOptions(): SsoReferenceSendTextOptions {
    return {
        ...shared(),
        uid: 'fixture-uid',
        request: {
            route: { kind: 'private', peerUin: 456n, peerUid: 'fixture-peer' },
            text: 'synthetic text',
            clientSequence: 9007199254740993n,
            random: 0x12345678,
        },
        maxResponseBodyBytes: 65536,
    };
}

function fixture() {
    const writes: Uint8Array[] = [];
    let calls = 0;
    const transport: Sso12RawTransport = {
        async transactRaw<C, T>(raw: Sso12RawOptions<C, T>) {
            calls++;

            try {
                const request = await raw.buildRequest(identity);
                // This is a fake write boundary; no transport or socket is opened.
                writes.push(Uint8Array.from(request.frame));
                return {
                    kind: 'failure' as const,
                    code: 'fixture-unexpected-build',
                    writeState: 'written' as const,
                };
            } catch {
                return {
                    kind: 'failure' as const,
                    code: 'fixture-build-failed',
                    writeState: 'not-written' as const,
                };
            }
        },
    };
    return {
        transport,
        writes,
        get calls() {
            return calls;
        },
    };
}

type Kind = 'register' | 'send';

async function runReference(
    kind: Kind,
    transport: Sso12RawTransport,
    options: SsoReferenceRegisterBorrowedOptions | SsoReferenceSendTextOptions,
) {
    return kind === 'register'
        ? referenceRegisterOnTransport(transport, options as SsoReferenceRegisterBorrowedOptions)
        : referenceSendTextOnTransport(transport, options as SsoReferenceSendTextOptions);
}

function inputs(options: SsoReferenceRegisterBorrowedOptions | SsoReferenceSendTextOptions) {
    return 'registration' in options
        ? { login: options.login, profile: options.profile, registration: options.registration }
        : {
              login: options.login,
              profile: options.profile,
              uid: options.uid,
              request: options.request,
          };
}

const reserveCases = (['uin', 'command', 'sequence', 'body'] as const).flatMap((field) =>
    (['write', 'delete', 'accessor'] as const).map((mode) => ({ field, mode })),
);
const referenceCases = (['register', 'send'] as const).flatMap((kind) =>
    (['uin', 'uid', 'command', 'sequence', 'body'] as const).flatMap((field) =>
        (['write', 'delete', 'accessor'] as const).map((mode) => ({ kind, field, mode })),
    ),
);

describe('synthetic signer context integrity', () => {
    it.each(reserveCases)(
        'rejects reserve $field $mode at Promise completion',
        async ({ field, mode }) => {
            const input = reserveRequest();
            const before = structuredClone(input);
            let returned = false;
            const sign = vi.fn(async (request: SsoSigningRequest) => {
                await Promise.resolve();
                mutate(request, field, mode);
                returned = true;
                return signature();
            });
            await expect(reserveBuilder(sign)(input)).rejects.toThrow();
            expect(returned).toBe(true);
            expect(sign).toHaveBeenCalledOnce();
            expect(input).toEqual(before);
        },
    );

    it.each(['uin', 'command', 'sequence', 'body'] as const)(
        'rejects reserve %s changed by the signature extra getter',
        async (field) => {
            const input = reserveRequest();
            const before = structuredClone(input);
            let getterCalled = false;
            const sign = vi.fn(async (request: SsoSigningRequest) => ({
                sign: Uint8Array.of(9),
                token: Uint8Array.of(8),
                get extra() {
                    getterCalled = true;
                    mutate(request, field, 'write');
                    return Uint8Array.of(7);
                },
            }));
            await expect(reserveBuilder(sign)(input)).rejects.toThrow();
            expect(sign).toHaveBeenCalledOnce();
            expect(getterCalled).toBe(true);
            expect(input).toEqual(before);
        },
    );

    it('accepts changes restored before the check without claiming what was signed', async () => {
        const input = reserveRequest();
        const before = structuredClone(input);
        const sign = vi.fn(async (request: SsoSigningRequest) => {
            const originalUin = request.uin;
            const originalBody = request.body;
            request.uin = '456';
            request.body = Uint8Array.from(originalBody);
            originalBody[0] ^= 0xff;
            await Promise.resolve();
            originalBody[0] ^= 0xff;
            request.body = originalBody;
            request.uin = originalUin;
            return signature();
        });
        const result = protobuf_decode<DirectSsoReserve>(await reserveBuilder(sign)(input));
        expect(result.secureInfo).toMatchObject(signature());
        expect(sign).toHaveBeenCalledOnce();
        expect(input).toEqual(before);
    });

    it.each(referenceCases)(
        'rejects $kind callback $field $mode before the fake write',
        async ({ kind, field, mode }) => {
            const options = kind === 'register' ? registerOptions() : sendOptions();
            const before = structuredClone(inputs(options));
            let returned = false;
            const sign = vi.fn(async (request: ReferenceRequest) => {
                await Promise.resolve();
                mutate(request, field, mode);
                returned = true;
                return Uint8Array.of(8, 9);
            });
            options.buildReserved = sign;
            const fake = fixture();
            const result = await runReference(kind, fake.transport, options);
            expect(returned).toBe(true);
            expect(sign).toHaveBeenCalledOnce();
            expect(result).toMatchObject({ kind: 'failure' });
            expect(fake.calls).toBe(1);
            expect(fake.writes).toHaveLength(0);
            expect(inputs(options)).toEqual(before);
        },
    );

    it.each([
        { kind: 'register', method: 'compare' },
        { kind: 'register', method: 'equals' },
        { kind: 'send', method: 'compare' },
        { kind: 'send', method: 'equals' },
    ] as const)(
        'rejects lasting $kind body mutation with Buffer.$method replaced',
        async ({ kind, method }) => {
            const options = kind === 'register' ? registerOptions() : sendOptions();
            const before = structuredClone(inputs(options));
            const originalCompare = Buffer.compare;
            const originalEquals = Buffer.prototype.equals;
            let returned = false;
            const sign = vi.fn(async (request: ReferenceRequest) => {
                if (method === 'compare') {
                    Buffer.compare = () => 0;
                } else {
                    Buffer.prototype.equals = () => true;
                }

                request.body[0] ^= 0xff;
                returned = true;
                return Uint8Array.of(8, 9);
            });
            options.buildReserved = sign;
            const fake = fixture();
            let result: Awaited<ReturnType<typeof runReference>>;

            try {
                result = await runReference(kind, fake.transport, options);
            } finally {
                // Restore synchronously, even when the transaction throws.
                Buffer.compare = originalCompare;
                Buffer.prototype.equals = originalEquals;
            }

            expect(returned).toBe(true);
            expect(sign).toHaveBeenCalledOnce();
            expect(result).toMatchObject({ kind: 'failure' });
            expect(fake.calls).toBe(1);
            expect(fake.writes).toHaveLength(0);
            expect(inputs(options)).toEqual(before);
        },
    );
});
