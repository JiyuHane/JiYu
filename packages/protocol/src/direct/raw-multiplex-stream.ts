import { types as utilTypes } from 'node:util';
import type { Socket } from 'node:net';
import { claimDirectSocket } from './socket-ownership';
import { createRawMultiplexClient, type RawMultiplexClientOptions } from './raw-multiplex-client';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from './sso12-packet-client';

type Listener = (...args: unknown[]) => void;

/** The caller supplies an already-established byte stream, not a connection factory. */
export interface RawMultiplexByteStream {
    readonly readable: boolean;
    readonly writable: boolean;
    readonly destroyed: boolean;
    readonly readableFlowing: boolean | null;
    readonly writableLength: number;
    readonly writableNeedDrain: boolean;
    on(event: string, listener: Listener): unknown;
    removeListener(event: string, listener: Listener): unknown;
    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean;
    destroy(): unknown;
}

export type RawMultiplexStreamOptions = Omit<RawMultiplexClientOptions, 'write'> & {
    /** Caller asserts an established, exclusively controlled channel. */
    exclusiveConnected: true;
    maxWriteBufferBytes: number;
};

export interface RawMultiplexStreamClient extends Sso12RawClient {
    readonly closed: boolean;
}

// Deliberately never released: other wrappers/module instances are outside this registry.
const claimed = new WeakMap<object, true>();
const maxWriteLimit = 16 * 1024 * 1024;

/**
 * Own an injected stream until terminal, including destroying it on close. The caller
 * guarantees it is already connected and exclusive: no other reader, writer, listener
 * changes, pause/resume, or direct stream operations while owned. Stream methods must
 * implement Node-style event and write-callback semantics and destroy must eventually
 * emit close. The stream must not already be paused. No peer authentication or network
 * probing is performed. The shared direct-socket registry coordinates this module and
 * the existing direct socket clients, but not unrelated owners or module instances.
 *
 * `whenClosed` reports logical termination, not completion of stream destruction. The
 * adapter keeps its error listener until close, and removes its listeners then. The
 * caller remains responsible for errors emitted after close or by a nonconforming stream.
 * The caller must maintain its own error listener, including throughout setup failure;
 * if physical close or complete listener cleanup cannot be established, the shared
 * claim is retained. A successful write callback is local acceptance,
 * not peer receipt. A false write return is accepted, but a subsequent write while
 * writableNeedDrain remains true fails closed rather than waiting for drain. A pending
 * stream-owned write copy is never cleared before its callback; a nonconforming stream
 * that never calls back controls the lifetime of that copy.
 */
export function createRawMultiplexStream(
    stream: RawMultiplexByteStream,
    options: RawMultiplexStreamOptions,
): RawMultiplexStreamClient {
    if (typeof options !== 'object' || options === null || utilTypes.isProxy(options)) {
        throw new Error('invalid stream configuration');
    }

    const proto = Object.getPrototypeOf(options);
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const writeLimit: unknown = descriptors.maxWriteBufferBytes?.value;
    const allowed = [
        'uin',
        'initialSequence',
        'defaultTimeoutMs',
        'maxFrameBytes',
        'maxBufferedBytes',
        'maxFrames',
        'maxPushFrames',
        'maxPushBytes',
        'classify',
        'holdFollowingFrames',
        'verifyPush',
        'onPush',
        'exclusiveConnected',
        'maxWriteBufferBytes',
    ];

    if (
        (proto !== Object.prototype && proto !== null) ||
        Reflect.ownKeys(descriptors).some(
            (key) =>
                typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]),
        ) ||
        descriptors.exclusiveConnected?.value !== true ||
        typeof writeLimit !== 'number' ||
        !Number.isSafeInteger(writeLimit) ||
        writeLimit < 14 ||
        writeLimit > maxWriteLimit
    ) {
        throw new Error('invalid stream configuration');
    }

    if (typeof stream !== 'object' || stream === null || utilTypes.isProxy(stream)) {
        throw new Error('invalid stream');
    }

    if (claimed.has(stream)) {
        throw new Error('stream already owned or retired');
    }

    // claimDirectSocket uses only object identity; this cast never invokes Socket APIs.
    // Claim and retire before consulting caller-controlled methods or state getters.
    const releaseClaim = claimDirectSocket(stream as unknown as Socket);
    claimed.set(stream, true);
    const maxWrite = writeLimit;
    let terminal = false;
    let streamClosed = false;
    let client: ReturnType<typeof createRawMultiplexClient> | undefined;
    let onMethod: RawMultiplexByteStream['on'];
    let removeMethod: RawMultiplexByteStream['removeListener'];
    let writeMethod: RawMultiplexByteStream['write'];
    let destroyMethod: RawMultiplexByteStream['destroy'] | undefined;
    let activeWrite: { reject: (error: Error) => void } | undefined;
    let resolveClosed!: (reason: Sso12CloseReason) => void;
    const whenClosed = new Promise<Sso12CloseReason>((resolve) => {
        resolveClosed = resolve;
    });
    const registered: Array<[string, Listener]> = [];
    const isPaused = (): boolean => stream.readableFlowing === false;

    let cleanupFailed = false;
    let externalDepth = 0;
    let installing = false;
    let removing = false;
    let removeAllRequested = false;

    const remove = (keepClose: boolean): void => {
        if (!keepClose) {
            removeAllRequested = true;
        }

        if (removing) {
            return;
        }

        removing = true;

        try {
            while (true) {
                const index = registered.findIndex(
                    ([event]) => removeAllRequested || (event !== 'error' && event !== 'close'),
                );

                if (index < 0) {
                    break;
                }

                const [event, listener] = registered.splice(index, 1)[0];

                try {
                    removeMethod.call(stream, event, listener);
                } catch {
                    // Keep the shared claim if cleanup may have left a listener installed.
                    cleanupFailed = true;
                }
            }
        } finally {
            removing = false;
        }
    };

    const releaseIfClosed = (): void => {
        if (
            streamClosed &&
            externalDepth === 0 &&
            !installing &&
            !removing &&
            !cleanupFailed &&
            registered.length === 0
        ) {
            releaseClaim();
        }
    };

    const invokeExternal = <T>(action: () => T): T => {
        externalDepth++;

        try {
            return action();
        } finally {
            externalDepth--;
            releaseIfClosed();
        }
    };

    const finish = (reason?: Sso12CloseReason, alreadyClosed = false): void => {
        if (alreadyClosed) {
            streamClosed = true;
        }

        if (terminal) {
            if (streamClosed) {
                remove(false);
                releaseIfClosed();
            }

            return;
        }

        terminal = true;
        const pending = activeWrite;
        activeWrite = undefined;
        pending?.reject(new Error('stream closed'));

        if (reason) {
            client?.close();
            resolveClosed(Object.freeze(reason));
        } else if (client) {
            // Already closed by the mux; preserve its own exact close reason.
            void client.whenClosed.then((value) => resolveClosed(value));
        }

        remove(!streamClosed);

        if (!streamClosed) {
            try {
                invokeExternal(() => destroyMethod?.call(stream));
            } catch {
                // Physical close remains unknown; retain the shared ownership claim.
            }
        } else {
            releaseIfClosed();
        }
    };

    const fail = (): void => {
        if (!terminal && client?.closed) {
            finish();
        } else {
            finish({ kind: 'transport-error', code: 'stream-error' });
        }
    };

    const onError: Listener = () => fail();

    const onClose: Listener = () => {
        if (!terminal && client?.closed) {
            finish(undefined, true);
        } else {
            finish({ kind: 'transport-error', code: 'stream-closed' }, true);
        }
    };

    const onEnd: Listener = () => {
        if (!terminal && client) {
            if (!client.closed) {
                client.end();
            }

            // end() closes synchronously; fence the stream before asynchronous observation.
            finish();
        }
    };

    const onPause: Listener = () => fail();

    const onData: Listener = (chunk) => {
        if (terminal || !client) {
            return;
        }

        if (client.closed) {
            finish();
            return;
        }

        try {
            client.feed(chunk as Uint8Array);

            if (client.closed) {
                finish();
            }
        } catch {
            fail();
        }
    };

    const write = (frame: Uint8Array): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            if (client?.closed && !terminal) {
                finish();
            }

            if (terminal || activeWrite) {
                reject(new Error('stream closed or busy'));
                return;
            }

            let copy: Uint8Array;

            try {
                invokeExternal(() => {
                    const length = stream.writableLength;

                    if (
                        stream.destroyed !== false ||
                        stream.writable !== true ||
                        stream.writableNeedDrain !== false ||
                        !Number.isSafeInteger(length) ||
                        length < 0 ||
                        length + frame.byteLength > maxWrite
                    ) {
                        throw new Error('stream capacity');
                    }
                });
                copy = Uint8Array.from(frame);

                if (terminal || client?.closed) {
                    copy.fill(0);
                    throw new Error('stream closed');
                }
            } catch {
                reject(new Error('stream capacity'));
                fail();
                return;
            }

            let returned = false;
            let callbackSeen = false;
            let callbackFailed = false;
            let settled = false;
            const pending = { reject };
            activeWrite = pending;

            const settle = (): void => {
                if (!returned || !callbackSeen || settled) {
                    return;
                }

                settled = true;
                copy.fill(0);

                if (activeWrite === pending) {
                    activeWrite = undefined;
                }

                if (callbackFailed || terminal || client?.closed) {
                    reject(new Error('stream write failed'));

                    if (!terminal) {
                        fail();
                    }
                } else {
                    resolve();
                }
            };

            try {
                const accepted = invokeExternal(() =>
                    writeMethod.call(stream, copy, (error) => {
                        if (callbackSeen) {
                            return;
                        }

                        callbackSeen = true;
                        callbackFailed = error != null;
                        settle();
                    }),
                );

                if (typeof accepted !== 'boolean') {
                    throw new Error('invalid write result');
                }

                returned = true;
                settle();
            } catch {
                returned = true;
                callbackFailed = true;
                settle();

                if (activeWrite === pending) {
                    activeWrite = undefined;
                    reject(new Error('stream write failed'));
                }

                fail();
            }
        });

    externalDepth++;

    try {
        onMethod = stream.on;
        removeMethod = stream.removeListener;
        writeMethod = stream.write;
        destroyMethod = stream.destroy;

        if (
            typeof onMethod !== 'function' ||
            typeof removeMethod !== 'function' ||
            typeof writeMethod !== 'function' ||
            typeof destroyMethod !== 'function' ||
            stream.destroyed !== false ||
            stream.readable !== true ||
            stream.writable !== true ||
            isPaused() ||
            stream.writableNeedDrain !== false ||
            !Number.isSafeInteger(stream.writableLength) ||
            stream.writableLength < 0 ||
            stream.writableLength > maxWrite
        ) {
            throw new Error('invalid stream state');
        }

        const config: Record<string, unknown> = {};

        for (const key of allowed) {
            if (key !== 'exclusiveConnected' && key !== 'maxWriteBufferBytes' && descriptors[key]) {
                config[key] = descriptors[key].value;
            }
        }

        config.write = write;
        client = createRawMultiplexClient(config as unknown as RawMultiplexClientOptions);
        void client.whenClosed.then((reason) => finish(reason));

        for (const [event, listener] of [
            ['error', onError],
            ['close', onClose],
            ['end', onEnd],
            ['pause', onPause],
            ['data', onData],
        ] as Array<[string, Listener]>) {
            // Register first, since a throwing implementation may install before throwing.
            registered.push([event, listener]);
            installing = true;

            try {
                onMethod.call(stream, event, listener);
            } finally {
                installing = false;

                if (terminal || client.closed) {
                    // EventEmitter's newListener runs before insertion. A close during
                    // that callback may have removed this listener before it was added.
                    try {
                        removeMethod.call(stream, event, listener);
                    } catch {
                        cleanupFailed = true;
                    }

                    releaseIfClosed();
                }
            }

            if (terminal || client.closed) {
                throw new Error('stream closed during setup');
            }
        }

        if (
            stream.destroyed !== false ||
            stream.readable !== true ||
            stream.writable !== true ||
            isPaused() ||
            terminal ||
            client.closed
        ) {
            throw new Error('stream closed during setup');
        }

        const mux = client;
        return Object.freeze({
            get closed() {
                return terminal || mux.closed;
            },
            whenClosed,
            close() {
                if (mux.closed) {
                    finish();
                } else {
                    finish({ kind: 'local', code: 'local-close' });
                }
            },
            transactRaw<C, T>(input: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                if (mux.closed) {
                    finish();
                }

                const result = mux.transactRaw(input);

                if (mux.closed) {
                    finish();
                }

                return result;
            },
        });
    } catch {
        const destroyNeeded = !terminal && !streamClosed;
        terminal = true;
        activeWrite?.reject(new Error('stream setup failed'));
        activeWrite = undefined;
        client?.close();
        remove(!streamClosed);

        if (destroyNeeded) {
            try {
                invokeExternal(() => destroyMethod?.call(stream));
            } catch {
                // Physical close remains unknown; retain the shared ownership claim.
            }
        }

        if (streamClosed) {
            remove(false);
        }

        releaseIfClosed();
        throw new Error('stream setup failed');
    } finally {
        externalDepth--;
        releaseIfClosed();
    }
}
