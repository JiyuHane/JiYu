import { randomUUID } from 'node:crypto';
import type { V12MessageEvent, V12Self } from './types';
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
export function convertV11Event(input: unknown, self: V12Self): V12MessageEvent | null {
    if (!isSelf(self) || !isObject(input) || typeof input.post_type !== 'string') {
        throw new Error('invalid V11 event or V12 account identity');
    }

    const sourceSelf = fromV11AccountId(input.self_id);

    if (sourceSelf === null || sourceSelf !== self.user_id) {
        throw new Error('V11 event account does not match V12 account');
    }

    if (
        input.post_type === 'meta_event' ||
        input.post_type === 'notice' ||
        input.post_type === 'request'
    ) {
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

    for (const segment of input.message) {
        if (
            !isObject(segment) ||
            segment.type !== 'text' ||
            !isObject(segment.data) ||
            typeof segment.data.text !== 'string'
        ) {
            throw new Error('unsupported or invalid V11 message segment');
        }

        if (
            Object.keys(segment).some((key) => key !== 'type' && key !== 'data') ||
            Object.keys(segment.data).some((key) => key !== 'text')
        ) {
            throw new Error('unsupported V11 message segment field');
        }

        message.push({ type: 'text', data: { text: segment.data.text } });
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
        // V11 raw_message is CQ-escaped, not a plain-text alternative.
        alt_message: message.map((segment) => segment.data.text).join(''),
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
