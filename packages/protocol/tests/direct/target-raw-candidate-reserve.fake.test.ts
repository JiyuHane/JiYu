import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import Module, { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    Sso12RawIdentity,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';
import type { TargetRawTransactionOptions } from '../../src/direct/target-raw-transaction';

type TransactionModule = typeof import('../../src/direct/target-raw-transaction');
type ReserveModule = typeof import('../../src/direct/target-sso12-reserve');
type HeadModule = typeof import('../../src/direct/target-sso12-head');
type TeaModule = typeof import('../../src/direct/qq-tea');
type CandidateOptions = Parameters<TransactionModule['transactTargetRawCandidateReserveOnce']>[1];
type Raw = Sso12RawOptions<unknown, unknown>;
type Guard = { mock: { calls: readonly unknown[] } };

// All identities, keys, request bytes, responses and candidate output are synthetic.
// The candidate callback is a fixture provider, not a real signing implementation.
const TRANSPORT_UIN = 'transport-fixture-α';
const TARGET_UIN = 'target-fixture-42é';
const KEY = Uint8Array.from({ length: 16 }, (_, index) => index);
const COMMAND = Uint8Array.from(Buffer.from('cmd/é\0路', 'utf8'));
const BODY = Uint8Array.of(0x81, 0, 0xfe, 0x44);
const SEQUENCE = 0x80000000;

let transaction: TransactionModule;
let reserve: ReserveModule;
let headCodec: HeadModule;
let tea: TeaModule;
let guards: Array<{ name: string; guard: Guard }> = [];

function blockedEffect(): never {
    throw new Error('unexpected fixture side effect');
}

beforeEach(async () => {
    vi.resetModules();
    guards = [
        { name: 'net.connect', guard: vi.spyOn(net, 'connect').mockImplementation(blockedEffect) },
        {
            name: 'net.createConnection',
            guard: vi.spyOn(net, 'createConnection').mockImplementation(blockedEffect),
        },
        {
            name: 'net.createServer',
            guard: vi.spyOn(net, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'net.Socket.connect',
            guard: vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blockedEffect),
        },
        {
            name: 'net.Server.listen',
            guard: vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blockedEffect),
        },
        {
            name: 'http.request',
            guard: vi.spyOn(http, 'request').mockImplementation(blockedEffect),
        },
        { name: 'http.get', guard: vi.spyOn(http, 'get').mockImplementation(blockedEffect) },
        {
            name: 'http.createServer',
            guard: vi.spyOn(http, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'https.request',
            guard: vi.spyOn(https, 'request').mockImplementation(blockedEffect),
        },
        { name: 'https.get', guard: vi.spyOn(https, 'get').mockImplementation(blockedEffect) },
        {
            name: 'https.createServer',
            guard: vi.spyOn(https, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'http2.connect',
            guard: vi.spyOn(http2, 'connect').mockImplementation(blockedEffect),
        },
        {
            name: 'http2.createServer',
            guard: vi.spyOn(http2, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'http2.createSecureServer',
            guard: vi.spyOn(http2, 'createSecureServer').mockImplementation(blockedEffect),
        },
        { name: 'tls.connect', guard: vi.spyOn(tls, 'connect').mockImplementation(blockedEffect) },
        {
            name: 'tls.createServer',
            guard: vi.spyOn(tls, 'createServer').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.createSocket',
            guard: vi.spyOn(dgram, 'createSocket').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.connect',
            guard: vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.send',
            guard: vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blockedEffect),
        },
        {
            name: 'dgram.Socket.bind',
            guard: vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blockedEffect),
        },
        {
            name: 'process.dlopen',
            guard: vi.spyOn(process, 'dlopen').mockImplementation(blockedEffect),
        },
    ];

    const fetchGuard = vi.fn(blockedEffect);
    const webSocketGuard = vi.fn(blockedEffect);
    const wsModuleGuard = vi.fn(blockedEffect);
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards.push(
        { name: 'fetch', guard: fetchGuard },
        { name: 'WebSocket', guard: webSocketGuard },
        { name: 'ws module load', guard: wsModuleGuard },
    );

    const moduleLoader = Module as unknown as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    vi.spyOn(moduleLoader, '_load').mockImplementation(function (
        this: unknown,
        ...args: unknown[]
    ) {
        const request = args[0];

        if (
            typeof request === 'string' &&
            (request === 'ws' || request.startsWith('ws/') || /[/\\]ws[/\\]/.test(request))
        ) {
            return wsModuleGuard();
        }

        return Reflect.apply(originalLoad, this, args);
    });

    // Rebind named builtin imports too; all implementation imports happen afterwards.
    syncBuiltinESMExports();
    transaction = await import('../../src/direct/target-raw-transaction');
    reserve = await import('../../src/direct/target-sso12-reserve');
    headCodec = await import('../../src/direct/target-sso12-head');
    tea = await import('../../src/direct/qq-tea');
});

afterEach(() => {
    try {
        for (const { name, guard } of guards) {
            expect(guard.mock.calls, name).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        vi.unstubAllGlobals();
        guards = [];
    }
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function candidateOutput(empty = false): Uint8Array {
    const output = new Uint8Array(0x300).fill(0xa5);
    output[0x000] = 0x11;
    output[0x0ff] = empty ? 0 : 1;
    output[0x100] = 0x22;
    output[0x1ff] = empty ? 0 : 1;
    output[0x200] = 0x33;
    output[0x2ff] = empty ? 0 : 1;
    return output;
}

function options(): CandidateOptions {
    return {
        head: {
            arg0: 0xa1a2a3a4,
            arg4: 0x11223344,
            arg8: 0x7f,
            a2: Uint8Array.of(0xaa, 0),
            requestCommand: Uint8Array.from(COMMAND),
            this8: Uint8Array.of(0x80),
            arg28: new Uint8Array(),
            this20: Uint8Array.of(0x11, 0x22),
            versionArg10: Uint8Array.of(0, 1),
        },
        reserveBase: {
            field12: Uint8Array.of(0xaa),
            field23: [{ field1: new Uint8Array(), field2: Uint8Array.of(0x44) }],
            field26: 0,
            field32: Uint8Array.of(0xcc),
        },
        rawBody: Uint8Array.from(BODY),
        service: {
            sourceCommand: 'wtlogin64.login',
            virtualProtocol: 0x01020304,
            basicBranch: { kind: 'span', virtualResultByte: 0, span: Uint8Array.of(0x0a) },
            requestObjectByte: 0x7f,
            uin: TARGET_UIN,
            targetTeaKey: Uint8Array.from(KEY),
        },
        response: {
            expectedSelector: 0,
            key: undefined,
            collection: [Uint8Array.of(0xff, 0, 0x80)],
            compression: 'reject',
            maxOutputBytes: 16,
        },
        verifyRaw: () => true,
        timeoutMs: 2000,
        buildCandidate: () => ({ status: 0, output: candidateOutput() }),
    };
}

function legacyOptions(): TargetRawTransactionOptions {
    const input = options();
    return {
        head: { ...input.head, sequence: 0, reserved: new Uint8Array() },
        rawBody: input.rawBody,
        service: input.service,
        response: input.response,
        verifyRaw: input.verifyRaw,
        timeoutMs: input.timeoutMs,
    };
}

function identity(sequence = SEQUENCE): Sso12RawIdentity {
    return { uin: TRANSPORT_UIN, sequence };
}

function response(): Uint8Array {
    // Local selector-0 fixture used only to exercise the existing response decoder.
    const header = Buffer.from(
        '0000002880000001fedcba9800000006ff0000000007ff008000000005420000000000000004dead',
        'hex',
    );
    const body = Buffer.from('aabbccdd0000000811223344cafe', 'hex');
    const frame = Buffer.concat([
        Buffer.from('000000008765432100a500000006beef', 'hex'),
        header,
        body,
    ]);
    frame.writeUInt32BE(frame.length, 0);
    return Uint8Array.from(frame);
}

function transport(perform: (raw: Raw) => Promise<Sso12RawResult<unknown>>): Sso12RawTransport {
    return { transactRaw: perform as Sso12RawTransport['transactRaw'] };
}

function normalFake(sequence = SEQUENCE) {
    const events: string[] = [];
    let frame: Uint8Array | undefined;
    const fake = transport(async (raw) => {
        try {
            events.push('build');
            const built = await raw.buildRequest(identity(sequence));
            frame = Uint8Array.from(built.frame);
            events.push('built');
            const accepted = await raw.verifyCandidate(
                response(),
                built.context,
                identity(sequence),
            );
            events.push('verify');

            if (accepted !== true) {
                return { kind: 'failure', code: 'fake-rejected', writeState: 'unknown' };
            }

            const value = await raw.consumeCandidate(response(), built.context, identity(sequence));
            events.push('consume');
            return { kind: 'response', sequence, value, writeState: 'written' };
        } catch {
            events.push('caught');
            return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
        }
    });
    return { fake, events, frame: () => frame };
}

function decodeRequest(request: Uint8Array) {
    const frame = Buffer.from(request);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(0x01020304);
    expect(frame[8]).toBe(2);
    const spanLength = frame.readUInt32BE(9);
    const objectOffset = 9 + spanLength;
    expect(frame[objectOffset]).toBe(0x7f);
    const uinOffset = objectOffset + 1;
    const uinLength = frame.readUInt32BE(uinOffset);
    const targetUin = frame.subarray(uinOffset + 4, uinOffset + uinLength).toString('utf8');
    const plain = Buffer.from(tea.qqTeaDecrypt(frame.subarray(uinOffset + uinLength), KEY));
    const headLength = plain.readUInt32BE(0);
    const head = plain.subarray(0, headLength);
    let cursor = 28;

    function field(width: 2 | 4): Buffer {
        const size = width === 2 ? head.readUInt16BE(cursor) : head.readUInt32BE(cursor);

        if (size < width || cursor + size > head.length) {
            throw new Error('invalid synthetic head framing');
        }

        const result = head.subarray(cursor + width, cursor + size);
        cursor += size;
        return result;
    }

    const a2 = field(4);
    const command = field(4);
    const this8 = field(4);
    const arg28 = field(4);
    const this20 = field(4);
    const version = field(2);
    const reserved = field(4);
    expect(cursor).toBe(head.length);
    const busi = plain.subarray(headLength);
    expect(busi.readUInt32BE(0)).toBe(busi.length);
    return {
        targetUin,
        sequence: head.readUInt32BE(4),
        head: Uint8Array.from(head),
        a2: Uint8Array.from(a2),
        command: Uint8Array.from(command),
        this8: Uint8Array.from(this8),
        arg28: Uint8Array.from(arg28),
        this20: Uint8Array.from(this20),
        version: Uint8Array.from(version),
        reserved: Uint8Array.from(reserved),
        body: Uint8Array.from(busi.subarray(4)),
    };
}

function hex(value: Uint8Array): string {
    return Buffer.from(value).toString('hex');
}

describe('candidate reserve transaction with synthetic in-memory transport', () => {
    it.each([0, 0x7fffffff, 0x80000000, 0xffffffff])(
        'binds unsigned sequence %# to callback, request head and fake result',
        async (sequence) => {
            const input = options();
            const fixture = normalFake(sequence);
            const seen: Array<{
                transportUin: string;
                targetUin: string;
                sequence: number;
                requestCommand: Uint8Array;
                rawBody: Uint8Array;
            }> = [];
            const verifier = vi.fn(() => true);
            input.verifyRaw = verifier;

            input.buildCandidate = (value) => {
                seen.push({
                    transportUin: value.transportUin,
                    targetUin: value.targetUin,
                    sequence: value.sequence,
                    requestCommand: Uint8Array.from(value.requestCommand),
                    rawBody: Uint8Array.from(value.rawBody),
                });
                return { status: 0, output: candidateOutput() };
            };

            const result = await transaction.transactTargetRawCandidateReserveOnce(
                fixture.fake,
                input,
            );
            expect(result.kind).toBe('response');

            if (result.kind !== 'response' || !fixture.frame()) {
                throw new Error('expected synthetic response and request');
            }

            expect(result.sequence).toBe(sequence);
            expect(result.writeState).toBe('written');
            expect(result.value.body).toEqual(Uint8Array.of(0x11, 0x22, 0x33, 0x44));
            expect(result.value.lookupMatched).toBe(true);
            expect(fixture.events).toEqual(['build', 'built', 'verify', 'consume']);
            expect(verifier).toHaveBeenCalledOnce();
            expect(seen).toEqual([
                {
                    transportUin: TRANSPORT_UIN,
                    targetUin: TARGET_UIN,
                    sequence,
                    requestCommand: COMMAND,
                    rawBody: BODY,
                },
            ]);
            expect(TRANSPORT_UIN).not.toBe(TARGET_UIN);
            const parsed = decodeRequest(fixture.frame()!);
            expect(parsed.targetUin).toBe(TARGET_UIN);
            expect(parsed.sequence).toBe(sequence);
            expect(parsed.command).toEqual(COMMAND);
            expect(parsed.body).toEqual(BODY);
            expect(hex(parsed.reserved)).toBe(
                '6201aaba01050a00120144c201090a01331201111a0122d00100820201cc',
            );
            const slots = reserve.decodeTargetMsfSignOutput(0, candidateOutput());
            const encodedReserve = reserve.encodeTargetSso12ReserveFromNativeSlots(
                input.reserveBase,
                slots,
            );
            expect(parsed.reserved).toEqual(encodedReserve);
            expect(parsed.head).toEqual(
                headCodec.encodeTargetSso12Head({
                    ...input.head,
                    sequence,
                    reserved: encodedReserve,
                }),
            );
        },
    );

    it('normalizes negative zero to the same uint32 sequence in the callback and result', async () => {
        const input = options();
        const fixture = normalFake(-0);
        let callbackSequence: number | undefined;

        input.buildCandidate = (value) => {
            callbackSequence = value.sequence;
            return { status: 0, output: candidateOutput() };
        };

        const result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        expect(result.kind).toBe('response');

        if (result.kind !== 'response' || !fixture.frame()) {
            throw new Error('expected synthetic response and request');
        }

        expect(Object.is(callbackSequence, 0)).toBe(true);
        expect(Object.is(result.sequence, 0)).toBe(true);
        expect(decodeRequest(fixture.frame()!).sequence).toBe(0);
    });

    it('uses each partition length independently and preserves embedded zero bytes', async () => {
        const input = options();
        input.reserveBase = {};
        const output = new Uint8Array(0x300).fill(0xdd);
        output.set([0x10, 0], 0x000);
        output[0x0ff] = 2;
        output.set([0x20, 0x21, 0], 0x100);
        output[0x1ff] = 3;
        output.set([0x30, 0x31, 0x32, 0], 0x200);
        output[0x2ff] = 4;
        input.buildCandidate = () => ({ status: 0, output });
        const fixture = normalFake();
        expect(
            (await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input)).kind,
        ).toBe('response');
        expect(hex(decodeRequest(fixture.frame()!).reserved)).toBe(
            'c2010f0a0430313200120210001a03202100',
        );
    });

    it('activates field12 and field23 only when a slot makes field24 nonempty', async () => {
        const populated = options();
        populated.reserveBase = {
            field12: Uint8Array.of(0xaa),
            field23: [{ field1: new Uint8Array(), field2: Uint8Array.of(0x44) }],
        };
        const active = normalFake();
        expect(
            (await transaction.transactTargetRawCandidateReserveOnce(active.fake, populated)).kind,
        ).toBe('response');
        expect(hex(decodeRequest(active.frame()!).reserved)).toBe(
            '6201aaba01050a00120144c201090a01331201111a0122',
        );

        const empty = options();
        empty.reserveBase = {
            field12: Uint8Array.of(0xaa),
            field23: [{ field1: new Uint8Array(), field2: Uint8Array.of(0x44) }],
        };
        empty.buildCandidate = () => ({ status: -0, output: candidateOutput(true) });
        const omitted = normalFake();
        expect(
            (await transaction.transactTargetRawCandidateReserveOnce(omitted.fake, empty)).kind,
        ).toBe('response');
        expect(decodeRequest(omitted.frame()!).reserved).toEqual(new Uint8Array());
    });

    it('retains field26 and field32 in wire order even when all candidate slots are empty', async () => {
        const input = options();
        input.buildCandidate = () => ({ status: 0, output: candidateOutput(true) });
        const fixture = normalFake();
        expect(
            (await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input)).kind,
        ).toBe('response');
        expect(hex(decodeRequest(fixture.frame()!).reserved)).toBe(
            '6201aaba01050a00120144d00100820201cc',
        );
    });

    it('snapshots head, nested reserve and body before the awaited provider resumes', async () => {
        const entered = deferred<void>();
        const release = deferred<void>();
        const input = options();
        const fixture = normalFake();
        let observedCommand: Uint8Array | undefined;
        let observedBody: Uint8Array | undefined;
        let providerPrivateBody: Uint8Array | undefined;
        let argumentBody: Uint8Array | undefined;
        let argumentCommand: Uint8Array | undefined;

        input.buildCandidate = async (value) => {
            argumentBody = value.rawBody;
            argumentCommand = value.requestCommand;
            observedBody = Uint8Array.from(value.rawBody);
            observedCommand = Uint8Array.from(value.requestCommand);
            providerPrivateBody = Uint8Array.from(value.rawBody);
            entered.resolve();
            await release.promise;
            // Deliberately mutate the provider-visible views; the frame must use the entry snapshot.
            value.rawBody.fill(0);
            value.requestCommand.fill(0);
            return { status: 0, output: candidateOutput() };
        };

        const pending = transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        await entered.promise;
        input.head.a2.fill(0);
        input.head.requestCommand.fill(0);
        input.head.arg0 = 0;
        input.reserveBase.field12!.fill(0);
        input.reserveBase.field23![0].field2.fill(0);
        input.reserveBase.field26 = 123;
        input.reserveBase.field32!.fill(0);
        input.rawBody.fill(0);
        release.resolve();
        expect((await pending).kind).toBe('response');

        const parsed = decodeRequest(fixture.frame()!);
        expect(observedCommand).toEqual(COMMAND);
        expect(observedBody).toEqual(BODY);
        expect(argumentBody!.buffer).not.toBe(input.rawBody.buffer);
        expect(argumentCommand!.buffer).not.toBe(input.head.requestCommand.buffer);
        expect(parsed.a2).toEqual(Uint8Array.of(0xaa, 0));
        expect(parsed.command).toEqual(COMMAND);
        expect(parsed.body).toEqual(BODY);
        expect(hex(parsed.reserved)).toBe(
            '6201aaba01050a00120144c201090a01331201111a0122d00100820201cc',
        );
        expect(Buffer.from(parsed.head).readUInt32BE(8)).toBe(0xa1a2a3a4);
        // An independent copy retained by the provider is outside transaction ownership.
        expect(providerPrivateBody).toEqual(BODY);
    });

    it.each(['success', 'failure'] as const)(
        'best-effort clears ordinary borrowed callback views after %s without clearing independent output',
        async (mode) => {
            const input = options();
            const fixture = normalFake();
            const output = candidateOutput();
            const originalOutput = Uint8Array.from(output);
            let borrowedCommand: Uint8Array | undefined;
            let borrowedBody: Uint8Array | undefined;

            input.buildCandidate = ({ requestCommand, rawBody }) => {
                borrowedCommand = requestCommand;
                borrowedBody = rawBody;
                return { status: mode === 'success' ? 0 : -1, output };
            };

            const result = await transaction.transactTargetRawCandidateReserveOnce(
                fixture.fake,
                input,
            );
            expect(result.kind).toBe(mode === 'success' ? 'response' : 'failure');
            expect(borrowedCommand).toBeDefined();
            expect(borrowedBody).toBeDefined();
            expect(borrowedCommand).toEqual(new Uint8Array(COMMAND.length));
            expect(borrowedBody).toEqual(new Uint8Array(BODY.length));
            expect(input.head.requestCommand).toEqual(COMMAND);
            expect(input.rawBody).toEqual(BODY);
            expect(output).toEqual(originalOutput);
        },
    );

    it('copies a borrowed body used as the 0x300-byte output before clearing the borrowed view', async () => {
        const input = options();
        const fixture = normalFake();
        const original = candidateOutput();
        input.rawBody = Uint8Array.from(original);
        input.reserveBase = {};
        let borrowedBody: Uint8Array | undefined;

        input.buildCandidate = ({ rawBody }) => {
            borrowedBody = rawBody;
            return { status: 0, output: rawBody };
        };

        const result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        expect(result.kind).toBe('response');
        expect(borrowedBody).toBeDefined();
        expect(borrowedBody).toEqual(new Uint8Array(0x300));
        expect(input.rawBody).toEqual(original);
        const parsed = decodeRequest(fixture.frame()!);
        expect(parsed.body).toEqual(original);
        expect(hex(parsed.reserved)).toBe('c201090a01331201111a0122');
    });

    it('clears borrowed callback views again after a late provider rewrites them', async () => {
        const input = options();
        const resume = deferred<void>();
        const rewritten = deferred<void>();
        const finish = deferred<void>();
        const output = candidateOutput();
        const originalOutput = Uint8Array.from(output);
        let borrowedCommand: Uint8Array | undefined;
        let borrowedBody: Uint8Array | undefined;
        let lateBuild: Promise<void> | undefined;
        let lateFrame: Uint8Array | undefined;

        input.buildCandidate = async ({ requestCommand, rawBody }) => {
            borrowedCommand = requestCommand;
            borrowedBody = rawBody;
            await resume.promise;
            requestCommand.fill(0x51);
            rawBody.fill(0x52);
            rewritten.resolve();
            await finish.promise;
            return { status: 0, output };
        };

        const fake = transport(async (raw) => {
            lateBuild = Promise.resolve(raw.buildRequest(identity())).then(
                (built) => {
                    lateFrame = Uint8Array.from(built.frame);
                },
                () => undefined,
            );
            await Promise.resolve();
            return { kind: 'failure', code: 'fake-ended', writeState: 'not-written' };
        });

        try {
            const result = await transaction.transactTargetRawCandidateReserveOnce(fake, input);
            expect(result.kind).toBe('failure');
            expect(borrowedCommand).toEqual(new Uint8Array(COMMAND.length));
            expect(borrowedBody).toEqual(new Uint8Array(BODY.length));
            resume.resolve();
            const didRewrite = await Promise.race([
                rewritten.promise.then(() => true),
                lateBuild!.then(() => false),
            ]);
            expect(didRewrite).toBe(true);
            expect(borrowedCommand).toEqual(new Uint8Array(COMMAND.length).fill(0x51));
            expect(borrowedBody).toEqual(new Uint8Array(BODY.length).fill(0x52));
        } finally {
            resume.resolve();
            finish.resolve();
            await lateBuild;
        }

        expect(lateFrame).toBeUndefined();
        expect(borrowedCommand).toEqual(new Uint8Array(COMMAND.length));
        expect(borrowedBody).toEqual(new Uint8Array(BODY.length));
        expect(output).toEqual(originalOutput);
    });

    it.each([
        ['negative status', () => ({ status: -1, output: candidateOutput() })],
        ['positive status', () => ({ status: 1, output: candidateOutput() })],
        ['NaN status', () => ({ status: Number.NaN, output: candidateOutput() })],
        ['string status', () => ({ status: '0', output: candidateOutput() })],
        ['short output', () => ({ status: 0, output: new Uint8Array(0x2ff) })],
        ['long output', () => ({ status: 0, output: new Uint8Array(0x301) })],
        ['wrong view', () => ({ status: 0, output: new DataView(new ArrayBuffer(0x300)) })],
        [
            'shared output',
            () => ({ status: 0, output: new Uint8Array(new SharedArrayBuffer(0x300)) }),
        ],
        ['missing output', () => ({ status: 0 })],
    ] as const)('fails before a frame for %s', async (_name, value) => {
        const input = options();
        const build = vi.fn(value);
        input.buildCandidate = build as unknown as CandidateOptions['buildCandidate'];
        const verifier = vi.fn(() => true);
        input.verifyRaw = verifier;
        const fixture = normalFake();
        const result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        expect(result.kind).toBe('failure');
        expect(build).toHaveBeenCalledOnce();
        expect(fixture.frame()).toBeUndefined();
        expect(fixture.events).not.toContain('verify');
        expect(verifier).not.toHaveBeenCalled();
    });

    it.each(['throw', 'reject'] as const)(
        'fails without a frame when the provider %ss',
        async (mode) => {
            const input = options();
            const build = vi.fn(() => {
                if (mode === 'throw') {
                    throw new Error('private synthetic provider error');
                }

                return Promise.reject(new Error('private synthetic provider error'));
            });
            input.buildCandidate = build;
            const fixture = normalFake();
            const result = await transaction.transactTargetRawCandidateReserveOnce(
                fixture.fake,
                input,
            );
            expect(result.kind).toBe('failure');
            expect(JSON.stringify(result)).not.toContain('private synthetic provider error');
            expect(build).toHaveBeenCalledOnce();
            expect(fixture.frame()).toBeUndefined();
            expect(fixture.events).not.toContain('verify');
        },
    );

    it('rejects provider result getters and byte proxies without invoking their traps', async () => {
        const trap = vi.fn(() => {
            throw new Error('synthetic trap');
        });
        const getter = Object.defineProperty({ status: 0 }, 'output', { get: trap });
        const bytes = new Proxy(candidateOutput(), { get: trap, getPrototypeOf: trap });

        for (const value of [getter, { status: 0, output: bytes }]) {
            const input = options();
            input.buildCandidate = (() => value) as unknown as CandidateOptions['buildCandidate'];
            const fixture = normalFake();
            expect(
                (await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input)).kind,
            ).toBe('failure');
            expect(fixture.frame()).toBeUndefined();
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('observes the unavoidable then lookup before rejecting a provider result proxy', async () => {
        const reads: PropertyKey[] = [];
        const otherTrap = vi.fn(() => {
            throw new Error('synthetic proxy trap');
        });
        const proxy = new Proxy(
            { status: 0, output: candidateOutput() },
            {
                get(_target, key) {
                    reads.push(key);

                    if (key === 'then') {
                        return undefined;
                    }

                    return otherTrap();
                },
                ownKeys: otherTrap,
                getPrototypeOf: otherTrap,
            },
        );
        const input = options();
        input.buildCandidate = () => proxy;
        const fixture = normalFake();
        const result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        expect(result.kind).toBe('failure');
        expect(fixture.frame()).toBeUndefined();
        // Await/Promise assimilation performs this read before proxy validation is possible.
        expect(reads).toContain('then');
        expect(reads.every((key) => key === 'then')).toBe(true);
        expect(otherTrap).not.toHaveBeenCalled();
    });

    it('fails without modifying provider output when the callback replaces Uint8Array', async () => {
        const input = options();
        const fixture = normalFake();
        const output = candidateOutput();
        const originalOutput = Uint8Array.from(output);
        const OriginalUint8Array = globalThis.Uint8Array;
        const impostor = function Uint8ArrayFixture() {
            return output;
        } as unknown as Uint8ArrayConstructor;
        Object.setPrototypeOf(impostor, OriginalUint8Array);
        const build = vi.fn(() => {
            globalThis.Uint8Array = impostor;
            return { status: 0, output };
        });
        input.buildCandidate = build;
        let result: Awaited<ReturnType<TransactionModule['transactTargetRawCandidateReserveOnce']>>;

        try {
            result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        } finally {
            globalThis.Uint8Array = OriginalUint8Array;
        }

        expect(build).toHaveBeenCalledOnce();
        expect(result.kind).toBe('failure');
        expect(fixture.frame()).toBeUndefined();
        expect(output).toEqual(originalOutput);
    });

    it('fails without a frame when the callback replaces DataView with a sequence-zeroing constructor', async () => {
        const input = options();
        const fixture = normalFake();
        const output = candidateOutput();
        const OriginalDataView = globalThis.DataView;
        const SequenceZeroDataView = function (
            buffer: ArrayBufferLike,
            byteOffset?: number,
            byteLength?: number,
        ) {
            const view = new OriginalDataView(buffer, byteOffset, byteLength);
            const originalSet = view.setUint32;
            Object.defineProperty(view, 'setUint32', {
                value: (offset: number, value: number, littleEndian?: boolean) =>
                    originalSet.call(view, offset, offset === 4 ? 0 : value, littleEndian),
            });
            return view;
        } as unknown as DataViewConstructor;
        const build = vi.fn(() => {
            globalThis.DataView = SequenceZeroDataView;
            return { status: 0, output };
        });
        input.buildCandidate = build;
        let result: Awaited<ReturnType<TransactionModule['transactTargetRawCandidateReserveOnce']>>;

        try {
            result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        } finally {
            globalThis.DataView = OriginalDataView;
        }

        expect(build).toHaveBeenCalledOnce();
        expect(result.kind).toBe('failure');
        expect(fixture.frame()).toBeUndefined();
    });

    it('fails without a frame when the callback replaces DataView.prototype.setUint32', async () => {
        const input = options();
        const fixture = normalFake();
        const output = candidateOutput();
        const prototype = DataView.prototype;
        const original = Object.getOwnPropertyDescriptor(prototype, 'setUint32')!;
        const originalSet = original.value as DataView['setUint32'];
        const build = vi.fn(() => {
            Object.defineProperty(prototype, 'setUint32', {
                ...original,
                value: function (
                    this: DataView,
                    byteOffset: number,
                    value: number,
                    littleEndian?: boolean,
                ) {
                    return originalSet.call(
                        this,
                        byteOffset,
                        byteOffset === 4 ? 0 : value,
                        littleEndian,
                    );
                },
            });
            return { status: 0, output };
        });
        input.buildCandidate = build;
        let result: Awaited<ReturnType<TransactionModule['transactTargetRawCandidateReserveOnce']>>;

        try {
            result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        } finally {
            Object.defineProperty(prototype, 'setUint32', original);
        }

        expect(build).toHaveBeenCalledOnce();
        expect(result.kind).toBe('failure');
        expect(fixture.frame()).toBeUndefined();
    });

    it('rejects a changed response even if the verifier replaces typed-array every', async () => {
        const input = options();
        const prototype = Uint8Array.prototype;
        const original = Object.getOwnPropertyDescriptor(prototype, 'every');

        input.verifyRaw = () => {
            Object.defineProperty(prototype, 'every', {
                configurable: true,
                writable: true,
                value: () => true,
            });
            return true;
        };

        const fake = transport(async (raw) => {
            try {
                const built = await raw.buildRequest(identity());
                const accepted = await raw.verifyCandidate(response(), built.context, identity());

                if (accepted !== true) {
                    return { kind: 'failure', code: 'fake-rejected', writeState: 'unknown' };
                }

                const changed = response();
                changed[4] ^= 1;
                const value = await raw.consumeCandidate(changed, built.context, identity());
                return { kind: 'response', sequence: SEQUENCE, value, writeState: 'written' };
            } catch {
                return { kind: 'failure', code: 'fake-caught', writeState: 'unknown' };
            }
        });
        let result: Awaited<ReturnType<TransactionModule['transactTargetRawCandidateReserveOnce']>>;

        try {
            result = await transaction.transactTargetRawCandidateReserveOnce(fake, input);
        } finally {
            if (original) {
                Object.defineProperty(prototype, 'every', original);
            } else {
                Reflect.deleteProperty(prototype, 'every');
            }
        }

        expect(result.kind).toBe('failure');
    });

    it('rejects a callback that replaces Array.prototype.push', async () => {
        const input = options();
        const fixture = normalFake();
        const output = candidateOutput();
        const prototype = Array.prototype;
        const original = Object.getOwnPropertyDescriptor(prototype, 'push')!;

        input.buildCandidate = () => {
            Object.defineProperty(prototype, 'push', {
                ...original,
                value: function (this: unknown[], ...values: unknown[]) {
                    return Reflect.apply(
                        original.value as (...items: unknown[]) => number,
                        this,
                        values,
                    );
                },
            });
            return { status: 0, output };
        };

        let result: Awaited<ReturnType<TransactionModule['transactTargetRawCandidateReserveOnce']>>;

        try {
            result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        } finally {
            Object.defineProperty(prototype, 'push', original);
        }

        expect(result.kind).toBe('failure');
        expect(fixture.frame()).toBeUndefined();
    });

    it('rejects a callback that replaces Object.getOwnPropertyDescriptors', async () => {
        const input = options();
        const fixture = normalFake();
        const output = candidateOutput();
        const original = Object.getOwnPropertyDescriptors;

        input.buildCandidate = () => {
            Object.getOwnPropertyDescriptors = ((value: object) => {
                const descriptors = original(value) as Record<string, PropertyDescriptor>;

                if (descriptors.sequence && descriptors.reserved && descriptors.arg0) {
                    descriptors.sequence.value = 0;
                }

                return descriptors;
            }) as typeof Object.getOwnPropertyDescriptors;
            return { status: 0, output };
        };

        let result: Awaited<ReturnType<TransactionModule['transactTargetRawCandidateReserveOnce']>>;

        try {
            result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        } finally {
            Object.getOwnPropertyDescriptors = original;
        }

        expect(result.kind).toBe('failure');
        expect(fixture.frame()).toBeUndefined();
    });

    it.each([0, 1])(
        'enforces the aggregate input budget at the boundary plus %i',
        async (extra) => {
            const input = options();
            const max = 16 * 1024 * 1024;
            input.timeoutMs = 10_000;
            const byteFields = [
                input.head.a2,
                input.head.requestCommand,
                input.head.this8,
                input.head.arg28,
                input.head.this20,
                input.head.versionArg10,
                input.reserveBase.field12!,
                input.reserveBase.field23![0].field1,
                input.reserveBase.field23![0].field2,
                input.reserveBase.field32!,
                input.rawBody,
                input.service.targetTeaKey,
            ];
            const branch = input.service.basicBranch;

            if (branch.kind !== 'span') {
                throw new Error('expected fixture span');
            }

            const fixed =
                0x300 +
                branch.span.length +
                byteFields.reduce((sum, bytes) => sum + bytes.length, 0);
            input.response.collection = [new Uint8Array(max - fixed + extra)];
            const fake = {
                transactRaw: vi.fn(async () => ({
                    kind: 'failure',
                    code: 'fixture',
                    writeState: 'not-written',
                })),
            } as unknown as Sso12RawTransport;
            const result = await transaction.transactTargetRawCandidateReserveOnce(fake, input);

            if (extra === 0) {
                expect(result).toEqual({
                    kind: 'failure',
                    code: 'fixture',
                    writeState: 'not-written',
                });
                expect(fake.transactRaw).toHaveBeenCalledOnce();
            } else {
                expect(result).toEqual({
                    kind: 'failure',
                    code: 'target-input-invalid',
                    writeState: 'not-written',
                });
                expect(fake.transactRaw).not.toHaveBeenCalled();
            }
        },
    );

    it('rejects a frame that only exceeds the limit after nonempty slots are encoded', async () => {
        const input = options();
        const max = 16 * 1024 * 1024;
        input.timeoutMs = 10_000;
        input.reserveBase = {};
        input.response.collection = [];
        const branch = input.service.basicBranch;

        if (branch.kind !== 'span') {
            throw new Error('expected fixture span');
        }

        const headFields = [
            input.head.a2,
            input.head.requestCommand,
            input.head.this8,
            input.head.arg28,
            input.head.this20,
            input.head.versionArg10,
        ];
        const fixed =
            0x300 +
            branch.span.length +
            input.service.targetTeaKey.length +
            headFields.reduce((sum, bytes) => sum + bytes.length, 0);
        input.rawBody = new Uint8Array(max - fixed);
        const candidate = new Uint8Array(0x300).fill(0x7a);
        candidate[0xff] = 0xff;
        candidate[0x1ff] = 0xff;
        candidate[0x2ff] = 0xff;
        const provider = vi.fn(() => ({ status: 0, output: candidate }));
        input.buildCandidate = provider;
        let built = false;
        const fake = transport(async (raw) => {
            try {
                await raw.buildRequest(identity());
                built = true;
            } catch {
                return { kind: 'failure', code: 'fake-too-large', writeState: 'not-written' };
            }

            return { kind: 'failure', code: 'unexpected-built-frame', writeState: 'unknown' };
        });
        const result = await transaction.transactTargetRawCandidateReserveOnce(fake, input);
        expect(provider).toHaveBeenCalledOnce();
        expect(built).toBe(false);
        expect(result.kind).toBe('failure');
    });

    it('rechecks frame size when a slot activates a large field23 base', async () => {
        const input = options();
        input.timeoutMs = 10_000;
        const empty = () => new Uint8Array();
        input.head = {
            ...input.head,
            a2: empty(),
            requestCommand: empty(),
            this8: empty(),
            arg28: empty(),
            this20: empty(),
            versionArg10: empty(),
        };
        input.reserveBase = {
            field23: Array.from({ length: 4096 }, () => ({ field1: empty(), field2: empty() })),
        };
        input.response.collection = [];
        input.service.basicBranch = { kind: 'span', virtualResultByte: 0, span: empty() };
        input.service.uin = '';
        input.rawBody = new Uint8Array(
            16 * 1024 * 1024 - 0x300 - input.service.targetTeaKey.length,
        );
        const provider = vi.fn(() => ({ status: 0, output: candidateOutput() }));
        input.buildCandidate = provider;
        let built = false;
        const fake = transport(async (raw) => {
            try {
                await raw.buildRequest(identity());
                built = true;
            } catch {
                return { kind: 'failure', code: 'fake-too-large', writeState: 'not-written' };
            }

            return { kind: 'failure', code: 'unexpected-built-frame', writeState: 'unknown' };
        });
        const result = await transaction.transactTargetRawCandidateReserveOnce(fake, input);
        expect(provider).toHaveBeenCalledOnce();
        expect(built).toBe(false);
        expect(result.kind).toBe('failure');
    });

    it('rejects invalid input getters, proxies and shared bytes before the fake transport', async () => {
        const trap = vi.fn(() => {
            throw new Error('synthetic trap');
        });
        const mutations: Array<(input: CandidateOptions) => void> = [
            (input) => {
                Object.defineProperty(input.head, 'requestCommand', { get: trap });
            },
            (input) => {
                Object.defineProperty(input.reserveBase, 'field12', { get: trap });
            },
            (input) => {
                input.head = new Proxy(input.head, {
                    get: trap,
                    ownKeys: trap,
                    getPrototypeOf: trap,
                });
            },
            (input) => {
                input.reserveBase = new Proxy(input.reserveBase, {
                    get: trap,
                    ownKeys: trap,
                    getPrototypeOf: trap,
                });
            },
            (input) => {
                input.rawBody = new Uint8Array(new SharedArrayBuffer(BODY.length));
            },
            (input) => {
                input.head.requestCommand = new Uint8Array(new SharedArrayBuffer(COMMAND.length));
            },
            (input) => {
                input.reserveBase.field23![0].field2 = new Uint8Array(new SharedArrayBuffer(1));
            },
        ];

        for (const mutate of mutations) {
            const input = options();
            const build = vi.fn(input.buildCandidate);
            input.buildCandidate = build;
            const transactRaw = vi.fn();
            mutate(input);
            const result = await transaction.transactTargetRawCandidateReserveOnce(
                { transactRaw } as unknown as Sso12RawTransport,
                input,
            );
            expect(result.kind).toBe('failure');
            expect(transactRaw).not.toHaveBeenCalled();
            expect(build).not.toHaveBeenCalled();
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it.each([
        'verify-uin',
        'verify-sequence',
        'consume-uin',
        'consume-sequence',
        'result-sequence',
        'frame',
    ] as const)('fails closed when the fake changes %s', async (mode) => {
        const input = options();
        const original = response();
        const changed = Uint8Array.from(original);
        changed[4] ^= 1;
        const fake = transport(async (raw) => {
            const first = identity();
            const mismatch = mode.endsWith('uin')
                ? { ...first, uin: 'other-transport-fixture' }
                : { ...first, sequence: 1 };

            try {
                const built = await raw.buildRequest(first);
                const accepted = await raw.verifyCandidate(
                    original,
                    built.context,
                    mode.startsWith('verify-') ? mismatch : identity(),
                );

                if (!accepted) {
                    return { kind: 'failure', code: 'fake-rejected', writeState: 'unknown' };
                }

                const value = await raw.consumeCandidate(
                    mode === 'frame' ? changed : original,
                    built.context,
                    mode.startsWith('consume-') ? mismatch : identity(),
                );
                return {
                    kind: 'response',
                    sequence: mode === 'result-sequence' ? 1 : first.sequence,
                    value,
                    writeState: 'written',
                };
            } catch {
                return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
            }
        });
        expect((await transaction.transactTargetRawCandidateReserveOnce(fake, input)).kind).toBe(
            'failure',
        );
    });

    it.each(['build', 'verify', 'consume'] as const)(
        'fails closed when the fake swallows a repeated %s phase',
        async (repeated) => {
            const input = options();
            const fake = transport(async (raw) => {
                const id = identity();
                const candidate = response();
                const built = await raw.buildRequest(id);
                const accepted = await raw.verifyCandidate(candidate, built.context, identity());

                if (!accepted) {
                    return { kind: 'failure', code: 'fake-rejected', writeState: 'unknown' };
                }

                const value = await raw.consumeCandidate(candidate, built.context, identity());

                try {
                    if (repeated === 'build') {
                        await raw.buildRequest(identity());
                    } else if (repeated === 'verify') {
                        await raw.verifyCandidate(candidate, built.context, identity());
                    } else {
                        await raw.consumeCandidate(candidate, built.context, identity());
                    }
                } catch {
                    // Deliberately misbehaving fake swallows the repeated callback failure.
                }

                return { kind: 'response', sequence: id.sequence, value, writeState: 'written' };
            });
            expect(
                (await transaction.transactTargetRawCandidateReserveOnce(fake, input)).kind,
            ).toBe('failure');
        },
    );

    it('fails closed when the provider reenters build and swallows the nested error', async () => {
        const input = options();
        let raw: Raw | undefined;
        let nested: Promise<unknown> | undefined;
        let calls = 0;

        input.buildCandidate = () => {
            calls++;

            if (calls === 1) {
                try {
                    nested = Promise.resolve(raw!.buildRequest(identity())).catch(() => undefined);
                } catch {
                    // The raw builder may reject synchronously.
                }
            }

            return { status: 0, output: candidateOutput() };
        };

        const fake = transport(async (callbacks) => {
            raw = callbacks;

            try {
                const built = await callbacks.buildRequest(identity());
                const accepted = await callbacks.verifyCandidate(
                    response(),
                    built.context,
                    identity(),
                );

                if (!accepted) {
                    return { kind: 'failure', code: 'fake-rejected', writeState: 'unknown' };
                }

                const value = await callbacks.consumeCandidate(
                    response(),
                    built.context,
                    identity(),
                );
                return { kind: 'response', sequence: SEQUENCE, value, writeState: 'written' };
            } catch {
                return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
            }
        });
        expect((await transaction.transactTargetRawCandidateReserveOnce(fake, input)).kind).toBe(
            'failure',
        );
        await nested;
        expect(calls).toBe(1);
    });

    it('throws synchronously on identity-getter build reentry without an unhandled rejection', async () => {
        const input = options();
        const build = vi.fn(input.buildCandidate);
        input.buildCandidate = build;
        let nestedThrows = 0;
        let getterCalls = 0;
        const unhandled: unknown[] = [];

        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };

        const fake = transport(async (raw) => {
            const hostile: Sso12RawIdentity = {
                get uin() {
                    getterCalls++;

                    try {
                        // Intentionally neither await nor attach a handler to the nested result.
                        void raw.buildRequest(identity());
                    } catch {
                        nestedThrows++;
                    }

                    return TRANSPORT_UIN;
                },
                sequence: SEQUENCE,
            };

            try {
                // The fake deliberately discards the outer asynchronous result as well.
                void raw.buildRequest(hostile);
            } catch {
                // A synchronous outer failure is also an acceptable fail-closed outcome.
            }

            return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
        });
        process.on('unhandledRejection', onUnhandled);

        try {
            const result = await transaction.transactTargetRawCandidateReserveOnce(fake, input);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(result.kind).toBe('failure');
            expect(getterCalls).toBe(1);
            expect(nestedThrows).toBe(1);
            expect(build).not.toHaveBeenCalled();
            expect(unhandled).toEqual([]);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    it('handles a late provider rejection when the fake discards the asynchronous build result', async () => {
        const input = options();
        const release = deferred<void>();
        const unhandled: unknown[] = [];

        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };

        const build = vi.fn(async () => {
            await release.promise;
            throw new Error('synthetic late provider failure');
        });
        input.buildCandidate = build;
        const fake = transport(async (raw) => {
            // No consumer attaches a handler to this promise; the transaction must do so.
            void raw.buildRequest(identity());
            await Promise.resolve();
            return { kind: 'failure', code: 'fake-ended', writeState: 'not-written' };
        });
        process.on('unhandledRejection', onUnhandled);

        try {
            const result = await transaction.transactTargetRawCandidateReserveOnce(fake, input);
            expect(result.kind).toBe('failure');
            expect(build).toHaveBeenCalledOnce();
            release.resolve();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally {
            release.resolve();
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    it('uses the bound candidate clock after the provider replaces global performance', async () => {
        const input = options();
        input.timeoutMs = 100;
        const fixture = normalFake();
        const realPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
        const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
        vi.resetModules();
        transaction = await import('../../src/direct/target-raw-transaction');
        const provider = vi.fn(() => {
            clock.mockReturnValue(101);
            Object.defineProperty(globalThis, 'performance', {
                configurable: true,
                writable: true,
                value: { now: () => 0 },
            });
            return { status: 0, output: candidateOutput() };
        });
        input.buildCandidate = provider;
        let result: Awaited<ReturnType<TransactionModule['transactTargetRawCandidateReserveOnce']>>;

        try {
            result = await transaction.transactTargetRawCandidateReserveOnce(fixture.fake, input);
        } finally {
            if (realPerformance) {
                Object.defineProperty(globalThis, 'performance', realPerformance);
            } else {
                Reflect.deleteProperty(globalThis, 'performance');
            }

            clock.mockRestore();
        }

        expect(provider).toHaveBeenCalledOnce();
        expect(result.kind).toBe('failure');
        expect(fixture.frame()).toBeUndefined();
    });

    it('returns pre-aborted failure before the fake transport or provider is called', async () => {
        const controller = new AbortController();
        controller.abort();
        const input = options();
        input.signal = controller.signal;
        const build = vi.fn(input.buildCandidate);
        input.buildCandidate = build;
        const transactRaw = vi.fn();
        const result = await transaction.transactTargetRawCandidateReserveOnce(
            { transactRaw } as unknown as Sso12RawTransport,
            input,
        );
        expect(result.kind).toBe('failure');
        expect(transactRaw).not.toHaveBeenCalled();
        expect(build).not.toHaveBeenCalled();
    });

    it('propagates abort to the fake despite stopped original events and shadowed original getters', async () => {
        // This checks local Node AbortSignal.any plus the controlled fake, not a real client.
        const controller = new AbortController();
        const original = controller.signal;
        const blocker = vi.fn((event: Event) => event.stopImmediatePropagation());
        original.addEventListener('abort', blocker);
        const shadowReads = { addEventListener: 0, aborted: 0 };
        Object.defineProperties(original, {
            addEventListener: {
                configurable: true,
                get() {
                    shadowReads.addEventListener++;
                    throw new Error('synthetic original addEventListener getter');
                },
            },
            aborted: {
                configurable: true,
                get() {
                    shadowReads.aborted++;
                    throw new Error('synthetic original aborted getter');
                },
            },
        });

        const input = options();
        input.signal = original;
        const entered = deferred<void>();
        const releaseProvider = deferred<void>();
        const fakeCancelled = deferred<void>();
        const teardown = deferred<void>();
        let receivedSignal: AbortSignal | undefined;
        let lateBuild: Promise<void> | undefined;
        let lateFrame: Uint8Array | undefined;
        let fakeAbortCalls = 0;
        let fakeCode: string | undefined;
        let providerFinished = false;
        const verifier = vi.fn(() => true);
        input.verifyRaw = verifier;

        input.buildCandidate = async () => {
            entered.resolve();
            await releaseProvider.promise;
            providerFinished = true;
            return { status: 0, output: candidateOutput() };
        };

        const fake = transport(async (raw) => {
            receivedSignal = raw.signal;

            if (!receivedSignal) {
                throw new Error('missing fake signal');
            }

            // Observe only the signal provided to the transport, never the original.
            receivedSignal.addEventListener(
                'abort',
                () => {
                    fakeAbortCalls++;
                    fakeCancelled.resolve();
                },
                { once: true },
            );
            lateBuild = Promise.resolve(raw.buildRequest(identity())).then(
                (built) => {
                    lateFrame = Uint8Array.from(built.frame);
                },
                () => undefined,
            );
            const completion = await Promise.race([
                fakeCancelled.promise.then(() => 'cancel' as const),
                // This branch is only for releasing a broken fake during test cleanup.
                teardown.promise.then(() => 'teardown' as const),
            ]);
            fakeCode = completion === 'cancel' ? 'fake-cancel' : 'fake-teardown';
            return { kind: 'failure', code: fakeCode, writeState: 'not-written' };
        });
        const pending = transaction.transactTargetRawCandidateReserveOnce(fake, input);

        try {
            const state = await Promise.race([
                entered.promise.then(() => 'entered' as const),
                pending.then(() => 'settled' as const),
                new Promise<'watchdog'>((resolve) => setImmediate(() => resolve('watchdog'))),
            ]);
            expect(state).toBe('entered');
            expect(receivedSignal).toBeDefined();
            expect(receivedSignal).not.toBe(original);
            expect(providerFinished).toBe(false);
            controller.abort();
            expect(blocker).toHaveBeenCalledOnce();
            expect(fakeAbortCalls).toBe(1);
            expect(shadowReads).toEqual({ addEventListener: 0, aborted: 0 });
            const result = await pending;
            expect(result.kind).toBe('failure');
            expect(fakeCode).toBe('fake-cancel');
            expect(lateFrame).toBeUndefined();
            expect(providerFinished).toBe(false);
            releaseProvider.resolve();
            await lateBuild;
            expect(providerFinished).toBe(true);
            expect(lateFrame).toBeUndefined();
            expect(verifier).not.toHaveBeenCalled();
            expect(shadowReads).toEqual({ addEventListener: 0, aborted: 0 });
        } finally {
            teardown.resolve();
            releaseProvider.resolve();
            await Promise.allSettled([pending, lateBuild]);
        }
    });

    it.each(['abort', 'timeout'] as const)(
        'ignores a delayed provider result after a fake %s outcome',
        async (mode) => {
            const input = options();
            const controller = new AbortController();
            input.signal = controller.signal;
            const entered = deferred<void>();
            const releaseProvider = deferred<void>();
            const stopFake = deferred<void>();
            let lateBuild: Promise<void> | undefined;
            let lateFrame: Uint8Array | undefined;
            let receivedSignal: AbortSignal | undefined;
            let receivedTimeout: number | undefined;
            let verifyCalls = 0;

            input.buildCandidate = async () => {
                entered.resolve();
                await releaseProvider.promise;
                return { status: 0, output: candidateOutput() };
            };

            const fake = transport(async (raw) => {
                receivedSignal = raw.signal;
                receivedTimeout = raw.timeoutMs;
                lateBuild = Promise.resolve(raw.buildRequest(identity())).then(
                    (built) => {
                        lateFrame = Uint8Array.from(built.frame);
                    },
                    () => undefined,
                );
                await stopFake.promise;
                // This fake declares its own outcome; it does not model a real client timer.
                return { kind: 'failure', code: `fake-${mode}`, writeState: 'not-written' };
            });

            input.verifyRaw = () => {
                verifyCalls++;
                return true;
            };

            const pending = transaction.transactTargetRawCandidateReserveOnce(fake, input);
            await entered.promise;

            if (mode === 'abort') {
                controller.abort();
            }

            stopFake.resolve();
            expect((await pending).kind).toBe('failure');
            expect(receivedSignal).toBeDefined();
            expect(receivedSignal!.aborted).toBe(mode === 'abort');
            expect(receivedTimeout).toBeGreaterThan(0);
            expect(receivedTimeout).toBeLessThanOrEqual(input.timeoutMs);
            releaseProvider.resolve();
            await lateBuild;
            expect(lateFrame).toBeUndefined();
            expect(verifyCalls).toBe(0);
        },
    );
});

describe('legacy synchronous raw build regression using the same fake boundary', () => {
    it('throws synchronously for a retained build callback after settlement', async () => {
        let retained: Raw | undefined;
        const fake = transport(async (raw) => {
            retained = raw;
            return { kind: 'failure', code: 'fake-ended', writeState: 'not-written' };
        });
        expect((await transaction.transactTargetRawOnce(fake, legacyOptions())).kind).toBe(
            'failure',
        );
        expect(retained).toBeDefined();
        expect(() => retained!.buildRequest(identity())).toThrow();
    });

    it('fails closed after an identity getter synchronously reenters build and swallows the error', async () => {
        let nested = 0;
        let builtFrame: Uint8Array | undefined;
        const fake = transport(async (raw) => {
            const hostile = {
                get uin() {
                    try {
                        raw.buildRequest(identity());
                    } catch {
                        nested++;
                    }

                    return TRANSPORT_UIN;
                },
                sequence: SEQUENCE,
            };

            try {
                const built = await raw.buildRequest(hostile);
                builtFrame = Uint8Array.from(built.frame);
                const accepted = await raw.verifyCandidate(response(), built.context, identity());

                if (!accepted) {
                    return { kind: 'failure', code: 'fake-rejected', writeState: 'unknown' };
                }

                const value = await raw.consumeCandidate(response(), built.context, identity());
                return { kind: 'response', sequence: SEQUENCE, value, writeState: 'written' };
            } catch {
                return { kind: 'failure', code: 'fake-caught', writeState: 'not-written' };
            }
        });
        const result = await transaction.transactTargetRawOnce(fake, legacyOptions());
        expect(result.kind).toBe('failure');
        expect(nested).toBe(1);
        expect(builtFrame).toBeUndefined();
    });
});
