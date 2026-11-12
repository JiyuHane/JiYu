import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { WtLoginFlow, type WtLoginFlowInput } from '../../src/direct/wt-login-flow';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeWtTlv, encodeWtTlv } from '../../src/direct/wt-tlv';

const int = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n | 0);
    return b;
};

const field = (b: Uint8Array): Buffer => Buffer.concat([int(b.length + 4), b]);

const scalar = (n: number): Uint8Array => {
    const b = new Uint8Array(24);
    b[23] = n;
    return b;
};

const rand = (n: number): Uint8Array => new Uint8Array(n).fill(0x42);
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const account = '123456';
const cmd = 'fixture.login';

function fixture() {
    const client = createWtEcdh(scalar(1));
    const peer = createWtEcdh(scalar(2));
    let signed = new Uint8Array();
    const input: WtLoginFlowInput = {
        account,
        command: cmd,
        sequence: 0x80000001,
        profile: { subAppId: 42, guid: Uint8Array.of(1, 2), version: 'v1', a2: new Uint8Array() },
        login: {
            uin: 123456,
            appId: 11,
            subAppId: 42,
            appClientVersion: 7,
            mainSigMap: 1,
            miscBitMap: 2,
            subSigMap: 3,
            packageName: 'p',
            ptVersion: 'v',
            sdkVersion: 's',
            os: 'os',
            deviceName: 'd',
            guid: Uint8Array.of(1, 2),
            apkSignature: Uint8Array.of(3),
            temporaryA1: Uint8Array.of(4),
            noPicSig: Uint8Array.of(5),
            tgtgtKey: Uint8Array.from(key),
            tlv124Value: new Uint8Array(12),
            randomSource: rand,
        },
        ecdh: client,
        peerPublicKey: peer.publicKey,
        randomKey: new Uint8Array(16).fill(7),
        timeoutMs: 2000,
        buildReserved: async (r) => {
            signed = Uint8Array.from(r.body);
            return Uint8Array.of(8);
        },
        exchange: async (frame) => {
            const f = Buffer.from(frame);
            expect(f.readUInt32BE(0)).toBe(f.length);
            expect(f.readInt32BE(4)).toBe(12);
            expect(f[8]).toBe(2);
            const pos = 9 + f.readUInt32BE(9) + 1;
            const accountEnd = pos + f.readUInt32BE(pos);
            expect(f.subarray(pos + 4, accountEnd).toString()).toBe(account);
            const plain = Buffer.from(qqTeaDecrypt(f.subarray(accountEnd), new Uint8Array(16)));
            expect(plain.readUInt32BE(4)).toBe(0x80000001);
            expect(plain.readInt32BE(8)).toBe(42);
            const headerLength = plain.readUInt32BE(0);
            const requestBody = plain.subarray(headerLength + 4);
            expect(requestBody).toEqual(Buffer.from(signed));
            expect(requestBody.readUInt16BE(5)).toBe(0x810);
            expect(requestBody.readUInt32BE(9)).toBe(123456);
            const shared = peer.deriveTeaKey(requestBody.subarray(48, 73));
            const requestBusiness = Buffer.from(qqTeaDecrypt(requestBody.subarray(73, -1), shared));
            const entries = decodeWtTlv(requestBusiness.subarray(2));
            expect(entries.find((e) => e.tag === 0x106)?.value).toEqual(Uint8Array.of(4));
            expect(entries.find((e) => e.tag === 0x16a)?.value).toEqual(Uint8Array.of(5));
            return makeResponse(shared);
        },
        verifyServer: () => true,
        selectBusinessBody: (body) => ({ start: 2, end: body.length - 1 }),
    };
    return { input, peer, getSigned: () => signed };
}

function makeResponse(
    shared: Uint8Array,
    options: {
        uin?: string;
        seq?: number;
        command?: string;
        wtUin?: number;
        wtCommand?: number;
        wtSeq?: number;
        state?: number;
        business?: Uint8Array;
    } = {},
): Uint8Array {
    const innerTickets = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: new Uint8Array(16).fill(10) },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
    ]);
    const business =
        options.business ??
        Buffer.concat([
            Buffer.of(0, 9, options.state ?? 0),
            encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(innerTickets, key, rand) }]),
        ]);
    const cipher = qqTeaEncrypt(
        Buffer.concat([Buffer.of(0xaa, 0xbb), business, Buffer.of(0xcc)]),
        shared,
        rand,
    );
    const wt = Buffer.alloc(17 + cipher.length);
    wt[0] = 2;
    wt.writeUInt16BE(wt.length, 1);
    wt.writeUInt16BE(8001, 3);
    wt.writeUInt16BE(options.wtCommand ?? 0x810, 5);
    wt.writeUInt16BE(options.wtSeq ?? 0, 7);
    wt.writeUInt32BE(options.wtUin ?? 123456, 9);
    wt[13] = 3;
    wt.set(cipher, 16);
    wt[wt.length - 1] = 3;
    const sso = Buffer.concat([
        field(
            Buffer.concat([
                int(options.seq ?? 0x80000001),
                int(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(options.command ?? cmd)),
                field(Buffer.alloc(0)),
                int(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(wt),
    ]);
    const body = qqTeaEncrypt(sso, new Uint8Array(16), rand);
    const uin = Buffer.from(options.uin ?? account);
    return Buffer.concat([
        int(14 + uin.length + body.length),
        int(12),
        Buffer.of(2, 0),
        field(uin),
        body,
    ]);
}

describe('one-shot WT login transaction (synthetic peer)', () => {
    it('signs precisely the emitted OICQ and decodes each layer without mutating input', async () => {
        const { input, getSigned } = fixture();
        const snapshot = Uint8Array.from(input.login.tgtgtKey);
        const result = await new WtLoginFlow().run(input);
        expect(result).toEqual({
            status: 'tickets',
            tickets: {
                d2: Uint8Array.of(9),
                d2Key: new Uint8Array(16).fill(10),
                a2: Uint8Array.of(11),
                a1: Uint8Array.of(12),
            },
        });
        expect(input.login.tgtgtKey).toEqual(snapshot);
        expect(getSigned().length).toBeGreaterThan(0);
    });
    it('snapshots account and profile bytes before callbacks and isolates callback views', async () => {
        const { input } = fixture();
        const exchange = input.exchange;

        input.buildReserved = async (r) => {
            input.login.temporaryA1.fill(99);
            input.login.tgtgtKey.fill(99);
            input.login.guid.fill(99);
            input.profile.guid.fill(99);
            input.account = '999';
            r.body.fill(0);
            // The fixture peer expects the signed snapshot; this test checks the transaction independently below.
            return Uint8Array.of(8);
        };

        input.exchange = async (frame, signal) => {
            const f = Buffer.from(frame);
            const pos = 9 + f.readUInt32BE(9) + 1;
            const end = pos + f.readUInt32BE(pos);
            expect(f.subarray(pos + 4, end).toString()).toBe(account);
            const plain = Buffer.from(qqTeaDecrypt(f.subarray(end), new Uint8Array(16)));
            const req = plain.subarray(plain.readUInt32BE(0) + 4);
            const shared = createWtEcdh(scalar(2)).deriveTeaKey(req.subarray(48, 73));
            const login = qqTeaDecrypt(req.subarray(73, -1), shared);
            expect(decodeWtTlv(login.subarray(2)).find((x) => x.tag === 0x106)?.value).toEqual(
                Uint8Array.of(4),
            );
            expect(signal.aborted).toBe(false);
            return makeResponse(shared);
        };

        input.verifyServer = (evidence) => {
            expect(evidence.account).toBe(account);
            expect(evidence.command).toBe(cmd);
            expect(evidence.sequence).toBe(0x80000001);
            expect(Buffer.from(evidence.requestOicq).readUInt16BE(5)).toBe(0x810);
            expect(Buffer.from(evidence.requestFrame).readInt32BE(4)).toBe(12);
            expect(Buffer.from(evidence.responseFrame).readInt32BE(4)).toBe(12);
            evidence.requestOicq.fill(0);
            evidence.requestFrame.fill(0);
            evidence.responseFrame.fill(0);
            return true;
        };

        input.selectBusinessBody = (body) => {
            const length = body.length;
            body.fill(0);
            return { start: 2, end: length - 1 };
        };

        expect((await new WtLoginFlow().run(input)).status).toBe('tickets');
        expect(exchange).toBeTypeOf('function');
    });
    it('rejects account/profile mismatches before signing or sending', async () => {
        for (const mutate of [
            (i: WtLoginFlowInput) => {
                i.account = '123457';
            },
            (i: WtLoginFlowInput) => {
                i.account = '0123456';
            },
            (i: WtLoginFlowInput) => {
                i.profile.guid[0] ^= 1;
            },
            (i: WtLoginFlowInput) => {
                i.profile.subAppId++;
            },
        ]) {
            const { input } = fixture();
            mutate(input);
            const send = vi.fn(input.exchange);
            input.exchange = send;
            expect((await new WtLoginFlow().run(input)).status).toBe('failure');
            expect(send).not.toHaveBeenCalled();
        }
    });
    it('rejects unverified server and mismatched outer, SSO, and OICQ fields', async () => {
        for (const mutation of [
            { uin: '123457' },
            { seq: 3 },
            { command: 'other' },
            { wtUin: 123457 },
            { wtCommand: 0x812 },
            { wtSeq: 1 },
        ]) {
            const { input } = fixture();

            input.exchange = async (frame) => {
                const f = Buffer.from(frame);
                const pos = 9 + f.readUInt32BE(9) + 1;
                const end = pos + f.readUInt32BE(pos);
                const p = Buffer.from(qqTeaDecrypt(f.subarray(end), new Uint8Array(16)));
                const req = p.subarray(p.readUInt32BE(0) + 4);
                return makeResponse(
                    createWtEcdh(scalar(2)).deriveTeaKey(req.subarray(48, 73)),
                    mutation,
                );
            };

            expect((await new WtLoginFlow().run(input)).status).toBe('failure');
        }

        const { input } = fixture();
        input.verifyServer = () => false;
        expect((await new WtLoginFlow().run(input)).status).toBe('failure');
        const noVerifier = fixture().input;
        noVerifier.verifyServer = undefined as never;
        expect((await new WtLoginFlow().run(noVerifier)).status).toBe('failure');
    });
    it('reports business status and explicit boundaries', async () => {
        for (const [business, expected] of [
            [Buffer.concat([Buffer.of(0, 9, 2), encodeWtTlv([])]), 'verification-required'],
            [Buffer.concat([Buffer.of(0, 9, 1), encodeWtTlv([])]), 'nonzero'],
            [Buffer.concat([Buffer.of(0, 9, 0), encodeWtTlv([])]), 'incomplete'],
            [
                Buffer.concat([
                    Buffer.of(0, 9, 1),
                    encodeWtTlv([{ tag: 0x146, value: Buffer.from('0000002a00000000', 'hex') }]),
                ]),
                'error146',
            ],
        ] as const) {
            const { input } = fixture();

            input.exchange = async (frame) => {
                const f = Buffer.from(frame);
                const pos = 9 + f.readUInt32BE(9) + 1;
                const end = pos + f.readUInt32BE(pos);
                const p = Buffer.from(qqTeaDecrypt(f.subarray(end), new Uint8Array(16)));
                const req = p.subarray(p.readUInt32BE(0) + 4);
                return makeResponse(createWtEcdh(scalar(2)).deriveTeaKey(req.subarray(48, 73)), {
                    business,
                });
            };

            expect((await new WtLoginFlow().run(input)).status).toBe(expected);
        }

        const { input } = fixture();
        input.selectBusinessBody = (body) => ({ start: 0, end: body.length });
        expect((await new WtLoginFlow().run(input)).status).toBe('failure');
    });
    it('enforces one flight and discards late completion on cancellation', async () => {
        const { input } = fixture();
        let complete!: (bytes: Uint8Array) => void;
        let sent!: Uint8Array;

        input.exchange = (frame) => {
            sent = frame;
            return new Promise((resolve) => {
                complete = resolve;
            });
        };

        const controller = new AbortController();
        input.signal = controller.signal;
        const flow = new WtLoginFlow();
        const pending = flow.run(input);
        await Promise.resolve();
        await Promise.resolve();
        expect((await flow.run(input)).status).toBe('busy');
        controller.abort();
        expect((await pending).status).toBe('cancelled');
        expect(sent.every((v) => v === 0)).toBe(true);
        complete(new Uint8Array([1, 2, 3]));
        await Promise.resolve();
        expect((await flow.run(input)).status).toBe('used');
    });
    it('exchanges complete frames through an actual loopback socket', async () => {
        const { input } = fixture();
        const fakePeer = input.exchange;
        const sockets: Socket[] = [];
        const server = createServer((peer) => {
            sockets.push(peer);
            const decoder = new ServiceFrameDecoder();
            peer.on('data', (chunk) => {
                for (const frame of decoder.push(chunk)) {
                    void fakePeer(frame, new AbortController().signal).then((reply) =>
                        peer.write(reply),
                    );
                }
            });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();

        if (!address || typeof address === 'string') {
            throw new Error('missing loopback address');
        }

        const socket = createConnection(address.port, '127.0.0.1');
        sockets.push(socket);
        await once(socket, 'connect');
        input.exchange = (frame, signal) =>
            new Promise((resolve, reject) => {
                const decoder = new ServiceFrameDecoder();
                socket.on('data', (chunk) => {
                    for (const reply of decoder.push(chunk)) {
                        resolve(reply);
                    }
                });
                socket.once('error', reject);
                signal.addEventListener('abort', () => socket.destroy(), { once: true });
                socket.write(frame);
            });

        try {
            expect((await new WtLoginFlow().run(input)).status).toBe('tickets');
        } finally {
            for (const socket of sockets) {
                socket.destroy();
            }

            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
    it('drops a verified but late valid response after cancellation', async () => {
        const { input } = fixture();
        const controller = new AbortController();
        input.signal = controller.signal;
        let allow!: (result: boolean) => void;
        let entered!: () => void;
        const verificationStarted = new Promise<void>((r) => {
            entered = r;
        });

        input.verifyServer = () => {
            entered();
            return new Promise((r) => {
                allow = r;
            });
        };

        const pending = new WtLoginFlow().run(input);
        await verificationStarted;
        controller.abort();
        expect((await pending).status).toBe('cancelled');
        allow(true);
        await Promise.resolve();
    });
    it('keeps validated scalar snapshots across adversarial byte and profile getters', async () => {
        const { input } = fixture();
        let lengthReads = 0;
        Object.defineProperty(input.profile.guid, 'length', {
            get() {
                lengthReads++;
                input.profile.subAppId = 99;
                input.account = '999';
                return 2;
            },
        });
        Object.defineProperty(input.profile, 'version', {
            get() {
                input.profile.subAppId = 99;
                input.login.subAppId = 99;
                input.login.uin = 1;
                input.account = '1';
                input.sequence = 2;
                input.timeoutMs = 1;
                input.peerPublicKey = new Uint8Array(25);
                input.randomKey = new Uint8Array(16);
                input.exchange = async () => new Uint8Array();
                return 'v1';
            },
        });
        expect((await new WtLoginFlow().run(input)).status).toBe('tickets');
        expect(lengthReads).toBe(0);
    });
    it('rejects synchronous reentrant run calls from an input getter', async () => {
        const { input } = fixture();
        const flow = new WtLoginFlow();
        let nested!: Promise<{ status: string }>;
        Object.defineProperty(input.profile, 'version', {
            get() {
                nested = flow.run(input);
                return 'v1';
            },
        });
        const outer = flow.run(input);
        expect((await nested).status).toBe('busy');
        expect((await outer).status).toBe('tickets');
    });
    it('wipes a business body produced after synchronous reentrant cancellation', async () => {
        const { input } = fixture();
        const controller = new AbortController();
        input.signal = controller.signal;
        const secret = Buffer.from('synthetic-sensitive-ticket');
        input.login.temporaryA1 = Uint8Array.from(secret);

        input.login.randomSource = (n) => {
            controller.abort();
            return rand(n);
        };

        const send = vi.fn(input.exchange);
        input.exchange = send;
        const fill = Buffer.prototype.fill;
        let erasedLateBody = false;
        const spy = vi.spyOn(Buffer.prototype, 'fill').mockImplementation(function (
            this: Buffer,
            ...args: Parameters<typeof fill>
        ) {
            if (this.includes(secret) && args[0] === 0) {
                erasedLateBody = true;
            }

            return fill.apply(this, args);
        });

        try {
            expect((await new WtLoginFlow().run(input)).status).toBe('cancelled');
            expect(erasedLateBody).toBe(true);
            expect(send).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
    it('rolls back a listener installation that throws after attaching', async () => {
        const { input } = fixture();
        const signal = new AbortController().signal;
        input.signal = signal;
        const add = signal.addEventListener.bind(signal);
        const remove = vi.spyOn(signal, 'removeEventListener');
        vi.spyOn(signal, 'addEventListener').mockImplementation((...args) => {
            add(...args);
            throw new Error('secret add exception');
        });
        const exchange = vi.fn(input.exchange);
        input.exchange = exchange;
        const flow = new WtLoginFlow();
        const result = await flow.run(input);
        expect(result).toEqual({
            status: 'failure',
            reason: 'invalid input or preparation failed',
        });
        expect(remove).toHaveBeenCalledOnce();
        expect(exchange).not.toHaveBeenCalled();
        expect((await flow.run(input)).status).toBe('used');
    });
    it('settles, aborts and wipes when removing the abort listener throws', async () => {
        const { input } = fixture();
        const controller = new AbortController();
        input.signal = controller.signal;
        vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(() => {
            throw new Error('secret remove exception');
        });
        let sent!: Uint8Array;
        let transactionSignal!: AbortSignal;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });

        input.exchange = (frame, signal) => {
            sent = frame;
            transactionSignal = signal;
            entered();
            return new Promise(() => {});
        };

        const flow = new WtLoginFlow();
        const pending = flow.run(input);
        await started;
        controller.abort();
        expect(await pending).toEqual({ status: 'cancelled' });
        expect(transactionSignal.aborted).toBe(true);
        expect(sent.every((byte) => byte === 0)).toBe(true);
        expect((await flow.run(input)).status).toBe('used');
    });
    it('rejects an oversized response before verification or copying', async () => {
        const { input } = fixture();
        const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
        input.exchange = async () => oversized;
        const verify = vi.fn(input.verifyServer);
        input.verifyServer = verify;
        expect(await new WtLoginFlow().run(input)).toEqual({
            status: 'failure',
            reason: 'transaction failed',
        });
        expect(verify).not.toHaveBeenCalled();
    });
    it('times out even if signer never resolves and does not start transport', async () => {
        const { input } = fixture();
        input.timeoutMs = 10;
        input.buildReserved = () => new Promise(() => {});
        const send = vi.fn(input.exchange);
        input.exchange = send;
        expect((await new WtLoginFlow().run(input)).status).toBe('timeout');
        expect(send).not.toHaveBeenCalled();
    });
});
