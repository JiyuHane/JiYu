import { randomUUID } from 'node:crypto';
import type { V12ConvertedEvent, V12MessageEvent, V12Self } from './types';
import { fromV11AccountId, fromV11MessageId, isObject, isSelf } from './validation';

/** Distinguishes unsupported self-sent semantics from malformed V11 input. */
export class V12UnsupportedEventError extends Error {
    readonly reason = 'self_sent_message';

    constructor() {
        super('V12 self-sent message mapping is not implemented');
        this.name = 'V12UnsupportedEventError';
    }
}

/** A known but unsupported V11 event returns null; malformed input throws. */
export function convertV11Event(input: unknown, self: V12Self): V12ConvertedEvent | null {
    if (!isSelf(self) || !isObject(input) || typeof input.post_type !== 'string') {
        throw new Error('invalid V11 event or V12 account identity');
    }

    const sourceSelf = fromV11AccountId(input.self_id);

    if (sourceSelf === null || sourceSelf !== self.user_id) {
        throw new Error('V11 event account does not match V12 account');
    }

    if (input.post_type === 'notice') {
        if (input.notice_type === 'friend_add') {
            const fields = ['time', 'self_id', 'post_type', 'notice_type', 'user_id'];
            const userId = fromV11AccountId(input.user_id);

            if (
                Reflect.ownKeys(input).some(
                    (key) => typeof key !== 'string' || !fields.includes(key),
                ) ||
                userId === null ||
                typeof input.time !== 'number' ||
                !Number.isFinite(input.time) ||
                input.time < 0
            ) {
                throw new Error('invalid or unsupported V11 friend add event');
            }

            return {
                id: randomUUID(),
                time: input.time,
                type: 'notice',
                detail_type: 'friend_increase',
                sub_type: '',
                self: { ...self },
                user_id: userId,
            };
        }

        if (input.notice_type === 'group_increase') {
            if (input.sub_type !== 'approve' && input.sub_type !== 'invite') {
                return null;
            }

            const fields = [
                'time',
                'self_id',
                'post_type',
                'notice_type',
                'sub_type',
                'group_id',
                'operator_id',
                'user_id',
                'invitor_id',
                'invitor_status',
            ];
            const groupId = fromV11AccountId(input.group_id);
            const operatorId = fromV11AccountId(input.operator_id);
            const userId = fromV11AccountId(input.user_id);
            const knownInvitor = fromV11AccountId(input.invitor_id);
            const unknownInvitor = input.invitor_status === 'unknown' && input.invitor_id === 0;

            if (
                Reflect.ownKeys(input).some(
                    (key) => typeof key !== 'string' || !fields.includes(key),
                ) ||
                groupId === null ||
                operatorId === null ||
                userId === null ||
                typeof input.time !== 'number' ||
                !Number.isFinite(input.time) ||
                input.time < 0 ||
                (!unknownInvitor && !(input.invitor_status === 'known' && knownInvitor !== null))
            ) {
                throw new Error('invalid or unsupported V11 group increase event');
            }

            // An independently known inviter is not represented by the standard fields.
            if (!unknownInvitor) {
                return null;
            }

            // Unknown includes absent or unresolved inviter identity, not absence of an
            // inviter. V11 admission types may be defaults or actor-comparison fallbacks,
            // and the self-join decoder can synthesize user_id from its account context.
            return {
                id: randomUUID(),
                time: input.time,
                type: 'notice',
                detail_type: 'group_member_increase',
                sub_type: '',
                self: { ...self },
                group_id: groupId,
                user_id: userId,
                operator_id: operatorId,
            };
        }

        if (input.notice_type === 'group_decrease') {
            // V11 leave can be a decoder default or a locally synthesized event;
            // the original reason and operator provenance are no longer available.
            if (input.sub_type !== 'leave') {
                return null;
            }

            const fields = [
                'time',
                'self_id',
                'post_type',
                'notice_type',
                'sub_type',
                'group_id',
                'operator_id',
                'user_id',
            ];
            const groupId = fromV11AccountId(input.group_id);
            const operatorId = fromV11AccountId(input.operator_id);
            const userId = fromV11AccountId(input.user_id);

            if (
                Reflect.ownKeys(input).some(
                    (key) => typeof key !== 'string' || !fields.includes(key),
                ) ||
                groupId === null ||
                operatorId === null ||
                userId === null ||
                typeof input.time !== 'number' ||
                !Number.isFinite(input.time) ||
                input.time < 0
            ) {
                throw new Error('invalid or unsupported V11 group decrease event');
            }

            return {
                id: randomUUID(),
                time: input.time,
                type: 'notice',
                detail_type: 'group_member_decrease',
                sub_type: '',
                self: { ...self },
                group_id: groupId,
                user_id: userId,
                operator_id: operatorId,
            };
        }

        if (input.notice_type !== 'group_recall') {
            return null;
        }

        // The internal v11 converter emits no subtype or extension fields here.
        // Unknown additions may carry semantics this mapping cannot preserve.
        const fields = [
            'time',
            'self_id',
            'post_type',
            'notice_type',
            'group_id',
            'operator_id',
            'user_id',
            'message_id',
        ];
        const groupId = fromV11AccountId(input.group_id);
        const operatorId = fromV11AccountId(input.operator_id);
        const userId = fromV11AccountId(input.user_id);
        const messageId = fromV11MessageId(input.message_id);

        if (
            Reflect.ownKeys(input).some(
                (key) => typeof key !== 'string' || !fields.includes(key),
            ) ||
            groupId === null ||
            operatorId === null ||
            userId === null ||
            messageId === null ||
            typeof input.time !== 'number' ||
            !Number.isFinite(input.time) ||
            input.time < 0
        ) {
            throw new Error('invalid or unsupported V11 group recall event');
        }

        return {
            id: randomUUID(),
            time: input.time,
            type: 'notice',
            detail_type: 'group_message_delete',
            // A different operator does not establish that they are an administrator.
            sub_type: operatorId === userId ? 'recall' : '',
            self: { ...self },
            group_id: groupId,
            message_id: messageId,
            user_id: userId,
            operator_id: operatorId,
        };
    }

    if (input.post_type === 'meta_event' || input.post_type === 'request') {
        return null;
    }

    if (input.post_type === 'message_sent') {
        // V11 private self events carry the recipient separately in target_id;
        // v12's private event does not define an equivalent recipient field.
        throw new V12UnsupportedEventError();
    }

    if (input.post_type !== 'message') {
        throw new Error('unsupported V11 event type');
    }

    const detail = input.message_type;

    if (
        (detail !== 'private' && detail !== 'group') ||
        (detail === 'private' && input.sub_type !== 'friend') ||
        (detail === 'group' && input.sub_type !== 'normal')
    ) {
        throw new Error('unsupported V11 message type');
    }

    const messageId = fromV11MessageId(input.message_id);
    const userId = fromV11AccountId(input.user_id);
    const groupId = detail === 'group' ? fromV11AccountId(input.group_id) : null;

    if (
        messageId === null ||
        userId === null ||
        (detail === 'group' && groupId === null) ||
        typeof input.time !== 'number' ||
        !Number.isFinite(input.time) ||
        input.time < 0 ||
        typeof input.raw_message !== 'string' ||
        !Array.isArray(input.message)
    ) {
        throw new Error('invalid V11 message event');
    }

    const message: V12MessageEvent['message'] = [];
    const alt: string[] = [];

    for (const segment of input.message) {
        if (
            !isObject(segment) ||
            (segment.type !== 'text' && segment.type !== 'at') ||
            !isObject(segment.data) ||
            (segment.type === 'text' && typeof segment.data.text !== 'string')
        ) {
            throw new Error('unsupported or invalid V11 message segment');
        }

        if (
            Object.keys(segment).some((key) => key !== 'type' && key !== 'data') ||
            Object.keys(segment.data).some(
                (key) => key !== (segment.type === 'text' ? 'text' : 'qq'),
            )
        ) {
            throw new Error('unsupported V11 message segment field');
        }

        if (segment.type === 'text') {
            // The earlier guard narrows this field at runtime, not across the segment type.
            if (typeof segment.data.text !== 'string') {
                throw new Error('unsupported or invalid V11 message segment');
            }

            message.push({ type: 'text', data: { text: segment.data.text } });
            alt.push(segment.data.text);
        } else if (segment.data.qq === 'all') {
            message.push({ type: 'mention_all', data: {} });
            alt.push('@全体成员');
        } else {
            const mentionedUser = fromV11AccountId(segment.data.qq);

            if (mentionedUser === null) {
                throw new Error('unsupported or invalid V11 message segment');
            }

            message.push({ type: 'mention', data: { user_id: mentionedUser } });
            alt.push(`@${mentionedUser}`);
        }
    }

    return {
        id: randomUUID(),
        time: input.time,
        type: 'message',
        detail_type: detail,
        sub_type: '',
        self: { ...self },
        message_id: messageId,
        message,
        // V11 raw_message is CQ-escaped. These mention labels are local plain-text
        // alternatives, not original platform display names or protocol-mandated spellings.
        alt_message: alt.join(''),
        user_id: userId,
        ...(groupId === null ? {} : { group_id: groupId }),
    };
}

/** The transport supplies actual version/status and decides when to emit these. */
export function createConnectEvent(
    version: { impl: string; version: string },
    now = Date.now() / 1000,
) {
    if (!version.impl || !version.version || !Number.isFinite(now) || now < 0) {
        throw new Error('invalid V12 connect event inputs');
    }

    return {
        id: randomUUID(),
        time: now,
        type: 'meta' as const,
        detail_type: 'connect' as const,
        sub_type: '',
        version: { ...version, onebot_version: '12' as const },
    };
}

export function createHeartbeatEvent(interval: number, now = Date.now() / 1000) {
    if (!Number.isSafeInteger(interval) || interval <= 0 || !Number.isFinite(now) || now < 0) {
        throw new Error('invalid V12 heartbeat event inputs');
    }

    return {
        id: randomUUID(),
        time: now,
        type: 'meta' as const,
        detail_type: 'heartbeat' as const,
        sub_type: '',
        interval,
    };
}

export function createStatusUpdateEvent(
    self: V12Self,
    status: { good: boolean; online: boolean },
    now = Date.now() / 1000,
) {
    if (
        !isSelf(self) ||
        typeof status.good !== 'boolean' ||
        typeof status.online !== 'boolean' ||
        !Number.isFinite(now) ||
        now < 0
    ) {
        throw new Error('invalid V12 status event inputs');
    }

    return {
        id: randomUUID(),
        time: now,
        type: 'meta' as const,
        detail_type: 'status_update' as const,
        sub_type: '',
        status: { good: status.good, bots: [{ self: { ...self }, online: status.online }] },
    };
}
