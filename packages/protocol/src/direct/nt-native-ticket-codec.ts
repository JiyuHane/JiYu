import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import {
    protobuf_decode,
    protobuf_encode,
    type pb,
    type pb_optional,
    type bytes,
    type uint_32,
    type uint_64,
} from '@snowluma/proton';
import { decryptKeyExchangeBytes, encryptKeyExchangeBytes } from './key-exchange';

// Independently derived from Linux QQ 3.2.35-54395 (wrapper SHA256 dc5209e2…70328).
// Common header 0x346b8e0; refresh request 0x3472090; response 0x34722f0/0x346d840.
// These are native inner messages, not a claim that the outer MSF framing is verified.
export const NATIVE_TICKET_REFRESH_COMMAND = 'trpc.login.ecdh.EcdhService.SsoNTLoginRefreshTicket';
export const NATIVE_NT_APP_ID = 1600001615n;
export const NATIVE_MESSAGE_LIMIT = 2 * 1024 * 1024;
const FIELD_LIMIT = 65535;
const UINT64_MAX = (1n << 64n) - 1n;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;

/** Internal input snapshot helpers shared by the three native modules. No getters/iterators. */
export function nativeRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        throw new TypeError('invalid native message input');
    }

    const proto = Object.getPrototypeOf(value) as unknown;

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid native message input');
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !property ||
            !('value' in property)
        ) {
            throw new TypeError('invalid native message input');
        }

        result[key] = property.value;
    }

    return result;
}

export function nativeBytes(value: unknown, min = 0, max = NATIVE_MESSAGE_LIMIT): Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new TypeError('invalid native message bytes');
    }

    const size = byteLength.call(value) as number;
    const storage = buffer.call(value) as ArrayBuffer;
    const offset = byteOffset.call(value) as number;

    if (size < min || size > max || isSharedArrayBuffer(storage) || resizable?.call(storage)) {
        throw new TypeError('invalid native message bytes');
    }

    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !/^(0|[1-9][0-9]*)$/.test(key) ||
            Number(key) >= size ||
            !property ||
            !('value' in property)
        ) {
            throw new TypeError('invalid native message bytes');
        }
    }

    const result = new Uint8Array(size);
    set.call(result, new Uint8Array(storage, offset, size));
    return result;
}

export function wipeNativeBytes(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Best effort for detached storage; engine/crypto copies are outside JS ownership.
        }
    }
}

export function nativeSeconds(value: unknown): bigint {
    if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) {
        throw new RangeError('native seconds must be a uint64 bigint');
    }

    return value;
}

export function nativeText(value: unknown, max = 4096): string {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        Buffer.byteLength(value, 'utf8') > max ||
        Buffer.from(value, 'utf8').toString('utf8') !== value
    ) {
        throw new TypeError('invalid native text field');
    }

    return value;
}

interface NativeUser {
    account: pb_optional<1, string>;
}
interface NativeClient {
    deviceType: pb_optional<1, string>;
    deviceName: pb_optional<2, string>;
    platform: pb<3, uint_32>;
    guid: pb_optional<4, bytes>;
}
interface NativeApp {
    version: pb_optional<1, string>;
    appId: pb<2, uint_64>;
    appName: pb_optional<3, string>;
}
interface NativeCookie {
    value?: pb_optional<1, bytes>;
}
interface NativeSdk {
    version: pb<1, uint_32>;
}
interface NativeHead {
    user: pb<1, NativeUser>;
    client: pb<2, NativeClient>;
    app: pb<3, NativeApp>;
    cookie?: pb<5, NativeCookie>;
    sdk: pb<7, NativeSdk>;
}
interface NativeRefreshBody {
    a1: pb_optional<1, bytes>;
}
export interface NativeRefreshRequestWire {
    head: pb<1, NativeHead>;
    body: pb<2, NativeRefreshBody>;
}
export interface NativeForwardWire {
    sessionTicket?: pb_optional<1, bytes>;
    buffer?: pb_optional<3, bytes>;
    type?: pb<4, uint_32>;
}
interface NativeResponseError {
    code?: pb_optional<1, uint_64>;
    needsLogin?: pb_optional<8, boolean>;
}
interface NativeResponseHead {
    error?: pb<4, NativeResponseError>;
    cookie?: pb<5, NativeCookie>;
}
export interface NativeRefreshTimeWire {
    next?: pb_optional<1, uint_64>;
    expires?: pb_optional<2, uint_64>;
}
export interface NativeTicketsWire {
    a1?: pb_optional<3, bytes>;
    a2?: pb_optional<4, bytes>;
    d2?: pb_optional<5, bytes>;
    d2Key?: pb_optional<6, bytes>;
    a1RefreshTime?: pb<12, NativeRefreshTimeWire>;
    a2RefreshTime?: pb<16, NativeRefreshTimeWire>;
}
interface NativeResponseAccount {
    uin?: pb_optional<1, uint_64>;
    uid?: pb_optional<2, string>;
}
interface NativeResponseBody {
    tickets?: pb<1, NativeTicketsWire>;
    account?: pb<2, NativeResponseAccount>;
}
export interface NativeRefreshResponseWire {
    head?: pb<1, NativeResponseHead>;
    body?: pb<2, NativeResponseBody>;
}

export interface NativeRefreshRequestInput {
    readonly uin: string;
    readonly guid: Uint8Array;
    readonly version: string;
    readonly deviceName: string;
    readonly a1: Uint8Array;
    readonly cookie?: Uint8Array;
}
export interface NativeTicketMetadata {
    /** Absolute Unix seconds, never a relative TTL or a JavaScript timeout. */
    readonly nextRefreshAtSeconds: bigint;
    readonly expiresAtSeconds: bigint;
}
export interface NativeRenewedTickets {
    readonly a1: Uint8Array;
    readonly a2: Uint8Array;
    readonly d2: Uint8Array;
    readonly d2Key: Uint8Array;
}
export type NativeTicketResponse =
    | {
          readonly kind: 'tickets';
          readonly tickets: NativeRenewedTickets;
          readonly metadata: NativeTicketMetadata;
          readonly account?: Readonly<{ uin?: bigint; uid?: string }>;
      }
    | { readonly kind: 'protocol-error'; readonly code: bigint; readonly needsLogin: boolean }
    | { readonly kind: 'empty-a1' };

/** Ordinary UIN login only. No QUA, empty cookie container, or reference-only fields. */
export function encodeNativeTicketRefresh(input: NativeRefreshRequestInput): Uint8Array {
    const value = nativeRecord(input, ['uin', 'guid', 'version', 'deviceName', 'a1', 'cookie']);
    const uin = nativeText(value.uin, 10);

    if (!/^[1-9][0-9]{0,9}$/.test(uin) || BigInt(uin) > 0xffffffffn) {
        throw new TypeError('invalid native account');
    }

    const version = nativeText(value.version);
    const deviceName = nativeText(value.deviceName);
    let guid: Uint8Array | undefined;
    let a1: Uint8Array | undefined;
    let cookie: Uint8Array | undefined;

    try {
        guid = nativeBytes(value.guid, 16, 16);
        a1 = nativeBytes(value.a1, 1, FIELD_LIMIT);
        cookie = value.cookie === undefined ? undefined : nativeBytes(value.cookie, 0, FIELD_LIMIT);
        return protobuf_encode<NativeRefreshRequestWire>({
            head: {
                user: { account: uin },
                client: { deviceType: 'Linux', deviceName, platform: 7, guid },
                app: { version, appId: NATIVE_NT_APP_ID, appName: 'com.tencent.qq' },
                ...(cookie?.length ? { cookie: { value: cookie } } : {}),
                sdk: { version: 1 },
            },
            body: { a1 },
        });
    } finally {
        [guid, a1, cookie].forEach(wipeNativeBytes);
    }
}

export function disposeNativeTicketResponse(result: NativeTicketResponse | undefined): void {
    if (result?.kind === 'tickets') {
        const { a1, a2, d2, d2Key } = result.tickets;
        [a1, a2, d2, d2Key].forEach(wipeNativeBytes);
    }
}

/** Copies ticket projections before destroying the parser input, including on errors. */
export function decodeNativeTicketRefresh(bytes: Uint8Array): NativeTicketResponse {
    const input = nativeBytes(bytes, 1);
    const owned: Uint8Array[] = [];
    let delivered = false;

    try {
        // Proton uses data.slice for byte fields: a Buffer view keeps even partial
        // decoder allocations backed by this one owned, finally-erased input.
        const result = protobuf_decode<NativeRefreshResponseWire>(
            Buffer.from(input.buffer, input.byteOffset, input.byteLength),
        );

        if (!result.head) {
            throw new Error('missing native response header');
        }

        const code = nativeSeconds(result.head.error?.code ?? 0n);

        if (code !== 0n) {
            return {
                kind: 'protocol-error',
                code,
                needsLogin: result.head.error?.needsLogin === true,
            };
        }

        const tickets = result.body?.tickets;

        if (!tickets?.a1?.length) {
            return { kind: 'empty-a1' };
        }

        const take = (value: unknown, min: number, max: number): Uint8Array => {
            const copy = nativeBytes(value, min, max);
            owned.push(copy);
            return copy;
        };

        const a1 = take(tickets.a1, 1, FIELD_LIMIT);
        const a2 = take(tickets.a2, 1, FIELD_LIMIT);
        const d2 = take(tickets.d2, 1, FIELD_LIMIT);
        const d2Key = take(tickets.d2Key, 16, 16);
        // Native decoding reads field16 first, then field12 into the SAME result slots.
        // An existing but empty field12 therefore overwrites both values with zero.
        const time = tickets.a1RefreshTime ?? tickets.a2RefreshTime;
        const metadata = Object.freeze({
            nextRefreshAtSeconds: nativeSeconds(time?.next ?? 0n),
            expiresAtSeconds: nativeSeconds(time?.expires ?? 0n),
        });
        const account = result.body?.account;
        const projection: NativeTicketResponse = {
            kind: 'tickets',
            tickets: Object.freeze({ a1, a2, d2, d2Key }),
            metadata,
            ...(account
                ? {
                      account: Object.freeze({
                          ...(account.uin == null ? {} : { uin: nativeSeconds(account.uin) }),
                          ...(account.uid == null ? {} : { uid: account.uid }),
                      }),
                  }
                : {}),
        };
        delivered = true;
        return projection;
    } finally {
        wipeNativeBytes(input);

        if (!delivered) {
            owned.forEach(wipeNativeBytes);
        }
    }
}

export function encodeNativeTicketForward(
    sessionKey: Uint8Array,
    sessionTicket: Uint8Array,
    plaintext: Uint8Array,
): Uint8Array {
    let key: Uint8Array | undefined;
    let ticket: Uint8Array | undefined;
    let plain: Uint8Array | undefined;
    let encrypted: Uint8Array | undefined;

    try {
        key = nativeBytes(sessionKey, 32, 32);
        ticket = nativeBytes(sessionTicket, 1, FIELD_LIMIT);
        plain = nativeBytes(plaintext, 1);
        encrypted = encryptKeyExchangeBytes(plain, key);
        return protobuf_encode<NativeForwardWire>({
            sessionTicket: ticket,
            buffer: encrypted,
            type: 1,
        });
    } finally {
        [key, ticket, plain, encrypted].forEach(wipeNativeBytes);
    }
}

export function decodeNativeTicketForward(
    sessionKey: Uint8Array,
    response: Uint8Array,
): NativeTicketResponse {
    let key: Uint8Array | undefined;
    let wire: Uint8Array | undefined;
    let plain: Uint8Array | undefined;

    try {
        key = nativeBytes(sessionKey, 32, 32);
        wire = nativeBytes(response, 1);
        const body = protobuf_decode<NativeForwardWire>(
            Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength),
        ).buffer;

        if (!body || body.length <= 28) {
            throw new Error('invalid native forward response');
        }

        plain = decryptKeyExchangeBytes(body, key);
        return decodeNativeTicketRefresh(plain);
    } finally {
        [key, wire, plain].forEach(wipeNativeBytes);
    }
}
