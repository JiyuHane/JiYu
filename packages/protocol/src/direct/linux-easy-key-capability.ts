import { timingSafeEqual } from 'node:crypto';
import { isProxy, isUint8Array } from 'node:util/types';
import { decodeServiceResponse, MAX_SERVICE_FRAME_BYTES } from './service-frame';
import { decodeSsoResponse } from './sso';

// Internal reference only. A deep import is not a same-process security boundary;
// QQ-TEA and successful parsing do not authenticate a peer or validate a payload.
// There is deliberately no owner/flow, queue, authentication or delivery here.
declare const tokenBrand: unique symbol;
declare const reservationBrand: unique symbol;
export type LinuxEasyKeyToken = { readonly [tokenBrand]: never };
export type LinuxEasyKeySessionReservation = { readonly [reservationBrand]: never };
export type LinuxEasyKeyState = 'empty' | 'tentative' | 'active' | 'revoked';

export interface LinuxEasyKeyBinding {
    lease: object;
    /** Canonical nonzero decimal uint32 EasyLogin account. */
    uin: string;
    /** Passive identity for this generation; never interpreted or invoked. */
    generation: object;
}
export interface LinuxEasyKeyLoginClaimInput {
    token: LinuxEasyKeyToken;
    lease: object;
    uin: string;
}
export interface LinuxEasyKeySessionReservationInput extends LinuxEasyKeyLoginClaimInput {
    reservation: LinuxEasyKeySessionReservation;
}
export interface LinuxEasyKeyTentativeInput extends LinuxEasyKeyLoginClaimInput {
    sequence: number;
}
export interface LinuxEasyKeyStageInput {
    token: LinuxEasyKeyToken;
    lease: object;
    uin: string;
    sequence: number;
    key: Uint8Array;
}
export interface LinuxEasyKeyCommitInput {
    token: LinuxEasyKeyToken;
    lease: object;
    uin: string;
    sequence: number;
    comparisonKey: Uint8Array;
}
export interface LinuxEasyKeyDecodeInput {
    token: LinuxEasyKeyToken;
    lease: object;
    uin: string;
    frame: Uint8Array;
}
export interface LinuxEasyServiceResponse {
    uin: string;
    protocol: 12;
    encryption: 'd2';
    dummy: 0;
    /** SSO signed sequence interpreted as its uint32 bit pattern. */
    sequence: number;
    /** Parsed metadata only, with no source authentication. */
    command: string;
    retCode: number;
    /** Complete decoded service payload; the caller owns and must wipe it. */
    body: Uint8Array;
}

type Slot = {
    phase: LinuxEasyKeyState;
    loginClaimed: boolean;
    lease: object;
    uin: string;
    generation: object;
    reservation?: object;
    sequence?: number;
    key?: Uint8Array;
};
const slots = new WeakMap<object, Slot>();
const reservations = new WeakMap<object, { token: object; slot: Slot }>();
const claimedLeases = new WeakSet<object>();
const apply = Reflect.apply;
const getPrototypeOf = Object.getPrototypeOf;
const setPrototypeOf = Object.setPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const weakDelete = WeakMap.prototype.delete;
const weakHas = WeakSet.prototype.has;
const weakAdd = WeakSet.prototype.add;
const Bytes = Uint8Array;
const typed = getPrototypeOf(Bytes.prototype) as object;
const getBuffer = getDescriptor(typed, 'buffer')!.get!;
const getOffset = getDescriptor(typed, 'byteOffset')!.get!;
const getLength = getDescriptor(typed, 'byteLength')!.get!;
const getArrayBufferLength = getDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const getResizable = getDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const integer = Number.isInteger;
const uinPattern = /^[1-9][0-9]{0,9}$/;
const regexpTest = RegExp.prototype.test;

function fail(): never {
    throw new Error('invalid Linux EasyLogin key capability');
}

function identity(value: unknown): value is object {
    return value !== null && typeof value === 'object' && !isProxy(value);
}

// Reject proxy traps and getters. Snapshot only the explicitly requested own data
// properties before reading or using any input. Extra properties are not evaluated.
function fields(value: unknown, names: readonly string[]): unknown[] {
    if (!identity(value)) {
        return fail();
    }

    const proto = getPrototypeOf(value);

    if (proto !== Object.prototype && proto !== null) {
        return fail();
    }

    const result: unknown[] = [];

    for (let index = 0; index < names.length; index++) {
        const descriptor = getDescriptor(value, names[index]);

        if (!descriptor || !hasOwn(descriptor, 'value')) {
            return fail();
        }

        // Define an own element without invoking an inherited numeric setter.
        defineProperty(result, index, {
            value: descriptor.value,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    return result;
}

function validUin(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        apply(regexpTest, uinPattern, [value]) &&
        Number(value) <= 0xffffffff
    );
}

function uint32(value: unknown): value is number {
    return typeof value === 'number' && integer(value) && value >= 0 && value <= 0xffffffff;
}

function lookup(value: unknown): Slot {
    if (!identity(value)) {
        return fail();
    }

    const found = apply(weakGet, slots, [value]) as Slot | undefined;
    return found ?? fail();
}

function bound(value: Slot, lease: unknown, uin: unknown): boolean {
    return identity(lease) && value.lease === lease && value.uin === uin;
}

// Reconstruct a private view from intrinsics, never caller-defined properties or
// iterators. Fixed ordinary ArrayBuffer only; rejects detached and shared storage.
// Key inputs additionally require a plain Uint8Array, not Buffer or a subclass.
function snapshot(value: unknown, min: number, max: number, plain: boolean): Uint8Array {
    if (
        isProxy(value) ||
        !isUint8Array(value) ||
        (plain && getPrototypeOf(value) !== Bytes.prototype)
    ) {
        return fail();
    }

    apply(values, value, []);
    const storage = apply(getBuffer, value, []) as ArrayBuffer;
    apply(getArrayBufferLength, storage, []);

    if (getResizable && apply(getResizable, storage, [])) {
        return fail();
    }

    const offset = apply(getOffset, value, []) as number;
    const length = apply(getLength, value, []) as number;

    if (length < min || length > max) {
        return fail();
    }

    const copy = new Bytes(length);

    try {
        apply(set, copy, [new Bytes(storage, offset, length)]);
        return copy;
    } catch {
        wipe(copy);
        return fail();
    }
}

function wipe(value: Uint8Array | undefined): void {
    if (value) {
        try {
            apply(fill, value, [0]);
        } catch {
            // Best effort for each independently owned allocation.
        }
    }
}

/**
 * Claim exactly one lease for this module for its entire lifetime, including after
 * revoke. This does not establish lease provenance, cross-module exclusivity, or
 * generation freshness. The token retains the supplied generation identity.
 */
export function createLinuxEasyKeyCapability(input: LinuxEasyKeyBinding): LinuxEasyKeyToken {
    try {
        const [lease, uin, generation] = fields(input, ['lease', 'uin', 'generation']);

        if (
            !identity(lease) ||
            !identity(generation) ||
            !validUin(uin) ||
            apply(weakHas, claimedLeases, [lease])
        ) {
            return fail();
        }

        const token = freeze({}) as LinuxEasyKeyToken;
        // Own data fields and a null prototype prevent inherited setters from
        // re-entering claim or reservation while the slot is being updated.
        const value: Slot = {
            phase: 'empty',
            loginClaimed: false,
            lease,
            uin,
            generation,
            reservation: undefined,
            sequence: undefined,
            key: undefined,
        };
        setPrototypeOf(value, null);
        apply(weakAdd, claimedLeases, [lease]);
        apply(weakSet, slots, [token, value]);
        return token;
    } catch {
        return fail();
    }
}

/**
 * Claim a capability for one login flow before invoking any external signer or
 * transport. A successful claim is permanent, including after failure or revoke;
 * the flow must revoke the capability on every subsequent failure. Failed claims
 * leave all slots unchanged. Stage and commit remain usable without a claim by
 * trusted deep-import callers; this is not a same-process security boundary.
 *
 * The generation identity is retained but not automatically validated. Claiming
 * does not authenticate a server: the caller must ensure its transport belongs
 * to the exact supplied lease.
 */
export function claimLinuxEasyKeyForLogin(input: LinuxEasyKeyLoginClaimInput): void {
    try {
        const args = fields(input, ['token', 'lease', 'uin']);
        const value = lookup(args[0]);
        const lease = args[1];
        const uin = args[2];

        // Equality with the factory-validated uin also validates its canonical form.
        if (value.phase !== 'empty' || value.loginClaimed || !bound(value, lease, uin)) {
            return fail();
        }

        value.loginClaimed = true;
    } catch {
        return fail();
    }
}

/**
 * Reserve the empty capability for a session before key exchange, then transfer
 * this internal occupancy once to its EasyLogin flow. The proof contains no key.
 * Neither reservation nor transfer validates a transport or server; a session's
 * stable transport wrapper need not be identical to the exact bound lease object.
 * The session must revoke on every failure, stop or cancellation. This is not a
 * same-process security boundary, and staging does not require the proof.
 */
export function reserveLinuxEasyKeyForSession(
    input: LinuxEasyKeyLoginClaimInput,
): LinuxEasyKeySessionReservation {
    try {
        const [token, lease, uin] = fields(input, ['token', 'lease', 'uin']);
        const value = lookup(token);

        if (value.phase !== 'empty' || value.loginClaimed || !bound(value, lease, uin)) {
            return fail();
        }

        // lookup has already checked token identity; keep that exact identity.
        if (!identity(token)) {
            return fail();
        }

        const reservation = freeze({}) as LinuxEasyKeySessionReservation;
        apply(weakSet, reservations, [reservation, { token, slot: value }]);
        value.reservation = reservation;
        value.loginClaimed = true;
        return reservation;
    } catch {
        return fail();
    }
}

/** Consume only the matching session reservation, exactly once, while still empty. */
export function consumeLinuxEasyKeySessionReservation(
    input: LinuxEasyKeySessionReservationInput,
): void {
    try {
        const [token, lease, uin, reservation] = fields(input, [
            'token',
            'lease',
            'uin',
            'reservation',
        ]);
        const value = lookup(token);

        if (!identity(reservation)) {
            return fail();
        }

        const record = apply(weakGet, reservations, [reservation]) as
            { token: object; slot: Slot } | undefined;

        if (
            value.phase !== 'empty' ||
            !bound(value, lease, uin) ||
            value.reservation !== reservation ||
            !record ||
            record.token !== token ||
            record.slot !== value
        ) {
            return fail();
        }

        apply(weakDelete, reservations, [reservation]);
        value.reservation = undefined;
    } catch {
        return fail();
    }
}

/**
 * Check staged metadata without returning key material or authenticating a peer.
 * The caller remains responsible for session liveness and failure cleanup.
 */
export function assertLinuxEasyKeyTentative(input: LinuxEasyKeyTentativeInput): void {
    try {
        const [token, lease, uin, sequence] = fields(input, ['token', 'lease', 'uin', 'sequence']);
        const value = lookup(token);

        if (
            value.phase !== 'tentative' ||
            !value.key ||
            !bound(value, lease, uin) ||
            !uint32(sequence) ||
            value.sequence !== sequence
        ) {
            return fail();
        }
    } catch {
        return fail();
    }
}

/**
 * Only the future controlled EasyLogin consumer should stage a ticket key. This
 * operation wipes only its own temporary copy, never the caller's key; the caller
 * must clear its key and upstream ticket/body bytes. Garbage collection of the
 * token does not guarantee erasure: explicitly revoke the capability.
 */
export function stageLinuxEasyKey(input: LinuxEasyKeyStageInput): void {
    let copy: Uint8Array | undefined;

    try {
        const [token, lease, uin, sequence, key] = fields(input, [
            'token',
            'lease',
            'uin',
            'sequence',
            'key',
        ]);
        const value = lookup(token);

        if (value.phase !== 'empty' || !bound(value, lease, uin) || !uint32(sequence)) {
            return fail();
        }

        copy = snapshot(key, 16, 16, true);

        if (value.phase !== 'empty' || !bound(value, lease, uin)) {
            return fail();
        }

        value.key = copy;
        value.sequence = sequence;
        value.phase = 'tentative';
        copy = undefined;
    } catch {
        return fail();
    } finally {
        wipe(copy);
    }
}

/**
 * Caller must first validate explicitly present zero status, complete body and
 * tickets, and registration success with poison 'not-requested'. Any failure
 * after resolving a tentative slot revokes and wipes it before returning an error.
 * A failed repeated commit of an active slot leaves that active slot unchanged.
 * This operation wipes its own temporary copy, not the caller's comparisonKey;
 * the caller must clear it and all upstream ticket/body bytes. The caller must
 * still revoke on outer exceptions, cancellation, login failure, closing, late
 * completion, and every other failure outside this operation.
 */
export function commitLinuxEasyKey(input: LinuxEasyKeyCommitInput): void {
    let copy: Uint8Array | undefined;
    let value: Slot | undefined;

    try {
        const [token] = fields(input, ['token']);
        value = lookup(token);
        const [lease, uin, sequence, comparisonKey] = fields(input, [
            'lease',
            'uin',
            'sequence',
            'comparisonKey',
        ]);
        const expected = value.key;

        if (
            value.phase !== 'tentative' ||
            !expected ||
            !bound(value, lease, uin) ||
            !uint32(sequence) ||
            value.sequence !== sequence
        ) {
            return fail();
        }

        copy = snapshot(comparisonKey, 16, 16, true);
        const matches = timingSafeEqual(expected, copy);

        if (
            !matches ||
            value.phase !== 'tentative' ||
            value.key !== expected ||
            !bound(value, lease, uin) ||
            value.sequence !== sequence
        ) {
            return fail();
        }

        value.phase = 'active';
    } catch {
        if (value?.phase === 'tentative') {
            const key = value.key;
            value.phase = 'revoked';
            value.key = undefined;
            value.sequence = undefined;
            wipe(key);
        }

        return fail();
    } finally {
        wipe(copy);
    }
}

export function linuxEasyKeyState(token: LinuxEasyKeyToken): LinuxEasyKeyState {
    try {
        return lookup(token).phase;
    } catch {
        return fail();
    }
}

/** Revoke synchronously and idempotently; mark stopped before wiping owned bytes. */
export function revokeLinuxEasyKey(token: LinuxEasyKeyToken): void {
    try {
        const value = lookup(token);
        const key = value.key;
        value.phase = 'revoked';
        const reservation = value.reservation;
        value.reservation = undefined;

        if (reservation) {
            apply(weakDelete, reservations, [reservation]);
        }

        value.key = undefined;
        value.sequence = undefined;
        wipe(key);
    } catch {
        return fail();
    }
}

/**
 * Decode only in tentative/active state for the exact lease and account. Parsing
 * returns facts, not authentication or safe MsgPush. Caller must bound and validate
 * the returned payload separately and wipe it on every outcome. A future owner must
 * impose a smaller business-specific input limit before calling: the 16 MiB frame
 * limit is neither a CPU, peak-memory nor latency bound, and synchronous QQ-TEA
 * decoding can be expensive. The existing legacy decoder has internal allocations
 * unreachable here, including QQ-TEA temporaries; wiping reachable snapshots does
 * not guarantee total memory erasure.
 */
export function decodeLinuxEasyServiceResponse(
    input: LinuxEasyKeyDecodeInput,
): LinuxEasyServiceResponse {
    let frameCopy: Uint8Array | undefined;
    let keyCopy: Uint8Array | undefined;
    let body: Uint8Array | undefined;
    let sso: ReturnType<typeof decodeSsoResponse> | undefined;
    let transferred = false;

    try {
        const [token, lease, uin, frame] = fields(input, ['token', 'lease', 'uin', 'frame']);
        const value = lookup(token);
        const expected = value.key;

        if (
            (value.phase !== 'tentative' && value.phase !== 'active') ||
            !expected ||
            !bound(value, lease, uin)
        ) {
            return fail();
        }

        frameCopy = snapshot(frame, 14, MAX_SERVICE_FRAME_BYTES, false);
        keyCopy = snapshot(expected, 16, 16, true);
        const outer = decodeServiceResponse(frameCopy, keyCopy);
        body = outer.body;

        if (
            outer.protocol !== 12 ||
            outer.encryption !== 'd2' ||
            outer.dummy !== 0 ||
            outer.uin !== value.uin
        ) {
            return fail();
        }

        sso = decodeSsoResponse(body);

        if (
            (value.phase !== 'tentative' && value.phase !== 'active') ||
            value.key !== expected ||
            !bound(value, lease, uin)
        ) {
            return fail();
        }

        const result: LinuxEasyServiceResponse = {
            uin: outer.uin,
            protocol: 12,
            encryption: 'd2',
            dummy: 0,
            sequence: sso.sequence >>> 0,
            command: sso.command,
            retCode: sso.retCode,
            body,
        };
        transferred = true;
        return result;
    } catch {
        return fail();
    } finally {
        if (!transferred) {
            wipe(body);
        }

        wipe(sso?.body);
        wipe(sso?.cookie);
        wipe(sso?.reserved);
        wipe(sso?.headerExtension);
        wipe(keyCopy);
        wipe(frameCopy);
    }
}
