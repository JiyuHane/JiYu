import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import {
    createSsoReferenceExchange,
    type SsoReferenceExchangeCapability,
    type SsoReferenceExchangeOptions,
} from './sso-reference-exchange-internal';
import type { Sso12RawResult } from './sso12-packet-client';

export type WtReferencePacketCommand =
    | 'MessageSvc.PbSendMsg'
    | 'OidbSvcTrpcTcp.0xfd4_1'
    | 'OidbSvcTrpcTcp.0xfe1_2'
    | 'OidbSvcTrpcTcp.0xfe5_2'
    | 'OidbSvcTrpcTcp.0xfe7_3'
    | 'OidbSvcTrpcTcp.0x9067_202';

export interface WtReferencePacketInput {
    readonly command: WtReferencePacketCommand;
    /** Borrowed only for the synchronous snapshot; never retained across an await. */
    readonly body: Uint8Array;
    readonly timeoutMs: number;
    /** Post-inflation acceptance cap, 0..2097152 bytes; requests remain capped at 65536. */
    readonly maxResponseBodyBytes: number;
}

export interface WtReferencePacketResult {
    readonly status: 'response';
    readonly command: WtReferencePacketCommand;
    readonly sequence: number;
    readonly retCode: 0;
    /** Independent caller-owned bytes after successful delivery. No business decoding is implied. */
    readonly body: Uint8Array;
    readonly writeState: 'written';
}

type WriteState = Sso12RawResult<unknown>['writeState'];
export interface ReferencePacketProgress {
    writeState: WriteState;
}

export class WtReferencePacketError extends Error {
    readonly writeState: WriteState;
    constructor(
        readonly command: WtReferencePacketCommand,
        progress: Readonly<ReferencePacketProgress>,
        readonly code: 'exchange-failed' | 'sso-error' | 'operation-stopped',
        readonly retCode?: number,
        readonly sequence?: number,
        readonly transportCode?: string,
    ) {
        super(`packet request ${code}`);
        this.name = 'WtReferencePacketError';
        this.writeState = progress.writeState;
    }
}

/** Code-owned exact names only; no prefix matching, registration, or caller extension. */
export function isWtReferencePacketCommand(value: unknown): value is WtReferencePacketCommand {
    switch (value) {
        case 'MessageSvc.PbSendMsg':
        case 'OidbSvcTrpcTcp.0xfd4_1':
        case 'OidbSvcTrpcTcp.0xfe1_2':
        case 'OidbSvcTrpcTcp.0xfe5_2':
        case 'OidbSvcTrpcTcp.0xfe7_3':
        case 'OidbSvcTrpcTcp.0x9067_202':
            return true;
        default:
            return false;
    }
}

const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;

function copyBytes(value: unknown): Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new TypeError('invalid packet bytes');
    }

    values.call(value);
    const size = byteLength.call(value) as number;
    const storage = buffer.call(value) as ArrayBufferLike;

    if (size > 65536 || isSharedArrayBuffer(storage) || (resizable && resizable.call(storage))) {
        throw new TypeError('invalid packet bytes');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > size + 16) {
        throw new TypeError('invalid packet bytes');
    }

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('invalid packet bytes');
        }
    }

    return Uint8Array.from(new Uint8Array(storage, byteOffset.call(value) as number, size));
}

export function prepareReferencePacketInput(input: unknown): WtReferencePacketInput {
    if (!input || typeof input !== 'object' || isProxy(input)) {
        throw new TypeError('invalid packet input');
    }

    const prototype = Object.getPrototypeOf(input) as unknown;
    const keys = Reflect.ownKeys(input);
    const allowed = ['command', 'body', 'timeoutMs', 'maxResponseBodyBytes'];

    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== allowed.length) {
        throw new TypeError('invalid packet input');
    }

    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid packet input');
        }

        record[key] = descriptor.value;
    }

    const { command, timeoutMs, maxResponseBodyBytes } = record;

    if (
        !isWtReferencePacketCommand(command) ||
        typeof timeoutMs !== 'number' ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 0x7fffffff ||
        typeof maxResponseBodyBytes !== 'number' ||
        !Number.isSafeInteger(maxResponseBodyBytes) ||
        maxResponseBodyBytes < 0 ||
        maxResponseBodyBytes > 2 * 1024 * 1024
    ) {
        throw new TypeError('invalid packet command or limits');
    }

    return Object.freeze({
        command,
        timeoutMs,
        maxResponseBodyBytes,
        body: copyBytes(record.body),
    });
}

export function disposePreparedReferencePacket(input: WtReferencePacketInput | undefined): void {
    if (input) {
        try {
            fill.call(input.body, 0);
        } catch {
            // A detached view is already inaccessible; still release every owner gate.
        }
    }
}

export function disposeReferencePacketResult(result: WtReferencePacketResult | undefined): void {
    if (result && !isProxy(result)) {
        const body = Object.getOwnPropertyDescriptor(result, 'body');

        if (body && 'value' in body) {
            try {
                fill.call(body.value as Uint8Array, 0);
            } catch {
                // A revoked/detached delivery copy is best effort; never skip owner cleanup.
            }
        }
    }
}

type EncodedRequest = { body: Uint8Array };
const makeExchange = (command: WtReferencePacketCommand) =>
    createSsoReferenceExchange<EncodedRequest, Uint8Array>({
        name: 'fixed-owner-packet',
        command,
        responseBodyLimit: 2 * 1024 * 1024,
        snapshotRequest: (input, record) => ({ body: record(input, ['body']).body as Uint8Array }),
        // Only prepared owner-owned bytes reach this internal spec.
        encodeRequest: (request) => Uint8Array.from(request.body),
        decodeResponse: (body) => Uint8Array.from(body),
        disposeResponse: (body) => {
            fill.call(body, 0);
        },
    });
const exchanges = Object.freeze({
    'MessageSvc.PbSendMsg': makeExchange('MessageSvc.PbSendMsg'),
    'OidbSvcTrpcTcp.0xfd4_1': makeExchange('OidbSvcTrpcTcp.0xfd4_1'),
    'OidbSvcTrpcTcp.0xfe1_2': makeExchange('OidbSvcTrpcTcp.0xfe1_2'),
    'OidbSvcTrpcTcp.0xfe5_2': makeExchange('OidbSvcTrpcTcp.0xfe5_2'),
    'OidbSvcTrpcTcp.0xfe7_3': makeExchange('OidbSvcTrpcTcp.0xfe7_3'),
    'OidbSvcTrpcTcp.0x9067_202': makeExchange('OidbSvcTrpcTcp.0x9067_202'),
});

export async function referencePacketWithCapability(
    binding: SsoReferenceExchangeCapability,
    prepared: WtReferencePacketInput,
    options: Omit<
        SsoReferenceExchangeOptions<EncodedRequest>,
        'request' | 'timeoutMs' | 'maxResponseBodyBytes'
    >,
    deadline: number,
    progress: ReferencePacketProgress,
    checkOwner: () => void,
): Promise<WtReferencePacketResult> {
    const check = (): number => {
        checkOwner();
        const remaining = Math.floor(deadline - performance.now());
        checkOwner();

        if (remaining < 1) {
            throw new WtReferencePacketError(prepared.command, progress, 'operation-stopped');
        }

        return remaining;
    };

    const timeoutMs = check();
    let pending: Uint8Array | undefined;

    try {
        progress.writeState = 'unknown';
        const result = await exchanges[prepared.command](
            undefined,
            {
                ...options,
                request: { body: prepared.body },
                timeoutMs,
                maxResponseBodyBytes: prepared.maxResponseBodyBytes,
                buildReserved: async (input) => {
                    check();
                    const signed = await options.buildReserved(input);
                    check();
                    return signed;
                },
                verifyRaw: async (input) => {
                    check();
                    const verified = await options.verifyRaw(input);
                    check();
                    return verified;
                },
            },
            binding,
        );
        progress.writeState = result.writeState;

        if (result.kind !== 'response') {
            throw new WtReferencePacketError(
                prepared.command,
                progress,
                'exchange-failed',
                undefined,
                undefined,
                result.code,
            );
        }

        if (result.value.status !== 'response') {
            throw new WtReferencePacketError(
                prepared.command,
                progress,
                'sso-error',
                result.value.retCode,
                result.sequence,
            );
        }

        pending = result.value.response;
        check();
        const response: WtReferencePacketResult = Object.freeze({
            status: 'response',
            command: prepared.command,
            sequence: result.sequence,
            retCode: 0,
            body: pending,
            writeState: 'written',
        });
        pending = undefined;
        return response;
    } finally {
        if (pending) {
            fill.call(pending, 0);
        }
    }
}
