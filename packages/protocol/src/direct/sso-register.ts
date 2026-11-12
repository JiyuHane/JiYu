import type {
    SsoHeartbeatRequest,
    SsoHeartbeatResponse,
    SsoRegisterRequest,
    SsoRegisterResponse,
} from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SsoResponse } from './sso';

// Offline reference codecs only. No QQ version or server interoperability is established.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/System/InfoSyncService.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/System/SsoHeartBeatService.cs
export const SSO_INFO_SYNC_COMMAND = 'trpc.msg.register_proxy.RegisterProxy.SsoInfoSync';
export const SSO_HEARTBEAT_COMMAND = 'trpc.qq_new_tech.status_svc.StatusService.SsoHeartBeat';
const MAX_BYTES = 1024 * 1024;

export interface SsoRegisterReferenceInput {
    /** Used by the enclosing SSO reserve; never encoded into the registration body. */
    uid: string;
    version: string;
    guid: Uint8Array;
    deviceName: string;
    deviceType: string;
    vendorOs: string;
    random: number;
}

function text(value: unknown, name: string, nonempty = false): asserts value is string {
    if (typeof value !== 'string' || (nonempty && value.length === 0)) {
        throw new TypeError(`${name} must be ${nonempty ? 'a nonempty' : 'a'} string`);
    }

    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) {
        throw new RangeError(`${name} exceeds size limit`);
    }
}

function bytes(value: unknown): asserts value is Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError('protobuf input must be bytes');
    }

    if (value.byteLength > MAX_BYTES) {
        throw new RangeError('protobuf message exceeds size limit');
    }
}

/**
 * Encode the pinned PC reference's registration body. The caller supplies UID
 * for the SSO reserve separately: it does not occur in this protobuf. Explicit
 * zero values mirror its generator's IgnoreDefaultFields=false behavior.
 */
export function encodeSsoRegisterReference(input: SsoRegisterReferenceInput): Uint8Array {
    if (typeof input !== 'object' || input === null) {
        throw new TypeError('registration input must be an object');
    }

    text(input.uid, 'uid', true);
    text(input.version, 'version', true);
    text(input.deviceName, 'deviceName');
    text(input.deviceType, 'deviceType');
    text(input.vendorOs, 'vendorOs');
    bytes(input.guid);

    if (input.guid.length === 0) {
        throw new TypeError('guid must be nonempty bytes');
    }

    if (!Number.isInteger(input.random) || input.random < 0 || input.random >= 0x7fffffff) {
        throw new RangeError('random must be in the reference Random.Next range');
    }

    const value: SsoRegisterRequest = {
        syncFlag: 735,
        random: input.random,
        activeStatus: 2,
        groupLastMsgTime: 0n,
        c2c: { cookie: { lastMsgTime: 0n }, lastMsgTime: 0n, lastCookie: { lastMsgTime: 0n } },
        config: {},
        register: {
            guid: Buffer.from(input.guid).toString('hex').toUpperCase(),
            kickPc: 0,
            buildVersion: input.version,
            firstRegister: 1,
            localeId: 2052,
            device: {
                name: input.deviceName,
                type: input.deviceType,
                osVersion: '',
                brand: '',
                vendorOs: input.vendorOs,
            },
            mute: 0,
            vendorType: 6,
            regType: 0,
            business: { notifySwitch: 1, bindUinNotifySwitch: 1 },
            battery: 0,
            field12: 1,
        },
        unknown: [{ key: 0, value: 2 }],
        appState: { delay: 0, status: 0, silence: 0 },
    };
    const result = protobuf_encode<SsoRegisterRequest>(value);
    bytes(result);
    return result;
}

export function decodeSsoRegisterResponse(body: Uint8Array): SsoRegisterResponse {
    bytes(body);
    const result = protobuf_decode<SsoRegisterResponse>(body);

    if (result.register == null) {
        delete result.register;
    } else if (result.register.message == null) {
        delete result.register.message;
    }

    return result;
}

export type SsoRegisterOutcome = 'success' | 'rejected' | 'missing-result' | 'sso-error';

/** Requires the actual decoded SSO header, not a caller-supplied success default. */
export function classifySsoRegisterResponse(response: SsoResponse): SsoRegisterOutcome {
    if (typeof response !== 'object' || response === null) {
        throw new TypeError('SSO response must be an object');
    }

    if (response.command !== SSO_INFO_SYNC_COMMAND) {
        throw new Error('unexpected SSO response command');
    }

    if (
        !Number.isInteger(response.retCode) ||
        response.retCode < -0x80000000 ||
        response.retCode > 0x7fffffff
    ) {
        throw new TypeError('SSO response retCode must be an int32');
    }

    if (response.retCode !== 0) {
        return 'sso-error';
    }

    const decoded = decodeSsoRegisterResponse(response.body);
    const result = decoded.register?.message;
    return result == null
        ? 'missing-result'
        : result === 'register success'
          ? 'success'
          : 'rejected';
}

/** The pinned PC reference sends type=1 and explicitly encoded defaults. */
export function encodeSsoHeartbeatReference(): Uint8Array {
    return protobuf_encode<SsoHeartbeatRequest>({
        type: 1,
        localSilence: { localSilence: 0 },
        batteryState: 0,
        time: 0n,
    });
}

export function decodeSsoHeartbeatResponse(body: Uint8Array): SsoHeartbeatResponse {
    bytes(body);
    const result = protobuf_decode<SsoHeartbeatResponse>(body);

    if (result.interval == null) {
        delete result.interval;
    }

    return result;
}
