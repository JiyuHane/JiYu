import { randomBytes } from 'node:crypto';
import type { DirectSsoReserve, DirectSsoSecureInfo } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_encode } from '@snowluma/proton';

// Field numbers follow a public reference, not a verified target-build capture.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoReserveFields.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoPacker.cs
const MAX_METADATA_FIELD_BYTES = 64 * 1024;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export interface SsoSigningRequest {
    uin: string;
    command: string;
    /** Unsigned 32-bit bit pattern of the SSO sequence. */
    sequence: number;
    body: Uint8Array;
}

export interface SsoSignature {
    sign: Uint8Array;
    token: Uint8Array;
    extra: Uint8Array;
}

export interface SsoReserveBuilderOptions {
    uin: string;
    uid?: string;
    /** The caller must decide which commands need a signature for its profile. */
    classifySigning: (command: string) => 'sign' | 'unsigned';
    /** Caller-provided signer; no signing algorithm or remote service is built in. */
    sign?: (request: SsoSigningRequest) => Promise<SsoSignature>;
    /** Caller-provided profile values; neither is automatically set for any platform. */
    msgType?: number;
    ntCoreVersion?: number;
    /** Optional test/profile override; default uses random bytes for every request. */
    createTraceParent?: () => string;
}

function validateString(
    value: unknown,
    name: string,
    allowEmpty: boolean,
): asserts value is string {
    if (
        typeof value !== 'string' ||
        (!allowEmpty && value.length === 0) ||
        Buffer.byteLength(value, 'utf8') > MAX_METADATA_FIELD_BYTES
    ) {
        throw new TypeError(`invalid ${name}`);
    }
}

function validateUint32(value: unknown, name: string): void {
    if (
        value !== undefined &&
        (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff)
    ) {
        throw new RangeError(`invalid ${name}`);
    }
}

function validateSignatureField(
    value: unknown,
    name: string,
    nonempty: boolean,
): asserts value is Uint8Array {
    if (
        !(value instanceof Uint8Array) ||
        (nonempty && value.length === 0) ||
        value.length > MAX_METADATA_FIELD_BYTES
    ) {
        throw new TypeError(`invalid signature ${name}`);
    }
}

function makeTraceParent(): string {
    const trace = randomBytes(24).toString('hex');
    return `01-${trace.slice(0, 32)}-${trace.slice(32)}-01`;
}

/**
 * Create an account-bound builder compatible with TcpPacketClient.buildReserved.
 * Signature classification is explicit and a missing/invalid required signature
 * fails rather than silently emitting an unsigned request. The signer sees a copy
 * of the exact command body; mutations do not affect the packet being sent.
 */
export function createSsoReserveBuilder(
    options: SsoReserveBuilderOptions,
): (request: SsoSigningRequest) => Promise<Uint8Array> {
    if (!options || typeof options !== 'object' || !/^[0-9]{1,20}$/.test(options.uin)) {
        throw new TypeError('invalid account');
    }

    if (typeof options.classifySigning !== 'function') {
        throw new TypeError('signature classification is required');
    }

    if (options.uid !== undefined) {
        validateString(options.uid, 'uid', true);
    }

    validateUint32(options.msgType, 'msgType');
    validateUint32(options.ntCoreVersion, 'ntCoreVersion');
    const { uin, uid, classifySigning, sign, msgType, ntCoreVersion } = options;
    const createTraceParent = options.createTraceParent ?? makeTraceParent;

    if (typeof createTraceParent !== 'function') {
        throw new TypeError('invalid trace generator');
    }

    return async (request: SsoSigningRequest): Promise<Uint8Array> => {
        if (!request || request.uin !== uin) {
            throw new Error('SSO reserve account mismatch');
        }

        validateString(request.command, 'command', false);

        if (request.sequence === undefined) {
            throw new RangeError('invalid sequence');
        }

        validateUint32(request.sequence, 'sequence');

        if (
            !(request.body instanceof Uint8Array) ||
            request.body.byteLength > MAX_REQUEST_BODY_BYTES
        ) {
            throw new TypeError('invalid SSO request body');
        }

        const traceParent = createTraceParent();
        validateString(traceParent, 'trace parent', false);
        const disposition = classifySigning(request.command);
        let secureInfo: DirectSsoSecureInfo | undefined;

        if (disposition === 'sign') {
            if (typeof sign !== 'function') {
                throw new Error('required SSO signer is missing');
            }

            const signature = await sign({
                uin,
                command: request.command,
                sequence: request.sequence,
                body: Uint8Array.from(request.body),
            });

            if (!signature || typeof signature !== 'object') {
                throw new TypeError('invalid SSO signature');
            }

            validateSignatureField(signature.sign, 'sign', true);
            validateSignatureField(signature.token, 'token', false);
            validateSignatureField(signature.extra, 'extra', false);
            secureInfo = {
                sign: Uint8Array.from(signature.sign),
                token: Uint8Array.from(signature.token),
                extra: Uint8Array.from(signature.extra),
            };
        } else if (disposition !== 'unsigned') {
            throw new Error('invalid signature classification');
        }

        const reserve: DirectSsoReserve = { traceParent, uid, msgType, secureInfo, ntCoreVersion };
        return protobuf_encode<DirectSsoReserve>(reserve);
    };
}
