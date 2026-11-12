import type { WtQrExtInfo } from '@snowluma/proto-defs/wt-qr';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

// Offline reference only; neither target-build captures nor online behavior are verified.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/TlvQrCode.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/TransEmpService.cs
const MAX_D1_BYTES = 0xffff;

export interface WtQrD1Request {
    deviceType: string;
    deviceName: string;
}

function object(value: unknown, name: string): asserts value is Record<string, unknown> {
    if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        value instanceof Uint8Array
    ) {
        throw new TypeError(`${name} must be an object`);
    }
}

function text(value: unknown, name: string, required = false): void {
    if (value == null && !required) {
        return;
    }

    if (typeof value !== 'string') {
        throw new TypeError(`${name} must be a string`);
    }

    if (Buffer.byteLength(value, 'utf8') > MAX_D1_BYTES) {
        throw new RangeError(`${name} exceeds D1 size limit`);
    }
}

function uint32(value: unknown, name: string): void {
    if (value == null) {
        return;
    }

    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`${name} must be a uint32`);
    }
}

function validate(value: WtQrExtInfo): void {
    object(value, 'D1');
    text(value.qrUrl, 'qrUrl');
    text(value.qrSig, 'qrSig');

    if (value.deviceInfo != null) {
        object(value.deviceInfo, 'deviceInfo');
        text(value.deviceInfo.deviceType, 'deviceType');
        text(value.deviceInfo.deviceName, 'deviceName');
    }

    if (value.genInfo != null) {
        object(value.genInfo, 'genInfo');
        uint32(value.genInfo.clientType, 'clientType');
        uint32(value.genInfo.clientVersion, 'clientVersion');
        uint32(value.genInfo.clientAppId, 'clientAppId');
        uint32(value.genInfo.field6, 'field6');
    }
}

/** Encode a D1 value; unknown decoded fields are diagnostic metadata, not re-emitted. */
export function encodeWtQrD1(value: WtQrExtInfo): Uint8Array {
    validate(value);
    const result = protobuf_encode<WtQrExtInfo>(value);

    if (result.byteLength > MAX_D1_BYTES) {
        throw new RangeError('D1 exceeds TLV size limit');
    }

    return result;
}

/** Create request D1 bytes for encodeWtQrFetchBody; no device profile is inferred. */
export function encodeWtQrD1Request(value: WtQrD1Request): Uint8Array {
    object(value, 'D1 request');
    text(value.deviceType, 'deviceType', true);
    text(value.deviceName, 'deviceName', true);
    return encodeWtQrD1({
        deviceInfo: { deviceType: value.deviceType, deviceName: value.deviceName },
        genInfo: { field6: 1 },
    });
}

/** Decode a D1 value. Proton exposes bounded unknown-field metadata on each message. */
export function decodeWtQrD1(bytes: Uint8Array): WtQrExtInfo {
    if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('D1 input must be bytes');
    }

    if (bytes.byteLength > MAX_D1_BYTES) {
        throw new RangeError('D1 exceeds TLV size limit');
    }

    const result = protobuf_decode<WtQrExtInfo>(bytes);
    validate(result);
    return result;
}

/** Decode the D1 response and require its URL without guessing a value. */
export function decodeWtQrD1Response(bytes: Uint8Array): WtQrExtInfo {
    const result = decodeWtQrD1(bytes);

    if (typeof result.qrUrl !== 'string' || result.qrUrl.length === 0) {
        throw new TypeError('D1 response qrUrl must be a nonempty string');
    }

    return result;
}
