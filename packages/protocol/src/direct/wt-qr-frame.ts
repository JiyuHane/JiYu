import { createWtEcdh } from './wt-ecdh';
import { encodeWtCode2dRequest } from './wt-oicq';
import { encodeWtQrFetchBody, encodeWtQrPollBody, type WtQrFetchBody } from './wt-qr-request';
import { encodeServiceRequest } from './service-frame';
import { encodeSso12Request } from './sso';
import type { SsoSigningRequest } from './sso-reserve';

// Composition based on a public reference, not a target-build wire observation.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/TransEmpService.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Context/PacketContext.cs
export interface WtQrFrameContext {
    /** Canonical decimal account for the outer service frame; use the actual profile's value. */
    uin: string;
    sequence: number;
    timestamp: number;
    appId: number;
    subAppId: number;
    clientVersion: number;
    ssoVersion: string;
    guid: Uint8Array;
    /** Bytes skipped by the reference; their target semantics remain unknown. */
    unknown21: Uint8Array;
    randomKey: Uint8Array;
    ecdh: ReturnType<typeof createWtEcdh>;
    peerPublicKey: Uint8Array;
    /** Exact service name must be selected by the caller for its target profile. */
    serviceCommand: string;
    /** Builds signature metadata over the complete OICQ packet, not the TLV body. */
    buildReserved: (request: SsoSigningRequest) => Promise<Uint8Array>;
}

export type WtQrFrameOperation =
    | { type: 'fetch'; fields: Omit<WtQrFetchBody, 'appId' | 'subAppId' | 'guid'> }
    | { type: 'poll'; qrSig: Uint8Array };

/** Only the fields used to construct the complete QR OICQ request body. */
export type WtQrOicqContext = Pick<
    WtQrFrameContext,
    | 'uin'
    | 'timestamp'
    | 'appId'
    | 'subAppId'
    | 'clientVersion'
    | 'guid'
    | 'unknown21'
    | 'randomKey'
    | 'ecdh'
    | 'peerPublicKey'
>;

function accountUin(context: WtQrOicqContext): bigint {
    if (
        !context ||
        typeof context !== 'object' ||
        typeof context.uin !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(context.uin)
    ) {
        throw new TypeError('invalid QR account');
    }

    const numericUin = BigInt(context.uin);

    if (numericUin > 0x7fffffffffffffffn) {
        throw new RangeError('QR account exceeds signed 64-bit range');
    }

    return numericUin;
}

function validateOicqProfile(context: WtQrOicqContext): void {
    if (
        !(context.guid instanceof Uint8Array) ||
        context.guid.length === 0 ||
        context.guid.length > 0xffff ||
        !Number.isInteger(context.subAppId) ||
        context.subAppId < 0 ||
        context.subAppId > 0x7fffffff ||
        !context.ecdh ||
        !(context.ecdh.publicKey instanceof Uint8Array) ||
        context.ecdh.publicKey.length !== 25 ||
        typeof context.ecdh.deriveTeaKey !== 'function'
    ) {
        throw new TypeError('invalid QR SSO profile');
    }
}

/**
 * Build one complete 0x812 OICQ body for the selected QR operation. A fresh
 * random TEA prefix is used on each call: pass these exact returned bytes to
 * the SSO sender, which must sign a copy of the same bytes it sends. This is
 * an offline reference-format encoder, not target interoperability evidence.
 */
export function buildWtQrOicq(context: WtQrOicqContext, operation: WtQrFrameOperation): Uint8Array {
    const numericUin = accountUin(context);
    validateOicqProfile(context);

    if (!operation || typeof operation !== 'object') {
        throw new TypeError('invalid QR operation');
    }

    const guid = Uint8Array.from(context.guid);
    const publicKey = Uint8Array.from(context.ecdh.publicKey);
    const body =
        operation.type === 'fetch'
            ? encodeWtQrFetchBody({
                  ...operation.fields,
                  appId: context.appId,
                  subAppId: context.subAppId,
                  guid,
              })
            : operation.type === 'poll'
              ? encodeWtQrPollBody({ appId: context.appId, qrSig: operation.qrSig })
              : (() => {
                    throw new Error('unknown QR operation');
                })();
    return encodeWtCode2dRequest({
        timestamp: context.timestamp,
        command: operation.type === 'fetch' ? 0x31 : 0x12,
        unknown21: context.unknown21,
        uin: numericUin,
        body,
        appId: context.appId,
        innerEncryption: { type: 'none' },
        clientVersion: context.clientVersion,
        encryption: { method: 0x87, ecdh: context.ecdh, peerPublicKey: context.peerPublicKey },
        head: { type: 'ecdh', randomKey: context.randomKey, publicKey },
    });
}

/**
 * Build one protocol-12/zero-key service request. This performs no network I/O,
 * login or server authentication. QR identity and signature policy are supplied
 * by the caller; no target-build compatibility is implied.
 */
export async function buildWtQrFrame(
    context: WtQrFrameContext,
    operation: WtQrFrameOperation,
): Promise<Uint8Array> {
    accountUin(context);

    if (typeof context.serviceCommand !== 'string' || context.serviceCommand.length === 0) {
        throw new TypeError('QR service command is required');
    }

    if (typeof context.buildReserved !== 'function') {
        throw new TypeError('QR reserved metadata builder is required');
    }

    if (
        typeof context.ssoVersion !== 'string' ||
        context.ssoVersion.length === 0 ||
        Buffer.byteLength(context.ssoVersion, 'utf8') > 0xfffd ||
        Buffer.byteLength(context.serviceCommand, 'utf8') > 0xffff
    ) {
        throw new TypeError('invalid QR SSO profile');
    }

    validateOicqProfile(context);

    if (!operation || typeof operation !== 'object') {
        throw new TypeError('invalid QR operation');
    }

    if (
        !Number.isInteger(context.sequence) ||
        context.sequence < -0x80000000 ||
        context.sequence > 0x7fffffff
    ) {
        throw new RangeError('QR sequence must fit in signed 32 bits');
    }

    // Snapshot mutable data before calling an asynchronous signer.
    const uin = context.uin;
    const sequence = context.sequence;
    const command = context.serviceCommand;
    const guid = Uint8Array.from(context.guid);
    const version = context.ssoVersion;
    const subAppId = context.subAppId;
    const oicq = buildWtQrOicq(context, operation);
    const reserved = await context.buildReserved({
        uin,
        command,
        sequence: sequence >>> 0,
        body: Uint8Array.from(oicq),
    });

    if (!(reserved instanceof Uint8Array)) {
        throw new TypeError('invalid QR reserved metadata');
    }

    const sso = encodeSso12Request({
        sequence,
        subAppId,
        a2: new Uint8Array(),
        command,
        guid,
        version,
        reserved,
        body: oicq,
    });
    return encodeServiceRequest({
        protocol: 12,
        encryption: { type: 'zero' },
        d2: new Uint8Array(),
        uin,
        body: sso,
    });
}
