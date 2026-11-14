import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { decodeServiceResponse } from './service-frame';
import { decodeSsoResponse } from './sso';

// A capability is scoped to one owner, not a security boundary against code in
// this process. In particular, this module is reachable by a deep import.
type BusinessOperation = 'poll' | 'login-register' | 'heartbeat' | 'alive';
type Slot = {
    phase: 'empty' | 'tentative' | 'active' | 'revoked';
    attempt?: object;
    reservation?: object;
    businessOwner?: object;
    businessFinalized?: boolean;
    businessFailure?: {
        operation: BusinessOperation;
        status: string;
        exactResult?: object;
        deadline?: number;
    };
    transportUin?: string;
    confirmedUin?: string;
    sequence?: number;
    key?: Uint8Array;
};
const slots = new WeakMap<object, Slot>();
const fill = Uint8Array.prototype.fill;
const set = Uint8Array.prototype.set;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;

function slot(token: object): Slot {
    const value = slots.get(token);

    if (!value) {
        throw new Error('invalid reference capability');
    }

    return value;
}

/** Internal composition capability. It exposes no raw key or plaintext. */
export function createReferenceKeyCapability(): object {
    const token = Object.freeze({});
    slots.set(token, { phase: 'empty' });
    return token;
}

export function assertReferenceKeyCapabilityAvailable(token: object): void {
    const value = slot(token);

    if (value.phase !== 'empty' || value.attempt || value.reservation) {
        throw new Error('reference capability already bound or stopped');
    }
}

/** Reserve before any owner callbacks can reenter construction. */
export function reserveReferenceKeyCapability(token: object): object {
    assertReferenceKeyCapabilityAvailable(token);
    const reservation = Object.freeze({});
    slot(token).reservation = reservation;
    return reservation;
}

export function bindReferenceKeyAttempt(token: object, attempt: object, reservation: object): void {
    const value = slot(token);

    if (value.phase !== 'empty' || value.attempt || value.reservation !== reservation) {
        throw new Error('reference capability already bound or stopped');
    }

    value.reservation = undefined;
    value.attempt = attempt;
    value.businessOwner = reservation;
}

/** One terminal business outcome, independent of key revocation. */
export function stageReferenceBusinessFailure(
    token: object,
    operation: BusinessOperation,
    status: string,
    exactResult?: object,
    deadline?: number,
): void {
    const value = slot(token);
    const allowed =
        (operation === 'poll' && ['expired', 'canceled', 'invalid', 'unknown'].includes(status)) ||
        (operation === 'login-register' &&
            [
                'verification-required',
                'nonzero',
                'incomplete',
                'error',
                'rejected',
                'missing-result',
                'sso-error',
            ].includes(status)) ||
        ((operation === 'heartbeat' || operation === 'alive') && status === 'sso-error');

    if (
        !value.businessOwner ||
        value.businessFinalized ||
        !allowed ||
        (exactResult !== undefined &&
            (typeof deadline !== 'number' || !Number.isFinite(deadline))) ||
        (exactResult === undefined && deadline !== undefined)
    ) {
        throw new Error('invalid reference business failure');
    }

    value.businessFinalized = true;
    value.businessFailure = { operation, status, exactResult, deadline };
}

export function discardReferenceBusinessFailure(token: object, exactOnly = false): void {
    const value = slot(token);

    if (!exactOnly || value.businessFailure?.exactResult !== undefined) {
        value.businessFailure = undefined;
    }
}

/** Consume the tombstone once, including on a mismatched query. */
export function consumeReferenceBusinessFailure(
    token: object,
    operation: BusinessOperation,
    status: string,
    exactResult?: object,
): boolean {
    const value = slot(token);
    const failure = value.businessFailure;
    value.businessFailure = undefined;
    return (
        failure?.operation === operation &&
        failure.status === status &&
        failure.exactResult === undefined &&
        exactResult === undefined
    );
}

/** Burn first; only exact committed WT results carry an absolute monotonic deadline. */
export function takeReferenceExactBusinessFailure(
    token: object,
    operation: BusinessOperation,
    status: string,
    exactResult: object,
): { deadline: number } | undefined {
    const value = slot(token);
    const failure = value.businessFailure;
    value.businessFailure = undefined;

    if (
        !failure ||
        failure.operation !== operation ||
        failure.status !== status ||
        failure.exactResult !== exactResult ||
        typeof failure.deadline !== 'number' ||
        !Number.isFinite(failure.deadline) ||
        performance.now() >= failure.deadline
    ) {
        return undefined;
    }

    return { deadline: failure.deadline };
}

export function stageReferenceConfirmed(
    token: object,
    attempt: object,
    transportUin: string,
    confirmedUin: string,
    sequence: number,
): void {
    const value = slot(token);

    if (
        value.phase !== 'empty' ||
        value.attempt !== attempt ||
        value.confirmedUin !== undefined ||
        !/^(0|[1-9][0-9]{0,18})$/.test(transportUin) ||
        !/^[1-9][0-9]{0,9}$/.test(confirmedUin) ||
        BigInt(confirmedUin) > 0xffffffffn ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence > 0xffffffff
    ) {
        throw new Error('invalid reference account stage');
    }

    value.transportUin = transportUin;
    value.confirmedUin = confirmedUin;
    value.sequence = sequence;
}

export function referenceExpectedUin(token: object): string | undefined {
    const value = slot(token);
    return value.phase === 'revoked' ? undefined : value.confirmedUin;
}

export function stageReferenceKey(
    token: object,
    attempt: object,
    transportUin: string,
    confirmedUin: string,
    sequence: number,
    key: Uint8Array,
): void {
    const value = slot(token);

    if (
        value.phase !== 'empty' ||
        value.attempt !== attempt ||
        value.transportUin !== transportUin ||
        value.confirmedUin !== confirmedUin ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence > 0xffffffff ||
        isProxy(key) ||
        !isUint8Array(key) ||
        isSharedArrayBuffer(buffer.call(key)) ||
        byteLength.call(key) !== 16
    ) {
        throw new Error('invalid reference key stage');
    }

    const copy = new Uint8Array(16);
    set.call(copy, key);
    value.transportUin = transportUin;
    value.confirmedUin = confirmedUin;
    value.sequence = sequence;
    value.key = copy;
    value.phase = 'tentative';
}

export function commitReferenceKey(token: object): void {
    const value = slot(token);

    if (value.phase !== 'tentative' || !value.key) {
        throw new Error('reference key not staged');
    }

    value.phase = 'active';
}

export function revokeReferenceKey(token: object): void {
    const value = slot(token);

    try {
        if (value.key) {
            fill.call(value.key, 0);
        }
    } finally {
        value.key = undefined;
        value.attempt = undefined;
        value.reservation = undefined;
        value.transportUin = undefined;
        value.confirmedUin = undefined;
        value.sequence = undefined;
        value.phase = 'revoked';
    }
}

export function referenceKeyState(token: object): Slot['phase'] {
    return slot(token).phase;
}

/** Decrypt and project routing metadata only. QQ-TEA is not authentication. */
export function decodeReferenceFrame(
    token: object,
    frame: Uint8Array,
    transportUin: string,
): {
    uin: string;
    protocol: 12 | 13;
    encryption: 'none' | 'zero' | 'd2';
    sequence: number;
    command: string;
} {
    const value = slot(token);

    if (value.phase === 'revoked' || (value.transportUin && value.transportUin !== transportUin)) {
        throw new Error('reference capability stopped');
    }

    const outer = decodeServiceResponse(frame, value.key);

    try {
        if (outer.encryption === 'd2' && (!value.key || outer.uin !== value.confirmedUin)) {
            throw new Error('reference account mismatch');
        }

        const sso = decodeSsoResponse(outer.body);

        try {
            return {
                uin: outer.uin,
                protocol: outer.protocol,
                encryption: outer.encryption,
                sequence: sso.sequence >>> 0,
                command: sso.command,
            };
        } finally {
            fill.call(sso.body, 0);
            fill.call(sso.cookie, 0);
            fill.call(sso.reserved, 0);
            fill.call(sso.headerExtension, 0);
        }
    } finally {
        fill.call(outer.body, 0);
    }
}

/** Re-decode one already verified push with the same active capability. The returned
 * body is an independent temporary copy; this operation does not authenticate QQ-TEA. */
export function decodeReferencePushBody(
    token: object,
    frame: Uint8Array,
    transportUin: string,
    expected: Readonly<{ uin: string; sequence: number; command: string }>,
    maxBodyBytes: number,
): { body: Uint8Array; retCode: number } {
    const value = slot(token);

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.transportUin !== transportUin ||
        value.confirmedUin !== expected.uin ||
        expected.command !== 'trpc.msg.olpush.OlPushService.MsgPush' ||
        !Number.isSafeInteger(maxBodyBytes) ||
        maxBodyBytes < 1 ||
        maxBodyBytes > 16 * 1024 * 1024
    ) {
        throw new Error('invalid push capability or binding');
    }

    const outer = decodeServiceResponse(frame, value.key);

    try {
        if (
            outer.protocol !== 12 ||
            outer.encryption !== 'd2' ||
            outer.uin !== value.confirmedUin
        ) {
            throw new Error('push account or protocol mismatch');
        }

        const sso = decodeSsoResponse(outer.body);

        try {
            if (
                sso.sequence >>> 0 !== expected.sequence ||
                sso.command !== expected.command ||
                sso.body.byteLength > maxBodyBytes ||
                value.phase !== 'active' ||
                !value.key ||
                value.transportUin !== transportUin ||
                value.confirmedUin !== outer.uin
            ) {
                throw new Error('push metadata or body limit mismatch');
            }

            return { body: Uint8Array.from(sso.body), retCode: sso.retCode };
        } finally {
            fill.call(sso.body, 0);
            fill.call(sso.cookie, 0);
            fill.call(sso.reserved, 0);
            fill.call(sso.headerExtension, 0);
        }
    } finally {
        fill.call(outer.body, 0);
    }
}
