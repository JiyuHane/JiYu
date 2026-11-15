import type { DirectSendMessageRequest } from '@snowluma/proto-defs/direct-send-message';
import { protobuf_encode } from '@snowluma/proton';

const MAX_ID = 0x7fff_ffff_ffff_ffffn;
const MAX_SEQUENCE = 0xffff_ffff_ffff_ffffn;
const MAX_RANDOM = 0xffff_ffff;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_UID_BYTES = 1024;

export type DirectSendMessageRoute =
    | { readonly kind: 'private'; readonly peerUin: bigint; readonly peerUid: string }
    | { readonly kind: 'group'; readonly groupUin: bigint };

export interface DirectSendMessageRequestInput {
    readonly route: DirectSendMessageRoute;
    readonly text: string;
    readonly clientSequence: bigint;
    readonly random: number;
}

function requireFields(value: unknown, names: readonly string[], label: string): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`invalid ${label}`);
    }

    const keys = Reflect.ownKeys(value);

    if (
        keys.length !== names.length ||
        keys.some((key) => typeof key !== 'string' || !names.includes(key))
    ) {
        throw new TypeError(`invalid ${label}`);
    }
}

function requireId(value: unknown, label: string): asserts value is bigint {
    if (typeof value !== 'bigint' || value < 1n || value > MAX_ID) {
        throw new RangeError(`invalid ${label}`);
    }
}

function requireString(value: unknown, maxBytes: number, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length > maxBytes) {
        throw new TypeError(`invalid ${label}`);
    }

    // Reject unpaired UTF-16 surrogates instead of depending on transcoder
    // replacement behaviour when comparing independent implementations.
    for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i);

        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(++i);

            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                throw new TypeError(`invalid ${label}`);
            }
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new TypeError(`invalid ${label}`);
        }
    }

    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
        throw new RangeError(`invalid ${label}`);
    }
}

/**
 * Encode one text element as a reference-only request body. The candidate
 * layout is statically derived from MessagePacker.Build and the protobuf
 * generator in LagrangeV2 commit 7011cdf87368cc0fb77273c1508e779a52328165;
 * it is not a cross-implementation byte comparison or evidence of QQ acceptance.
 *
 * All inputs are explicit. ID, sequence, random and UTF-8 length limits are
 * local API policy, not established server limits. Empty text and UID are
 * accepted locally; server acceptance is unknown. Inputs are ordinary trusted
 * caller-owned objects; accessors and proxies may execute caller code during
 * validation. No transport, account, signing, clock or random source is used.
 * The returned byte array is owned by the caller. Errors do not include input
 * values for ordinary data objects.
 */
export function encodeDirectSendMessageRequest(input: DirectSendMessageRequestInput): Uint8Array {
    requireFields(input, ['route', 'text', 'clientSequence', 'random'], 'request');
    const { route, text, clientSequence, random } = input;

    if (typeof route !== 'object' || route === null || Array.isArray(route)) {
        throw new TypeError('invalid route');
    }

    let routingHead: DirectSendMessageRequest['routingHead'];

    if (route.kind === 'private') {
        requireFields(route, ['kind', 'peerUin', 'peerUid'], 'route');
        const { peerUin, peerUid } = route;
        requireId(peerUin, 'peerUin');
        requireString(peerUid, MAX_UID_BYTES, 'peerUid');
        routingHead = { c2c: { peerUin, peerUid } };
    } else if (route.kind === 'group') {
        requireFields(route, ['kind', 'groupUin'], 'route');
        const { groupUin } = route;
        requireId(groupUin, 'groupUin');
        routingHead = { group: { groupUin } };
    } else {
        throw new TypeError('invalid route');
    }

    requireString(text, MAX_TEXT_BYTES, 'text');

    if (
        typeof clientSequence !== 'bigint' ||
        clientSequence < 0n ||
        clientSequence > MAX_SEQUENCE
    ) {
        throw new RangeError('invalid clientSequence');
    }

    if (
        typeof random !== 'number' ||
        !Number.isInteger(random) ||
        random < 0 ||
        random > MAX_RANDOM
    ) {
        throw new RangeError('invalid random');
    }

    const encoded = protobuf_encode<DirectSendMessageRequest>({
        routingHead,
        contentHead: { pkgNum: 1, pkgIndex: 0, divSeq: 0, autoReply: 0 },
        messageBody: { richText: { elems: [{ text: { text, pbReserve: new Uint8Array(0) } }] } },
        clientSequence,
        random,
    });
    // Proton may return a view into a shared pool. Give callers a dedicated
    // backing buffer; the temporary encoding itself is not securely erased.
    return Uint8Array.from(encoded);
}
