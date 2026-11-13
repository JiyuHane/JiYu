import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import {
    createSso12RawClient,
    type Sso12RawClient,
    type Sso12RawTransport,
    type Sso12RawOptions,
    type Sso12RawResult,
} from '../../src/direct/sso12-packet-client';
import type { CandidateWithLookup } from '../../src/direct/target-response-candidate';
import * as responseCandidate from '../../src/direct/target-response-candidate';
import * as numericReserve from '../../src/direct/target-sso12-numeric-reserve';
import * as decryptCandidate from '../../src/direct/target-service-decrypt-candidate';
import { encodeTargetSso12Reserve } from '../../src/direct/target-sso12-reserve';
import {
    transactTargetRawOnce,
    type TargetRawTransactionOptions,
} from '../../src/direct/target-raw-transaction';

const sockets: Socket[] = [];
const servers: Server[] = [];
const clients: Sso12RawClient[] = [];
const errors: Error[] = [];
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const field2 = Uint8Array.of(0xff, 0, 0x80);

function options(): TargetRawTransactionOptions {
    return {
        head: {
            sequence: 999,
            arg0: 1,
            arg4: 2,
            arg8: 3,
            a2: Uint8Array.of(4),
            requestCommand: Uint8Array.of(5),
            this8: Uint8Array.of(6),
            arg28: new Uint8Array(),
            this20: Uint8Array.of(7),
            versionArg10: Uint8Array.of(8),
            reserved: encodeTargetSso12Reserve({ field13: Uint8Array.of(9) }),
        },
        rawBody: Uint8Array.of(1, 2, 3),
        service: {
            sourceCommand: 'wtlogin64.login',
            virtualProtocol: 0x01020304,
            basicBranch: { kind: 'span', virtualResultByte: 0, span: Uint8Array.of(10) },
            requestObjectByte: 0x7f,
            uin: '42é',
            targetTeaKey: Uint8Array.from(key),
        },
        response: {
            expectedSelector: 1,
            key: Uint8Array.from(key),
            collection: [Uint8Array.from(field2)],
            compression: 'reject',
            maxOutputBytes: 16,
        },
        verifyRaw: () => true,
        timeoutMs: 2000,
    };
}

function response(hit: boolean, selector = 1, reserve: false | true | Uint8Array = false): Buffer {
    const head = Buffer.from(
        '0000002880000001fedcba9800000006ff0000000007ff008000000005420000000000000004dead',
        'hex',
    );

    if (reserve) {
        // Synthetic reserve replaces the empty vector in this fixture.
        const bytes = reserve === true ? Uint8Array.of(1) : reserve;
        const length = Buffer.alloc(4);
        length.writeUInt32BE(4 + bytes.length);
        const changed = Buffer.concat([
            head.subarray(0, 34),
            length,
            bytes,
            Buffer.from('dead', 'hex'),
        ]);
        changed.writeUInt32BE(changed.length, 0);
        return frame(changed, hit, selector);
    }

    return frame(head, hit, selector);
}

function frame(head: Buffer, hit: boolean, selector: number): Buffer {
    const body = Buffer.from(hit ? 'aabbccdd0000000811223344cafe' : '0000000811223344cafe', 'hex');
    const plain = Buffer.concat([head, body]);
    const data =
        selector === 0 ? plain : qqTeaEncrypt(plain, key, (n) => new Uint8Array(n).fill(0x51));
    const result = Buffer.concat([Buffer.from('000000008765432101a500000006beef', 'hex'), data]);
    result.writeUInt32BE(result.length, 0);
    result[8] = selector;
    return result;
}

async function setup(answer: Buffer) {
    const server = createServer();
    servers.push(server);
    server.on('error', (error) => errors.push(error));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('missing address');
    }

    const incoming = once(server, 'connection');
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    sockets.push(socket);
    socket.on('error', (error) => errors.push(error));
    await once(socket, 'connect');
    const [peer] = (await incoming) as [Socket];
    sockets.push(peer);
    peer.on('error', (error) => errors.push(error));
    let request: Uint8Array | undefined;
    const decoder = new ServiceFrameDecoder();
    peer.on('data', (chunk) => {
        try {
            for (const bytes of decoder.push(chunk)) {
                request = Uint8Array.from(bytes);
                peer.write(answer);
            }
        } catch (error) {
            errors.push(error as Error);
        }
    });
    const client = createSso12RawClient({ socket, uin: '123456' });
    clients.push(client);
    return { client, peer, getRequest: () => request };
}

afterEach(async () => {
    for (const client of clients.splice(0)) {
        client.close();
    }

    for (const socket of sockets.splice(0)) {
        socket.destroy();
    }

    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()));
                }),
        ),
    );
    expect(errors.splice(0)).toEqual([]);
});

describe('experimental target raw transaction on synthetic loopback', () => {
    it('accepts a structurally typed generic raw transport without a reference client', async () => {
        const transport: Sso12RawTransport = {
            async transactRaw<C, T>(_options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                return { kind: 'failure', code: 'fixture', writeState: 'not-written' };
            },
        };
        expect(await transactTargetRawOnce(transport, options())).toEqual({
            kind: 'failure',
            code: 'fixture',
            writeState: 'not-written',
        });
    });
    it.each([true, false])('uses private snapshots and publishes hit=%s', async (hit) => {
        const answer = response(hit);
        const fixture = await setup(answer);
        const input = options();

        if (!hit) {
            input.response.collection = [Uint8Array.of(0)];
        }

        const beforeHead = Uint8Array.from(input.head.a2);
        let exposedRequest: Uint8Array | undefined;
        let exposedResponse: Uint8Array | undefined;

        input.verifyRaw = (info) => {
            expect(info.transportUin).toBe('123456');
            expect(info.targetUin).toBe('42é');
            expect(info.sequence).toBe(1);
            expect(info.requestFrame).toEqual(fixture.getRequest());
            expect(info.responseFrame).toEqual(Uint8Array.from(answer));
            exposedRequest = info.requestFrame;
            exposedResponse = info.responseFrame;
            info.requestFrame.fill(0);
            info.responseFrame.fill(0);
            input.service.targetTeaKey.fill(0);
            input.response.key!.fill(0);
            input.response.collection[0].fill(0);
            return true;
        };

        const result = await transactTargetRawOnce(fixture.client, input);
        expect(result.kind).toBe('response');

        if (result.kind !== 'response') {
            throw new Error('expected response');
        }

        expect(result.sequence).toBe(1);
        expect(result.value.head.sequenceBits).toBe(0x80000001);
        expect(result.value.lookupMatched).toBe(hit);
        expect(result.value.skip).toBe(hit ? 4 : 0);
        expect(result.value.body).toEqual(Uint8Array.of(0x11, 0x22, 0x33, 0x44));
        const request = Buffer.from(fixture.getRequest()!);
        expect(request.readUInt32BE(4)).toBe(0x01020304);
        expect(request.subarray(19, 23).toString()).toBe('42é');
        const plaintext = Buffer.from(qqTeaDecrypt(request.subarray(23), key));
        expect(plaintext.readUInt32BE(4)).toBe(1);
        expect(input.head.a2).toEqual(beforeHead);
        expect(exposedRequest!.every((x) => x === 0)).toBe(true);
        expect(exposedResponse!.every((x) => x === 0)).toBe(true);
        const arrays = [
            result.value.basic.opaque,
            result.value.head.field1,
            result.value.head.field2,
            result.value.head.field3,
            result.value.head.reserve,
            result.value.head.tail,
            result.value.body,
            result.value.trailing,
        ];
        expect(new Set(arrays.map((x) => x.buffer)).size).toBe(arrays.length);
        fixture.client.close();
        expect(result.value.body).toEqual(Uint8Array.of(0x11, 0x22, 0x33, 0x44));
    });

    it.each([true, false])(
        'decodes opted-in numeric reserve after verifier on loopback hit=%s',
        async (hit) => {
            // Two fields together are a local synthetic case, not a target observation.
            const reserve = Uint8Array.from(Buffer.from('4800c8018001', 'hex'));
            const fixture = await setup(response(hit, 1, reserve));
            const input = options();
            input.response.reserveMode = 'numeric-candidate';

            if (!hit) {
                input.response.collection = [];
            }

            const order: string[] = [];
            const realDecode = numericReserve.decodeTargetSso12NumericReserveCandidate;
            const realDecrypt = decryptCandidate.decodeTargetServiceDecryptCandidate;
            const numericSpy = vi
                .spyOn(numericReserve, 'decodeTargetSso12NumericReserveCandidate')
                .mockImplementation((bytes) => {
                    order.push('numeric');
                    return realDecode(bytes);
                });
            const decrypt = vi
                .spyOn(decryptCandidate, 'decodeTargetServiceDecryptCandidate')
                .mockImplementation((...args) => {
                    order.push('decrypt');
                    return realDecrypt(...args);
                });

            input.verifyRaw = () => {
                order.push('verify');
                return true;
            };

            try {
                const result = await transactTargetRawOnce(fixture.client, input);
                expect(result.kind).toBe('response');

                if (result.kind !== 'response') {
                    throw new Error('expected response');
                }

                expect(result.writeState).toBe('written');
                expect(result.sequence).toBe(1);
                expect(result.value.head.sequenceBits).toBe(0x80000001);
                expect(result.value.lookupMatched).toBe(hit);
                expect(result.value.skip).toBe(hit ? 4 : 0);
                expect(result.value.numericReserveCandidate).toEqual({
                    kind: 'numeric-reserve-candidate',
                    field9: 0,
                    field25: 128,
                });
                expect(result.value.body).toEqual(Uint8Array.of(0x11, 0x22, 0x33, 0x44));
                expect(order).toEqual(['verify', 'decrypt', 'numeric']);
            } finally {
                numericSpy.mockRestore();
                decrypt.mockRestore();
            }
        },
    );

    it.each(['reject', 'malformed', 'default'] as const)(
        'keeps numeric decode and writeState boundaries for %s',
        async (caseName) => {
            const reserve = Uint8Array.from(
                Buffer.from(caseName === 'malformed' ? '4880' : '4800', 'hex'),
            );
            const fixture = await setup(response(true, 1, reserve));
            const input = options();

            if (caseName !== 'default') {
                input.response.reserveMode = 'numeric-candidate';
            }

            const numericSpy = vi.spyOn(numericReserve, 'decodeTargetSso12NumericReserveCandidate');
            const decryptSpy = vi.spyOn(decryptCandidate, 'decodeTargetServiceDecryptCandidate');
            input.verifyRaw = () => caseName !== 'reject';

            try {
                expect(await transactTargetRawOnce(fixture.client, input)).toEqual({
                    kind: 'failure',
                    code: caseName === 'reject' ? 'raw-rejected' : 'raw-callback-failed',
                    writeState: 'unknown',
                });
                expect(numericSpy).toHaveBeenCalledTimes(caseName === 'malformed' ? 1 : 0);
                expect(decryptSpy).toHaveBeenCalledTimes(caseName === 'reject' ? 0 : 1);
            } finally {
                numericSpy.mockRestore();
                decryptSpy.mockRestore();
            }
        },
    );

    it('does not publish when business transformation fails after numeric decoding', async () => {
        const reserve = Uint8Array.of(0x48, 0x80, 1);
        const fixture = await setup(response(true, 1, reserve));
        const input = options();
        input.response.reserveMode = 'numeric-candidate';
        input.response.maxOutputBytes = 3; // The synthetic business body contains four bytes.
        const realDecode = numericReserve.decodeTargetSso12NumericReserveCandidate;
        let reserveCopy: Uint8Array | undefined;
        const decode = vi
            .spyOn(numericReserve, 'decodeTargetSso12NumericReserveCandidate')
            .mockImplementation((bytes) => {
                reserveCopy = bytes;
                const result = realDecode(bytes);
                expect(result.field9).toBe(128);
                return result;
            });
        const verifier = vi.fn(() => true);
        input.verifyRaw = verifier;

        try {
            expect(await transactTargetRawOnce(fixture.client, input)).toEqual({
                kind: 'failure',
                code: 'raw-callback-failed',
                writeState: 'unknown',
            });
            expect(verifier).toHaveBeenCalledOnce();
            expect(decode).toHaveBeenCalledOnce();
            expect(reserveCopy).toBeDefined();
            expect(reserveCopy!.every((byte) => byte === 0)).toBe(true);
        } finally {
            decode.mockRestore();
        }
    });

    it.each([false, 'truthy', 'throw'] as const)('rejects verifier %s', async (verdict) => {
        const fixture = await setup(response(true));
        const input = options();

        input.verifyRaw = () => {
            if (verdict === 'throw') {
                throw new Error('sensitive');
            }

            return verdict as boolean;
        };

        expect(await transactTargetRawOnce(fixture.client, input)).toEqual({
            kind: 'failure',
            code: verdict === 'throw' ? 'raw-callback-failed' : 'raw-rejected',
            writeState: 'unknown',
        });
    });

    it.each(['selector', 'reserve'] as const)('rejects verified invalid %s', async (type) => {
        const fixture = await setup(response(true, 1, type === 'reserve'));
        const input = options();

        if (type === 'selector') {
            input.response.expectedSelector = 2;
        }

        expect(await transactTargetRawOnce(fixture.client, input)).toEqual({
            kind: 'failure',
            code: 'raw-callback-failed',
            writeState: 'unknown',
        });
    });

    it('times out while verifier continues and clears the exposed copies', async () => {
        const fixture = await setup(response(true, 1, Uint8Array.of(0x48, 0)));
        const input = options();
        input.response.reserveMode = 'numeric-candidate';
        input.timeoutMs = 50;
        let release!: () => void;
        let exposed: Uint8Array | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        input.verifyRaw = async ({ responseFrame }) => {
            exposed = responseFrame;
            await gate;
            return true;
        };

        const result = await transactTargetRawOnce(fixture.client, input);
        expect(result).toEqual({ kind: 'failure', code: 'raw-timeout', writeState: 'unknown' });
        expect(exposed!.every((x) => x === 0)).toBe(true);
        release();
    });

    it('aborts while the verifier is pending and clears its copies', async () => {
        const fixture = await setup(response(true, 1, Uint8Array.of(0x48, 0)));
        const controller = new AbortController();
        let enter!: () => void;
        let release!: () => void;
        let visible: Uint8Array | undefined;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const input = options();
        input.signal = controller.signal;
        input.response.reserveMode = 'numeric-candidate';

        input.verifyRaw = async ({ responseFrame }) => {
            visible = responseFrame;
            enter();
            await gate;
            return true;
        };

        const transaction = transactTargetRawOnce(fixture.client, input);
        await entered;
        controller.abort();
        expect(await transaction).toEqual({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'unknown',
        });
        expect(visible!.every((byte) => byte === 0)).toBe(true);
        release();
    });

    it('preserves busy and closed raw failures', async () => {
        const fixture = await setup(response(true));
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const input = options();

        input.verifyRaw = async () => {
            enter();
            await gate;
            return true;
        };

        const first = transactTargetRawOnce(fixture.client, input);
        await entered;
        expect(await transactTargetRawOnce(fixture.client, options())).toEqual({
            kind: 'failure',
            code: 'busy',
            writeState: 'not-written',
        });
        release();
        expect((await first).kind).toBe('response');
        fixture.client.close();
        expect(await transactTargetRawOnce(fixture.client, options())).toEqual({
            kind: 'failure',
            code: 'closed',
            writeState: 'not-written',
        });
    });

    it('treats unexpected raw throws and wrong returned value as unknown', async () => {
        const thrown = {
            transactRaw: () => {
                throw new Error('private key');
            },
        } as unknown as Sso12RawTransport;
        expect(await transactTargetRawOnce(thrown, options())).toEqual({
            kind: 'failure',
            code: 'target-transaction-failed',
            writeState: 'unknown',
        });
        const wrong = {
            transactRaw: async () => ({
                kind: 'response',
                value: {},
                sequence: 1,
                writeState: 'written',
            }),
        } as unknown as Sso12RawTransport;
        expect(await transactTargetRawOnce(wrong, options())).toEqual({
            kind: 'failure',
            code: 'target-transaction-failed',
            writeState: 'unknown',
        });
    });

    it('rejects undefined success and guards late raw callbacks', async () => {
        let retained: Sso12RawOptions<null, CandidateWithLookup> | undefined;
        const fake = {
            transactRaw: async (raw: Sso12RawOptions<null, CandidateWithLookup>) => {
                retained = raw;
                return { kind: 'response', value: undefined, sequence: 1, writeState: 'written' };
            },
        } as unknown as Sso12RawTransport;
        expect(await transactTargetRawOnce(fake, options())).toEqual({
            kind: 'failure',
            code: 'target-transaction-failed',
            writeState: 'unknown',
        });
        const identity = { uin: '123456', sequence: 1 };
        expect(() => retained!.buildRequest(identity)).toThrow();
        expect(() =>
            retained!.consumeCandidate(Uint8Array.from(response(true)), null, identity),
        ).toThrow();
        await expect(
            retained!.verifyCandidate(Uint8Array.from(response(true)), null, identity),
        ).rejects.toThrow();
    });

    it('wipes all staged arrays when raw fails after synchronous consume', async () => {
        let staged: CandidateWithLookup | undefined;
        let exposed: unknown;
        const real = responseCandidate.composeTargetResponseCandidateWithLookup;
        const spy = vi
            .spyOn(responseCandidate, 'composeTargetResponseCandidateWithLookup')
            .mockImplementation((...args) => {
                staged = real(...args);
                return staged;
            });
        const fake = {
            transactRaw: async (raw: Sso12RawOptions<null, unknown>) => {
                const identity = { uin: '123456', sequence: 1 };
                await raw.buildRequest(identity);
                await raw.verifyCandidate(Uint8Array.from(response(true)), null, identity);
                exposed = await raw.consumeCandidate(
                    Uint8Array.from(response(true)),
                    null,
                    identity,
                );
                return { kind: 'failure', code: 'raw-extra-data', writeState: 'unknown' };
            },
        } as unknown as Sso12RawTransport;

        try {
            expect(await transactTargetRawOnce(fake, options())).toEqual({
                kind: 'failure',
                code: 'raw-extra-data',
                writeState: 'unknown',
            });
        } finally {
            spy.mockRestore();
        }

        expect(exposed).toEqual({});
        expect(Object.isFrozen(exposed)).toBe(true);
        expect(exposed).not.toBe(staged);

        if (!staged) {
            throw new Error('consumer was not called');
        }

        const arrays: Uint8Array[] = [
            staged.basic.opaque,
            staged.head.field1,
            staged.head.field2,
            staged.head.field3,
            staged.head.reserve,
            staged.head.tail,
            staged.body,
            staged.trailing,
        ];
        expect(arrays).toHaveLength(8);
        expect(arrays.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    });

    it.each(['not-written', 'wrong-token'] as const)('discards staged data on %s', async (mode) => {
        const answer = response(true);
        const identity = { uin: '123456', sequence: 1 };
        const fake = {
            async transactRaw(raw: Sso12RawOptions<null, unknown>) {
                await raw.buildRequest(identity);
                await raw.verifyCandidate(answer, null, identity);
                const token = await raw.consumeCandidate(answer, null, identity);
                expect(token).toEqual({});
                expect(Object.isFrozen(token)).toBe(true);
                answer.fill(0);

                if (mode === 'not-written') {
                    return { kind: 'failure', code: 'fixture', writeState: 'not-written' };
                }

                return { kind: 'response', value: {}, sequence: 1, writeState: 'written' };
            },
        } as unknown as Sso12RawTransport;
        expect(await transactTargetRawOnce(fake, options())).toEqual({
            kind: 'failure',
            code: 'target-transaction-failed',
            writeState: 'unknown',
        });
    });

    it('returns cancelled or expired preflight before calling raw', async () => {
        const raw = vi.fn();
        const fake = { transactRaw: raw } as unknown as Sso12RawTransport;
        const controller = new AbortController();
        controller.abort();
        const input = options();
        input.signal = controller.signal;
        expect(await transactTargetRawOnce(fake, input)).toEqual({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'not-written',
        });
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(2001);

        try {
            expect(await transactTargetRawOnce(fake, options())).toEqual({
                kind: 'failure',
                code: 'raw-timeout',
                writeState: 'not-written',
            });
        } finally {
            clock.mockRestore();
        }

        expect(raw).not.toHaveBeenCalled();
    });

    it('keeps entry snapshot ownership if the global byte constructor changes', async () => {
        const input = options();
        const original = Uint8Array.from(input.head.a2);
        const callerBytes = input.head.a2;
        input.head.requestCommand = null as never; // Stop before invoking the existing encoder.
        const hostile = vi.fn(function () {
            return callerBytes;
        });
        const fake = { transactRaw: vi.fn() } as unknown as Sso12RawTransport;
        vi.stubGlobal('Uint8Array', hostile);
        let result;

        try {
            result = await transactTargetRawOnce(fake, input);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(result).toEqual({
            kind: 'failure',
            code: 'target-input-invalid',
            writeState: 'not-written',
        });
        expect(hostile).not.toHaveBeenCalled();
        expect(callerBytes).toEqual(original);
    });

    it.each([
        'frame',
        'verify-uin',
        'verify-sequence',
        'consume-uin',
        'consume-sequence',
        'result-sequence',
    ] as const)('fails closed for structural transport mismatch %s', async (variant) => {
        const original = response(true);
        const changed = Buffer.from(original);
        changed.writeUInt32BE((changed.readUInt32BE(4) ^ 1) >>> 0, 4); // basic.word4 only
        const normal = { uin: '123456', sequence: 1 };
        const mismatch = variant.endsWith('uin')
            ? { ...normal, uin: 'other' }
            : { ...normal, sequence: 2 };
        const fake = {
            async transactRaw(raw: Sso12RawOptions<null, CandidateWithLookup>) {
                await raw.buildRequest(normal);

                try {
                    await raw.verifyCandidate(
                        original,
                        null,
                        variant.startsWith('verify-') ? mismatch : normal,
                    );
                    const value = await raw.consumeCandidate(
                        variant === 'frame' ? changed : original,
                        null,
                        variant.startsWith('consume-') ? mismatch : normal,
                    );
                    return {
                        kind: 'response',
                        value,
                        sequence: variant === 'result-sequence' ? 2 : 1,
                        writeState: 'written',
                    };
                } catch {
                    return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
                }
            },
        } as unknown as Sso12RawTransport;
        expect(await transactTargetRawOnce(fake, options())).toEqual({
            kind: 'failure',
            code: 'target-transaction-failed',
            writeState: 'unknown',
        });
    });

    it('accepts distinct equal identities, inherited getters and independent verifier mutation', async () => {
        const answer = response(true);
        const reads = { uin: 0, sequence: 0 };
        const identity = () =>
            Object.create({
                get uin() {
                    reads.uin++;
                    return '123456';
                },
                get sequence() {
                    reads.sequence++;
                    return 1;
                },
            }) as { uin: string; sequence: number };
        const input = options();

        input.verifyRaw = ({ requestFrame, responseFrame }) => {
            requestFrame.fill(0);
            responseFrame.fill(0);
            return true;
        };

        const fake = {
            async transactRaw(raw: Sso12RawOptions<null, CandidateWithLookup>) {
                await raw.buildRequest(identity());
                await raw.verifyCandidate(answer, null, identity());
                const value = await raw.consumeCandidate(Uint8Array.from(answer), null, identity());
                return { kind: 'response', value, sequence: 1, writeState: 'written' };
            },
        } as unknown as Sso12RawTransport;
        const result = await transactTargetRawOnce(fake, input);
        expect(result.kind).toBe('response');
        expect(reads).toEqual({ uin: 3, sequence: 3 });

        if (result.kind === 'response') {
            expect(result.value.basic.word4).toBe(0x87654321);
        }
    });

    it.each(['throw', 'reenter'] as const)(
        'poisons identity getter %s even when a fake transport catches errors',
        async (mode) => {
            const normal = { uin: '123456', sequence: 1 };
            const fake = {
                async transactRaw(raw: Sso12RawOptions<null, CandidateWithLookup>) {
                    const identity = {
                        get uin() {
                            if (mode === 'throw') {
                                throw new Error('fixture');
                            }

                            try {
                                raw.buildRequest(normal);
                            } catch {
                                /* swallowed reentry */
                            }

                            return normal.uin;
                        },
                        sequence: 1,
                    };

                    try {
                        await raw.buildRequest(identity);
                    } catch {
                        /* swallowed failure */
                    }

                    return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
                },
            } as unknown as Sso12RawTransport;
            expect(await transactTargetRawOnce(fake, options())).toEqual({
                kind: 'failure',
                code: 'target-transaction-failed',
                writeState: 'unknown',
            });
        },
    );

    it('snapshots a structural transport failure instead of returning its changing object', async () => {
        let reads = 0;
        const fake = {
            async transactRaw() {
                return {
                    get kind() {
                        return ++reads === 1 ? 'failure' : 'response';
                    },
                    code: 'fixture',
                    writeState: 'not-written',
                };
            },
        } as unknown as Sso12RawTransport;
        expect(await transactTargetRawOnce(fake, options())).toEqual({
            kind: 'failure',
            code: 'fixture',
            writeState: 'not-written',
        });
        expect(reads).toBe(1);
    });

    it('rejects callbacks reentered from a failure result getter', async () => {
        const fake = {
            async transactRaw(raw: Sso12RawOptions<null, CandidateWithLookup>) {
                return {
                    kind: 'failure',
                    get code() {
                        try {
                            raw.buildRequest({ uin: '123456', sequence: 1 });
                        } catch {
                            /* swallowed */
                        }

                        return 'fixture';
                    },
                    writeState: 'not-written',
                };
            },
        } as unknown as Sso12RawTransport;
        expect(await transactTargetRawOnce(fake, options())).toEqual({
            kind: 'failure',
            code: 'target-transaction-failed',
            writeState: 'unknown',
        });
    });

    it.each(['build', 'verify', 'consume'] as const)(
        'poisons a staged result after a caught repeated %s',
        async (repeated) => {
            const answer = response(true);
            const identity = { uin: '123456', sequence: 1 };
            const fake = {
                async transactRaw(raw: Sso12RawOptions<null, CandidateWithLookup>) {
                    await raw.buildRequest(identity);
                    await raw.verifyCandidate(answer, null, identity);
                    const value = await raw.consumeCandidate(answer, null, identity);

                    try {
                        if (repeated === 'build') {
                            await raw.buildRequest(identity);
                        }

                        if (repeated === 'verify') {
                            await raw.verifyCandidate(answer, null, identity);
                        }

                        if (repeated === 'consume') {
                            await raw.consumeCandidate(answer, null, identity);
                        }
                    } catch {
                        /* fake transport swallows callback failure */
                    }

                    return { kind: 'response', value, sequence: 1, writeState: 'written' };
                },
            } as unknown as Sso12RawTransport;
            expect(await transactTargetRawOnce(fake, options())).toEqual({
                kind: 'failure',
                code: 'target-transaction-failed',
                writeState: 'unknown',
            });
        },
    );

    it.each(['consume', 'verify'] as const)(
        'poisons concurrent %s while verifier is pending and ignores late acceptance',
        async (attempt) => {
            const answer = response(true);
            const identity = { uin: '123456', sequence: 1 };
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const input = options();
            let count = 0;

            input.verifyRaw = async () => {
                count++;
                await gate;
                return true;
            };

            let late: Promise<boolean> | undefined;
            const fake = {
                async transactRaw(raw: Sso12RawOptions<null, CandidateWithLookup>) {
                    await raw.buildRequest(identity);
                    late = Promise.resolve(raw.verifyCandidate(answer, null, identity));

                    try {
                        if (attempt === 'consume') {
                            await raw.consumeCandidate(answer, null, identity);
                        } else {
                            await raw.verifyCandidate(answer, null, identity);
                        }
                    } catch {
                        /* fake transport swallows callback failure */
                    }

                    return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
                },
            } as unknown as Sso12RawTransport;
            expect(await transactTargetRawOnce(fake, input)).toEqual({
                kind: 'failure',
                code: 'target-transaction-failed',
                writeState: 'unknown',
            });
            release();
            expect(await late).toBe(false);
            expect(count).toBe(1);
        },
    );

    it('rejects proxy, getter, hole and shared inputs before network callbacks', async () => {
        const fixture = await setup(response(true));
        const invalid = [
            (x: TargetRawTransactionOptions) => {
                x.response.reserveMode = 'invalid' as 'numeric-candidate';
            },
            (x: TargetRawTransactionOptions) => {
                Object.defineProperty(x.response, 'reserveMode', {
                    get: () => {
                        throw Error('secret');
                    },
                });
            },
            (x: TargetRawTransactionOptions) => {
                x.response.collection = new Array(1);
            },
            (x: TargetRawTransactionOptions) => {
                x.response.collection = [new Uint8Array(new SharedArrayBuffer(1))];
            },
            (x: TargetRawTransactionOptions) => {
                x.service = new Proxy(x.service, {});
            },
            (x: TargetRawTransactionOptions) => {
                Object.defineProperty(x.response, 'key', {
                    get: () => {
                        throw Error('secret');
                    },
                });
            },
        ];

        for (const mutate of invalid) {
            const input = options();
            const verify = vi.fn(() => true);
            input.verifyRaw = verify;
            mutate(input);
            expect(await transactTargetRawOnce(fixture.client, input)).toEqual({
                kind: 'failure',
                code: 'target-input-invalid',
                writeState: 'not-written',
            });
            expect(verify).not.toHaveBeenCalled();
        }

        expect(fixture.getRequest()).toBeUndefined();
    });
});
