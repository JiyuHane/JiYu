import { describe, expect, it, vi } from 'vitest';
import { encodeLinuxNTEasyLoginReferenceRequest } from '../../src/direct/nt-linux-easy-login-reference';
import { encodeLinuxNTLoginReferenceRequest } from '../../src/direct/nt-linux-login-reference';
import { referenceLinuxEasyLoginOnTransport } from '../../src/direct/sso-reference-linux-easy-login-flow';
import type { Sso12RawTransport } from '../../src/direct/sso12-packet-client';

vi.mock('../../src/direct/nt-linux-easy-login-reference', async (importOriginal) => {
    const original =
        await importOriginal<typeof import('../../src/direct/nt-linux-easy-login-reference')>();
    return {
        ...original,
        encodeLinuxNTEasyLoginReferenceRequest: vi.fn(
            original.encodeLinuxNTEasyLoginReferenceRequest,
        ),
    };
});

vi.mock('../../src/direct/nt-linux-login-reference', async (importOriginal) => {
    const original =
        await importOriginal<typeof import('../../src/direct/nt-linux-login-reference')>();
    return {
        ...original,
        encodeLinuxNTLoginReferenceRequest: vi.fn(original.encodeLinuxNTLoginReferenceRequest),
    };
});

describe('Linux EasyLogin pre-abort with a synthetic transport', () => {
    it('returns cancellation before either encoder, signer, or transport is called', async () => {
        const controller = new AbortController();
        controller.abort();
        const signer = vi.fn(() => Uint8Array.of(3));
        const verifier = vi.fn(() => true);
        const transactRaw = vi.fn((): Promise<never> => {
            throw new Error('unexpected synthetic transport call');
        });
        const transport: Sso12RawTransport = { transactRaw };
        const options: Parameters<typeof referenceLinuxEasyLoginOnTransport>[1] = {
            uin: '123456',
            sessionKey: Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i),
            sessionTicket: Uint8Array.of(0xaa, 0x01),
            a1: Uint8Array.of(0x10, 0x20, 0x30),
            a2: Uint8Array.of(0x07, 0x08),
            nonce: Uint8Array.from({ length: 12 }, (_, i) => i),
            guid: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
            version: 'fixture-version',
            subAppId: 42,
            deviceName: 'fixture-device',
            deviceType: 'fixture-pc',
            appId: 42,
            appName: 'fixture-app',
            qua: 'fixture-qua',
            cookie: 'fixture-cookie',
            timeoutMs: 3000,
            signal: controller.signal,
            buildReserved: signer,
            verifyRaw: verifier,
        };
        const inputs = [
            options.sessionKey,
            options.sessionTicket,
            options.a1,
            options.a2!,
            options.nonce,
            options.guid,
        ];
        const before = inputs.map((value) => Uint8Array.from(value));

        expect(await referenceLinuxEasyLoginOnTransport(transport, options)).toEqual({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'not-written',
        });
        expect(signer).not.toHaveBeenCalled();
        expect(verifier).not.toHaveBeenCalled();
        expect(transactRaw).not.toHaveBeenCalled();
        expect(encodeLinuxNTEasyLoginReferenceRequest).not.toHaveBeenCalled();
        expect(encodeLinuxNTLoginReferenceRequest).not.toHaveBeenCalled();
        inputs.forEach((value, index) => expect(value).toEqual(before[index]));
    });
});
