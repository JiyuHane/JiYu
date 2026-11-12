import type {
    KeyExchangeRequest,
    KeyExchangeRequestBuf,
    KeyExchangeResponse,
    KeyExchangeResponseSecret,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

// These are offline wire codecs, separate from the cryptographic primitives.
// Field numbers come from NTEcdh.cs; no captured response or online login was tested.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function message(value: unknown): asserts value is object {
    if (typeof value !== 'object' || value === null || value instanceof Uint8Array) {
        throw new TypeError('protobuf message must be an object');
    }
}

function byteField(value: unknown, name: string, required = false): void {
    if (value == null && !required) {
        return;
    }

    if (!(value instanceof Uint8Array) || (required && value.length === 0)) {
        throw new TypeError(`${name} must be ${required ? 'nonempty ' : ''}bytes`);
    }

    if (value.byteLength > MAX_MESSAGE_BYTES) {
        throw new RangeError(`${name} exceeds size limit`);
    }
}

function uint32Field(value: unknown, name: string): void {
    if (
        value != null &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    ) {
        throw new RangeError(`${name} must be a uint32`);
    }
}

function requestFields(value: KeyExchangeRequest): void {
    message(value);
    byteField(value.publicKey, 'publicKey');
    uint32Field(value.type, 'type');
    byteField(value.secret, 'secret');

    if (
        value.timestamp != null &&
        (typeof value.timestamp !== 'bigint' ||
            value.timestamp < -(1n << 63n) ||
            value.timestamp >= 1n << 63n)
    ) {
        throw new RangeError('timestamp must be an int64 bigint');
    }

    byteField(value.verifyHash, 'verifyHash');
}

function responseFields(value: KeyExchangeResponse): void {
    message(value);
    byteField(value.secret, 'secret', true);
    byteField(value.field2, 'field2');
    byteField(value.publicKey, 'publicKey', true);
}

function requestBufFields(value: KeyExchangeRequestBuf): void {
    message(value);

    if (value.uin != null && typeof value.uin !== 'string') {
        throw new TypeError('uin must be a string');
    }

    if (value.uin != null && Buffer.byteLength(value.uin, 'utf8') > MAX_MESSAGE_BYTES) {
        throw new RangeError('uin exceeds size limit');
    }

    byteField(value.guid, 'guid');
}

function responseSecretFields(value: KeyExchangeResponseSecret): void {
    message(value);
    byteField(value.sessionKey, 'sessionKey', true);
    byteField(value.sessionTicket, 'sessionTicket', true);
    uint32Field(value.expiration, 'expiration');
}

function forwardFields(value: NTLoginForwardRequest): void {
    message(value);
    byteField(value.sessionTicket, 'sessionTicket');
    byteField(value.buffer, 'buffer');
    uint32Field(value.type, 'type');
    byteField(value.secBuffer, 'secBuffer');
}

function wireBytes(value: Uint8Array): void {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError('protobuf input must be bytes');
    }

    if (value.byteLength > MAX_MESSAGE_BYTES) {
        throw new RangeError('protobuf message exceeds size limit');
    }
}

export function encodeKeyExchangeRequest(value: KeyExchangeRequest): Uint8Array {
    requestFields(value);
    return protobuf_encode<KeyExchangeRequest>(value);
}

export function decodeKeyExchangeRequest(bytes: Uint8Array): KeyExchangeRequest {
    wireBytes(bytes);
    const result = protobuf_decode<KeyExchangeRequest>(bytes);
    requestFields(result);
    return result;
}

export function encodeKeyExchangeResponse(value: KeyExchangeResponse): Uint8Array {
    responseFields(value);
    return protobuf_encode<KeyExchangeResponse>(value);
}

export function decodeKeyExchangeResponse(bytes: Uint8Array): KeyExchangeResponse {
    wireBytes(bytes);
    const result = protobuf_decode<KeyExchangeResponse>(bytes);
    responseFields(result);
    return result;
}

export function encodeKeyExchangeRequestBuf(value: KeyExchangeRequestBuf): Uint8Array {
    requestBufFields(value);
    return protobuf_encode<KeyExchangeRequestBuf>(value);
}

export function decodeKeyExchangeRequestBuf(bytes: Uint8Array): KeyExchangeRequestBuf {
    wireBytes(bytes);
    const result = protobuf_decode<KeyExchangeRequestBuf>(bytes);
    requestBufFields(result);
    return result;
}

export function encodeKeyExchangeResponseSecret(value: KeyExchangeResponseSecret): Uint8Array {
    responseSecretFields(value);
    return protobuf_encode<KeyExchangeResponseSecret>(value);
}

export function decodeKeyExchangeResponseSecret(bytes: Uint8Array): KeyExchangeResponseSecret {
    wireBytes(bytes);
    const result = protobuf_decode<KeyExchangeResponseSecret>(bytes);
    responseSecretFields(result);
    return result;
}

export function encodeNTLoginForwardRequest(value: NTLoginForwardRequest): Uint8Array {
    forwardFields(value);
    return protobuf_encode<NTLoginForwardRequest>(value);
}

export function decodeNTLoginForwardRequest(bytes: Uint8Array): NTLoginForwardRequest {
    wireBytes(bytes);
    const result = protobuf_decode<NTLoginForwardRequest>(bytes);
    forwardFields(result);
    return result;
}
