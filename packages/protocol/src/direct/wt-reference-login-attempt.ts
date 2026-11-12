import type { Socket } from 'node:net';
import { isProxy } from 'node:util/types';
import { Sso12PacketClient, type Sso12PacketClientOptions } from './sso12-packet-client';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import { createWtEcdh } from './wt-ecdh';
import { buildWtQrOicq, type WtQrFrameOperation, type WtQrOicqContext } from './wt-qr-frame';
import { decodeWtQrD1Response } from './wt-qr-protobuf';
import { decodeWtQrFetchResponse, decodeWtQrPollResponse } from './wt-qr-response';
import {
    decodeWtCode2dResponse,
    decodeWtOicqResponse,
    encodeWtPcLoginOicqRequest,
} from './wt-oicq';
import { encodeWtLoginRequestBody, type WtLoginRequestBody } from './wt-login-request';
import { decodeWtLoginResponse } from './wt-login-response';

type Operation = 'fetch' | 'poll' | 'login';
type FetchFields = Extract<WtQrFrameOperation, { type: 'fetch' }>['fields'];
type LoginFields = Omit<
    WtLoginRequestBody,
    | 'uin'
    | 'appId'
    | 'subAppId'
    | 'appClientVersion'
    | 'guid'
    | 'temporaryA1'
    | 'noPicSig'
    | 'tgtgtKey'
>;
type State =
    'new' | 'qr-ready' | 'confirmed-held' | 'login-inflight' | 'tickets' | 'failed' | 'closed';
type Context = {
    requestFrame: Uint8Array;
    requestOicq: Uint8Array;
    account: string;
    command: string;
    operation: Operation;
};
export type WtReferenceLoginResult =
    | {
          status: 'tickets';
          /** Confirmed UIN accepted by the caller's context policy; not server authentication. */
          readonly uin: string;
          tickets: { d2: Uint8Array; d2Key: Uint8Array; a1: Uint8Array; a2: Uint8Array };
      }
    | { status: 'verification-required' | 'nonzero' | 'incomplete'; state: number }
    | { status: 'error'; state: number; code: number };

type Held = {
    uin: bigint;
    decimal: string;
    number: number;
    tgtgtKey: Uint8Array;
    noPicSig: Uint8Array;
    temporaryA1: Uint8Array;
};

const typedArrayFill = Uint8Array.prototype.fill;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const sharedLength = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;

function wipeOwned(bytes: Uint8Array): void {
    try {
        typedArrayFill.call(bytes, 0);
    } catch {
        /* Detached callback-visible buffers cannot be erased. */
    }
}

function snapshotRecord(value: object): object {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        throw new Error('invalid record');
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('invalid record');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const name of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, name) as PropertyDescriptor;

        if (!('value' in descriptor)) {
            throw new Error('invalid record');
        }

        if (typeof name === 'string') {
            result[name] = descriptor.value;
        }
    }

    return result;
}

function snapshotBytes(value: unknown, maximum: number): Uint8Array {
    if (!ArrayBuffer.isView(value) || typedArrayTag.call(value) !== 'Uint8Array') {
        throw new Error('invalid bytes');
    }

    const backing: unknown = backingBuffer.call(value);
    let shared = false;

    try {
        sharedLength.call(backing);
        shared = true;
    } catch {
        /* ordinary ArrayBuffer */
    }

    if (shared || (byteLength.call(value) as number) > maximum) {
        throw new Error('invalid bytes');
    }

    return new Uint8Array(value as Uint8Array);
}

export interface WtReferenceLoginAttemptOptions {
    socket: Socket;
    profile: Omit<WtQrOicqContext, 'timestamp' | 'ecdh'> & {
        ssoVersion: string;
        qrCommand: string;
        loginCommand: string;
    };
    /** Per-transaction timeout and separate local whole-attempt lifetime; neither is server expiry. */
    timeoutMs: number;
    attemptTimeoutMs: number;
    initialSequence?: number;
    /** Cancels the whole attempt, including while confirmation is held. */
    signal?: AbortSignal;
    getTimestamp: () => number;
    buildReserved: Sso12PacketClientOptions['buildReserved'];
    /** Receives separate snapshots of the actual request and raw response; implements trust policy. */
    verifyRaw: (evidence: {
        operation: Operation;
        transportUin: string;
        requestUin: string;
        sequence: number;
        command: string;
        requestFrame: Uint8Array;
        requestOicq: Uint8Array;
        responseFrame: Uint8Array;
    }) => boolean | Promise<boolean>;
    /** Explicit business context policy; QR response identities may differ from initial account. */
    verifyContext: (context: {
        operation: Operation;
        transportUin: string;
        requestUin: string;
        responseUin: string;
        sequence: number;
        command: string;
        oicqCommand: number;
        oicqSequence: number;
        oicqUin: number;
        code2dCommand?: number;
        code2dSequence?: number;
        code2dUin?: bigint;
        businessUin?: bigint;
        businessAppId?: number;
    }) => boolean | Promise<boolean>;
    /** Exact half-open business range inside decoded code2d or login OICQ body. */
    sliceBusiness: (input: { operation: Operation; bodyLength: number }) => {
        start: number;
        end: number;
    };
}

/** Reference-only attempt. External callbacks can retain or act on copies; JS/crypto erasure is best effort.
 * QQ-TEA does not authenticate. Parsed tickets do not register or establish online state. */
export class WtReferenceLoginAttempt {
    private readonly client: Sso12PacketClient;
    private readonly socket: Socket;
    private readonly p: WtReferenceLoginAttemptOptions['profile'];
    private readonly ecdh = createWtEcdh();
    private readonly timeout: number;
    private readonly deadline: number;
    private lifetimeTimer?: ReturnType<typeof setTimeout>;
    private readonly clock: WtReferenceLoginAttemptOptions['getTimestamp'];
    private readonly signer: WtReferenceLoginAttemptOptions['buildReserved'];
    private readonly verifier: WtReferenceLoginAttemptOptions['verifyRaw'];
    private readonly contextVerifier: WtReferenceLoginAttemptOptions['verifyContext'];
    private readonly slicer: WtReferenceLoginAttemptOptions['sliceBusiness'];
    private readonly signal?: AbortSignal;
    private readonly controller = new AbortController();
    private readonly onAbort = () => this.fail();
    private state: State = 'new';
    private busy = false;
    private qrSig?: Uint8Array;
    private held?: Held;

    constructor(options: WtReferenceLoginAttemptOptions) {
        const started = performance.now();
        options = snapshotRecord(options) as WtReferenceLoginAttemptOptions;

        if (
            !options.profile ||
            !Number.isInteger(options.timeoutMs) ||
            options.timeoutMs < 1 ||
            options.timeoutMs > 0x7fffffff ||
            !Number.isInteger(options.attemptTimeoutMs) ||
            options.attemptTimeoutMs < 1 ||
            options.attemptTimeoutMs > 0x7fffffff ||
            typeof options.getTimestamp !== 'function' ||
            typeof options.buildReserved !== 'function' ||
            typeof options.verifyRaw !== 'function' ||
            typeof options.verifyContext !== 'function' ||
            typeof options.sliceBusiness !== 'function'
        ) {
            throw new TypeError('invalid attempt configuration');
        }

        // Validate the genuine AbortSignal internal slot before claiming the caller's socket.
        if (options.signal !== undefined) {
            if (isProxy(options.signal)) {
                throw new TypeError('invalid attempt signal');
            }

            try {
                signalAborted.call(options.signal);
            } catch {
                throw new TypeError('invalid attempt signal');
            }
        }

        const p = snapshotRecord(options.profile) as WtReferenceLoginAttemptOptions['profile'];
        const {
            uin,
            appId,
            subAppId,
            clientVersion,
            ssoVersion,
            qrCommand,
            loginCommand,
            guid,
            unknown21,
            randomKey,
            peerPublicKey,
        } = p;
        const guidBytes = snapshotBytes(guid, 0xffff);
        const unknownBytes = snapshotBytes(unknown21, 21);
        const randomBytes = snapshotBytes(randomKey, 16);
        const peerBytes = snapshotBytes(peerPublicKey, 0xffff);

        if (
            typeof uin !== 'string' ||
            !/^(0|[1-9][0-9]{0,18})$/.test(uin) ||
            BigInt(uin) > 0x7fffffffffffffffn ||
            !Number.isInteger(appId) ||
            appId < 0 ||
            appId > 0xffffffff ||
            !Number.isInteger(subAppId) ||
            subAppId < 0 ||
            subAppId > 0x7fffffff ||
            !Number.isInteger(clientVersion) ||
            clientVersion < 0 ||
            clientVersion > 0xffff ||
            typeof ssoVersion !== 'string' ||
            !ssoVersion ||
            typeof qrCommand !== 'string' ||
            !qrCommand ||
            typeof loginCommand !== 'string' ||
            !loginCommand ||
            !guidBytes.length ||
            unknownBytes.length !== 21 ||
            randomBytes.length !== 16
        ) {
            throw new TypeError('invalid attempt profile');
        }

        this.p = {
            uin,
            appId,
            subAppId,
            clientVersion,
            ssoVersion,
            qrCommand,
            loginCommand,
            guid: guidBytes,
            unknown21: unknownBytes,
            randomKey: randomBytes,
            peerPublicKey: peerBytes,
        };
        this.ecdh.deriveTeaKey(this.p.peerPublicKey).fill(0);
        this.socket = options.socket;
        this.timeout = options.timeoutMs;
        this.deadline = started + options.attemptTimeoutMs;
        this.clock = options.getTimestamp;
        this.signer = options.buildReserved;
        this.verifier = options.verifyRaw;
        this.contextVerifier = options.verifyContext;
        this.slicer = options.sliceBusiness;
        this.signal = options.signal;
        this.client = new Sso12PacketClient({
            socket: options.socket,
            uin,
            encryption: { type: 'zero' },
            subAppId,
            guid: this.p.guid,
            version: ssoVersion,
            a2: new Uint8Array(),
            buildReserved: this.signer,
            classifyIncoming: () => 'response',
            initialSequence: options.initialSequence,
            defaultTimeoutMs: this.timeout,
        });
        this.lifetimeTimer = setTimeout(
            this.onAbort,
            Math.max(1, Math.ceil(this.deadline - performance.now())),
        );

        try {
            if (this.signal) {
                addListener.call(this.signal, 'abort', this.onAbort, { once: true });
            }

            if (
                (this.signal && signalAborted.call(this.signal)) ||
                performance.now() >= this.deadline
            ) {
                this.fail();
            }
        } catch {
            this.fail();
            throw new Error('invalid attempt signal');
        }

        void this.client.whenClosed.then(() => {
            if (this.state !== 'tickets' && this.state !== 'closed') {
                this.fail();
            }
        });
    }

    getState(): State {
        return this.state;
    }

    async fetch(fields: FetchFields): Promise<{ image: Uint8Array; qrUrl: string }> {
        this.enter('new');
        let value: ExchangeResult | undefined;

        try {
            const { packageName, ptVersion, miscBitMap, ssoVersion, d1, unusualSig } =
                snapshotRecord(fields) as FetchFields;

            const operation: WtQrFrameOperation = {
                type: 'fetch',
                fields: {
                    packageName,
                    ptVersion,
                    miscBitMap,
                    ssoVersion,
                    d1: snapshotBytes(d1, 0xffff),
                    unusualSig:
                        unusualSig === undefined ? undefined : snapshotBytes(unusualSig, 0xffff),
                },
            };
            value = await this.exchange('fetch', operation);

            if (value.type !== 'fetch') {
                throw new Error('response');
            }

            this.active();
            this.qrSig = value.sig;
            this.state = 'qr-ready';
            const output = { image: value.image, qrUrl: value.url };
            value = undefined;
            return output;
        } catch {
            this.fail();
            throw new Error('attempt fetch failed');
        } finally {
            if (value) {
                scrubResult(value);
            }

            this.busy = false;
        }
    }

    async poll(): Promise<{
        status: 'confirmed' | 'wait' | 'confirm' | 'expired' | 'canceled' | 'invalid' | 'unknown';
        code?: number;
    }> {
        this.enter('qr-ready');
        let value: ExchangeResult | undefined;
        let sig: Uint8Array | undefined;

        try {
            sig = Uint8Array.from(this.qrSig!);
            value = await this.exchange('poll', { type: 'poll', qrSig: sig });

            if (value.type !== 'poll') {
                throw new Error('response');
            }

            this.active();

            if (value.held) {
                this.held = value.held;
                this.qrSig?.fill(0);
                this.qrSig = undefined;
                this.state = 'confirmed-held';
                value = undefined;
                return { status: 'confirmed' };
            }

            if (value.status !== 'wait' && value.status !== 'confirm') {
                this.fail();
            }

            return { status: value.status, code: value.code };
        } catch {
            this.fail();
            throw new Error('attempt poll failed');
        } finally {
            sig?.fill(0);

            if (value) {
                scrubResult(value);
            }

            this.busy = false;
        }
    }

    async login(fields: LoginFields): Promise<WtReferenceLoginResult> {
        this.enter('confirmed-held');
        this.state = 'login-inflight';
        let value: ExchangeResult | undefined;

        try {
            const {
                mainSigMap,
                miscBitMap,
                subSigMap,
                packageName,
                ptVersion,
                sdkVersion,
                os,
                deviceName,
                apkSignature,
                tlv124Value,
                randomSource,
            } = snapshotRecord(fields) as LoginFields;

            const h = this.held!;
            const login: WtLoginRequestBody = {
                uin: h.number,
                appId: this.p.appId,
                subAppId: this.p.subAppId,
                appClientVersion: this.p.clientVersion,
                guid: Uint8Array.from(this.p.guid),
                mainSigMap,
                miscBitMap,
                subSigMap,
                packageName,
                ptVersion,
                sdkVersion,
                os,
                deviceName,
                apkSignature: snapshotBytes(apkSignature, 0xffff),
                tlv124Value: snapshotBytes(tlv124Value, 12),
                randomSource,
                temporaryA1: Uint8Array.from(h.temporaryA1),
                noPicSig: Uint8Array.from(h.noPicSig),
                tgtgtKey: Uint8Array.from(h.tgtgtKey),
            };

            try {
                value = await this.exchange('login', login);

                if (value.type !== 'login') {
                    throw new Error('response');
                }

                this.active();
                this.state = value.result.status === 'tickets' ? 'tickets' : 'failed';
                this.clean();
                const output = value.result;
                value = undefined;
                return output;
            } finally {
                login.temporaryA1.fill(0);
                login.noPicSig.fill(0);
                login.tgtgtKey.fill(0);
            }
        } catch {
            this.fail();
            throw new Error('attempt login failed');
        } finally {
            if (value) {
                scrubResult(value);
            }

            this.busy = false;
        }
    }

    close(): void {
        this.state = 'closed';
        this.clean();
    }
    private enter(expected: State): void {
        if (this.busy) {
            this.fail();
            throw new Error('attempt single-flight violation');
        }

        if (
            this.state !== expected ||
            this.socket.destroyed ||
            this.controller.signal.aborted ||
            performance.now() >= this.deadline
        ) {
            this.fail();
            throw new Error('attempt state violation');
        }

        this.busy = true;
    }
    private active(): void {
        if (
            this.state === 'failed' ||
            this.state === 'closed' ||
            this.socket.destroyed ||
            this.controller.signal.aborted ||
            performance.now() >= this.deadline
        ) {
            throw new Error('attempt stopped');
        }
    }
    private clearHeld(): void {
        if (this.held) {
            this.held.tgtgtKey.fill(0);
            this.held.noPicSig.fill(0);
            this.held.temporaryA1.fill(0);
            this.held = undefined;
        }
    }
    private clean(): void {
        if (this.lifetimeTimer) {
            clearTimeout(this.lifetimeTimer);
            this.lifetimeTimer = undefined;
        }

        this.qrSig?.fill(0);
        this.qrSig = undefined;
        this.clearHeld();
        this.p.randomKey.fill(0);

        try {
            if (this.signal) {
                removeListener.call(this.signal, 'abort', this.onAbort);
            }
        } catch {
            /* continue teardown */
        }

        this.controller.abort();
        this.client.close();
    }
    private fail(): void {
        if (this.state !== 'closed' && this.state !== 'tickets') {
            this.state = 'failed';
            this.clean();
        }
    }

    private async exchange(operation: Operation, input: WtQrFrameOperation | WtLoginRequestBody) {
        const account = operation === 'login' ? this.held!.decimal : this.p.uin;
        const command = operation === 'login' ? this.p.loginCommand : this.p.qrCommand;
        let context: Context | undefined;
        let outgoingFrame: Uint8Array | undefined;
        let staged: ExchangeResult | undefined;

        const stage = (value: ExchangeResult): ExchangeResult => {
            staged = value;

            try {
                this.active();
            } catch (error) {
                scrubResult(value);
                staged = undefined;
                throw error;
            }

            return value;
        };

        const result = await this.client.transactRaw<Context, ExchangeResult>({
            timeoutMs: this.timeout,
            signal: this.controller.signal,
            buildRequest: async ({ sequence }) => {
                this.active();
                let oicq: Uint8Array | undefined;
                let inner: Uint8Array | undefined;
                let metadata: Uint8Array | undefined;
                let transferred = false;

                try {
                    if (operation === 'login') {
                        const login = input as WtLoginRequestBody;
                        const business = encodeWtLoginRequestBody(login);

                        try {
                            this.active();
                            oicq = encodeWtPcLoginOicqRequest({
                                uin: this.held!.uin,
                                clientVersion: this.p.clientVersion,
                                body: business,
                                randomKey: this.p.randomKey,
                                ecdh: this.ecdh,
                                peerPublicKey: this.p.peerPublicKey,
                                randomSource: login.randomSource,
                            });
                        } finally {
                            business.fill(0);
                        }
                    } else {
                        const timestamp = this.clock();
                        this.active();
                        oicq = buildWtQrOicq(
                            { ...this.p, timestamp, ecdh: this.ecdh },
                            input as WtQrFrameOperation,
                        );
                    }

                    this.active();
                    const signed = Buffer.from(oicq);

                    try {
                        const reserved = await this.signer({
                            uin: account,
                            sequence,
                            command,
                            body: signed,
                        });
                        this.active();
                        metadata = snapshotBytes(reserved, 0xffff);
                    } finally {
                        wipeOwned(signed);
                    }

                    this.active();
                    inner = encodeSso12Request({
                        sequence: sequence | 0,
                        subAppId: this.p.subAppId,
                        a2: new Uint8Array(),
                        command,
                        guid: this.p.guid,
                        version: this.p.ssoVersion,
                        reserved: metadata,
                        body: oicq,
                    });
                    outgoingFrame = encodeServiceRequest({
                        protocol: 12,
                        encryption: { type: 'zero' },
                        d2: new Uint8Array(),
                        uin: account,
                        body: inner,
                    });
                    this.active();
                    context = {
                        requestFrame: Uint8Array.from(outgoingFrame),
                        requestOicq: oicq,
                        account,
                        command,
                        operation,
                    };
                    transferred = true;
                    return { frame: outgoingFrame, context };
                } finally {
                    inner?.fill(0);
                    metadata?.fill(0);

                    if (!transferred) {
                        oicq?.fill(0);
                        outgoingFrame?.fill(0);
                        outgoingFrame = undefined;
                    }
                }
            },
            verifyCandidate: async (frame, ctx, identity) => {
                const requestFrame = Uint8Array.from(ctx.requestFrame),
                    requestOicq = Uint8Array.from(ctx.requestOicq),
                    responseFrame = Uint8Array.from(frame);

                try {
                    const valid = await this.verifier({
                        operation,
                        transportUin: identity.uin,
                        requestUin: ctx.account,
                        sequence: identity.sequence,
                        command: ctx.command,
                        requestFrame,
                        requestOicq,
                        responseFrame,
                    });
                    this.active();
                    return valid === true;
                } finally {
                    wipeOwned(requestFrame);
                    wipeOwned(requestOicq);
                    wipeOwned(responseFrame);
                }
            },
            consumeCandidate: async (frame, ctx, identity) => {
                this.active();

                if (
                    ctx.account !== account ||
                    ctx.command !== command ||
                    ctx.operation !== operation
                ) {
                    throw new Error('context');
                }

                const owned: Uint8Array[] = [];

                try {
                    const outer = decodeServiceResponse(frame);
                    owned.push(outer.body);
                    const sso = decodeSsoResponse(outer.body);
                    owned.push(sso.body, sso.cookie, sso.reserved, sso.headerExtension);

                    if (
                        outer.protocol !== 12 ||
                        outer.encryption !== 'zero' ||
                        (operation === 'login' && outer.uin !== account) ||
                        sso.sequence >>> 0 !== identity.sequence ||
                        sso.command !== command ||
                        sso.retCode !== 0
                    ) {
                        throw new Error('binding');
                    }

                    const key = this.ecdh.deriveTeaKey(this.p.peerPublicKey);
                    let wt: ReturnType<typeof decodeWtOicqResponse>;

                    try {
                        wt = decodeWtOicqResponse(sso.body, {
                            sharedKey: key,
                            randomKey: this.p.randomKey,
                            ecdh: this.ecdh,
                        });
                        owned.push(wt.body);
                    } finally {
                        key.fill(0);
                    }

                    if (
                        wt.command !== (operation === 'login' ? 0x810 : 0x812) ||
                        wt.sequence !== 0 ||
                        wt.state !== 0 ||
                        (operation === 'login' && wt.uin !== this.held!.number)
                    ) {
                        throw new Error('WT binding');
                    }

                    const code =
                        operation === 'login' ? undefined : decodeWtCode2dResponse(wt.body);

                    if (code) {
                        owned.push(code.body, code.unknown21);
                    }

                    if (code && code.command !== (operation === 'fetch' ? 0x31 : 0x12)) {
                        throw new Error('code2d binding');
                    }

                    const body = code?.body ?? wt.body;
                    const selection = snapshotRecord(
                        this.slicer({ operation, bodyLength: body.length }),
                    ) as { start: number; end: number };
                    this.active();
                    const { start, end } = selection;

                    if (
                        !Number.isInteger(start) ||
                        !Number.isInteger(end) ||
                        start < 0 ||
                        end <= start ||
                        end > body.length
                    ) {
                        throw new Error('boundary');
                    }

                    const business = Uint8Array.from(body.subarray(start, end));
                    owned.push(business);

                    try {
                        let parsed:
                            | ReturnType<typeof decodeWtQrFetchResponse>
                            | ReturnType<typeof decodeWtQrPollResponse>
                            | ReturnType<typeof decodeWtLoginResponse>;

                        if (operation === 'fetch') {
                            parsed = decodeWtQrFetchResponse(business);
                        } else if (operation === 'poll') {
                            parsed = decodeWtQrPollResponse(business);
                        } else {
                            parsed = decodeWtLoginResponse(business, this.held!.tgtgtKey);
                        }

                        const qr =
                            operation === 'login'
                                ? undefined
                                : (parsed as
                                      | ReturnType<typeof decodeWtQrFetchResponse>
                                      | ReturnType<typeof decodeWtQrPollResponse>);
                        const businessUin = qr && qr.status === 'confirmed' ? qr.uin : undefined;

                        try {
                            const verified = await this.contextVerifier({
                                operation,
                                transportUin: identity.uin,
                                requestUin: account,
                                responseUin: outer.uin,
                                sequence: identity.sequence,
                                command,
                                oicqCommand: wt.command,
                                oicqSequence: wt.sequence,
                                oicqUin: wt.uin,
                                code2dCommand: code?.command,
                                code2dSequence: code?.sequence,
                                code2dUin: code?.uin,
                                businessUin,
                                businessAppId: qr?.appId,
                            });
                            this.active();

                            if (verified !== true) {
                                throw new Error('context');
                            }

                            if (operation === 'fetch') {
                                const fetch = parsed as ReturnType<typeof decodeWtQrFetchResponse>;

                                if (fetch.status !== 'success') {
                                    throw new Error('fetch');
                                }

                                const d1 = decodeWtQrD1Response(fetch.d1);

                                if (!d1.qrUrl) {
                                    throw new Error('QR URL');
                                }

                                return stage({
                                    type: 'fetch',
                                    sig: Uint8Array.from(fetch.qrSig),
                                    image: Uint8Array.from(fetch.image),
                                    url: d1.qrUrl,
                                });
                            }

                            if (operation === 'poll') {
                                const poll = parsed as ReturnType<typeof decodeWtQrPollResponse>;

                                if (poll.status !== 'confirmed') {
                                    return {
                                        type: 'poll',
                                        status: poll.status,
                                        code: poll.retCode,
                                    } as ExchangeResult;
                                }

                                if (poll.uin < 1n || poll.uin > 0xffffffffn) {
                                    throw new Error('account range');
                                }

                                const uin = poll.uin;
                                return stage({
                                    type: 'poll',
                                    status: 'confirmed',
                                    held: {
                                        uin,
                                        decimal: uin.toString(),
                                        number: Number(uin),
                                        tgtgtKey: Uint8Array.from(poll.tickets.tgtgtKey),
                                        noPicSig: Uint8Array.from(poll.tickets.noPicSig),
                                        temporaryA1: Uint8Array.from(poll.tickets.tempPassword),
                                    },
                                });
                            }

                            const login = parsed as ReturnType<typeof decodeWtLoginResponse>;

                            if (login.status === 'tickets') {
                                return stage({
                                    type: 'login',
                                    result: {
                                        status: 'tickets',
                                        uin: this.held!.decimal,
                                        tickets: {
                                            d2: Uint8Array.from(login.tickets.d2),
                                            d2Key: Uint8Array.from(login.tickets.d2Key),
                                            a1: Uint8Array.from(login.tickets.a1),
                                            a2: Uint8Array.from(login.tickets.a2),
                                        },
                                    },
                                });
                            }

                            if (login.status === 'error') {
                                return stage({
                                    type: 'login',
                                    result: {
                                        status: 'error',
                                        state: login.state,
                                        code: login.error.code,
                                    },
                                });
                            }

                            return stage({
                                type: 'login',
                                result: { status: login.status, state: login.state },
                            });
                        } finally {
                            if ('outerTlvs' in parsed) {
                                parsed.outerTlvs.forEach((e) => e.value.fill(0));

                                if ('innerTlvs' in parsed) {
                                    parsed.innerTlvs.forEach((e) => e.value.fill(0));
                                }

                                if (parsed.status === 'tickets') {
                                    Object.values(parsed.tickets).forEach((v) => v.fill(0));
                                }
                            } else if (parsed.status === 'confirmed') {
                                Object.values(parsed.tickets).forEach((v) => v.fill(0));
                            } else if (parsed.status === 'success') {
                                parsed.qrSig.fill(0);
                            } else {
                                parsed.remaining.fill(0);
                            }
                        }
                    } finally {
                        business.fill(0);
                    }
                } finally {
                    for (const bytes of owned) {
                        bytes.fill(0);
                    }
                }
            },
        });
        context?.requestFrame.fill(0);
        context?.requestOicq.fill(0);
        outgoingFrame?.fill(0);

        if (result.kind !== 'response') {
            if (staged) {
                scrubResult(staged);
            }

            throw new Error('transport');
        }

        try {
            this.active();
        } catch (error) {
            if (staged) {
                scrubResult(staged);
            }

            throw error;
        }

        return result.value;
    }
}

function scrubResult(value: ExchangeResult): void {
    if (value.type === 'fetch') {
        value.sig.fill(0);
        value.image.fill(0);
    } else if (value.type === 'poll' && value.held) {
        value.held.tgtgtKey.fill(0);
        value.held.noPicSig.fill(0);
        value.held.temporaryA1.fill(0);
    } else if (value.type === 'login' && value.result.status === 'tickets') {
        Object.values(value.result.tickets).forEach((bytes) => bytes.fill(0));
    }
}

type ExchangeResult =
    | { type: 'fetch'; sig: Uint8Array; image: Uint8Array; url: string }
    | {
          type: 'poll';
          status: 'confirmed' | 'wait' | 'confirm' | 'expired' | 'canceled' | 'invalid' | 'unknown';
          code?: number;
          held?: Held;
      }
    | { type: 'login'; result: WtReferenceLoginResult };
