import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    LinuxFriendAddUinBody,
    LinuxFriendSettingUinBody,
} from '@snowluma/proto-defs/linux-friend';
import { makeOidbEnvelope } from '../bridge-oidb';

export const LINUX_FRIEND_SETTING_COMMAND = 'OidbSvcTrpcTcp.0x7c1_1';
export const LINUX_FRIEND_ADD_COMMAND = 'OidbSvcTrpcTcp.0x7c2_5';
export const LINUX_FRIEND_MAX_REQUEST_BYTES = 65536;
const MAX_TEXT_BYTES = 4096;
const MAX_FIELD_BYTES = 16384;
const MAX_UIN = 0xffff_ffff_ffff_ffffn;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;

export interface LinuxFriendSettingInput {
    readonly selfUin: bigint;
    readonly peerUin: bigint;
    /** Explicit source metadata; these are not Android group-entry defaults. */
    readonly sourceId: number;
    readonly sourceSub: number;
    readonly name?: string;
    readonly name1?: string;
}

/** Native Node AddBuddyReq materializes omitted addSetting, groupId and
 * cardSwitch (showMyCard) as present zeroes. The UI's explicit card value 1
 * is not a default; other omitted optional fields stay absent.
 */
export interface LinuxFriendAddInput extends LinuxFriendSettingInput {
    readonly addSetting?: number;
    readonly myAllowFlag?: number;
    readonly groupId?: number;
    readonly answer?: string;
    readonly srcFlag?: number;
    readonly autoSend?: number;
    readonly sig?: Uint8Array;
    readonly sourceDescription?: string;
    readonly friendSourceDescription?: string;
    readonly remark?: string;
    readonly cardSwitch?: number;
    readonly token?: Uint8Array;
    readonly verify?: Uint8Array;
    readonly secureTips?: boolean;
    readonly supportAddRelief?: boolean;
    readonly ext?: Uint8Array;
    readonly bytesSig?: Uint8Array;
    readonly clientExt?: Uint8Array;
}

const commonFields = ['selfUin', 'peerUin', 'sourceId', 'sourceSub', 'name', 'name1'] as const;
const addFields = [
    ...commonFields,
    'addSetting',
    'myAllowFlag',
    'groupId',
    'answer',
    'srcFlag',
    'autoSend',
    'sig',
    'sourceDescription',
    'friendSourceDescription',
    'remark',
    'cardSwitch',
    'token',
    'verify',
    'secureTips',
    'supportAddRelief',
    'ext',
    'bytesSig',
    'clientExt',
] as const;

function record(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || isProxy(input)) {
        throw new TypeError('invalid friend request');
    }

    const prototype = Object.getPrototypeOf(input) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid friend request');
    }

    const keys = Reflect.ownKeys(input);

    if (keys.length > allowed.length) {
        throw new TypeError('invalid friend request');
    }

    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid friend request');
        }

        copy[key] = descriptor.value;
    }

    return copy;
}

function uin(value: unknown): bigint {
    if (typeof value !== 'bigint' || value < 1n || value > MAX_UIN) {
        throw new RangeError('invalid friend account');
    }

    return value;
}

function integer(value: unknown, signed = false): number {
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < (signed ? -0x8000_0000 : 0) ||
        value > (signed ? 0x7fff_ffff : 0xffff_ffff)
    ) {
        throw new RangeError('invalid friend integer');
    }

    return value;
}

/** Encoders are pure. Source metadata and optional verification fields are explicit;
 * no source discovery, signature generation, account query or application is performed.
 * The fixed native UIN branch maps its internal mode 2 to OIDB reserved=1.
 * Local byte limits are resource bounds, not established QQ business limits.
 */
function encode(input: unknown, setting: boolean): Uint8Array {
    const value = record(input, setting ? commonFields : addFields);
    const owned: Uint8Array[] = [];
    // Bound aggregate variable-sized data before encoding, leaving ample room for tags.
    let budget = LINUX_FRIEND_MAX_REQUEST_BYTES - 1024;

    const reserve = (size: number): void => {
        budget -= size;

        if (budget < 0) {
            throw new RangeError('friend request exceeds local limit');
        }
    };

    const optionalInteger = (key: string, signed = false): number | undefined =>
        value[key] === undefined ? undefined : integer(value[key], signed);

    const optionalBoolean = (key: string): boolean | undefined => {
        const current = value[key];

        if (current !== undefined && typeof current !== 'boolean') {
            throw new TypeError('invalid friend boolean');
        }

        return current;
    };

    const text = (key: string): string | undefined => {
        const current = value[key];

        if (current === undefined) {
            return undefined;
        }

        if (typeof current !== 'string' || current.length > MAX_TEXT_BYTES) {
            throw new TypeError('invalid friend text');
        }

        for (let i = 0; i < current.length; i++) {
            const unit = current.charCodeAt(i);

            if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = current.charCodeAt(++i);

                if (!(next >= 0xdc00 && next <= 0xdfff)) {
                    throw new TypeError('invalid friend text');
                }
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
                throw new TypeError('invalid friend text');
            }
        }

        const size = Buffer.byteLength(current, 'utf8');

        if (size > MAX_TEXT_BYTES) {
            throw new RangeError('friend text exceeds local limit');
        }

        reserve(size);
        return current;
    };

    const bytes = (key: string): Uint8Array | undefined => {
        const current = value[key];

        if (current === undefined) {
            return undefined;
        }

        if (isProxy(current) || !isUint8Array(current)) {
            throw new TypeError('invalid friend bytes');
        }

        values.call(current);
        const storage = arrayBuffer.call(current) as ArrayBufferLike;
        const size = byteLength.call(current) as number;

        if (
            isSharedArrayBuffer(storage) ||
            (resizable && resizable.call(storage)) ||
            size > MAX_FIELD_BYTES
        ) {
            throw new TypeError('invalid friend bytes');
        }

        const keys = Reflect.ownKeys(current);

        if (
            keys.length > size + 16 ||
            keys.some((key) => {
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                return !descriptor || !('value' in descriptor);
            })
        ) {
            throw new TypeError('invalid friend bytes');
        }

        reserve(size);
        const copy = Uint8Array.from(
            new Uint8Array(storage, byteOffset.call(current) as number, size),
        );
        owned.push(copy);
        return copy;
    };

    try {
        const selfUin = uin(value.selfUin);
        const peerUin = uin(value.peerUin);
        const sourceId = integer(value.sourceId);
        const sourceSub = integer(value.sourceSub);
        let encoded: Uint8Array;

        if (setting) {
            const body: LinuxFriendSettingUinBody = {
                // Pinned Linux UI getBuddySetting initializes version=1. The native
                // encoder writes that optional uint32 to tag 1 (RVA 0x4a0e4f2).
                version: 1,
                selfUin,
                peerUin,
                sourceId,
                sourceSub,
                name: text('name'),
                name1: text('name1'),
            };
            encoded = protobuf_encode<OidbBase<LinuxFriendSettingUinBody>>(
                makeOidbEnvelope(0x7c1, 1, body, true),
            );
        } else {
            const body: LinuxFriendAddUinBody = {
                selfUin,
                peerUin,
                sourceId,
                sourceSub,
                addSetting: optionalInteger('addSetting', true) ?? 0,
                myAllowFlag: optionalInteger('myAllowFlag'),
                groupId: optionalInteger('groupId') ?? 0,
                answer: text('answer'),
                srcFlag: optionalInteger('srcFlag'),
                autoSend: optionalInteger('autoSend'),
                sig: bytes('sig'),
                name: text('name'),
                name1: text('name1'),
                sourceDescription: text('sourceDescription'),
                friendSourceDescription: text('friendSourceDescription'),
                remark: text('remark'),
                cardSwitch: optionalInteger('cardSwitch', true) ?? 0,
                token: bytes('token'),
                verify: bytes('verify'),
                secureTips: optionalBoolean('secureTips'),
                supportAddRelief: optionalBoolean('supportAddRelief'),
                ext: bytes('ext'),
                bytesSig: bytes('bytesSig'),
                clientExt: bytes('clientExt'),
            };
            encoded = protobuf_encode<OidbBase<LinuxFriendAddUinBody>>(
                makeOidbEnvelope(0x7c2, 5, body, true),
            );
        }

        if (encoded.length > LINUX_FRIEND_MAX_REQUEST_BYTES) {
            throw new RangeError('friend request exceeds local limit');
        }

        // Proton may use shared scratch storage. Return independently owned bytes.
        return Uint8Array.from(encoded);
    } finally {
        for (const copy of owned) {
            try {
                fill.call(copy, 0);
            } catch {
                // Best effort for owned snapshots only; never clear caller storage.
            }
        }
    }
}

export function encodeLinuxFriendSettingRequest(input: LinuxFriendSettingInput): Uint8Array {
    return encode(input, true);
}

export function encodeLinuxFriendAddRequest(input: LinuxFriendAddInput): Uint8Array {
    return encode(input, false);
}
