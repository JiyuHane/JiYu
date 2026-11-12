import type { Socket } from 'node:net';
import { Sso12PacketClient, type Sso12PacketClientOptions } from './sso12-packet-client';
import { createWtEcdh } from './wt-ecdh';
import { decodeWtCode2dResponse, decodeWtOicqResponse } from './wt-oicq';
import { buildWtQrOicq, type WtQrFrameOperation, type WtQrOicqContext } from './wt-qr-frame';
import { decodeWtQrD1Response } from './wt-qr-protobuf';
import { decodeWtQrFetchResponse, decodeWtQrPollResponse } from './wt-qr-response';

export interface WtQrFlowOptions {
    /** Already-connected, exclusively owned socket; establishing and securing it is caller-owned. */
    socket: Socket;
    profile: Omit<WtQrOicqContext, 'ecdh' | 'timestamp'> & {
        ssoVersion: string;
        serviceCommand: string;
    };
    /** Explicit time source: unsigned 32-bit seconds for each request. */
    getTimestamp: () => number;
    buildReserved: Sso12PacketClientOptions['buildReserved'];
    classifyIncoming: Sso12PacketClientOptions['classifyIncoming'];
    verifyResponseUin: NonNullable<Sso12PacketClientOptions['verifyResponseUin']>;
    /**
     * Caller must independently establish peer identity and integrity of the response and its
     * SSO context. This callback receives only the OICQ bytes after SSO decoding; the SSO12
     * client does not expose the complete wire frame. Returning true is a caller assertion,
     * not authentication implemented by this class or by QQ-TEA.
     */
    verifyResponse: (input: {
        operation: 'fetch' | 'poll';
        uin: string;
        command: string;
        sequence: number;
        oicq: Uint8Array;
    }) => boolean;
    /** Exact response command and UIN relationships are unknown; caller must check all relevant fields. */
    verifyContext: (input: {
        operation: 'fetch' | 'poll';
        requestUin: string;
        ssoSequence: number;
        ssoCommand: string;
        oicqCommand: number;
        oicqSequence: number;
        oicqUin: number;
        code2dCommand: number;
        code2dSequence: number;
        code2dUin: bigint;
        businessUin?: bigint;
        businessAppId: number;
    }) => boolean;
    /** Explicit half-open slice of the decoded code2d body, including any unknown trailer decision. */
    sliceBusiness: (input: { operation: 'fetch' | 'poll'; bodyLength: number }) => {
        start: number;
        end: number;
    };
    timeoutMs: number;
    initialSequence?: number;
}

type FetchFields = Extract<WtQrFrameOperation, { type: 'fetch' }>['fields'];
type FlowState = 'new' | 'ready' | 'terminal' | 'closed';
export type WtQrPollResult =
    | {
          status: 'confirmed';
          uin: bigint;
          retry: number;
          tickets: { tgtgtKey: Uint8Array; noPicSig: Uint8Array; tempPassword: Uint8Array };
      }
    | { status: 'wait' | 'confirm' | 'expired' | 'canceled' | 'invalid' | 'unknown'; code: number };

/**
 * Reference-only QR coordination. No 0x810, online state, signing algorithm or trust implementation.
 * Confirmation closes the socket and retains no ECDH handoff; unlike the reference's
 * reused keystore/socket lifecycle, this flow cannot continue to 0x810.
 * Copies can survive in JS, crypto providers and caller callbacks; erasure is not guaranteed.
 */
export class WtQrFlow {
    private readonly client: Sso12PacketClient;
    private readonly socket: Socket;
    private readonly profile: Omit<WtQrOicqContext, 'timestamp'> & {
        ssoVersion: string;
        serviceCommand: string;
    };
    private readonly getTimestamp: WtQrFlowOptions['getTimestamp'];
    private readonly verifyResponse: WtQrFlowOptions['verifyResponse'];
    private readonly verifyContext: WtQrFlowOptions['verifyContext'];
    private readonly sliceBusiness: WtQrFlowOptions['sliceBusiness'];
    private readonly timeoutMs: number;
    private state: FlowState = 'new';
    private busy = false;
    private deadline = 0;
    private qrSig?: Uint8Array;

    constructor(options: WtQrFlowOptions) {
        if (
            !options ||
            !options.profile ||
            typeof options.getTimestamp !== 'function' ||
            typeof options.verifyResponse !== 'function' ||
            typeof options.verifyContext !== 'function' ||
            typeof options.sliceBusiness !== 'function' ||
            typeof options.verifyResponseUin !== 'function' ||
            typeof options.buildReserved !== 'function' ||
            typeof options.classifyIncoming !== 'function' ||
            !Number.isInteger(options.timeoutMs) ||
            options.timeoutMs < 1 ||
            options.timeoutMs > 0x7fffffff
        ) {
            throw new TypeError('invalid QR flow configuration');
        }

        const p = options.profile;
        const uin = p.uin;
        const appId = p.appId;
        const subAppId = p.subAppId;
        const clientVersion = p.clientVersion;
        const ssoVersion = p.ssoVersion;
        const serviceCommand = p.serviceCommand;
        const guidInput = p.guid;

        if (!(guidInput instanceof Uint8Array)) {
            throw new TypeError('invalid QR profile');
        }

        const guid = Uint8Array.from(guidInput);
        const unknownInput = p.unknown21;

        if (!(unknownInput instanceof Uint8Array)) {
            throw new TypeError('invalid QR profile');
        }

        const unknown21 = Uint8Array.from(unknownInput);
        const randomInput = p.randomKey;

        if (!(randomInput instanceof Uint8Array)) {
            throw new TypeError('invalid QR profile');
        }

        const randomKey = Uint8Array.from(randomInput);
        const peerInput = p.peerPublicKey;

        if (!(peerInput instanceof Uint8Array)) {
            throw new TypeError('invalid QR profile');
        }

        const peerPublicKey = Uint8Array.from(peerInput);

        if (
            typeof uin !== 'string' ||
            !/^(0|[1-9][0-9]{0,18})$/.test(uin) ||
            BigInt(uin) > 0x7fffffffffffffffn ||
            typeof serviceCommand !== 'string' ||
            !serviceCommand ||
            Buffer.byteLength(serviceCommand) > 0xffff ||
            typeof ssoVersion !== 'string' ||
            !ssoVersion ||
            Buffer.byteLength(ssoVersion) > 0xfffd ||
            !Number.isInteger(appId) ||
            appId < 0 ||
            appId > 0xffffffff ||
            !Number.isInteger(subAppId) ||
            subAppId < 0 ||
            subAppId > 0x7fffffff ||
            !Number.isInteger(clientVersion) ||
            clientVersion < 0 ||
            clientVersion > 0xffff ||
            guid.length === 0 ||
            guid.length > 0xffff ||
            unknown21.length !== 21 ||
            randomKey.length !== 16
        ) {
            throw new TypeError('invalid QR profile');
        }

        const ecdh = createWtEcdh();
        const sharedKey = ecdh.deriveTeaKey(peerPublicKey);
        sharedKey.fill(0);
        const profile = Object.freeze({
            uin,
            appId,
            subAppId,
            clientVersion,
            guid,
            unknown21,
            randomKey,
            peerPublicKey,
            ecdh,
            ssoVersion,
            serviceCommand,
        });
        this.profile = profile;
        this.socket = options.socket;
        this.getTimestamp = options.getTimestamp;
        this.verifyResponse = options.verifyResponse;
        this.verifyContext = options.verifyContext;
        this.sliceBusiness = options.sliceBusiness;
        this.timeoutMs = options.timeoutMs;
        this.client = new Sso12PacketClient({
            socket: options.socket,
            uin: profile.uin,
            encryption: { type: 'zero' },
            subAppId: profile.subAppId,
            guid: profile.guid,
            version: profile.ssoVersion,
            a2: new Uint8Array(),
            buildReserved: options.buildReserved,
            classifyIncoming: options.classifyIncoming,
            verifyResponseUin: options.verifyResponseUin,
            initialSequence: options.initialSequence,
            defaultTimeoutMs: options.timeoutMs,
        });
        void this.client.whenClosed.then(() => this.finish('closed'));
    }

    async fetch(
        fields: FetchFields,
        signal?: AbortSignal,
    ): Promise<{ image: Uint8Array; qrUrl: string }> {
        this.enter('new', signal);

        try {
            if (!fields || typeof fields !== 'object') {
                throw new TypeError('invalid QR fetch fields');
            }

            const packageName = fields.packageName;
            const ptVersion = fields.ptVersion;
            const miscBitMap = fields.miscBitMap;
            const ssoVersion = fields.ssoVersion;
            const d1 = fields.d1;

            if (!(d1 instanceof Uint8Array)) {
                throw new TypeError('invalid QR fetch fields');
            }

            const d1Copy = Uint8Array.from(d1);
            const unusualSig = fields.unusualSig;
            this.assertActive(signal);

            if (unusualSig !== undefined && !(unusualSig instanceof Uint8Array)) {
                throw new TypeError('invalid QR fetch fields');
            }

            const input = {
                packageName,
                ptVersion,
                miscBitMap,
                ssoVersion,
                d1: d1Copy,
                unusualSig: unusualSig === undefined ? undefined : Uint8Array.from(unusualSig),
            };
            const decoded = await this.exchange({ type: 'fetch', fields: input }, signal);

            try {
                const response = decodeWtQrFetchResponse(decoded.body);

                try {
                    this.checkContext('fetch', decoded, response.appId);

                    if (response.status !== 'success') {
                        throw new Error('QR fetch rejected');
                    }

                    const d1 = decodeWtQrD1Response(response.d1);
                    this.assertActive(signal);
                    this.qrSig = Uint8Array.from(response.qrSig);
                    this.state = 'ready';
                    return { image: Uint8Array.from(response.image), qrUrl: d1.qrUrl! };
                } finally {
                    if (response.status === 'success') {
                        response.qrSig.fill(0);
                    } else {
                        response.remaining.fill(0);
                    }
                }
            } finally {
                this.scrub(decoded);
            }
        } catch {
            this.finish('terminal');
            throw new Error('QR fetch failed');
        } finally {
            this.busy = false;
        }
    }

    async poll(signal?: AbortSignal): Promise<WtQrPollResult> {
        this.enter('ready', signal);

        try {
            const qrSig = Uint8Array.from(this.qrSig!);
            let decoded: Awaited<ReturnType<WtQrFlow['exchange']>>;

            try {
                decoded = await this.exchange({ type: 'poll', qrSig }, signal);
            } finally {
                qrSig.fill(0);
            }

            try {
                const response = decodeWtQrPollResponse(decoded.body);

                try {
                    this.checkContext(
                        'poll',
                        decoded,
                        response.appId,
                        response.status === 'confirmed' ? response.uin : undefined,
                    );
                    this.assertActive(signal);

                    if (response.status === 'confirmed') {
                        this.finish('terminal');
                        return {
                            status: 'confirmed',
                            uin: response.uin,
                            retry: response.retry,
                            tickets: response.tickets,
                        };
                    }

                    if (response.status !== 'wait' && response.status !== 'confirm') {
                        this.finish('terminal');
                    }

                    return { status: response.status, code: response.retCode };
                } catch (error) {
                    if (response.status === 'confirmed') {
                        response.tickets.tgtgtKey.fill(0);
                        response.tickets.noPicSig.fill(0);
                        response.tickets.tempPassword.fill(0);
                    }

                    throw error;
                } finally {
                    if (response.status !== 'confirmed') {
                        response.remaining.fill(0);
                    }
                }
            } finally {
                this.scrub(decoded);
            }
        } catch {
            this.finish('terminal');
            throw new Error('QR poll failed');
        } finally {
            this.busy = false;
        }
    }

    close(): void {
        this.finish('closed');
    }

    private enter(expected: FlowState, signal?: AbortSignal): void {
        if (this.busy || this.state !== expected || this.socket.destroyed) {
            throw new Error('QR flow state or single-flight violation');
        }

        if (signal?.aborted) {
            this.finish('terminal');
            throw new Error('QR flow cancelled');
        }

        this.busy = true;
        this.deadline = performance.now() + this.timeoutMs;
    }

    private assertActive(signal?: AbortSignal): void {
        if (
            this.state === 'closed' ||
            this.state === 'terminal' ||
            this.socket.destroyed ||
            signal?.aborted ||
            performance.now() >= this.deadline
        ) {
            throw new Error('QR flow closed');
        }
    }

    private async exchange(operation: WtQrFrameOperation, signal?: AbortSignal) {
        this.assertActive(signal);
        // Exactly one randomized OICQ is created; the internal SSO12 client copies it
        // once for signing and transmits the same byte sequence.
        const timestamp = this.getTimestamp();
        this.assertActive(signal);
        const packet = buildWtQrOicq({ ...this.profile, timestamp }, operation);
        this.assertActive(signal);
        const remaining = Math.max(1, Math.ceil(this.deadline - performance.now()));
        const bound = await this.client.sendBoundPacket(
            this.profile.serviceCommand,
            packet,
            remaining,
            signal,
        );
        this.assertActive(signal);

        if (bound.kind !== 'response' || bound.binding.command !== this.profile.serviceCommand) {
            throw new Error('QR response binding failed');
        }

        const reply = bound.result;

        if (
            !reply.success ||
            !reply.gotResponse ||
            reply.errorCode !== 0 ||
            !(reply.responseData instanceof Uint8Array)
        ) {
            throw new Error('QR transport failure');
        }

        const bytes = Uint8Array.from(reply.responseData);

        if (
            this.verifyResponse({
                operation: operation.type,
                uin: this.profile.uin,
                command: bound.binding.command,
                sequence: bound.binding.sequence,
                oicq: Uint8Array.from(bytes),
            }) !== true
        ) {
            throw new Error('QR response verification failed');
        }

        this.assertActive(signal);
        const sharedKey = this.profile.ecdh.deriveTeaKey(this.profile.peerPublicKey);
        let oicq: ReturnType<typeof decodeWtOicqResponse>;

        try {
            oicq = decodeWtOicqResponse(bytes, {
                sharedKey,
                randomKey: this.profile.randomKey,
                ecdh: this.profile.ecdh,
            });
        } finally {
            sharedKey.fill(0);
        }

        let code2d: ReturnType<typeof decodeWtCode2dResponse> | undefined;

        try {
            code2d = decodeWtCode2dResponse(oicq.body);
            const slice = this.sliceBusiness({
                operation: operation.type,
                bodyLength: code2d.body.length,
            });
            this.assertActive(signal);

            if (!slice || typeof slice !== 'object') {
                throw new Error('invalid QR business boundary');
            }

            const start = slice.start;
            const end = slice.end;
            this.assertActive(signal);

            if (
                !Number.isInteger(start) ||
                !Number.isInteger(end) ||
                start < 0 ||
                end < start ||
                end > code2d.body.length
            ) {
                throw new Error('invalid QR business boundary');
            }

            return {
                oicq,
                code2d,
                binding: bound.binding,
                body: Uint8Array.from(code2d.body.subarray(start, end)),
            };
        } catch (error) {
            oicq.body.fill(0);
            code2d?.body.fill(0);
            throw error;
        }
    }

    private scrub(decoded: Awaited<ReturnType<WtQrFlow['exchange']>>): void {
        decoded.body.fill(0);
        decoded.code2d.body.fill(0);
        decoded.oicq.body.fill(0);
    }

    private checkContext(
        operation: 'fetch' | 'poll',
        decoded: Awaited<ReturnType<WtQrFlow['exchange']>>,
        businessAppId: number,
        businessUin?: bigint,
    ): void {
        if (
            this.verifyContext({
                operation,
                requestUin: this.profile.uin,
                ssoSequence: decoded.binding.sequence,
                ssoCommand: decoded.binding.command,
                oicqCommand: decoded.oicq.command,
                oicqSequence: decoded.oicq.sequence,
                oicqUin: decoded.oicq.uin,
                code2dCommand: decoded.code2d.command,
                code2dSequence: decoded.code2d.sequence,
                code2dUin: decoded.code2d.uin,
                businessUin,
                businessAppId,
            }) !== true
        ) {
            throw new Error('QR context verification failed');
        }
    }

    private finish(state: 'terminal' | 'closed'): void {
        if (this.state === 'closed' || this.state === 'terminal') {
            return;
        }

        this.state = state;
        this.qrSig?.fill(0);
        this.qrSig = undefined;
        this.profile.randomKey.fill(0);
        this.client.close();
    }
}
