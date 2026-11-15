import type { Socket } from 'node:net';
import { addAbortListener } from 'node:events';
import { isPromise, isProxy } from 'node:util/types';
import {
    Sso12PacketClient,
    type Sso12PacketClientOptions,
    type Sso12RawOptions,
    type Sso12RawTransport,
} from './sso12-packet-client';
import type { RawSessionLease } from './raw-session-broker';
import { guardBorrowedTransport } from './guard-raw-transaction';
import {
    bindReferenceTerminalAttempt,
    cancelReferenceTerminal,
    claimReferenceTerminal,
    hasReferenceTerminal,
    publishReferenceTerminal,
} from './wt-reference-terminal-private';
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
import { projectWtLoginUid, type WtLoginUidProjection } from './wt-login-keystore';
import {
    bindReferenceKeyAttemptOwnerLease,
    registerReferenceBorrowedAttempt,
    revokeReferenceKey,
    stageReferenceConfirmed,
    stageReferenceKey,
} from './wt-reference-session-private';

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
          /** Parsed response data only, not authentication or evidence of online state. */
          uidProjection?: WtLoginUidProjection;
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

// Tracks only arrays allocated by this attempt or returned by its local decoders.
// A callback may retain or detach a loan; wiping remains best effort.
class OwnedScope {
    private readonly values = new Set<Uint8Array>();
    private revoked = false;

    own<T extends Uint8Array>(bytes: T): T {
        if (this.revoked) {
            wipeOwned(bytes);
            throw new Error('attempt stopped');
        }

        this.values.add(bytes);
        return bytes;
    }

    ownMany(values: readonly Uint8Array[]): void {
        if (this.revoked) {
            for (const bytes of values) {
                wipeOwned(bytes);
            }

            throw new Error('attempt stopped');
        }

        for (const bytes of values) {
            this.values.add(bytes);
        }
    }

    release(bytes: Uint8Array | undefined): void {
        if (bytes) {
            wipeOwned(bytes);
            this.values.delete(bytes);
        }
    }

    transfer(bytes: Uint8Array): void {
        this.values.delete(bytes);
    }

    revoke(): void {
        this.revoked = true;

        for (const bytes of this.values) {
            wipeOwned(bytes);
        }

        this.values.clear();
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
    /** Opt in to parsing UID from accepted login tickets; strings cannot be wiped. */
    enableUidProjection?: boolean;
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

export type BorrowedWtReferenceLoginAttemptOptions = Omit<
    WtReferenceLoginAttemptOptions,
    'socket' | 'initialSequence'
>;

/** Operations for a single account attempt, not an authenticated or registered session. */
export interface BorrowedWtReferenceLoginAttempt {
    getState(): State;
    fetch(fields: FetchFields): Promise<{ image: Uint8Array; qrUrl: string }>;
    poll(): Promise<{
        status: 'confirmed' | 'wait' | 'confirm' | 'expired' | 'canceled' | 'invalid' | 'unknown';
        code?: number;
    }>;
    login(fields: LoginFields): Promise<WtReferenceLoginResult>;
    close(): void;
}

const borrowedPorts = new WeakMap<
    object,
    { lease: RawSessionLease; closed: PromiseLike<unknown> }
>();
const referenceCapabilities = new WeakMap<object, object>();
const borrowedSources = new WeakMap<object, RawSessionLease>();
const terminalPorts = new WeakMap<object, object>();

export function bindReferenceTerminalPort(
    attempt: BorrowedWtReferenceLoginAttempt,
    port: object,
): void {
    if (terminalPorts.has(attempt)) {
        throw new Error('terminal port already bound');
    }

    bindReferenceTerminalAttempt(port, attempt);
    terminalPorts.set(attempt, port);
}

/** Internal composition hook; does not expose ticket bytes. */
export function bindReferenceKeyCapability(
    attempt: BorrowedWtReferenceLoginAttempt,
    capability: object,
    reservation: object,
): void {
    if (!attempt || typeof attempt !== 'object' || isProxy(attempt)) {
        throw new Error('invalid reference attempt binding');
    }

    if (referenceCapabilities.has(attempt)) {
        throw new Error('attempt capability already bound');
    }

    const lease = borrowedSources.get(attempt);

    if (!lease) {
        throw new Error('invalid reference attempt binding');
    }

    // These own data properties are local coordination state, not an isolation
    // boundary against code in this process. Do not invoke caller-supplied getters.
    const state = Object.getOwnPropertyDescriptor(attempt, 'state');
    const busy = Object.getOwnPropertyDescriptor(attempt, 'busy');

    if (
        !state ||
        !('value' in state) ||
        state.value !== 'new' ||
        !busy ||
        !('value' in busy) ||
        busy.value !== false
    ) {
        throw new Error('invalid reference attempt binding');
    }

    bindReferenceKeyAttemptOwnerLease(capability, attempt, reservation, lease);
    referenceCapabilities.set(attempt, capability);
}

const promiseThen = Promise.prototype.then;

function observeClosure(value: PromiseLike<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const promise = isPromise(value) ? value : Promise.resolve(value);
        promiseThen.call(promise, resolve, reject);
    });
}

/** Reference-only attempt. External callbacks can retain or act on copies; JS/crypto erasure is best effort.
 * QQ-TEA does not authenticate. Parsed tickets do not register or establish online state. */
export class WtReferenceLoginAttempt implements BorrowedWtReferenceLoginAttempt {
    private readonly client?: Sso12PacketClient;
    private readonly socket?: Socket;
    private readonly borrowed?: RawSessionLease;
    private readonly transport: Sso12RawTransport;
    private readonly p: WtReferenceLoginAttemptOptions['profile'];
    private ecdh: ReturnType<typeof createWtEcdh> | undefined = createWtEcdh();
    private readonly timeout: number;
    private readonly deadline: number;
    private lifetimeTimer?: ReturnType<typeof setTimeout>;
    private readonly clock: WtReferenceLoginAttemptOptions['getTimestamp'];
    private readonly signer: WtReferenceLoginAttemptOptions['buildReserved'];
    private readonly verifier: WtReferenceLoginAttemptOptions['verifyRaw'];
    private readonly contextVerifier: WtReferenceLoginAttemptOptions['verifyContext'];
    private readonly slicer: WtReferenceLoginAttemptOptions['sliceBusiness'];
    private readonly enableUidProjection: boolean;
    private readonly signal?: AbortSignal;
    private borrowedAbortListener?: ReturnType<typeof addAbortListener>;
    private readonly controller = new AbortController();
    readonly #owned = new OwnedScope();
    private readonly onAbort = () => this.fail();
    private state: State = 'new';
    private busy = false;
    private qrSig?: Uint8Array;
    private held?: Held;
    private borrowedPoisoned = false;
    private transactionDeadline = Infinity;

    constructor(options: WtReferenceLoginAttemptOptions);
    constructor(
        supplied: WtReferenceLoginAttemptOptions | BorrowedWtReferenceLoginAttemptOptions,
        port: object | undefined = undefined,
    ) {
        const borrowedPort = port === undefined ? undefined : borrowedPorts.get(port);
        const borrowed = borrowedPort?.lease;
        const started = performance.now();
        const record = snapshotRecord(supplied);

        if (
            borrowed &&
            (Object.hasOwn(record, 'socket') || Object.hasOwn(record, 'initialSequence'))
        ) {
            throw new TypeError('invalid borrowed attempt configuration');
        }

        const options = record as WtReferenceLoginAttemptOptions;

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
            typeof options.sliceBusiness !== 'function' ||
            (options.enableUidProjection !== undefined &&
                typeof options.enableUidProjection !== 'boolean')
        ) {
            throw new TypeError('invalid attempt configuration');
        }

        // Validate the genuine AbortSignal internal slot before claiming the caller's socket.
        if (options.signal !== undefined) {
            if (
                isProxy(options.signal) ||
                (borrowed &&
                    (Object.getPrototypeOf(options.signal) !== AbortSignal.prototype ||
                        Object.hasOwn(options.signal, 'aborted') ||
                        Object.hasOwn(options.signal, 'addEventListener') ||
                        Object.hasOwn(options.signal, 'removeEventListener')))
            ) {
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
        wipeOwned(this.ecdh!.deriveTeaKey(this.p.peerPublicKey));
        this.socket = borrowed ? undefined : options.socket;
        this.borrowed = borrowed;
        this.timeout = options.timeoutMs;
        this.deadline = started + options.attemptTimeoutMs;
        this.clock = options.getTimestamp;
        this.signer = options.buildReserved;
        this.verifier = options.verifyRaw;
        this.contextVerifier = options.verifyContext;
        this.slicer = options.sliceBusiness;
        this.enableUidProjection = options.enableUidProjection === true;
        this.signal = options.signal;

        if (borrowed) {
            this.transport = borrowed;
        } else {
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
            this.transport = this.client;
        }

        this.lifetimeTimer = setTimeout(
            this.onAbort,
            Math.max(1, Math.ceil(this.deadline - performance.now())),
        );

        try {
            if (this.signal) {
                if (borrowed) {
                    this.borrowedAbortListener = addAbortListener(this.signal, this.onAbort);
                } else {
                    addListener.call(this.signal, 'abort', this.onAbort, { once: true });
                }
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

        const stopped = (): void => {
            const port = terminalPorts.get(this);

            if (port && hasReferenceTerminal(port, this)) {
                return;
            }

            if (this.state !== 'tickets' && this.state !== 'closed') {
                this.fail();
            }
        };

        if (borrowed) {
            try {
                void observeClosure(borrowedPort!.closed).then(stopped, stopped);
            } catch {
                this.fail();
                throw new TypeError('invalid borrowed lease');
            }
        } else {
            void this.client!.whenClosed.then(stopped);
        }
    }

    getState(): State {
        return this.state;
    }

    async fetch(fields: FetchFields): Promise<{ image: Uint8Array; qrUrl: string }> {
        this.enter('new');
        let value: ExchangeResult | undefined;
        let d1Bytes: Uint8Array | undefined;
        let unusualBytes: Uint8Array | undefined;

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
                    d1: (d1Bytes = this.#owned.own(snapshotBytes(d1, 0xffff))),
                    unusualSig:
                        unusualSig === undefined
                            ? undefined
                            : (unusualBytes = this.#owned.own(snapshotBytes(unusualSig, 0xffff))),
                },
            };
            value = await this.exchange('fetch', operation);

            if (value.type !== 'fetch') {
                throw new Error('response');
            }

            this.active();
            this.#owned.transfer(value.sig);
            this.#owned.transfer(value.image);
            this.qrSig = value.sig;
            this.state = 'qr-ready';
            const output = { image: value.image, qrUrl: value.url };
            value = undefined;
            return output;
        } catch {
            this.fail();
            throw new Error('attempt fetch failed');
        } finally {
            this.#owned.release(d1Bytes);
            this.#owned.release(unusualBytes);

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
            sig = this.#owned.own(Uint8Array.from(this.qrSig!));
            value = await this.exchange('poll', { type: 'poll', qrSig: sig });

            if (value.type !== 'poll') {
                throw new Error('response');
            }

            this.active();

            if (value.held) {
                this.#owned.transfer(value.held.tgtgtKey);
                this.#owned.transfer(value.held.noPicSig);
                this.#owned.transfer(value.held.temporaryA1);
                this.held = value.held;

                if (this.qrSig) {
                    wipeOwned(this.qrSig);
                }

                this.qrSig = undefined;
                this.state = 'confirmed-held';
                value = undefined;
                return { status: 'confirmed' };
            }

            const output = { status: value.status, code: value.code };

            if (value.status !== 'wait' && value.status !== 'confirm') {
                if (terminalPorts.has(this)) {
                    Object.freeze(output);
                    this.finishTerminal('poll', output);
                } else {
                    this.fail();
                }
            }

            return output;
        } catch {
            this.fail();
            throw new Error('attempt poll failed');
        } finally {
            this.#owned.release(sig);

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
                guid: this.#owned.own(Uint8Array.from(this.p.guid)),
                mainSigMap,
                miscBitMap,
                subSigMap,
                packageName,
                ptVersion,
                sdkVersion,
                os,
                deviceName,
                apkSignature: this.#owned.own(snapshotBytes(apkSignature, 0xffff)),
                tlv124Value: this.#owned.own(snapshotBytes(tlv124Value, 12)),
                randomSource,
                temporaryA1: this.#owned.own(Uint8Array.from(h.temporaryA1)),
                noPicSig: this.#owned.own(Uint8Array.from(h.noPicSig)),
                tgtgtKey: this.#owned.own(Uint8Array.from(h.tgtgtKey)),
            };

            try {
                value = await this.exchange('login', login);

                if (value.type !== 'login') {
                    throw new Error('response');
                }

                this.active();

                if (value.result.status !== 'tickets' && terminalPorts.has(this)) {
                    const output = Object.freeze(value.result);
                    this.finishTerminal('login-register', output);
                    value = undefined;
                    return output;
                }

                if (value.result.status === 'tickets') {
                    for (const bytes of Object.values(value.result.tickets)) {
                        this.#owned.transfer(bytes);
                    }
                }

                this.state = value.result.status === 'tickets' ? 'tickets' : 'failed';

                if (this.state === 'failed') {
                    this.poisonBorrowed();
                }

                this.clean();

                if (value.result.status === 'tickets') {
                    if (this.borrowed) {
                        this.assertBorrowedCommit();
                    } else if (
                        this.state !== 'tickets' ||
                        (this.signal && signalAborted.call(this.signal)) ||
                        performance.now() >= this.deadline
                    ) {
                        if (this.state === 'tickets') {
                            this.state = 'failed';
                        }

                        throw new Error('attempt stopped');
                    }
                }

                const output = value.result;
                value = undefined;
                return output;
            } finally {
                this.#owned.release(login.guid);
                this.#owned.release(login.apkSignature);
                this.#owned.release(login.tlv124Value);
                this.#owned.release(login.temporaryA1);
                this.#owned.release(login.noPicSig);
                this.#owned.release(login.tgtgtKey);
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
        this.#owned.revoke();
        const port = terminalPorts.get(this);

        if (port) {
            cancelReferenceTerminal(port);
        }

        const wasBusy = this.busy;

        try {
            if (wasBusy || this.state !== 'tickets') {
                this.revokeReferenceCapability();
            }
        } finally {
            this.state = 'closed';

            try {
                if (wasBusy) {
                    this.poisonBorrowed();
                }
            } finally {
                this.clean();
            }
        }
    }
    private finishTerminal(operation: 'poll' | 'login-register', result: object): void {
        const port = terminalPorts.get(this);

        if (!port) {
            throw new Error('terminal port missing');
        }

        const live = (): boolean =>
            this.state !== 'closed' &&
            this.state !== 'failed' &&
            !this.controller.signal.aborted &&
            (!this.signal || !signalAborted.call(this.signal)) &&
            performance.now() < this.deadline &&
            performance.now() < this.transactionDeadline &&
            this.getState() !== 'closed' &&
            this.getState() !== 'failed' &&
            !this.controller.signal.aborted &&
            (!this.signal || !signalAborted.call(this.signal));

        if (
            !claimReferenceTerminal(
                port,
                this,
                operation,
                result,
                this.deadline,
                this.transactionDeadline,
                live,
            )
        ) {
            throw new Error('terminal claim failed');
        }

        this.state = 'failed';
        this.revokeReferenceCapability();
        this.clean();
        const afterClean = (): boolean =>
            this.state === 'failed' &&
            (!this.signal || !signalAborted.call(this.signal)) &&
            performance.now() < this.deadline &&
            performance.now() < this.transactionDeadline &&
            this.state === 'failed' &&
            (!this.signal || !signalAborted.call(this.signal));

        if (!publishReferenceTerminal(port, this, operation, result, afterClean)) {
            throw new Error('terminal publication failed');
        }
    }

    private enter(expected: State): void {
        if (this.busy) {
            // A borrowed success is not committed until cleanup and its reentry check finish.
            if (this.borrowed && this.state === 'tickets') {
                this.state = 'failed';
            }

            this.fail();
            throw new Error('attempt single-flight violation');
        }

        if (
            this.state !== expected ||
            this.socket?.destroyed ||
            this.controller.signal.aborted ||
            (this.borrowed && this.signal && signalAborted.call(this.signal)) ||
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
            this.socket?.destroyed ||
            this.controller.signal.aborted ||
            (this.borrowed && this.signal && signalAborted.call(this.signal)) ||
            performance.now() >= this.deadline
        ) {
            throw new Error('attempt stopped');
        }
    }
    private assertBorrowedCommit(): void {
        if (
            this.state !== 'tickets' ||
            (this.signal && signalAborted.call(this.signal)) ||
            performance.now() >= this.deadline
        ) {
            if (this.state !== 'closed') {
                this.state = 'failed';
            }

            this.poisonBorrowed();
            throw new Error('attempt stopped');
        }
    }
    private clearHeld(): void {
        if (this.held) {
            wipeOwned(this.held.tgtgtKey);
            wipeOwned(this.held.noPicSig);
            wipeOwned(this.held.temporaryA1);

            this.held = undefined;
        }
    }
    private clean(): void {
        this.#owned.revoke();

        if (this.lifetimeTimer) {
            clearTimeout(this.lifetimeTimer);
            this.lifetimeTimer = undefined;
        }

        if (this.qrSig) {
            wipeOwned(this.qrSig);
        }

        this.qrSig = undefined;
        this.clearHeld();
        wipeOwned(this.p.randomKey);

        try {
            if (this.borrowedAbortListener) {
                this.borrowedAbortListener[Symbol.dispose]();
                this.borrowedAbortListener = undefined;
            } else if (this.signal && !this.borrowed) {
                removeListener.call(this.signal, 'abort', this.onAbort);
            }
        } catch {
            /* continue teardown */
        }

        this.controller.abort();
        this.client?.close();

        if (this.borrowed) {
            // These are attempt-owned snapshots; the lease owner retains its own profile.
            wipeOwned(this.p.guid);
            wipeOwned(this.p.unknown21);
            wipeOwned(this.p.peerPublicKey);
            // Release the closure reference; OpenSSL/JS private key erasure is not guaranteed.
            this.ecdh = undefined;
        }
    }
    private poisonBorrowed(): void {
        if (!this.borrowed || this.borrowedPoisoned) {
            return;
        }

        this.borrowedPoisoned = true;

        try {
            this.borrowed.poison();
        } catch {
            // A foreign lease may throw; the attempt remains terminal.
        }
    }
    private revokeReferenceCapability(): void {
        const capability = referenceCapabilities.get(this);

        if (capability) {
            revokeReferenceKey(capability);
        }
    }
    private fail(): void {
        if (this.state !== 'tickets') {
            this.#owned.revoke();
        }

        const port = terminalPorts.get(this);

        if (port) {
            cancelReferenceTerminal(port);
        }

        try {
            this.revokeReferenceCapability();
        } finally {
            if (this.state !== 'closed' && this.state !== 'tickets') {
                this.state = 'failed';

                try {
                    this.poisonBorrowed();
                } finally {
                    this.clean();
                }
            }
        }
    }

    private async exchange(operation: Operation, input: WtQrFrameOperation | WtLoginRequestBody) {
        const account = operation === 'login' ? this.held!.decimal : this.p.uin;
        const command = operation === 'login' ? this.p.loginCommand : this.p.qrCommand;
        let context: Context | undefined;
        let outgoingFrame: Uint8Array | undefined;
        let staged: ExchangeResult | undefined;
        let finished = false;

        const exchangeActive = (): void => {
            this.active();

            if (finished) {
                throw new Error('transaction stopped');
            }
        };

        const stage = (value: ExchangeResult): ExchangeResult => {
            staged = value;

            try {
                if (value.type === 'fetch') {
                    this.#owned.own(value.sig);
                    this.#owned.own(value.image);
                } else if (value.type === 'poll' && value.held) {
                    this.#owned.own(value.held.tgtgtKey);
                    this.#owned.own(value.held.noPicSig);
                    this.#owned.own(value.held.temporaryA1);
                } else if (value.type === 'login' && value.result.status === 'tickets') {
                    for (const bytes of Object.values(value.result.tickets)) {
                        this.#owned.own(bytes);
                    }
                }

                exchangeActive();
            } catch (error) {
                scrubResult(value);
                staged = undefined;
                throw error;
            }

            return value;
        };

        const rawOptions: Sso12RawOptions<Context, ExchangeResult> = {
            timeoutMs: this.timeout,
            signal: this.controller.signal,
            buildRequest: async ({ sequence }) => {
                exchangeActive();
                let oicq: Uint8Array | undefined;
                let inner: Uint8Array | undefined;
                let metadata: Uint8Array | undefined;
                let transferred = false;

                try {
                    if (operation === 'login') {
                        const login = input as WtLoginRequestBody;
                        const business = this.#owned.own(encodeWtLoginRequestBody(login));

                        try {
                            this.active();
                            oicq = this.#owned.own(
                                encodeWtPcLoginOicqRequest({
                                    uin: this.held!.uin,
                                    clientVersion: this.p.clientVersion,
                                    body: business,
                                    randomKey: this.p.randomKey,
                                    ecdh: this.ecdh!,
                                    peerPublicKey: this.p.peerPublicKey,
                                    randomSource: login.randomSource,
                                }),
                            );
                        } finally {
                            this.#owned.release(business);
                        }
                    } else {
                        const timestamp = this.clock();
                        this.active();
                        oicq = this.#owned.own(
                            buildWtQrOicq(
                                { ...this.p, timestamp, ecdh: this.ecdh! },
                                input as WtQrFrameOperation,
                            ),
                        );
                    }

                    this.active();
                    const signed = this.#owned.own(Buffer.from(oicq));

                    try {
                        const reserved = await this.signer({
                            uin: account,
                            sequence,
                            command,
                            body: signed,
                        });
                        exchangeActive();
                        metadata = this.#owned.own(snapshotBytes(reserved, 0xffff));
                    } finally {
                        this.#owned.release(signed);
                    }

                    this.active();
                    inner = this.#owned.own(
                        encodeSso12Request({
                            sequence: sequence | 0,
                            subAppId: this.p.subAppId,
                            a2: new Uint8Array(),
                            command,
                            guid: this.p.guid,
                            version: this.p.ssoVersion,
                            reserved: metadata,
                            body: oicq,
                        }),
                    );
                    outgoingFrame = this.#owned.own(
                        encodeServiceRequest({
                            protocol: 12,
                            encryption: { type: 'zero' },
                            d2: new Uint8Array(),
                            uin: account,
                            body: inner,
                        }),
                    );
                    exchangeActive();
                    context = {
                        requestFrame: this.#owned.own(Uint8Array.from(outgoingFrame)),
                        requestOicq: oicq,
                        account,
                        command,
                        operation,
                    };
                    transferred = true;
                    return { frame: outgoingFrame, context };
                } finally {
                    this.#owned.release(inner);
                    this.#owned.release(metadata);

                    if (!transferred) {
                        this.#owned.release(oicq);
                        this.#owned.release(outgoingFrame);
                        outgoingFrame = undefined;
                    }
                }
            },
            verifyCandidate: async (frame, ctx, identity) => {
                let requestFrame: Uint8Array | undefined;
                let requestOicq: Uint8Array | undefined;
                let responseFrame: Uint8Array | undefined;

                try {
                    exchangeActive();
                    requestFrame = this.#owned.own(Uint8Array.from(ctx.requestFrame));
                    requestOicq = this.#owned.own(Uint8Array.from(ctx.requestOicq));
                    responseFrame = this.#owned.own(Uint8Array.from(frame));
                    exchangeActive();
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
                    exchangeActive();
                    return valid === true;
                } finally {
                    this.#owned.release(requestFrame);
                    this.#owned.release(requestOicq);
                    this.#owned.release(responseFrame);
                }
            },
            consumeCandidate: async (frame, ctx, identity) => {
                exchangeActive();

                if (
                    ctx.account !== account ||
                    ctx.command !== command ||
                    ctx.operation !== operation
                ) {
                    throw new Error('context');
                }

                const owned: Uint8Array[] = [];

                const register = (...values: Uint8Array[]): void => {
                    owned.push(...values);
                    this.#owned.ownMany(values);
                };

                try {
                    const outer = decodeServiceResponse(frame);
                    register(outer.body);
                    const sso = decodeSsoResponse(outer.body);
                    register(sso.body, sso.cookie, sso.reserved, sso.headerExtension);

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

                    const key = this.#owned.own(this.ecdh!.deriveTeaKey(this.p.peerPublicKey));
                    let wt: ReturnType<typeof decodeWtOicqResponse>;

                    try {
                        wt = decodeWtOicqResponse(sso.body, {
                            sharedKey: key,
                            randomKey: this.p.randomKey,
                            ecdh: this.ecdh!,
                        });
                        register(wt.body);
                    } finally {
                        this.#owned.release(key);
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
                        register(code.body, code.unknown21);
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
                    register(business);

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
                            if ('outerTlvs' in parsed) {
                                const bytes = parsed.outerTlvs.map((entry) => entry.value);

                                if ('innerTlvs' in parsed) {
                                    bytes.push(...parsed.innerTlvs.map((entry) => entry.value));
                                }

                                if (parsed.status === 'tickets') {
                                    bytes.push(...Object.values(parsed.tickets));
                                }

                                register(...bytes);
                            } else if (parsed.status === 'confirmed') {
                                register(...Object.values(parsed.tickets));
                            } else if (parsed.status === 'success') {
                                register(parsed.qrSig, parsed.image, parsed.d1);
                            } else {
                                register(parsed.remaining);
                            }

                            exchangeActive();
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
                            exchangeActive();

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
                                const capability = referenceCapabilities.get(this);

                                if (capability) {
                                    exchangeActive();
                                    stageReferenceConfirmed(
                                        capability,
                                        this,
                                        identity.uin,
                                        uin.toString(),
                                        identity.sequence,
                                    );
                                    exchangeActive();
                                }

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
                                const capability = referenceCapabilities.get(this);

                                if (capability) {
                                    exchangeActive();
                                    stageReferenceKey(
                                        capability,
                                        this,
                                        identity.uin,
                                        this.held!.decimal,
                                        identity.sequence,
                                        login.tickets.d2Key,
                                    );
                                    exchangeActive();
                                }

                                const uidProjection = this.enableUidProjection
                                    ? projectWtLoginUid(login.innerTlvs)
                                    : undefined;
                                return stage({
                                    type: 'login',
                                    result: {
                                        status: 'tickets',
                                        uin: this.held!.decimal,
                                        ...(uidProjection === undefined ? {} : { uidProjection }),
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
                        } catch (error) {
                            this.revokeReferenceCapability();
                            throw error;
                        }
                    } finally {
                        this.#owned.release(business);
                    }
                } catch (error) {
                    this.revokeReferenceCapability();
                    throw error;
                } finally {
                    for (const bytes of owned) {
                        this.#owned.release(bytes);
                    }
                }
            },
        };
        let result;

        try {
            this.transactionDeadline = performance.now() + this.timeout;
            result = this.borrowed
                ? await guardBorrowedTransport<Context, ExchangeResult>(this.transport, {
                      disposeContext: (value) => {
                          wipeOwned(value.requestFrame);
                          wipeOwned(value.requestOicq);
                      },
                      disposeResult: (value) => {
                          try {
                              this.revokeReferenceCapability();
                          } finally {
                              scrubResult(value);
                          }
                      },
                  })(rawOptions)
                : await this.transport.transactRaw(rawOptions);
        } catch (error) {
            this.revokeReferenceCapability();

            if (staged) {
                scrubResult(staged);
            }

            throw error;
        } finally {
            finished = true;
            this.#owned.release(context?.requestFrame);
            this.#owned.release(context?.requestOicq);
            this.#owned.release(outgoingFrame);
        }

        if (result.kind !== 'response') {
            this.revokeReferenceCapability();

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

/**
 * Borrow a caller-owned lease for one WT attempt. The owner must exclusively hold
 * the lease across all stages and registration, allocate sequences, and establish
 * successful transport quiescence. Local identity and callback binding do not
 * authenticate the peer. A failed attempt poisons the lease; success and idle
 * close leave it to the owner. In-flight close aborts and poisons it. Aborting
 * can itself cause the underlying broker/client to close. A broker fence can hide
 * a late callback result from the guard. Attempt-visible owned arrays are wiped on
 * cleanup and again on callback settlement; external copies and helper internals
 * remain outside that guarantee. A non-settling transport may not observe its
 * transaction deadline until another existing teardown path runs.
 * Promise constructor/species or global-intrinsic tampering and promises hidden
 * inside foreign thenables are outside observation guarantees.
 */
export function createBorrowedWtReferenceLoginAttempt(
    lease: RawSessionLease,
    options: BorrowedWtReferenceLoginAttemptOptions,
): BorrowedWtReferenceLoginAttempt {
    let closed: PromiseLike<unknown>;

    try {
        if (
            !lease ||
            typeof lease !== 'object' ||
            isProxy(lease) ||
            typeof lease.transactRaw !== 'function' ||
            typeof lease.poison !== 'function'
        ) {
            throw new TypeError();
        }

        closed = lease.whenClosed;

        if (!closed || (typeof closed !== 'object' && typeof closed !== 'function')) {
            throw new TypeError();
        }
    } catch {
        throw new TypeError('invalid borrowed lease');
    }

    // Attach both handlers even if option validation later throws. Genuine promises
    // are observed without reading an own `then`; foreign thenables remain untrusted.
    const observed = observeClosure(closed);
    void promiseThen.call(observed, undefined, () => undefined);
    const port = {};
    borrowedPorts.set(port, { lease, closed: observed });

    try {
        const attempt = Reflect.construct(WtReferenceLoginAttempt, [
            options,
            port,
        ]) as WtReferenceLoginAttempt;

        try {
            borrowedSources.set(attempt, lease);
            registerReferenceBorrowedAttempt(attempt, lease);
        } catch (error) {
            borrowedSources.delete(attempt);

            try {
                attempt.close();
            } catch {
                // Preserve the registration failure while attempting teardown.
            }

            throw error;
        }

        return attempt;
    } finally {
        borrowedPorts.delete(port);
    }
}

function scrubResult(value: ExchangeResult): void {
    if (value.type === 'fetch') {
        wipeOwned(value.sig);
        wipeOwned(value.image);
    } else if (value.type === 'poll' && value.held) {
        wipeOwned(value.held.tgtgtKey);
        wipeOwned(value.held.noPicSig);
        wipeOwned(value.held.temporaryA1);
    } else if (value.type === 'login' && value.result.status === 'tickets') {
        Object.values(value.result.tickets).forEach(wipeOwned);
        // Drop the reference; JavaScript strings themselves cannot be wiped.
        delete value.result.uidProjection;
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
