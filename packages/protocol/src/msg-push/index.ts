import { types as utilTypes } from 'node:util';
import { createLogger } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { classifyMessageSurvival, warnUndecodedMessage } from './blank-filter';
import { buildContextFromPushFields } from './context';
import { decodeEvent0x210 } from './decoders/event-0x210';
import { decodeEvent0x2DC } from './decoders/event-0x2dc';
import { decodeFriendMessage } from './decoders/friend-message';
import { decodeGroupAdmin } from './decoders/group-admin';
import {
    decodeGroupInvitation,
    decodeGroupInvite,
    decodeGroupJoinRequest,
} from './decoders/group-join-request';
import {
    decodeGroupMemberJoin,
    decodeGroupMemberLeave,
    decodeGroupSelfJoined,
} from './decoders/group-member-change';
import { decodeGroupMessage } from './decoders/group-message';
import { decodeTempMessage } from './decoders/temp-message';
import { PkgType } from './enums';
import { MsgPushRegistry } from './registry';
import { deriveSysMsgDedupIdentity, SysMsgDedup } from './sysmsg-dedup';

export { deriveSysMsgDedupIdentity, SysMsgDedup } from './sysmsg-dedup';
export type { SysMsgDedupIdentity } from './sysmsg-dedup';
export { decodeClientMessageReceipt, fetchClientMessage } from './client-message-receipt';

export { SSO_GET_GROUP_MSG_CMD, fetchGroupMessageRange } from './fetch-group-history';
export {
    SSO_GET_C2C_MSG_CMD,
    SSO_GET_ROAM_MSG_CMD,
    fetchC2cMessageRange,
    fetchC2cRoamMessagePage,
    type C2cRoamPage,
} from './fetch-c2c-history';

export const MSG_PUSH_CMD = 'trpc.msg.olpush.OlPushService.MsgPush';

const registry = new MsgPushRegistry();
registry.register(PkgType.GroupMemberIncreaseNotice, decodeGroupMemberJoin);
registry.register(PkgType.GroupMemberDecreaseNotice, decodeGroupMemberLeave);
registry.register(PkgType.GroupSelfJoinedNotice, decodeGroupSelfJoined);
registry.register(PkgType.GroupAdminChangedNotice, decodeGroupAdmin);
registry.register(PkgType.GroupRequestJoinNotice, decodeGroupJoinRequest);
registry.register(PkgType.GroupRequestInvitationNotice, decodeGroupInvitation);
registry.register(PkgType.GroupInviteNotice, decodeGroupInvite);
registry.register(PkgType.Event0x210, decodeEvent0x210);
registry.register(PkgType.Event0x2DC, decodeEvent0x2DC);
registry.register(PkgType.GroupMessage, decodeGroupMessage);
registry.register(PkgType.TempMessage, decodeTempMessage);
registry.register(
    [
        PkgType.PrivateMessage,
        PkgType.ForwardFakePrivateMessage,
        PkgType.PrivateRecordMessage,
        PkgType.PrivateFileMessage,
    ],
    decodeFriendMessage,
);

const log = createLogger('MsgPush');

type PushFields = Pick<PacketInfo, 'uin' | 'serviceCmd' | 'seqId' | 'body'>;

export interface DirectMsgPush {
    readonly uin: string;
    readonly sequence: number;
    readonly command: string;
    readonly retCode: number;
    readonly body: Uint8Array;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteOffset',
)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
)!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const directPushKeys = ['uin', 'sequence', 'command', 'retCode', 'body'] as const;

/**
 * Decode an already-decrypted direct push synchronously through the same live
 * context, dedup, registry and filters as parseMsgPushOrThrow. This does not
 * authenticate the peer, establish an online session, or dispatch the events.
 * The identity service must have the same UIN; the caller owns its provenance
 * and the input and output lifetimes. Consume temporary bodies before any
 * asynchronous wipe. Dedup and identity operations may have synchronous effects
 * that remain even if decoding throws. Use a separate dedup per account/session:
 * its key does not include selfUin.
 * A zero return code is a local admission policy, not a wire-authenticity claim.
 * Direct-path undecoded-body and registry-exception logs omit content previews;
 * the original exception may contain message data and requires careful handling.
 * Existing identity and decoder diagnostics still apply; configure logs accordingly.
 */
export function parseDirectMsgPushOrThrow(
    input: DirectMsgPush,
    identity: IdentityService,
    dedup?: SysMsgDedup,
): QQEventVariant[] {
    if (typeof input !== 'object' || input === null || utilTypes.isProxy(input)) {
        throw new TypeError('invalid direct push record');
    }

    const proto = Object.getPrototypeOf(input);

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid direct push record');
    }

    const keys = Reflect.ownKeys(input);

    if (
        keys.length !== directPushKeys.length ||
        keys.some(
            (key) =>
                typeof key !== 'string' ||
                !directPushKeys.includes(key as (typeof directPushKeys)[number]),
        )
    ) {
        throw new TypeError('invalid direct push fields');
    }

    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of directPushKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('invalid direct push field');
        }

        values[key] = descriptor.value;
    }

    const { uin, sequence, command, retCode, body } = values;

    if (
        typeof uin !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(uin) ||
        BigInt(uin) > 0xffffffffn ||
        typeof sequence !== 'number' ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence > 0xffffffff ||
        command !== MSG_PUSH_CMD ||
        typeof retCode !== 'number' ||
        retCode !== 0 ||
        !utilTypes.isUint8Array(body) ||
        utilTypes.isProxy(body)
    ) {
        throw new TypeError('invalid direct push metadata or body');
    }

    if (identity.uin !== uin) {
        throw new TypeError('direct push identity UIN mismatch');
    }

    // Use intrinsic brand checks and a plain view: neither caller-owned getters
    // nor Buffer.slice semantics should influence the synchronous codec path.
    let bytes: Uint8Array;

    try {
        typedArrayValues.call(body); // A detached backing store throws.
        const buffer = typedArrayBuffer.call(body) as ArrayBuffer;
        arrayBufferByteLength.call(buffer); // Reject SharedArrayBuffer.
        const byteOffset = typedArrayByteOffset.call(body) as number;
        const byteLength = typedArrayByteLength.call(body) as number;
        bytes = new Uint8Array(buffer, byteOffset, byteLength);
    } catch {
        throw new TypeError('invalid direct push body storage');
    }

    return parseMsgPushInternal(
        { uin, serviceCmd: command, seqId: sequence, body: bytes },
        identity,
        dedup,
        true,
        true,
    );
}

function messageElements(ev: QQEventVariant): readonly unknown[] | undefined {
    if (ev.kind === 'friend_message' || ev.kind === 'group_message' || ev.kind === 'temp_message') {
        return ev.elements;
    }

    return undefined;
}

function warnMissingC2cSequence(ev: QQEventVariant, fromUin: number): void {
    if (
        (ev.kind === 'friend_message' || ev.kind === 'temp_message') &&
        ev.sequenceAuthoritative === false
    ) {
        log.warn(
            'c2c message omitted NT sequence; keeping non-authoritative client sequence (kind=%s from=%d clientSeq=%d time=%d)',
            ev.kind,
            fromUin,
            ev.clientSeq ?? ev.msgSeq,
            ev.time,
        );
    }
}

export function parseMsgPush(
    pkt: PacketInfo,
    identity: IdentityService,
    dedup?: SysMsgDedup,
): QQEventVariant[] {
    return parseMsgPushInternal(pkt, identity, dedup, false);
}

export function parseMsgPushOrThrow(
    pkt: PacketInfo,
    identity: IdentityService,
    dedup?: SysMsgDedup,
): QQEventVariant[] {
    return parseMsgPushInternal(pkt, identity, dedup, true);
}

function parseMsgPushInternal(
    pkt: PushFields,
    identity: IdentityService,
    dedup: SysMsgDedup | undefined,
    throwDecoderErrors: boolean,
    suppressContentPreview = false,
): QQEventVariant[] {
    const ctx = buildContextFromPushFields(pkt, identity);

    if (!ctx) {
        if (suppressContentPreview) {
            log.trace('packet_branch branch=push_context_invalid');
        } else {
            log.trace(() => [
                'packet_branch serviceCmd=%j seqId=%d branch=push_context_invalid',
                pkt.serviceCmd,
                pkt.seqId,
            ]);
        }

        return [];
    }

    // #137/#266: mirror QQ NT `sys_msg_mgr.cc::ProcessRecvSysMsg` before
    // dispatch. Its static routing table is the scope boundary: listed routes
    // use the native global key, while unlisted routes fail open. Running this
    // before registry decode also covers native system packets whose outer type
    // SnowLuma otherwise interprets as a chat message or does not decode at all.
    if (dedup) {
        const dedupIdentity = deriveSysMsgDedupIdentity(ctx);

        if (dedupIdentity && dedup.seenDuplicate(dedupIdentity)) {
            if (suppressContentPreview) {
                log.trace(() => [
                    'packet_branch branch=duplicate_system_push msgType=%d subType=%d',
                    ctx.head.msgType,
                    ctx.head.subType,
                ]);
            } else {
                log.trace(() => [
                    'packet_branch serviceCmd=%j seqId=%d branch=duplicate_system_push peer=%j chatType=%d messageSeq=%d messageRandom=%d',
                    pkt.serviceCmd,
                    pkt.seqId,
                    dedupIdentity.peerUid,
                    dedupIdentity.chatType,
                    dedupIdentity.sequence,
                    dedupIdentity.random,
                ]);
                log.debug(
                    'dropped duplicate system push (peer=%s chatType=%d seq=%d msgType=%d/%d msgId=%d)',
                    dedupIdentity.peerUid,
                    dedupIdentity.chatType,
                    ctx.head.sequence,
                    ctx.head.msgType,
                    ctx.head.subType,
                    ctx.head.msgId,
                );
            }

            return [];
        }
    }

    const events = throwDecoderErrors
        ? suppressContentPreview
            ? registry.decodeOrThrowRedacted(ctx)
            : registry.decodeOrThrow(ctx)
        : registry.decode(ctx);
    const out = events.filter((ev) => {
        const elements = messageElements(ev);

        if (elements === undefined) {
            return true;
        }

        const survival = classifyMessageSurvival(ctx.head, elements, ctx.body);

        if (survival === 'drop-control') {
            if (suppressContentPreview) {
                log.trace(() => [
                    'packet_branch branch=c2c_control_push msgType=%d subType=%d',
                    ctx.head.msgType,
                    ctx.head.subType,
                ]);
                return false;
            }

            log.trace(() => [
                'packet_branch serviceCmd=%j seqId=%d branch=c2c_control_push msgType=%d subType=%d c2cCmd=%d messageSeq=%d',
                pkt.serviceCmd,
                pkt.seqId,
                ctx.head.msgType,
                ctx.head.subType,
                ctx.head.c2cCmd,
                ctx.head.sequence,
            ]);

            if (elements.length > 0) {
                log.debug(
                    'dropped c2c control push that carried %d element(s) (kind=%s seq=%d from=%d msgType=%d cmd=%d)',
                    elements.length,
                    ev.kind,
                    ctx.head.sequence,
                    ctx.fromUin,
                    ctx.head.msgType,
                    ctx.head.c2cCmd,
                );
            }

            return false;
        }

        if (survival === 'drop-receipt') {
            if (suppressContentPreview) {
                log.trace(() => [
                    'packet_branch branch=offline_file_receipt msgType=%d subType=%d',
                    ctx.head.msgType,
                    ctx.head.subType,
                ]);
                return false;
            }

            log.trace(() => [
                'packet_branch serviceCmd=%j seqId=%d branch=offline_file_receipt msgType=%d subType=%d messageSeq=%d',
                pkt.serviceCmd,
                pkt.seqId,
                ctx.head.msgType,
                ctx.head.subType,
                ctx.head.sequence,
            ]);
            log.debug(
                'dropped offline file receipt (kind=%s seq=%d from=%d msgType=%d)',
                ev.kind,
                ctx.head.sequence,
                ctx.fromUin,
                ctx.head.msgType,
            );
            return false;
        }

        if (survival === 'drop-blank') {
            if (suppressContentPreview) {
                log.trace(() => [
                    'packet_branch branch=empty_message msgType=%d subType=%d',
                    ctx.head.msgType,
                    ctx.head.subType,
                ]);
                return false;
            }

            log.trace(() => [
                'packet_branch serviceCmd=%j seqId=%d branch=empty_message msgType=%d subType=%d messageSeq=%d',
                pkt.serviceCmd,
                pkt.seqId,
                ctx.head.msgType,
                ctx.head.subType,
                ctx.head.sequence,
            ]);
            return false;
        }

        if (survival === 'keep-undecoded') {
            if (suppressContentPreview) {
                log.warn(
                    'message had content but decoded to 0 elements (kind=%s msgType=%d/%d)',
                    ev.kind,
                    ctx.head.msgType,
                    ctx.head.subType,
                );
            } else {
                warnUndecodedMessage({
                    kind: ev.kind,
                    sequence: ctx.head.sequence,
                    fromUin: ctx.fromUin,
                    msgType: ctx.head.msgType,
                    subType: ctx.head.subType,
                    body: ctx.body,
                });
            }
        }

        if (suppressContentPreview) {
            if (
                (ev.kind === 'friend_message' || ev.kind === 'temp_message') &&
                ev.sequenceAuthoritative === false
            ) {
                log.warn('c2c message omitted NT sequence (kind=%s)', ev.kind);
            }
        } else {
            warnMissingC2cSequence(ev, ctx.fromUin);
        }

        return true;
    });

    return out;
}
