import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { SSO_HEARTBEAT_COMMAND } from '../../src/direct/sso-register';
import {
    referenceHeartbeatOnTransport,
    type SsoReferenceHeartbeatOptions,
} from '../../src/direct/sso-reference-heartbeat-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Only local codec operations and a synthetic borrowed transport. A successful
// response is not evidence of server authentication, signatures or online state.
const UIN = '123';
const SEQUENCE = 0xf0000001;
const KEY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const MAX_BODY = 16 * 1024 * 1024;

function word(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
}

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

function reply(body: Uint8Array, compressed: boolean, retCode = 0): Uint8Array {
    const header = Buffer.concat([
        word(SEQUENCE),
        word(retCode),
        field(Buffer.alloc(0)),
        field(Buffer.from(SSO_HEARTBEAT_COMMAND)),
        field(Buffer.alloc(0)),
        word(compressed ? 1 : 0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(compressed ? deflateSync(body) : body)]);
    const encrypted = qqTeaEncrypt(inner, KEY);
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from(UIN)),
        encrypted,
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function options(): SsoReferenceHeartbeatOptions {
    return {
        login: {
            status: 'tickets',
            uin: UIN,
            tickets: {
                d2: Uint8Array.of(3, 4),
                d2Key: Uint8Array.from(KEY),
                a1: Uint8Array.of(5),
                a2: Uint8Array.of(6, 7),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
        uid: 'synthetic-uid',
        timeoutMs: 5000,
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

class Peer implements Sso12RawTransport {
    calls = 0;
    builds = 0;
    verifies = 0;
    consumes = 0;
    constructor(readonly candidate: Uint8Array) {}

    async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const identity = { uin: UIN, sequence: SEQUENCE };

        try {
            const built = await raw.buildRequest(identity);
            this.builds++;
            this.verifies++;

            if (!(await raw.verifyCandidate(this.candidate, built.context, identity))) {
                return { kind: 'failure', code: 'fixture-rejected', writeState: 'unknown' };
            }

            const value = await raw.consumeCandidate(this.candidate, built.context, identity);
            this.consumes++;
            return { kind: 'response', sequence: SEQUENCE, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'fixture-callback', writeState: 'unknown' };
        }
    }
}

const success = {
    kind: 'response',
    sequence: SEQUENCE,
    value: { status: 'success', interval: 0n },
    writeState: 'written',
} as const;
const missing = {
    kind: 'response',
    sequence: SEQUENCE,
    value: { status: 'missing-interval' },
    writeState: 'written',
} as const;

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('borrowed heartbeat decoded-response byte limits on a synthetic transport', () => {
    it.each([false, true])(
        'accepts exact and rejects exceeded compressed=%s body size',
        async (compressed) => {
            const body = Buffer.from('48011800', 'hex'); // Unknown field, then interval zero.
            const at = new Peer(reply(body, compressed));
            const under = new Peer(reply(body, compressed));
            expect(
                await referenceHeartbeatOnTransport(at, { ...options(), maxResponseBodyBytes: 4 }),
            ).toEqual(success);
            expect(
                await referenceHeartbeatOnTransport(under, {
                    ...options(),
                    maxResponseBodyBytes: 3,
                }),
            ).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect([at.calls, at.builds, at.verifies, at.consumes]).toEqual([1, 1, 1, 1]);
            expect([under.calls, under.builds, under.verifies, under.consumes]).toEqual([
                1, 1, 1, 0,
            ]);
        },
    );

    it.each([false, true])(
        'applies zero to actual compressed=%s output, not encoded length',
        async (compressed) => {
            const empty = new Peer(reply(Buffer.alloc(0), compressed));
            const nonempty = new Peer(reply(Buffer.from('1800', 'hex'), compressed));
            // One byte fits the decoder's minimum cap of 1; it must still exceed
            // the caller's 0 cap even though a nonzero code skips protobuf parsing.
            const oneByte = new Peer(reply(Buffer.of(0xff), compressed, -7));
            const oneByteAtLimit = new Peer(reply(Buffer.of(0xff), compressed, -7));
            expect(
                await referenceHeartbeatOnTransport(empty, {
                    ...options(),
                    maxResponseBodyBytes: 0,
                }),
            ).toEqual(missing);
            expect(
                await referenceHeartbeatOnTransport(nonempty, {
                    ...options(),
                    maxResponseBodyBytes: 0,
                }),
            ).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(
                await referenceHeartbeatOnTransport(oneByte, {
                    ...options(),
                    maxResponseBodyBytes: 0,
                }),
            ).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(
                await referenceHeartbeatOnTransport(oneByteAtLimit, {
                    ...options(),
                    maxResponseBodyBytes: 1,
                }),
            ).toEqual({
                kind: 'response',
                sequence: SEQUENCE,
                value: { status: 'sso-error', retCode: -7 },
                writeState: 'written',
            });
            expect(empty.consumes).toBe(1);
            expect(nonempty.consumes).toBe(0);
            expect(oneByte.consumes).toBe(0);
            expect(oneByteAtLimit.consumes).toBe(1);
        },
    );

    it.each([false, true])(
        'applies the limit before returning a nonzero SSO code, compressed=%s',
        async (compressed) => {
            const body = Buffer.from('1880', 'hex'); // Deliberately malformed as heartbeat protobuf.
            const at = new Peer(reply(body, compressed, -7));
            const under = new Peer(reply(body, compressed, -7));
            expect(
                await referenceHeartbeatOnTransport(at, { ...options(), maxResponseBodyBytes: 2 }),
            ).toEqual({
                kind: 'response',
                sequence: SEQUENCE,
                value: { status: 'sso-error', retCode: -7 },
                writeState: 'written',
            });
            expect(
                await referenceHeartbeatOnTransport(under, {
                    ...options(),
                    maxResponseBodyBytes: 1,
                }),
            ).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(under.consumes).toBe(0);
        },
    );

    it('keeps the omitted limit at 16 MiB while bounding compressed expansion', async () => {
        // Nonzero SSO status intentionally skips the separate 1 MiB heartbeat
        // protobuf decoder limit; the response body cap is the behavior under test.
        const exact = new Peer(reply(Buffer.alloc(MAX_BODY), true, -7));
        const exceeded = new Peer(reply(Buffer.alloc(MAX_BODY + 1), true, -7));
        expect(await referenceHeartbeatOnTransport(exact, options())).toEqual({
            kind: 'response',
            sequence: SEQUENCE,
            value: { status: 'sso-error', retCode: -7 },
            writeState: 'written',
        });
        expect(await referenceHeartbeatOnTransport(exceeded, options())).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect([exact.calls, exact.consumes]).toEqual([1, 1]);
        expect([exceeded.calls, exceeded.consumes]).toEqual([1, 0]);
    });

    it.each([-1, 0.5, NaN, Infinity, MAX_BODY + 1])(
        'rejects invalid limit %s before transaction',
        async (limit) => {
            const peer = new Peer(reply(Buffer.alloc(0), false));
            await expect(
                referenceHeartbeatOnTransport(peer, { ...options(), maxResponseBodyBytes: limit }),
            ).rejects.toThrow();
            expect(peer.calls).toBe(0);
        },
    );
});
