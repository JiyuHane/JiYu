import type { Socket } from 'node:net';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { ServiceFrameDecoder } from './service-stream';
import { decodeSsoResponse, encodeSso13Request, type SsoResponse } from './sso';

export interface TcpPacketClientOptions {
    /** The caller owns connection establishment and supplies an already connected socket. */
    socket: Socket;
    uin: string;
    d2Key: Uint8Array;
    /** Supplies serialized metadata; this component does not create signatures or log in. */
    buildReserved: (request: {
        uin: string;
        sequence: number;
        command: string;
        body: Buffer;
    }) => Promise<Uint8Array>;
    /** Caller-supplied classification; an incorrect classifier can misroute pushes as responses. */
    classifyIncoming: (response: SsoResponse) => 'response' | 'push';
    onPush?: (response: SsoResponse) => void;
    initialSequence?: number;
    defaultTimeoutMs?: number;
    maxPending?: number;
    maxWriteBufferBytes?: number;
}

type Pending = {
    command: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: SendPacketResult) => void;
    written: boolean;
    deadline: number;
};

function failure(message: string, code = -1): SendPacketResult {
    return {
        success: false,
        gotResponse: false,
        errorCode: code,
        errorMessage: message,
        responseData: null,
    };
}

/**
 * A single-account service-13 transport. No login, signing, reconnect or live
 * compatibility is implied. Incoming classification is entirely caller-owned.
 * A timeout after a write has an unknown outcome; do not automatically retry.
 */
export class TcpPacketClient implements PacketSender {
    private readonly socket: Socket;
    private readonly uin: string;
    private readonly key: Uint8Array;
    private readonly buildReserved: TcpPacketClientOptions['buildReserved'];
    private readonly classifyIncoming: TcpPacketClientOptions['classifyIncoming'];
    private readonly onPush?: TcpPacketClientOptions['onPush'];
    private readonly decoder = new ServiceFrameDecoder();
    private readonly pending = new Map<number, Pending>();
    private readonly defaultTimeoutMs: number;
    private readonly maxPending: number;
    private readonly maxWriteBufferBytes: number;
    private nextSequence: number;
    private readonly firstSequence: number;
    private issued = 0;
    private closed = false;
    private blocked = false;
    private preparing = 0;
    private preparingBytes = 0;

    constructor(options: TcpPacketClientOptions) {
        if (
            !/^[0-9]{1,20}$/.test(options.uin) ||
            options.d2Key.byteLength !== 16 ||
            typeof options.classifyIncoming !== 'function' ||
            typeof options.buildReserved !== 'function'
        ) {
            throw new Error('invalid account or D2 key');
        }

        const sequence = options.initialSequence ?? 1;
        const timeout = options.defaultTimeoutMs ?? 15000;
        const maxPending = options.maxPending ?? 256;
        const maxWrite = options.maxWriteBufferBytes ?? 16 * 1024 * 1024;

        if (
            !Number.isInteger(sequence) ||
            sequence < 0 ||
            sequence > 0xffffffff ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            !Number.isSafeInteger(maxPending) ||
            maxPending < 1 ||
            !Number.isSafeInteger(maxWrite) ||
            maxWrite < 1
        ) {
            throw new RangeError('invalid transport limits');
        }

        if (
            options.socket.destroyed ||
            options.socket.connecting ||
            !options.socket.writable ||
            !options.socket.readable
        ) {
            throw new Error('socket must already be connected');
        }

        this.socket = options.socket;
        this.uin = options.uin;
        this.key = Uint8Array.from(options.d2Key);
        this.buildReserved = options.buildReserved;
        this.classifyIncoming = options.classifyIncoming;
        this.onPush = options.onPush;
        this.nextSequence = sequence;
        this.firstSequence = sequence;
        this.defaultTimeoutMs = timeout;
        this.maxPending = maxPending;
        this.maxWriteBufferBytes = maxWrite;
        this.socket.on('data', this.handleData);
        this.socket.on('drain', this.handleDrain);
        this.socket.on('error', this.handleError);
        this.socket.on('end', this.handleEnd);
        this.socket.on('close', this.handleClose);
    }

    sendPacket(
        command: string,
        body: Buffer,
        timeoutMs = this.defaultTimeoutMs,
    ): Promise<SendPacketResult> {
        if (this.closed || this.socket.destroyed || !this.socket.writable) {
            return Promise.resolve(failure('connection closed'));
        }

        if (
            !Number.isInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 0x7fffffff ||
            typeof command !== 'string' ||
            command.length === 0 ||
            !Buffer.isBuffer(body)
        ) {
            return Promise.resolve(failure('invalid request'));
        }

        if (
            this.pending.size >= this.maxPending ||
            this.preparing >= this.maxPending ||
            this.blocked ||
            Buffer.byteLength(command, 'utf8') > this.maxWriteBufferBytes ||
            body.length > this.maxWriteBufferBytes - this.preparingBytes
        ) {
            return Promise.resolve(failure('transport capacity exceeded'));
        }

        // Never reuse a sequence on this connection: a late response must not satisfy a newer request.
        if (this.issued === 0x100000000) {
            return Promise.resolve(failure('sequence space exhausted'));
        }

        const deadline = performance.now() + timeoutMs;
        const sequence = this.nextSequence;
        this.nextSequence = (sequence + 1) >>> 0;
        this.issued++;
        const input = Buffer.from(body);
        this.preparing++;
        this.preparingBytes += input.length;
        return new Promise((resolve) => {
            const timer = setTimeout(
                () => this.settle(sequence, failure('request timed out', -2)),
                timeoutMs,
            );
            this.pending.set(sequence, { command, timer, resolve, written: false, deadline });
            void this.prepareAndWrite(sequence, command, input);
        });
    }

    close(): void {
        this.shutdown('connection closed');
    }

    private async prepareAndWrite(sequence: number, command: string, body: Buffer): Promise<void> {
        try {
            const reserved = await this.buildReserved({
                uin: this.uin,
                sequence,
                command,
                body: Buffer.from(body),
            });

            if (!this.pending.has(sequence) || this.closed) {
                return;
            }

            if (this.hasExpired(sequence)) {
                return;
            }

            if (!(reserved instanceof Uint8Array)) {
                this.settle(sequence, failure('invalid reserved metadata'));
                return;
            }

            if (
                reserved.byteLength + body.length + Buffer.byteLength(command, 'utf8') >
                this.maxWriteBufferBytes
            ) {
                this.settle(sequence, failure('transport capacity exceeded'));
                return;
            }

            const inner = encodeSso13Request({ command, reserved, body });
            const frame = encodeServiceRequest({
                protocol: 13,
                sequence: sequence | 0,
                uin: this.uin,
                encryption: { type: 'd2', key: this.key },
                body: inner,
            });

            if (this.hasExpired(sequence)) {
                return;
            }

            if (
                this.blocked ||
                this.socket.writableLength + frame.length > this.maxWriteBufferBytes
            ) {
                this.settle(sequence, failure('transport capacity exceeded'));
                return;
            }

            this.pending.get(sequence)!.written = true;

            try {
                const accepted = this.socket.write(frame, (error?: Error | null) => {
                    if (error) {
                        this.shutdown('socket write failed');
                    }
                });

                if (!accepted) {
                    this.blocked = true;
                }
            } catch {
                this.shutdown('socket write failed');
            }
        } catch {
            this.settle(sequence, failure('request preparation or write failed'));
        } finally {
            this.preparing--;
            this.preparingBytes -= body.length;
        }
    }

    private readonly handleData = (chunk: Buffer): void => {
        try {
            for (const frame of this.decoder.push(chunk)) {
                const outer = decodeServiceResponse(frame, this.key);

                if (outer.uin !== this.uin || outer.protocol !== 13 || outer.encryption !== 'd2') {
                    this.shutdown('unexpected account or service envelope');
                    return;
                }

                const response = decodeSsoResponse(outer.body);
                let classification: 'response' | 'push';

                try {
                    classification = this.classifyIncoming(response);
                } catch {
                    this.shutdown('incoming classification callback failed');
                    return;
                }

                if (classification === 'push') {
                    if (!this.onPush) {
                        this.shutdown('push handler missing');
                        return;
                    }

                    try {
                        this.onPush(response);
                    } catch {
                        this.shutdown('push callback failed');
                        return;
                    }

                    if (this.closed) {
                        return;
                    }

                    continue;
                }

                if (classification !== 'response') {
                    this.shutdown('invalid incoming classification');
                    return;
                }

                const sequence = response.sequence >>> 0;
                const pending = this.pending.get(sequence);

                if (!pending) {
                    // Retired response sequences are discarded, never reused.
                    if ((sequence - this.firstSequence) >>> 0 >= this.issued) {
                        this.shutdown('response has unissued sequence');
                        return;
                    }
                } else if (this.hasExpired(sequence)) {
                    continue;
                } else if (!pending.written) {
                    this.shutdown('response before request write');
                    return;
                } else if (pending.command !== response.command) {
                    this.shutdown('response command mismatch');
                    return;
                } else {
                    this.settle(sequence, {
                        success: response.retCode === 0,
                        gotResponse: true,
                        errorCode: response.retCode,
                        errorMessage: response.extra,
                        responseData: Buffer.from(response.body),
                    });
                }

                if (this.closed) {
                    return;
                }
            }
        } catch {
            this.shutdown('invalid service response');
        }
    };

    private readonly handleDrain = (): void => {
        this.blocked = false;
    };
    private readonly handleError = (): void => {
        this.shutdown('socket error');
    };
    private readonly handleEnd = (): void => {
        try {
            this.decoder.finish();
            this.shutdown('connection ended');
        } catch {
            this.shutdown('truncated service stream');
        }
    };
    private readonly handleClose = (): void => {
        this.shutdown('connection closed');
        this.socket.off('error', this.handleError);
        this.socket.off('close', this.handleClose);
    };

    private hasExpired(sequence: number): boolean {
        const pending = this.pending.get(sequence);

        if (!pending) {
            return true;
        }

        if (performance.now() < pending.deadline) {
            return false;
        }

        this.settle(sequence, failure('request timed out', -2));
        return true;
    }

    private settle(sequence: number, result: SendPacketResult): void {
        const pending = this.pending.get(sequence);

        if (!pending) {
            return;
        }

        this.pending.delete(sequence);
        clearTimeout(pending.timer);
        pending.resolve(result);
    }

    private shutdown(message: string): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.socket.off('data', this.handleData);
        this.socket.off('drain', this.handleDrain);
        this.socket.off('end', this.handleEnd);

        for (const sequence of this.pending.keys()) {
            this.settle(sequence, failure(message));
        }

        this.key.fill(0);
        this.socket.destroy();
    }
}
