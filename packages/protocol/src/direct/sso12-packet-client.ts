import type { Socket } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types as utilTypes } from 'node:util';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import {
    decodeServiceResponse,
    encodeServiceRequest,
    MAX_SERVICE_FRAME_BYTES,
} from './service-frame';
import { ServiceFrameDecoder } from './service-stream';
import { claimDirectSocket } from './socket-ownership';
import { decodeSsoResponse, encodeSso12Request, type SsoResponse } from './sso';

export interface Sso12PacketClientOptions {
    socket: Socket;
    uin: string;
    encryption: { type: 'zero' } | { type: 'd2'; key: Uint8Array; d2: Uint8Array };
    subAppId: number;
    guid: Uint8Array;
    version: string;
    a2: Uint8Array;
    buildReserved: (request: {
        uin: string;
        sequence: number;
        command: string;
        body: Buffer;
    }) => Promise<Uint8Array>;
    /** Classification is caller-owned. This narrow client closes on a classified push. */
    classifyIncoming: (response: SsoResponse) => 'response' | 'push';
    /** Defaults to exact equality. This is account binding, not server authentication. */
    verifyResponseUin?: (requestUin: string, responseUin: string) => boolean;
    initialSequence?: number;
    defaultTimeoutMs?: number;
    maxWriteBufferBytes?: number;
}

export type Sso12CloseReason = Readonly<{
    kind: 'local' | 'remote' | 'transport-error' | 'protocol-error' | 'handler-error';
    code: string;
}>;

/** Public account/device identifiers; GUID bytes are fresh copies, not shared state. */
export type Sso12Profile = Readonly<{
    uin: string;
    subAppId: number;
    guid: Uint8Array;
    version: string;
}>;

/** A successful local response match, not proof of server authenticity. */
export type Sso12ResponseBinding = Readonly<{ sequence: number; command: string }>;
export type Sso12BoundResult =
    | {
          readonly kind: 'response';
          readonly result: SendPacketResult;
          readonly binding: Sso12ResponseBinding;
      }
    | { readonly kind: 'failure'; readonly result: SendPacketResult; readonly binding: null };

/** The callback owns all interpretation and verification of raw candidates. */
export type Sso12RawIdentity = Readonly<{ uin: string; sequence: number }>;
export type Sso12RawResult<T> =
    | {
          readonly kind: 'response';
          readonly sequence: number;
          readonly value: T;
          readonly writeState: 'written';
      }
    | {
          readonly kind: 'failure';
          readonly code: string;
          readonly writeState: 'not-written' | 'unknown';
      };
export interface Sso12RawOptions<C, T> {
    buildRequest: (
        identity: Sso12RawIdentity,
    ) => { frame: Uint8Array; context: C } | Promise<{ frame: Uint8Array; context: C }>;
    verifyCandidate: (
        candidate: Uint8Array,
        context: C,
        identity: Sso12RawIdentity,
    ) => boolean | Promise<boolean>;
    consumeCandidate: (
        candidate: Uint8Array,
        context: C,
        identity: Sso12RawIdentity,
    ) => T | Promise<T>;
    timeoutMs?: number;
    signal?: AbortSignal;
}

type RawPending = {
    sequence: number;
    deadline: number;
    written: boolean;
    phase: 'building' | 'waiting' | 'verifying';
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
    candidate?: Uint8Array;
    callbackCopy?: Uint8Array;
    requestFrame?: Uint8Array;
    accept: (candidate: Uint8Array) => void;
    fail: (code: string) => void;
};
const rawCallback = new AsyncLocalStorage<RawPending>();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const tagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const sharedByteLengthGetter = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;
const isArrayBufferView = ArrayBuffer.isView;
const typedArrayValues = Uint8Array.prototype.values;
const fillBytes = Uint8Array.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const isProxy = utilTypes.isProxy;
const uint8Prototype = Uint8Array.prototype;

function hasLocalUint8Prototype(value: object): boolean {
    let current: object | null = value;

    // Bound traversal and reject proxy prototypes before accessing their traps.
    for (let depth = 0; depth < 256 && current !== null; depth++) {
        if (isProxy(current)) {
            return false;
        }

        if (current === uint8Prototype) {
            return true;
        }

        current = getPrototype(current) as object | null;
    }

    return false;
}

function wipeRawBuffer(buffer: Uint8Array | undefined): void {
    if (!buffer) {
        return;
    }

    try {
        fillBytes.call(buffer, 0);
    } catch {
        // A callback can detach its copy; continue cleaning the remaining buffers.
    }
}

type Pending = {
    sequence: number;
    command: string;
    deadline: number;
    written: boolean;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
    resolve: (result: SendPacketResult, binding: Sso12ResponseBinding | null) => void;
};

const failure = (errorMessage: string, errorCode = -1): SendPacketResult => ({
    success: false,
    gotResponse: false,
    errorCode,
    errorMessage,
    responseData: null,
});

/**
 * Experimental, synthetic-reference protocol-12 transport; not target verified.
 * One request at a time, no push support, no reconnect or replay. Timeout and
 * cancellation close the connection, including while metadata is being built.
 * A verifier/classifier is an application policy, not cryptographic server authentication.
 */
export class Sso12PacketClient {
    private readonly socket: Socket;
    private readonly releaseSocket: () => void;
    private readonly uin: string;
    private readonly encryption: { type: 'zero' } | { type: 'd2'; key: Uint8Array; d2: Uint8Array };
    private readonly subAppId: number;
    private readonly guid: Uint8Array;
    private readonly version: string;
    private readonly a2: Uint8Array;
    private readonly buildReserved: Sso12PacketClientOptions['buildReserved'];
    private readonly classify: Sso12PacketClientOptions['classifyIncoming'];
    private readonly verifyUin: NonNullable<Sso12PacketClientOptions['verifyResponseUin']>;
    private readonly timeout: number;
    private readonly maxWrite: number;
    private readonly decoder = new ServiceFrameDecoder();
    private nextSequence: number;
    private issued = 0;
    private pending?: Pending;
    private rawPending?: RawPending;
    private closed = false;
    private reason?: Sso12CloseReason;
    private resolveClosed!: (reason: Sso12CloseReason) => void;
    private readonly closedPromise = new Promise<Sso12CloseReason>((resolve) => {
        this.resolveClosed = resolve;
    });

    constructor(options: Sso12PacketClientOptions) {
        const { socket, uin, encryption, subAppId, guid, version, a2 } = options;
        const timeout = options.defaultTimeoutMs ?? 15000;
        const maxWrite = options.maxWriteBufferBytes ?? MAX_SERVICE_FRAME_BYTES;
        const sequence = options.initialSequence ?? 1;

        if (
            typeof uin !== 'string' ||
            !/^[0-9]{1,20}$/.test(uin) ||
            !encryption ||
            (encryption.type !== 'zero' && encryption.type !== 'd2') ||
            (encryption.type === 'd2' &&
                (!(encryption.key instanceof Uint8Array) ||
                    encryption.key.length !== 16 ||
                    !(encryption.d2 instanceof Uint8Array) ||
                    encryption.d2.length === 0 ||
                    encryption.d2.length > MAX_SERVICE_FRAME_BYTES)) ||
            !Number.isInteger(subAppId) ||
            subAppId < 0 ||
            subAppId > 0x7fffffff ||
            !(guid instanceof Uint8Array) ||
            guid.length === 0 ||
            guid.length > 0xffff ||
            !(a2 instanceof Uint8Array) ||
            a2.length > MAX_SERVICE_FRAME_BYTES ||
            typeof version !== 'string' ||
            version.length === 0 ||
            Buffer.byteLength(version) > 0xfffd ||
            typeof options.buildReserved !== 'function' ||
            typeof options.classifyIncoming !== 'function' ||
            (options.verifyResponseUin !== undefined &&
                typeof options.verifyResponseUin !== 'function') ||
            !Number.isInteger(sequence) ||
            sequence < 0 ||
            sequence > 0xffffffff ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            !Number.isSafeInteger(maxWrite) ||
            maxWrite < 1 ||
            maxWrite > MAX_SERVICE_FRAME_BYTES
        ) {
            throw new Error('invalid protocol-12 transport configuration');
        }

        if (
            !socket ||
            socket.destroyed ||
            socket.connecting ||
            !socket.writable ||
            !socket.readable
        ) {
            throw new Error('socket must be connected and exclusively owned');
        }

        this.socket = socket;
        this.uin = uin;
        this.encryption =
            encryption.type === 'zero'
                ? { type: 'zero' }
                : {
                      type: 'd2',
                      key: Uint8Array.from(encryption.key),
                      d2: Uint8Array.from(encryption.d2),
                  };
        this.subAppId = subAppId;
        this.guid = Uint8Array.from(guid);
        this.version = version;
        this.a2 = Uint8Array.from(a2);
        this.buildReserved = options.buildReserved;
        this.classify = options.classifyIncoming;
        this.verifyUin = options.verifyResponseUin ?? ((expected, actual) => expected === actual);
        this.timeout = timeout;
        this.maxWrite = maxWrite;
        this.nextSequence = sequence;
        this.releaseSocket = claimDirectSocket(socket);

        try {
            socket.on('data', this.onData);
            socket.on('error', this.onError);
            socket.on('end', this.onEnd);
            socket.on('close', this.onClose);
        } catch (error) {
            socket.off('data', this.onData);
            socket.off('error', this.onError);
            socket.off('end', this.onEnd);
            socket.off('close', this.onClose);
            this.releaseSocket();
            throw error;
        }
    }

    get whenClosed(): Promise<Sso12CloseReason> {
        return this.closedPromise;
    }

    /** Snapshot caller-supplied account/device identifiers; unavailable after close. */
    getProfile(): Sso12Profile {
        if (this.closed || this.socket.destroyed) {
            throw new Error('connection closed');
        }

        return Object.freeze({
            uin: this.uin,
            subAppId: this.subAppId,
            guid: Uint8Array.from(this.guid),
            version: this.version,
        });
    }

    sendPacket(
        command: string,
        body: Uint8Array,
        timeoutMs = this.timeout,
        signal?: AbortSignal,
    ): Promise<SendPacketResult> {
        return this.sendInternal(command, body, timeoutMs, signal, (result) => result);
    }

    /**
     * Bind a received response to the actual request sequence and command. The
     * caller's classifier and UIN verifier are trusted policy, not server
     * authentication; QQ-TEA does not authenticate the peer. Nonzero SSO
     * return codes still produce a binding, but are not successful responses.
     */
    sendBoundPacket(
        command: string,
        body: Uint8Array,
        timeoutMs = this.timeout,
        signal?: AbortSignal,
    ): Promise<Sso12BoundResult> {
        return this.sendInternal(command, body, timeoutMs, signal, (result, binding) =>
            binding
                ? { kind: 'response', result, binding }
                : { kind: 'failure', result, binding: null },
        );
    }

    private sendInternal<T>(
        command: string,
        body: Uint8Array,
        timeoutMs: number,
        signal: AbortSignal | undefined,
        wrap: (result: SendPacketResult, binding: Sso12ResponseBinding | null) => T,
    ): Promise<T> {
        const started = performance.now();

        if (this.closed || this.socket.destroyed || !this.socket.writable) {
            return Promise.resolve(wrap(failure('connection closed'), null));
        }

        if (this.rawPending && rawCallback.getStore() === this.rawPending) {
            this.shutdown('handler-error', 'callback-reentry', 'raw callback reentry');
            return Promise.resolve(wrap(failure('raw callback reentry'), null));
        }

        if (this.pending || this.rawPending) {
            return Promise.resolve(wrap(failure('single-flight capacity exceeded'), null));
        }

        if (
            typeof command !== 'string' ||
            command.length === 0 ||
            !(body instanceof Uint8Array) ||
            !Number.isInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 0x7fffffff ||
            (signal !== undefined && !(signal instanceof AbortSignal))
        ) {
            return Promise.resolve(wrap(failure('invalid request'), null));
        }

        if (signal?.aborted) {
            return Promise.resolve(wrap(failure('request cancelled', -3), null));
        }

        if (this.issued >= 0x100000000) {
            return Promise.resolve(wrap(failure('sequence space exhausted'), null));
        }

        const sequence = this.nextSequence;
        this.nextSequence = (sequence + 1) >>> 0;
        this.issued++;
        const deadline = started + timeoutMs;
        return new Promise((resolve) => {
            const onTimeout = (): void => {
                if (this.pending !== pending || this.closed) {
                    return;
                }

                if (!this.expired(pending)) {
                    pending.timer = setTimeout(
                        onTimeout,
                        Math.max(1, Math.ceil(deadline - performance.now())),
                    );
                }
            };

            const pending: Pending = {
                sequence,
                command,
                deadline,
                written: false,
                timer: setTimeout(onTimeout, Math.max(1, Math.ceil(deadline - performance.now()))),
                resolve: (result, binding) => resolve(wrap(result, binding)),
                signal,
            };
            this.pending = pending;

            if (signal) {
                pending.abort = () => {
                    if (this.pending === pending) {
                        this.abortRequest('request cancelled', -3, 'cancelled');
                    }
                };

                try {
                    signal.addEventListener('abort', pending.abort, { once: true });
                } catch {
                    this.settle(failure('cancellation setup failed'));
                    this.shutdown(
                        'handler-error',
                        'cancellation-setup-failed',
                        'cancellation setup failed',
                    );
                    return;
                }

                if (signal.aborted) {
                    pending.abort();
                    return;
                }
            }

            try {
                const size = body.length + Buffer.byteLength(command);

                if (this.pending !== pending || this.closed || this.expired(pending)) {
                    return;
                }

                if (size > this.maxWrite) {
                    this.settle(failure('transport capacity exceeded'));
                    return;
                }

                const input = Buffer.from(body);

                if (this.pending !== pending || this.closed || this.expired(pending)) {
                    return;
                }

                if (input.length + Buffer.byteLength(command) > this.maxWrite) {
                    this.settle(failure('transport capacity exceeded'));
                    return;
                }

                void this.prepare(pending, input);
            } catch {
                if (this.pending === pending && !this.closed && !this.expired(pending)) {
                    this.settle(failure('request preparation failed'));
                }
            }
        });
    }

    /**
     * One strict raw request/candidate exchange, before any service or SSO decode.
     * Callbacks own the entire semantic and authentication policy. Context is
     * caller-owned and is not authenticated or copied by this transport. A
     * write makes the outcome unknown on failure; no retry is performed. Callback
     * frame copies are cleared after use; copy any returned bytes to retain them.
     * Buffers are cleared where possible, without a JS memory-erasure guarantee.
     * Async callbacks may continue after cancellation; their side effects are caller-owned.
     * The socket owner must not pause, resume, read, or otherwise alter its read mode
     * while this client is active. Checks observe Node buffers, not arrival time in the OS.
     */
    transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const started = performance.now();

        if (this.closed || this.socket.destroyed || !this.socket.writable) {
            return Promise.resolve({ kind: 'failure', code: 'closed', writeState: 'not-written' });
        }

        if (this.rawPending && rawCallback.getStore() === this.rawPending) {
            this.shutdown('handler-error', 'callback-reentry', 'raw callback reentry');
            return Promise.resolve({
                kind: 'failure',
                code: 'callback-reentry',
                writeState: 'not-written',
            });
        }

        if (this.pending || this.rawPending) {
            return Promise.resolve({ kind: 'failure', code: 'busy', writeState: 'not-written' });
        }

        if (this.issued >= 0x100000000) {
            return Promise.resolve({
                kind: 'failure',
                code: 'sequence-exhausted',
                writeState: 'not-written',
            });
        }

        if (this.socket.isPaused() || this.decoder.hasPartial || this.socket.readableLength !== 0) {
            this.shutdown('protocol-error', 'raw-partial-stream', 'unexpected partial stream');
            return Promise.resolve({
                kind: 'failure',
                code: 'raw-partial-stream',
                writeState: 'not-written',
            });
        }

        const sequence = this.nextSequence;
        this.nextSequence = (sequence + 1) >>> 0;
        this.issued++;
        const identity = Object.freeze({ uin: this.uin, sequence });
        return new Promise((resolve) => {
            let context: C;
            let verify!: Sso12RawOptions<C, T>['verifyCandidate'];
            let consume!: Sso12RawOptions<C, T>['consumeCandidate'];

            const active = (): boolean => {
                if (this.rawPending !== pending || this.closed) {
                    return false;
                }

                if (performance.now() >= pending.deadline) {
                    this.shutdown('local', 'raw-timeout', 'raw transaction timed out');
                    return false;
                }

                // A partial candidate is expected only while waiting for its remaining bytes.
                if (
                    this.socket.isPaused() ||
                    (pending.phase !== 'waiting' &&
                        (this.socket.readableLength !== 0 || this.decoder.hasPartial))
                ) {
                    this.shutdown('protocol-error', 'raw-extra-data', 'unexpected raw data');
                    return false;
                }

                return true;
            };

            const timed = (): void => {
                if (!active()) {
                    return;
                }

                pending.timer = setTimeout(
                    timed,
                    Math.max(1, Math.ceil(pending.deadline - performance.now())),
                );
            };

            const pending: RawPending = {
                sequence,
                deadline: started + this.timeout,
                written: false,
                phase: 'building',
                timer: setTimeout(timed, this.timeout),
                accept: (candidate) => {
                    pending.candidate = candidate;
                    pending.phase = 'verifying';

                    void (async () => {
                        try {
                            if (!active()) {
                                return;
                            }

                            const first = Uint8Array.from(candidate);
                            pending.callbackCopy = first;
                            let accepted: boolean;

                            try {
                                accepted = await rawCallback.run(pending, () =>
                                    verify(first, context, identity),
                                );
                            } finally {
                                wipeRawBuffer(first);

                                if (pending.callbackCopy === first) {
                                    pending.callbackCopy = undefined;
                                }
                            }

                            if (!active()) {
                                return;
                            }

                            if (accepted !== true) {
                                this.shutdown(
                                    'handler-error',
                                    'raw-rejected',
                                    'raw candidate rejected',
                                );
                                return;
                            }

                            const second = Uint8Array.from(candidate);
                            pending.callbackCopy = second;
                            let value: T;

                            try {
                                value = await rawCallback.run(pending, () =>
                                    consume(second, context, identity),
                                );
                            } finally {
                                wipeRawBuffer(second);

                                if (pending.callbackCopy === second) {
                                    pending.callbackCopy = undefined;
                                }
                            }

                            if (!active()) {
                                return;
                            }

                            rawCallback.run(pending, () => this.removeRawAbort(pending));

                            if (!active()) {
                                return;
                            }

                            if (this.decoder.hasPartial || this.socket.readableLength !== 0) {
                                this.shutdown('protocol-error', 'raw-extra-data', 'extra raw data');
                                return;
                            }

                            this.rawPending = undefined;
                            clearTimeout(pending.timer);
                            wipeRawBuffer(candidate);
                            pending.candidate = undefined;
                            resolve({ kind: 'response', sequence, value, writeState: 'written' });
                        } catch {
                            if (this.rawPending === pending && !this.closed) {
                                this.shutdown(
                                    'handler-error',
                                    'raw-callback-failed',
                                    'raw callback failed',
                                );
                            }
                        }
                    })();
                },
                fail: (code) => {
                    if (this.rawPending !== pending) {
                        return;
                    }

                    this.rawPending = undefined;
                    clearTimeout(pending.timer);
                    this.removeRawAbort(pending);
                    wipeRawBuffer(pending.candidate);
                    wipeRawBuffer(pending.callbackCopy);
                    wipeRawBuffer(pending.requestFrame);
                    resolve({
                        kind: 'failure',
                        code,
                        writeState: pending.written ? 'unknown' : 'not-written',
                    });
                },
            };
            this.rawPending = pending;

            void (async () => {
                try {
                    if (!options || typeof options !== 'object') {
                        throw new Error('invalid');
                    }

                    const values = rawCallback.run(pending, () => ({
                        build: options.buildRequest,
                        verify: options.verifyCandidate,
                        consume: options.consumeCandidate,
                        timeout: options.timeoutMs ?? this.timeout,
                        signal: options.signal,
                    }));

                    if (this.rawPending !== pending || this.closed) {
                        return;
                    }

                    if (
                        typeof values.build !== 'function' ||
                        typeof values.verify !== 'function' ||
                        typeof values.consume !== 'function' ||
                        !Number.isInteger(values.timeout) ||
                        values.timeout < 1 ||
                        values.timeout > 0x7fffffff ||
                        (values.signal !== undefined && !(values.signal instanceof AbortSignal))
                    ) {
                        this.shutdown(
                            'handler-error',
                            'raw-invalid-options',
                            'invalid raw options',
                        );
                        return;
                    }

                    pending.deadline = started + values.timeout;
                    clearTimeout(pending.timer);
                    pending.timer = setTimeout(
                        timed,
                        Math.max(1, Math.ceil(pending.deadline - performance.now())),
                    );

                    if (!active()) {
                        return;
                    }

                    pending.signal = values.signal;

                    if (pending.signal) {
                        pending.abort = () => {
                            if (this.rawPending === pending) {
                                this.shutdown(
                                    'local',
                                    'raw-cancelled',
                                    'raw transaction cancelled',
                                );
                            }
                        };

                        try {
                            rawCallback.run(pending, () =>
                                pending.signal!.addEventListener('abort', pending.abort!, {
                                    once: true,
                                }),
                            );
                        } catch {
                            this.shutdown(
                                'handler-error',
                                'raw-signal-failed',
                                'raw cancellation setup failed',
                            );
                            return;
                        }

                        if (!active()) {
                            return;
                        }

                        if (rawCallback.run(pending, () => pending.signal!.aborted)) {
                            pending.abort();
                            return;
                        }

                        if (!active()) {
                            return;
                        }
                    }

                    verify = values.verify;
                    consume = values.consume;
                    const built = await rawCallback.run(pending, () => values.build(identity));

                    if (!active()) {
                        return;
                    }

                    // Copy the frame before reading context, whose getter may mutate caller-owned input.
                    const frameInput = rawCallback.run(pending, () => built.frame);

                    if (!active()) {
                        return;
                    }

                    if (
                        !isArrayBufferView(frameInput) ||
                        tagGetter.call(frameInput) !== 'Uint8Array' ||
                        !hasLocalUint8Prototype(frameInput)
                    ) {
                        throw new Error('invalid');
                    }

                    // The intrinsic detects detached and out-of-bounds resizable views.
                    typedArrayValues.call(frameInput);
                    const size = byteLengthGetter.call(frameInput) as number;
                    const offset = byteOffsetGetter.call(frameInput) as number;
                    const buffer = bufferGetter.call(frameInput) as ArrayBuffer | SharedArrayBuffer;
                    let shared = true;

                    try {
                        sharedByteLengthGetter.call(buffer);
                    } catch {
                        shared = false;
                    }

                    if (
                        shared ||
                        size < 14 ||
                        size > this.maxWrite ||
                        size > MAX_SERVICE_FRAME_BYTES
                    ) {
                        throw new Error('invalid');
                    }

                    const frame = Buffer.from(new Uint8Array(buffer, offset, size));
                    pending.requestFrame = frame;

                    if (!active()) {
                        return;
                    }

                    context = rawCallback.run(pending, () => built.context);

                    if (!active()) {
                        return;
                    }

                    if (frame.readUInt32BE(0) !== frame.length) {
                        throw new Error('invalid');
                    }

                    if (
                        this.decoder.hasPartial ||
                        this.socket.writableNeedDrain ||
                        this.socket.writableLength + frame.length > this.maxWrite
                    ) {
                        throw new Error('capacity');
                    }

                    if (!active() || this.socket.destroyed || !this.socket.writable) {
                        if (!this.closed) {
                            this.shutdown(
                                'transport-error',
                                'raw-socket-closed',
                                'connection closed',
                            );
                        }

                        return;
                    }

                    pending.phase = 'waiting';
                    pending.written = true;

                    try {
                        this.socket.write(frame, (error?: Error | null) => {
                            wipeRawBuffer(frame);

                            if (pending.requestFrame === frame) {
                                pending.requestFrame = undefined;
                            }

                            if (error && this.rawPending === pending && !this.closed) {
                                this.shutdown(
                                    'transport-error',
                                    'raw-write-failed',
                                    'socket write failed',
                                );
                            }
                        });
                    } catch {
                        this.shutdown('transport-error', 'raw-write-failed', 'socket write failed');
                        return;
                    }

                    active();
                } catch {
                    if (this.rawPending === pending && !this.closed && active()) {
                        this.shutdown(
                            'handler-error',
                            'raw-build-failed',
                            'raw request preparation failed',
                        );
                    }
                }
            })();
        });
    }

    private removeRawAbort(pending: RawPending): void {
        try {
            if (pending.signal && pending.abort) {
                pending.signal.removeEventListener('abort', pending.abort);
            }
        } catch {
            /* Caller-overridden signal must not prevent cleanup. */
        }
    }

    close(): void {
        this.shutdown('local', 'local-close', 'connection closed');
    }

    private async prepare(pending: Pending, body: Buffer): Promise<void> {
        try {
            const reserved = await this.buildReserved({
                uin: this.uin,
                sequence: pending.sequence,
                command: pending.command,
                body: Buffer.from(body),
            });

            if (this.pending !== pending || this.closed || this.expired(pending)) {
                return;
            }

            if (!(reserved instanceof Uint8Array)) {
                this.settle(failure('invalid reserved metadata'));
                return;
            }

            if (
                reserved.byteLength + body.length + Buffer.byteLength(pending.command) >
                this.maxWrite
            ) {
                this.settle(failure('transport capacity exceeded'));
                return;
            }

            const inner = encodeSso12Request({
                sequence: pending.sequence | 0,
                subAppId: this.subAppId,
                a2: this.a2,
                command: pending.command,
                guid: this.guid,
                version: this.version,
                reserved: Uint8Array.from(reserved),
                body,
            });
            const frame = encodeServiceRequest({
                protocol: 12,
                uin: this.uin,
                encryption: this.encryption,
                d2: this.encryption.type === 'd2' ? this.encryption.d2 : new Uint8Array(),
                body: inner,
            });

            if (this.pending !== pending || this.closed || this.expired(pending)) {
                return;
            }

            if (
                frame.length + this.socket.writableLength > this.maxWrite ||
                this.socket.writableNeedDrain
            ) {
                this.settle(failure('transport capacity exceeded'));
                return;
            }

            pending.written = true;

            try {
                this.socket.write(frame, (error?: Error | null) => {
                    if (error) {
                        this.shutdown('transport-error', 'write-failed', 'socket write failed');
                    }
                });

                if (this.pending === pending && !this.closed) {
                    this.expired(pending);
                }
            } catch {
                this.shutdown('transport-error', 'write-failed', 'socket write failed');
            }
        } catch {
            if (this.pending === pending && !this.closed && !this.expired(pending)) {
                this.settle(failure('request preparation failed'));
            }
        }
    }

    private readonly onData = (chunk: Buffer): void => {
        try {
            const raw = this.rawPending;

            if (raw) {
                if (this.socket.isPaused()) {
                    this.shutdown('protocol-error', 'raw-extra-data', 'unexpected raw data');
                    return;
                }

                if (raw.phase !== 'waiting' || !raw.written) {
                    this.shutdown('protocol-error', 'raw-unexpected-data', 'unexpected raw data');
                    return;
                }

                if (performance.now() >= raw.deadline) {
                    this.shutdown('local', 'raw-timeout', 'raw transaction timed out');
                    return;
                }

                const item = this.decoder.pushFirst(chunk);

                if (item.frame) {
                    if (
                        item.consumed !== chunk.length ||
                        this.decoder.hasPartial ||
                        this.socket.readableLength !== 0
                    ) {
                        item.frame.fill(0);
                        this.shutdown('protocol-error', 'raw-extra-data', 'extra raw data');
                        return;
                    }

                    raw.accept(item.frame);
                }

                return;
            }

            // Bound each returned frame list even when a peer coalesces many tiny frames.
            for (let offset = 0; offset < chunk.length && !this.closed; offset += 65536) {
                for (const frame of this.decoder.push(chunk.subarray(offset, offset + 65536))) {
                    const outer = decodeServiceResponse(
                        frame,
                        this.encryption.type === 'd2' ? this.encryption.key : undefined,
                    );

                    if (outer.protocol !== 12 || outer.encryption !== this.encryption.type) {
                        this.shutdown(
                            'protocol-error',
                            'unexpected-envelope',
                            'unexpected service envelope',
                        );
                        return;
                    }

                    let accepted: boolean;

                    try {
                        accepted = this.verifyUin(this.uin, outer.uin) === true;
                    } catch {
                        this.shutdown(
                            'handler-error',
                            'uin-verifier-failed',
                            'UIN verifier failed',
                        );
                        return;
                    }

                    if (this.closed) {
                        return;
                    }

                    if (!accepted) {
                        this.shutdown('protocol-error', 'uin-mismatch', 'response UIN mismatch');
                        return;
                    }

                    const response = decodeSsoResponse(outer.body);
                    // Do not let callback mutations alter the object used for matching.
                    const view: SsoResponse = {
                        ...response,
                        cookie: Uint8Array.from(response.cookie),
                        reserved: Uint8Array.from(response.reserved),
                        body: Uint8Array.from(response.body),
                        headerExtension: Uint8Array.from(response.headerExtension),
                    };
                    let classification: 'response' | 'push';

                    try {
                        classification = this.classify(view);
                    } catch {
                        this.shutdown(
                            'handler-error',
                            'classification-failed',
                            'incoming classification failed',
                        );
                        return;
                    }

                    if (this.closed) {
                        return;
                    }

                    if (classification === 'push') {
                        this.shutdown('protocol-error', 'push-unsupported', 'push unsupported');
                        return;
                    }

                    if (classification !== 'response') {
                        this.shutdown(
                            'protocol-error',
                            'invalid-classification',
                            'invalid incoming classification',
                        );
                        return;
                    }

                    const pending = this.pending;

                    if (!pending || response.sequence >>> 0 !== pending.sequence) {
                        this.shutdown(
                            'protocol-error',
                            'sequence-mismatch',
                            'response sequence mismatch',
                        );
                        return;
                    }

                    if (this.expired(pending)) {
                        return;
                    }

                    if (!pending.written) {
                        this.shutdown(
                            'protocol-error',
                            'response-before-write',
                            'response before request write',
                        );
                        return;
                    }

                    if (response.command !== pending.command) {
                        this.shutdown(
                            'protocol-error',
                            'command-mismatch',
                            'response command mismatch',
                        );
                        return;
                    }

                    this.settle(
                        {
                            success: response.retCode === 0,
                            gotResponse: true,
                            errorCode: response.retCode,
                            errorMessage: response.extra,
                            responseData: Buffer.from(response.body),
                        },
                        Object.freeze({ sequence: pending.sequence, command: pending.command }),
                    );
                }
            }
        } catch {
            this.shutdown('protocol-error', 'invalid-response', 'invalid service response');
        }
    };
    private readonly onError = (): void => {
        this.shutdown('transport-error', 'socket-error', 'socket error');
    };
    private readonly onEnd = (): void => {
        try {
            this.decoder.finish();
            this.shutdown('remote', 'remote-end', 'connection ended');
        } catch {
            this.shutdown('protocol-error', 'truncated-stream', 'truncated service stream');
        }
    };
    private readonly onClose = (): void => {
        this.shutdown('transport-error', 'socket-closed', 'connection closed');
        this.socket.off('error', this.onError);
        this.socket.off('close', this.onClose);
        this.releaseSocket();
        this.resolveClosed(this.reason!);
    };
    private expired(pending: Pending): boolean {
        if (performance.now() < pending.deadline) {
            return false;
        }

        this.abortRequest('request timed out', -2, 'timeout');
        return true;
    }
    private abortRequest(message: string, errorCode: number, code: string): void {
        if (!this.pending || this.closed) {
            return;
        }

        this.settle(failure(message, errorCode));
        this.shutdown('local', code, message);
    }
    private settle(result: SendPacketResult, binding: Sso12ResponseBinding | null = null): void {
        const pending = this.pending;

        if (!pending) {
            return;
        }

        this.pending = undefined;
        clearTimeout(pending.timer);

        try {
            if (pending.signal && pending.abort) {
                pending.signal.removeEventListener('abort', pending.abort);
            }
        } catch {
            // A caller-overridden signal must not prevent completion or teardown.
        } finally {
            pending.resolve(result, binding);
        }
    }
    private shutdown(kind: Sso12CloseReason['kind'], code: string, message: string): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.reason = Object.freeze({ kind, code });
        this.socket.off('data', this.onData);
        this.socket.off('end', this.onEnd);
        this.settle(failure(message));
        this.rawPending?.fail(code);
        this.decoder.discard();

        if (this.encryption.type === 'd2') {
            this.encryption.key.fill(0);
            this.encryption.d2.fill(0);
        }

        this.a2.fill(0);
        this.guid.fill(0);
        this.socket.destroy();
    }
}
