import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { protobuf_decode, type bytes } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    LinuxFriendAddResponseBody,
    LinuxFriendSettingUinResponseBody,
} from '@snowluma/proto-defs/linux-friend';

export const LINUX_FRIEND_MAX_RESPONSE_BYTES = 65536;
const MAX_FIELD_BYTES = 16384;
const MAX_TEXT_BYTES = 4096;
const MAX_QUESTIONS = 16;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface LinuxFriendOidbError {
    readonly kind: 'oidb-error';
    readonly errorCode: number;
    readonly errorMessage?: string;
}

export interface LinuxFriendSettingProjection {
    readonly kind: 'settings';
    readonly peerUin?: bigint;
    readonly returnedUin?: bigint;
    readonly setting?: number;
    readonly result?: number;
    readonly errorCode?: number;
    readonly isContactFriend?: boolean;
    readonly questions: readonly string[];
}

export interface LinuxFriendAddProjection {
    readonly kind: 'application';
    readonly friendSetting?: number;
    readonly myAllowFlag?: number;
    readonly groupId?: number;
    readonly result?: number;
    readonly errorCode?: number;
    readonly errorMessage?: string;
    /** Independently owned opaque bytes. Dispose after use; never log these. */
    readonly sig?: Uint8Array;
    readonly verify?: Uint8Array;
}

export type LinuxFriendSettingResponse = LinuxFriendOidbError | LinuxFriendSettingProjection;
export type LinuxFriendAddResponse = LinuxFriendOidbError | LinuxFriendAddProjection;

function snapshot(input: Uint8Array): Uint8Array {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new TypeError('invalid friend response bytes');
    }

    values.call(input);
    const storage = arrayBuffer.call(input) as ArrayBufferLike;
    const size = byteLength.call(input) as number;

    if (
        isSharedArrayBuffer(storage) ||
        (resizable && resizable.call(storage)) ||
        size > LINUX_FRIEND_MAX_RESPONSE_BYTES
    ) {
        throw new TypeError('invalid friend response bytes');
    }

    const keys = Reflect.ownKeys(input);

    if (
        keys.length > size + 16 ||
        keys.some((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            return !descriptor || !('value' in descriptor);
        })
    ) {
        throw new TypeError('invalid friend response bytes');
    }

    return Uint8Array.from(new Uint8Array(storage, byteOffset.call(input) as number, size));
}

function wipe(value: Uint8Array): void {
    try {
        fill.call(value, 0);
    } catch {
        // Best effort for detached owned storage; never touch caller input.
    }
}

function text(value: Uint8Array): string {
    if (value.length > MAX_TEXT_BYTES) {
        throw new RangeError('friend response text exceeds local limit');
    }

    return utf8.decode(value);
}

function envelope(raw: Uint8Array, command: number, subCommand: number): OidbBase<bytes> {
    const decoded = protobuf_decode<OidbBase<bytes>>(raw);

    if (
        (decoded.command != null && decoded.command !== command) ||
        (decoded.subCommand != null && decoded.subCommand !== subCommand)
    ) {
        throw new Error('friend OIDB response association mismatch');
    }

    if (decoded.errorMsg != null && Buffer.byteLength(decoded.errorMsg, 'utf8') > MAX_TEXT_BYTES) {
        throw new RangeError('friend OIDB error text exceeds local limit');
    }

    return decoded;
}

/** Pure, bounded projection only. The caller must authenticate and associate the
 * exact SSO frame before decoding. A zero outer OIDB code does not establish an
 * application result or friendship. Missing business fields remain undefined.
 */
export function decodeLinuxFriendSettingResponse(input: Uint8Array): LinuxFriendSettingResponse {
    const raw = snapshot(input);

    try {
        const outer = envelope(raw, 0x7c1, 1);

        if (outer.errorCode != null && outer.errorCode !== 0) {
            return Object.freeze({
                kind: 'oidb-error',
                errorCode: outer.errorCode,
                errorMessage: outer.errorMsg ?? undefined,
            });
        }

        if (outer.body == null) {
            throw new Error('friend setting response body missing');
        }

        const body = protobuf_decode<LinuxFriendSettingUinResponseBody>(outer.body);
        const questions = body.questions ?? [];

        if (questions.length > MAX_QUESTIONS) {
            throw new RangeError('too many friend verification questions');
        }

        return Object.freeze({
            kind: 'settings',
            peerUin: body.peerUin ?? undefined,
            returnedUin: body.returnedUin ?? undefined,
            setting: body.setting ?? undefined,
            result: body.result ?? undefined,
            errorCode: body.errorCode ?? undefined,
            isContactFriend: body.isContactFriend ?? undefined,
            questions: Object.freeze(questions.map((question) => text(question))),
        });
    } finally {
        wipe(raw);
    }
}

/** Returned sig/verify arrays have independent ownership even after the input
 * frame is cleared. On a failed decode all partially made copies are cleared.
 * Successful callers must eventually use disposeLinuxFriendAddResponse, including
 * an exchange's uncommitted-result disposal path. No business enum is inferred.
 */
export function decodeLinuxFriendAddResponse(input: Uint8Array): LinuxFriendAddResponse {
    const raw = snapshot(input);
    const pending: Uint8Array[] = [];
    let transferred = false;

    const take = (value: Uint8Array | null | undefined): Uint8Array | undefined => {
        if (value == null) {
            return undefined;
        }

        if (value.length > MAX_FIELD_BYTES) {
            throw new RangeError('friend response bytes exceed local limit');
        }

        const copy = Uint8Array.from(value);
        pending.push(copy);
        return copy;
    };

    try {
        const outer = envelope(raw, 0x7c2, 5);

        if (outer.errorCode != null && outer.errorCode !== 0) {
            return Object.freeze({
                kind: 'oidb-error',
                errorCode: outer.errorCode,
                errorMessage: outer.errorMsg ?? undefined,
            });
        }

        if (outer.body == null) {
            throw new Error('friend application response body missing');
        }

        const body = protobuf_decode<LinuxFriendAddResponseBody>(outer.body);
        const result: LinuxFriendAddProjection = Object.freeze({
            kind: 'application',
            friendSetting: body.friendSetting ?? undefined,
            myAllowFlag: body.myAllowFlag ?? undefined,
            groupId: body.groupId ?? undefined,
            result: body.result ?? undefined,
            errorCode: body.errorCode ?? undefined,
            errorMessage: body.errorMessage == null ? undefined : text(body.errorMessage),
            sig: take(body.sig),
            verify: take(body.verify),
        });
        transferred = true;
        return result;
    } finally {
        wipe(raw);

        if (!transferred) {
            for (const value of pending) {
                wipe(value);
            }
        }
    }
}

/** Release opaque arrays returned by this module; scalar projection fields remain. */
export function disposeLinuxFriendAddResponse(response: LinuxFriendAddResponse): void {
    if (response.kind === 'application') {
        if (response.sig) {
            wipe(response.sig);
        }

        if (response.verify) {
            wipe(response.verify);
        }
    }
}
