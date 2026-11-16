import { createECDH } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    prepareKeyExchangeFlow,
    type KeyExchangeFlow,
    type KeyExchangeFlowInput,
} from '../../src/direct/key-exchange-flow';

// The wrapper calls the production encoder and only introduces synchronous reentry.
const interception = vi.hoisted(() => ({
    phase: 'before' as 'before' | 'after',
    hook: undefined as ((request: import('../../src/direct/sso').Sso12Request) => void) | undefined,
    calls: 0,
    encoded: undefined as Uint8Array | undefined,
    encodedSnapshot: undefined as Uint8Array | undefined,
}));

vi.mock('../../src/direct/sso', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/direct/sso')>();
    return {
        ...real,
        encodeSso12Request(request: Parameters<typeof real.encodeSso12Request>[0]) {
            interception.calls++;

            if (interception.phase === 'before') {
                interception.hook?.(request);
            }

            const encoded = real.encodeSso12Request(request);
            interception.encoded = encoded;
            interception.encodedSnapshot = Uint8Array.from(encoded);

            if (interception.phase === 'after') {
                interception.hook?.(request);
            }

            return encoded;
        },
    };
});

afterEach(() => {
    interception.hook = undefined;
    interception.calls = 0;
    interception.encoded = undefined;
    interception.encodedSnapshot = undefined;
});

function fixture(): Omit<KeyExchangeFlowInput, 'reserved'> {
    const peer = createECDH('prime256v1');
    peer.generateKeys();
    return {
        uin: '123456',
        guid: Uint8Array.of(1, 2, 3, 4),
        version: 'synthetic-version',
        subAppId: 1234,
        a2: Uint8Array.of(5, 6, 7),
        sequence: 123,
        serverPublicKey: Uint8Array.from(peer.getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        timestamp: 1700000000,
        verifyServerResponse: () => true,
    };
}

describe('prepared key exchange synchronous encoder reentry', () => {
    it.each(['before', 'after'] as const)(
        'clears the borrow and fails closed when cancelled %s the real SSO encoder',
        (phase) => {
            const input = fixture();
            const inputSnapshot = {
                ...input,
                guid: Uint8Array.from(input.guid),
                a2: Uint8Array.from(input.a2!),
                serverPublicKey: Uint8Array.from(input.serverPublicKey),
                verifyKey: Uint8Array.from(input.verifyKey),
            };
            const reserved = Uint8Array.of(0xaa, 0, 0xfe);
            const reservedSnapshot = Uint8Array.from(reserved);
            const prepared = prepareKeyExchangeFlow(input);
            const borrowed = prepared.body;
            let borrowedSnapshot: Uint8Array | undefined;
            let hookCompleted = false;
            let frame: KeyExchangeFlow | undefined;

            interception.phase = phase;

            interception.hook = (request) => {
                borrowedSnapshot = Uint8Array.from(borrowed);
                expect(borrowedSnapshot.length).toBeGreaterThan(0);
                expect(borrowedSnapshot.some((byte) => byte !== 0)).toBe(true);
                expect(request.body).not.toBe(borrowed);
                expect(request.body).toEqual(borrowedSnapshot);
                const privateBody = Uint8Array.from(request.body);
                const privateGuid = Uint8Array.from(request.guid);
                const privateA2 = Uint8Array.from(request.a2);
                const privateReserved = Uint8Array.from(request.reserved);

                prepared.cancel();

                // These checks execute before the encoder wrapper returns to finish.
                expect(borrowed).toEqual(new Uint8Array(borrowedSnapshot.length));
                expect(request.body).toEqual(privateBody);
                expect(request.guid).toEqual(privateGuid);
                expect(request.a2).toEqual(privateA2);
                expect(request.reserved).toEqual(privateReserved);
                hookCompleted = true;
            };

            expect(() => {
                frame = prepared.finish(reserved);
            }).toThrow(/key exchange preparation cancelled or body changed/);

            expect(frame).toBeUndefined();
            expect(hookCompleted).toBe(true);
            expect(interception.calls).toBe(1);
            expect(interception.encodedSnapshot?.length).toBeGreaterThan(0);
            expect(interception.encodedSnapshot?.some((byte) => byte !== 0)).toBe(true);
            expect(Uint8Array.from(interception.encoded!)).toEqual(
                new Uint8Array(interception.encodedSnapshot!.length),
            );
            expect(borrowedSnapshot).toBeDefined();
            expect(borrowed).toEqual(new Uint8Array(borrowedSnapshot!.length));
            expect(input).toEqual(inputSnapshot);
            expect(reserved).toEqual(reservedSnapshot);
            expect(() => prepared.finish(reserved)).toThrow();
            expect(() => prepared.cancel()).not.toThrow();
            expect(() => prepared.cancel()).not.toThrow();
            expect(() => prepared.finish(reserved)).toThrow();
            expect(input).toEqual(inputSnapshot);
            expect(reserved).toEqual(reservedSnapshot);
        },
    );
});
