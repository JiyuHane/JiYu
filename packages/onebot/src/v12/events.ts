import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { V12ConvertedEvent, V12MessageEvent, V12Self } from './types';
import { fromV11AccountId, fromV11MessageId, isObject, isSelf } from './validation';

// V12 timestamps retain fractional Unix seconds, but must also survive the SDK's
// JSON-number validation. Match the existing self-sent nonnegative safe range.
function isV12Time(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
    );
}

/** Distinguishes unsupported self-sent semantics from malformed V11 input. */
export class V12UnsupportedEventError extends Error {
    readonly reason = 'self_sent_message';

    constructor() {
        super('V12 self-sent message shape is not supported');
        this.name = 'V12UnsupportedEventError';
    }
}

// Read own or inherited data properties without executing Proxy traps or getters.
// This retains observable legacy text/at values while rejecting accessors.
function segmentProperty(segment: object, name: string): unknown {
    let current: object | null = segment;
    let depth = 0;

    while (current !== null && depth++ < 256 && !isProxy(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);

        if (descriptor) {
            return 'value' in descriptor ? descriptor.value : undefined;
        }

        current = Object.getPrototypeOf(current);
    }

    return undefined;
}

// Only public JSON fields are projected. Hidden symbols hold persistence-only
// snapshots in production; check their visibility without reading their values.
function visibleOwnData(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
    if (isProxy(value) || !isObject(value)) {
        return null;
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        return null;
    }

    const keys = Object.keys(value);

    if (
        keys.length !== fields.length ||
        keys.some((key) => !fields.includes(key)) ||
        Object.getOwnPropertySymbols(value).some((key) =>
            Object.prototype.propertyIsEnumerable.call(value, key),
        )
    ) {
        return null;
    }

    // Hidden string extras are outside the JSON shape, but accessors are still
    // rejected without evaluation. Hidden symbols are never value-inspected.
    for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            return null;
        }
    }

    const result = Object.create(null) as Record<string, unknown>;

    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);

        if (!descriptor?.enumerable || !('value' in descriptor)) {
            return null;
        }

        result[field] = descriptor.value;
    }

    return result;
}

function ordinaryImageUrl(segment: object): string | null {
    const outer = visibleOwnData(segment, ['type', 'data']);

    if (!outer || outer.type !== 'image') {
        return null;
    }

    const data = visibleOwnData(outer.data, ['file', 'url', 'sub_type', 'summary']);

    if (
        !data ||
        typeof data.file !== 'string' ||
        typeof data.url !== 'string' ||
        data.url.length === 0 ||
        data.sub_type !== 0 ||
        (data.summary !== '' && data.summary !== '[图片]')
    ) {
        return null;
    }

    return data.url;
}

// This projects only the observable V11 shape; it does not establish the
// identity or playability of the original QQ media.
function ordinaryVoiceUrl(segment: object): string | null {
    const outer = visibleOwnData(segment, ['type', 'data']);

    if (!outer || outer.type !== 'record') {
        return null;
    }

    const data = visibleOwnData(outer.data, ['file', 'url']);

    if (
        !data ||
        typeof data.file !== 'string' ||
        typeof data.url !== 'string' ||
        data.url.length === 0
    ) {
        return null;
    }

    return data.url;
}

/** A known but unsupported V11 event returns null; malformed input throws. */
export function convertV11Event(
    input: unknown,
    self: V12Self,
    options?: {
        issueImageFileId: (url: string) => string;
        issueVoiceFileId?: (url: string) => string;
        validateMediaFileUrl?: (url: string) => boolean;
    },
): V12ConvertedEvent | null {
    if (isProxy(self) || !isObject(self)) {
        throw new Error('invalid V11 event or V12 account identity');
    }

    // Capture identity before inspecting the event: event getters can reenter
    // caller code, but cannot change the identity used for this projection.
    const eventSelf = { ...self };

    if (!isSelf(eventSelf) || !isObject(input)) {
        throw new Error('invalid V11 event or V12 account identity');
    }

    const postType = input.post_type;

    if (typeof postType !== 'string') {
        throw new Error('invalid V11 event or V12 account identity');
    }

    const sourceSelf = fromV11AccountId(input.self_id);

    if (sourceSelf === null || sourceSelf !== eventSelf.user_id) {
        throw new Error('V11 event account does not match V12 account');
    }

    if (postType === 'notice') {
        if (input.notice_type === 'friend_add') {
            const fields = ['time', 'self_id', 'post_type', 'notice_type', 'user_id'];
            const userId = fromV11AccountId(input.user_id);

            if (
                Reflect.ownKeys(input).some(
                    (key) => typeof key !== 'string' || !fields.includes(key),
                ) ||
                userId === null ||
                !isV12Time(input.time)
            ) {
                throw new Error('invalid or unsupported V11 friend add event');
            }

            return {
                id: randomUUID(),
                time: input.time,
                type: 'notice',
                detail_type: 'friend_increase',
                sub_type: '',
                self: { ...eventSelf },
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
                !isV12Time(input.time) ||
                (!unknownInvitor && !(input.invitor_status === 'known' && knownInvitor !== null))
            ) {
                throw new Error('invalid or unsupported V11 group increase event');
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
                self: { ...eventSelf },
                group_id: groupId,
                user_id: userId,
                operator_id: operatorId,
                ...(knownInvitor === null ? {} : { 'qq.invitor_id': knownInvitor }),
            };
        }

        if (input.notice_type === 'group_decrease') {
            // V11 leave may be a decoder default or locally synthesized; kick and
            // kick_me can also originate from an unknown decoder decrease type.
            // Preserve the observed actors without asserting the original reason.
            if (
                input.sub_type !== 'leave' &&
                input.sub_type !== 'kick' &&
                input.sub_type !== 'kick_me'
            ) {
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
                !isV12Time(input.time)
            ) {
                throw new Error('invalid or unsupported V11 group decrease event');
            }

            return {
                id: randomUUID(),
                time: input.time,
                type: 'notice',
                detail_type: 'group_member_decrease',
                sub_type: '',
                self: { ...eventSelf },
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
            !isV12Time(input.time)
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
            self: { ...eventSelf },
            group_id: groupId,
            message_id: messageId,
            user_id: userId,
            operator_id: operatorId,
        };
    }

    if (postType === 'meta_event' || postType === 'request') {
        return null;
    }

    const isSent = postType === 'message_sent';

    if (!isSent && postType !== 'message') {
        throw new Error('unsupported V11 event type');
    }

    const detail = input.message_type;

    if (
        (detail !== 'private' && detail !== 'group') ||
        (detail === 'private' && input.sub_type !== 'friend') ||
        (detail === 'group' && input.sub_type !== 'normal')
    ) {
        if (isSent) {
            throw new V12UnsupportedEventError();
        }

        throw new Error('unsupported V11 message type');
    }

    // These are observed self echoes, not send or delivery confirmation.
    const sentUserId = isSent ? fromV11AccountId(input.user_id) : null;

    if (isSent && sentUserId === null) {
        throw new Error('invalid V11 message event');
    }

    if (isSent && sentUserId !== eventSelf.user_id) {
        throw new V12UnsupportedEventError();
    }

    // If the optional sender projection has a safely observable, canonical ID,
    // reject an explicit contradiction rather than treating it as this account.
    // Missing or uninspectable sender metadata remains unknown; never call getters.
    if (isSent && detail === 'private') {
        const sender = Object.getOwnPropertyDescriptor(input, 'sender');

        if (
            sender?.enumerable &&
            'value' in sender &&
            !isProxy(sender.value) &&
            isObject(sender.value)
        ) {
            const id = Object.getOwnPropertyDescriptor(sender.value, 'user_id');
            const projected = id?.enumerable && 'value' in id ? fromV11AccountId(id.value) : null;

            if (projected !== null && projected !== eventSelf.user_id) {
                throw new V12UnsupportedEventError();
            }
        }
    }

    // Only a visible own data property is evidence of the private peer. Do not
    // invoke an accessor or accept an inherited or hidden target.
    const target =
        isSent && detail === 'private'
            ? Object.getOwnPropertyDescriptor(input, 'target_id')
            : undefined;
    const targetId =
        target?.enumerable && 'value' in target ? fromV11AccountId(target.value) : null;

    if (isSent && detail === 'private' && targetId === null) {
        throw new V12UnsupportedEventError();
    }

    const messageId = fromV11MessageId(input.message_id);
    const userId = isSent ? sentUserId : fromV11AccountId(input.user_id);
    const groupId = detail === 'group' ? fromV11AccountId(input.group_id) : null;
    const messageTime = input.time;
    const sourceMessage = input.message;

    if (
        messageId === null ||
        userId === null ||
        (detail === 'group' && groupId === null) ||
        !isV12Time(messageTime) ||
        typeof input.raw_message !== 'string' ||
        isProxy(sourceMessage) ||
        !Array.isArray(sourceMessage)
    ) {
        throw new Error('invalid V11 message event');
    }

    // V11 message extras were previously ignored; do not invoke an auto_reply getter.
    const autoReply =
        !isSent && detail === 'private'
            ? Object.getOwnPropertyDescriptor(input, 'auto_reply')
            : undefined;
    // Read array elements by their own data descriptors instead of invoking a
    // caller-controlled iterator or index getter. Non-enumerable array indices
    // remain visible in JSON arrays and are therefore accepted here.
    const sourceSegments: unknown[] = [];

    for (let index = 0; index < sourceMessage.length; index += 1) {
        const item = Object.getOwnPropertyDescriptor(sourceMessage, String(index));

        if (!item || !('value' in item)) {
            throw new Error('invalid V11 message event');
        }

        sourceSegments.push(item.value);
    }

    const message: V12MessageEvent['message'] = [];
    const alt: string[] = [];
    const media: { type: 'image' | 'voice'; index: number; url: string }[] = [];

    for (let index = 0; index < sourceSegments.length; index += 1) {
        const segment = sourceSegments[index];

        if (isProxy(segment) || !isObject(segment)) {
            throw new Error('unsupported or invalid V11 message segment');
        }

        const type = segmentProperty(segment, 'type');

        if (type === 'image' || type === 'record') {
            if (isSent || !options) {
                throw new Error('unsupported or invalid V11 message segment');
            }

            const url = type === 'image' ? ordinaryImageUrl(segment) : ordinaryVoiceUrl(segment);

            if (url === null) {
                throw new Error('unsupported or invalid V11 message segment');
            }

            const mediaType = type === 'image' ? 'image' : 'voice';
            media.push({ type: mediaType, index: message.length, url });

            // These placeholders remain private until all issuance succeeds.
            if (mediaType === 'image') {
                message.push({ type: 'image', data: { file_id: '' } });
                alt.push('[图片]');
            } else {
                message.push({ type: 'voice', data: { file_id: '' } });
                alt.push('[语音]');
            }

            continue;
        }

        if (type !== 'text' && type !== 'at') {
            throw new Error('unsupported or invalid V11 message segment');
        }

        // A getter could mutate a later segment, so only snapshot data properties.
        const data = segmentProperty(segment, 'data');

        if (isProxy(data) || !isObject(data)) {
            throw new Error('unsupported or invalid V11 message segment');
        }

        const hasUnsupportedFields =
            Object.keys(segment).some((key) => key !== 'type' && key !== 'data') ||
            Object.keys(data).some((key) => key !== (type === 'text' ? 'text' : 'qq'));

        if (type === 'text') {
            const text = segmentProperty(data, 'text');

            if (typeof text !== 'string') {
                throw new Error('unsupported or invalid V11 message segment');
            }

            if (hasUnsupportedFields) {
                throw new Error('unsupported V11 message segment field');
            }

            message.push({ type: 'text', data: { text } });
            alt.push(text);
        } else {
            if (hasUnsupportedFields) {
                throw new Error('unsupported V11 message segment field');
            }

            const qq = segmentProperty(data, 'qq');

            if (qq === 'all') {
                message.push({ type: 'mention_all', data: {} });
                alt.push('@全体成员');
                continue;
            }

            const mentionedUser = fromV11AccountId(qq);

            if (mentionedUser === null) {
                throw new Error('unsupported or invalid V11 message segment');
            }

            message.push({ type: 'mention', data: { user_id: mentionedUser } });
            alt.push(`@${mentionedUser}`);
        }
    }

    // Capture and validate all required issuers before allocating an event ID or
    // calling any issuer. An earlier callback cannot replace a later callback.
    const issueImage = media.some((item) => item.type === 'image')
        ? options?.issueImageFileId
        : undefined;
    const issueVoice = media.some((item) => item.type === 'voice')
        ? options?.issueVoiceFileId
        : undefined;
    const issuance = media.map((item) => {
        const issue = item.type === 'image' ? issueImage : issueVoice;

        if (typeof issue !== 'function') {
            throw new Error('unsupported or invalid V11 message segment');
        }

        return { ...item, issue };
    });

    // The optional preflight is read once and runs over captured URLs before
    // any issuer or event ID allocation. Never expose a URL through its errors.
    if (issuance.length > 0) {
        let validate: ((url: string) => boolean) | undefined;

        try {
            validate = options?.validateMediaFileUrl;
        } catch {
            throw new Error('invalid V12 media file URL');
        }

        if (validate !== undefined) {
            if (typeof validate !== 'function') {
                throw new Error('invalid V12 media file URL');
            }

            for (const item of issuance) {
                let valid: boolean;

                try {
                    valid = validate(item.url);
                } catch {
                    throw new Error('invalid V12 media file URL');
                }

                if (valid !== true) {
                    throw new Error('invalid V12 media file URL');
                }
            }
        }
    }

    // Capture the validated event before calling the issuer, which may mutate its
    // caller's input. No partially populated event is exposed if issuance fails.
    const converted: V12MessageEvent = {
        id: randomUUID(),
        time: messageTime,
        type: 'message',
        detail_type: detail,
        sub_type: '',
        self: { ...eventSelf },
        message_id: messageId,
        message,
        // V11 raw_message is CQ-escaped. These mention labels are local plain-text
        // alternatives, not original platform display names or protocol-mandated spellings.
        alt_message: alt.join(''),
        user_id: userId,
        ...(groupId === null ? {} : { group_id: groupId }),
        ...(targetId === null ? {} : { 'qq.target_id': targetId }),
        ...(autoReply?.enumerable && 'value' in autoReply && autoReply.value === true
            ? { 'qq.auto_reply': true as const }
            : {}),
    };

    // All segments and issuers are validated. Issue synchronously in source
    // order; a later failure does not undo earlier issuer side effects.
    for (const item of issuance) {
        const issue = item.issue;
        const fileId = issue(item.url);

        if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 4096) {
            throw new Error(`invalid V12 ${item.type} file id`);
        }

        message[item.index] =
            item.type === 'image'
                ? { type: 'image', data: { file_id: fileId } }
                : { type: 'voice', data: { file_id: fileId } };
    }

    return converted;
}

/** The transport supplies actual version/status and decides when to emit these. */
export function createConnectEvent(
    version: { impl: string; version: string },
    now = Date.now() / 1000,
) {
    if (!version.impl || !version.version || !isV12Time(now)) {
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
    if (!Number.isSafeInteger(interval) || interval <= 0 || !isV12Time(now)) {
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
        !isV12Time(now)
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
