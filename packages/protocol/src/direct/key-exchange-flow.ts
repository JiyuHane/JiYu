import { buildKeyExchange, decryptKeyExchangeBytes } from './key-exchange';
import {
    decodeKeyExchangeResponse,
    decodeKeyExchangeResponseSecret,
    encodeKeyExchangeRequest,
    encodeKeyExchangeRequestBuf,
} from './key-exchange-protobuf';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';

// This composition follows a public reference, not a verified QQ build or server capture.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/KeyExchangeService.cs
export const KEY_EXCHANGE_COMMAND = 'trpc.login.ecdh.EcdhService.SsoKeyExchange';

export interface KeyExchangeFlowInput {
    uin: string;
    guid: Uint8Array;
    version: string;
    subAppId: number;
    reserved: Uint8Array;
    sequence: number;
    serverPublicKey: Uint8Array;
    verifyKey: Uint8Array;
    timestamp: number;
    /** Must authenticate the response key and any proof using caller-owned trust. */
    verifyServerResponse: (response: {
        publicKey: Uint8Array;
        field2?: Uint8Array;
        secret: Uint8Array;
        requestPublicKey: Uint8Array;
        uin: string;
        sequence: number;
    }) => boolean;
}

export interface KeyExchangeFlowResult {
    sessionKey: Uint8Array;
    sessionTicket: Uint8Array;
    expiration?: number;
}

/**
 * Construct one frame and consume at most one response attempt, including failures.
 * The observed reference does not authenticate the response public key here;
 * the caller must supply a verifier. GCM alone does not establish server identity.
 */
export function createKeyExchangeFlow(input: KeyExchangeFlowInput): {
    request: Uint8Array;
    complete: (response: Uint8Array) => KeyExchangeFlowResult;
    cancel: () => void;
} {
    if (typeof input !== 'object' || input === null) {
        throw new TypeError('key exchange input must be an object');
    }

    if (typeof input.uin !== 'string' || !/^[0-9]{1,20}$/.test(input.uin)) {
        throw new Error('invalid service UIN');
    }

    if (!(input.guid instanceof Uint8Array) || input.guid.length === 0) {
        throw new TypeError('guid must be nonempty bytes');
    }

    if (!(input.reserved instanceof Uint8Array)) {
        throw new TypeError('reserved must be bytes');
    }

    if (typeof input.version !== 'string' || input.version.length === 0) {
        throw new TypeError('version must be a nonempty string');
    }

    if (typeof input.verifyServerResponse !== 'function') {
        throw new TypeError('server response verifier is required');
    }

    if (!Number.isInteger(input.subAppId) || input.subAppId < 0 || input.subAppId > 0x7fffffff) {
        throw new RangeError('subAppId must fit in nonnegative signed 32 bits');
    }

    if (
        !Number.isInteger(input.sequence) ||
        input.sequence < -0x80000000 ||
        input.sequence > 0x7fffffff
    ) {
        throw new RangeError('sequence must fit in signed 32 bits');
    }

    const uin = input.uin;
    const sequence = input.sequence;
    const verifyServerResponse = input.verifyServerResponse;
    const secret = encodeKeyExchangeRequestBuf({ uin, guid: input.guid });
    const exchange = buildKeyExchange(
        secret,
        input.serverPublicKey,
        input.verifyKey,
        input.timestamp,
    );
    // The request-side ECDH result is no longer needed after constructing the fields.
    exchange.sharedSecret.fill(0);
    const body = encodeKeyExchangeRequest({
        publicKey: exchange.publicKey,
        type: 1,
        secret: exchange.secret,
        timestamp: BigInt(exchange.timestamp),
        verifyHash: exchange.verifyHash,
    });
    const sso = encodeSso12Request({
        sequence,
        subAppId: input.subAppId,
        a2: new Uint8Array(),
        command: KEY_EXCHANGE_COMMAND,
        guid: input.guid,
        version: input.version,
        reserved: input.reserved,
        body,
    });
    const request = encodeServiceRequest({
        protocol: 12,
        encryption: { type: 'zero' },
        d2: new Uint8Array(),
        uin,
        body: sso,
    });
    let derive: typeof exchange.deriveResponseSecret | undefined = exchange.deriveResponseSecret;
    const requestPublicKey = Uint8Array.from(exchange.publicKey);

    return {
        request,
        cancel(): void {
            derive = undefined;
        },
        complete(response: Uint8Array): KeyExchangeFlowResult {
            const deriveOnce = derive;
            derive = undefined;

            if (!deriveOnce) {
                throw new Error('key exchange response already consumed');
            }

            if (!(response instanceof Uint8Array)) {
                throw new TypeError('response must be bytes');
            }

            const frame = decodeServiceResponse(response);

            if (frame.protocol !== 12 || frame.encryption !== 'zero') {
                throw new Error('unexpected key exchange service frame');
            }

            if (frame.uin !== uin) {
                throw new Error('key exchange account mismatch');
            }

            const parsed = decodeSsoResponse(frame.body);

            if (parsed.sequence !== sequence) {
                throw new Error('key exchange sequence mismatch');
            }

            if (parsed.command !== KEY_EXCHANGE_COMMAND) {
                throw new Error('key exchange command mismatch');
            }

            if (parsed.retCode !== 0) {
                throw new Error(`key exchange server error: ${parsed.retCode}`);
            }

            const payload = decodeKeyExchangeResponse(parsed.body);

            // The codec validates both required byte fields before returning.
            if (!payload.publicKey || !payload.secret) {
                throw new Error('missing key exchange response fields');
            }

            const verified = verifyServerResponse({
                publicKey: Uint8Array.from(payload.publicKey),
                field2: payload.field2 && Uint8Array.from(payload.field2),
                secret: Uint8Array.from(payload.secret),
                requestPublicKey: Uint8Array.from(requestPublicKey),
                uin,
                sequence,
            });

            if (verified !== true) {
                throw new Error('key exchange server verification failed');
            }

            const responseKey = deriveOnce(payload.publicKey);

            try {
                const decoded = decodeKeyExchangeResponseSecret(
                    decryptKeyExchangeBytes(payload.secret, responseKey),
                );

                if (!decoded.sessionKey?.length || !decoded.sessionTicket?.length) {
                    throw new Error('missing key exchange session key or ticket');
                }

                return {
                    sessionKey: decoded.sessionKey,
                    sessionTicket: decoded.sessionTicket,
                    expiration: decoded.expiration,
                };
            } finally {
                responseKey.fill(0);
            }
        },
    };
}
