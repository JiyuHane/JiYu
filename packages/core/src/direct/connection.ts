import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { ServiceFrameDecoder } from '@snowluma/protocol/direct/service-stream';
import type { RawMultiplexByteStream } from '@snowluma/protocol/direct/raw-multiplex-stream';
import { DirectLoginError } from './errors';

export const WIRE_LIMIT = 2 * 1024 * 1024;
export const frameHash = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');

export interface ConnectionDiagnostics {
    writeCalls: number;
    receivedFrames: number;
    socketBytesWritten: number;
    socketBytesRead: number;
}

/** Owns one TCP connection. Only hashes of actually received complete frames are retained.
 * This proves local provenance/association, not server identity or a MAC on QQ-TEA. */
export class ObservedConnection extends EventEmitter implements RawMultiplexByteStream {
    private readonly decoder = new ServiceFrameDecoder(WIRE_LIMIT);
    private readonly received = new Map<string, number>();
    private receivedCount = 0;
    private writeCalls = 0;
    private receivedFrames = 0;
    private written?: string;
    private readonly address: string;
    private readonly remotePort: number;
    private readonly localPort: number;
    readonly whenClosed: Promise<void>;

    constructor(private readonly socket: Socket) {
        super();

        if (!socket.remoteAddress || !socket.remotePort || !socket.localPort) {
            throw new DirectLoginError('transport');
        }

        this.address = socket.remoteAddress;
        this.remotePort = socket.remotePort;
        this.localPort = socket.localPort;
        this.on('error', this.ignoreError);
        this.whenClosed = new Promise((resolve) => {
            socket.once('close', () => {
                this.decoder.discard();
                this.received.clear();
                this.receivedCount = 0;
                this.written = undefined;
                socket.removeListener('data', this.onData);
                socket.removeListener('error', this.onError);
                socket.removeListener('end', this.onEnd);
                socket.removeListener('drain', this.onDrain);
                this.emit('close');
                resolve();
            });
        });
        socket.on('data', this.onData);
        socket.on('error', this.onError);
        socket.on('end', this.onEnd);
        socket.on('drain', this.onDrain);
        socket.setNoDelay(true);
    }
    private readonly ignoreError = () => {};
    private readonly onError = () => this.emit('error', new DirectLoginError('transport'));
    private readonly onEnd = () => this.emit('end');
    private readonly onDrain = () => this.emit('drain');
    private readonly onData = (chunk: Buffer) => {
        try {
            for (const frame of this.decoder.push(chunk)) {
                if (frame.length > WIRE_LIMIT || this.receivedCount >= 64) {
                    throw new Error();
                }

                const hash = frameHash(frame);
                this.received.set(hash, (this.received.get(hash) ?? 0) + 1);
                this.receivedCount++;
                this.receivedFrames++;
                this.emit('data', frame);
            }
        } catch {
            this.emit('error', new DirectLoginError('transport-framing'));
            this.destroy();
        }
    };
    get readable() {
        return this.socket.readable;
    }
    get writable() {
        return this.socket.writable;
    }
    get destroyed() {
        return this.socket.destroyed;
    }
    get readableFlowing() {
        return this.socket.readableFlowing;
    }
    get writableLength() {
        return this.socket.writableLength;
    }
    get writableNeedDrain() {
        return this.socket.writableNeedDrain;
    }
    get live(): boolean {
        return (
            !this.socket.destroyed &&
            this.socket.writable &&
            this.socket.readable &&
            this.socket.remoteAddress === this.address &&
            this.socket.remotePort === this.remotePort &&
            this.socket.localPort === this.localPort
        );
    }
    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        if (!this.live || bytes.length > WIRE_LIMIT) {
            throw new DirectLoginError('transport');
        }

        this.written = frameHash(bytes);
        this.writeCalls++;
        return this.socket.write(bytes, callback);
    }
    /** Node counters include locally queued writes; they are not a remote acknowledgement. */
    getDiagnostics(): ConnectionDiagnostics {
        return {
            writeCalls: this.writeCalls,
            receivedFrames: this.receivedFrames,
            socketBytesWritten: this.socket.bytesWritten,
            socketBytesRead: this.socket.bytesRead,
        };
    }
    destroy(): void {
        this.socket.destroy();
    }
    takeReceived(frame: Uint8Array): boolean {
        if (!this.live) {
            return false;
        }

        const hash = frameHash(frame);
        const count = this.received.get(hash) ?? 0;

        if (count === 0) {
            return false;
        }

        if (count === 1) {
            this.received.delete(hash);
        } else {
            this.received.set(hash, count - 1);
        }

        this.receivedCount--;
        return true;
    }
    verifyExchange(request: Uint8Array, response: Uint8Array): boolean {
        return this.live && this.written === frameHash(request) && this.takeReceived(response);
    }
}

export async function connectObserved(
    gateway: { host: string; port: number; family: 4 | 6 },
    timeoutMs: number,
    signal: AbortSignal,
): Promise<ObservedConnection> {
    const socket = new Socket();
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;

    let onAbort: () => void = () => {};

    let onError: () => void = () => {};

    let onConnect: () => void = () => {};

    try {
        await new Promise<void>((resolve, reject) => {
            onError = () => reject(new DirectLoginError('connect'));
            onAbort = () => reject(new DirectLoginError('aborted'));
            onConnect = resolve;
            socket.on('error', onError);
            socket.once('connect', onConnect);
            signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => reject(new DirectLoginError('connect-timeout')), timeoutMs);

            if (signal.aborted) {
                onAbort();
            } else {
                socket.connect(gateway);
            }
        });
        return new ObservedConnection(socket);
    } catch (error) {
        socket.destroy();
        await closed;
        throw error;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
    }
}
