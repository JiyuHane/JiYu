import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { QQEventVariant } from '@snowluma/protocol/events';
import type { OneBotInstanceContext } from '../instance-context';
import type { JsonObject } from '../types';
import type { V12PrivateMessageDeleteEvent, V12Self } from '../v12/types';
import { fromV11AccountId, fromV11MessageId } from '../v12/validation';
import type { V12Source } from './source-generation';

type FriendRecall = Extract<QQEventVariant, { kind: 'friend_recall' }>;
type RecallContext = Pick<OneBotInstanceContext, 'uin' | 'selfId'>;

/** Internal event provenance. The ticket identifies an epoch, not a security boundary. */
export interface PrivateRecallSnapshot {
    readonly selfUin: number;
    readonly peerUin: number;
    readonly msgSeq: number;
    readonly clientSequence: number;
    readonly time: number;
    readonly recalledBySelf: boolean;
    readonly sourceTicket: V12Source;
}

export interface PrivateRecallProvenance extends PrivateRecallSnapshot {
    readonly messageId: number;
}

// Both the instance context and the exact converted event are weak keys. Nothing
// is attached to the public v11 event, its clones, or its serialized payload.
const sources = new WeakMap<object, WeakMap<object, PrivateRecallProvenance>>();
const captures = new WeakMap<PrivateRecallSnapshot, RecallContext>();

function isV12Time(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
    );
}

type DataDescriptor = PropertyDescriptor & { value: unknown };

function ownDataDescriptor(target: object, key: string): DataDescriptor | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor && 'value' in descriptor ? (descriptor as DataDescriptor) : undefined;
}

function sameDataDescriptor(target: object, key: string, before: DataDescriptor): boolean {
    const after = ownDataDescriptor(target, key);
    return (
        after !== undefined &&
        Object.is(after.value, before.value) &&
        after.enumerable === before.enumerable &&
        after.configurable === before.configurable &&
        after.writable === before.writable
    );
}

/** Capture before the store await without evaluating protocol-event accessors. */
export function capturePrivateRecallSource(
    context: RecallContext,
    event: FriendRecall,
    sourceTicket: V12Source | undefined,
): PrivateRecallSnapshot | undefined {
    if (sourceTicket === undefined) {
        return undefined;
    }

    try {
        if (isProxy(event) || isProxy(context)) {
            return undefined;
        }

        const prototype = Object.getPrototypeOf(event);

        if (prototype !== Object.prototype && prototype !== null) {
            return undefined;
        }

        const kind = ownDataDescriptor(event, 'kind');
        const selfField = ownDataDescriptor(event, 'selfUin');
        const peerField = ownDataDescriptor(event, 'userUin');
        const sequenceField = ownDataDescriptor(event, 'msgSeq');
        const timeField = ownDataDescriptor(event, 'time');
        const directionField = ownDataDescriptor(event, 'recalledBySelf');
        const clientField = Object.getOwnPropertyDescriptor(event, 'clientSeq');
        const accountUinField = ownDataDescriptor(context, 'uin');
        const accountSelfField = ownDataDescriptor(context, 'selfId');

        if (
            !kind ||
            !accountUinField ||
            !accountSelfField ||
            !selfField ||
            !peerField ||
            !sequenceField ||
            !timeField ||
            !directionField ||
            (clientField !== undefined && !('value' in clientField)) ||
            (clientField === undefined && 'clientSeq' in event)
        ) {
            return undefined;
        }

        const selfUin = selfField.value;
        const peerUin = peerField.value;
        const msgSeq = sequenceField.value;
        const clientSequence = clientField?.value ?? msgSeq;
        const time = timeField.value;
        const recalledBySelf = directionField.value;
        const accountUin = accountUinField.value;
        const accountSelf = accountSelfField.value;
        const self = fromV11AccountId(selfUin);

        if (
            kind.value !== 'friend_recall' ||
            typeof selfUin !== 'number' ||
            typeof peerUin !== 'number' ||
            typeof recalledBySelf !== 'boolean' ||
            self === null ||
            self !== accountUin ||
            self !== fromV11AccountId(accountSelf) ||
            fromV11AccountId(peerUin) === null ||
            typeof msgSeq !== 'number' ||
            !Number.isSafeInteger(msgSeq) ||
            msgSeq < 0 ||
            typeof clientSequence !== 'number' ||
            !Number.isSafeInteger(clientSequence) ||
            clientSequence <= 0 ||
            !isV12Time(time) ||
            !sameDataDescriptor(context, 'uin', accountUinField) ||
            !sameDataDescriptor(context, 'selfId', accountSelfField) ||
            Object.getPrototypeOf(event) !== prototype ||
            !sameDataDescriptor(event, 'kind', kind) ||
            !sameDataDescriptor(event, 'selfUin', selfField) ||
            !sameDataDescriptor(event, 'userUin', peerField) ||
            !sameDataDescriptor(event, 'msgSeq', sequenceField) ||
            !sameDataDescriptor(event, 'time', timeField) ||
            !sameDataDescriptor(event, 'recalledBySelf', directionField) ||
            (clientField
                ? !sameDataDescriptor(event, 'clientSeq', clientField as DataDescriptor)
                : Object.getOwnPropertyDescriptor(event, 'clientSeq') !== undefined ||
                  'clientSeq' in event)
        ) {
            return undefined;
        }

        const snapshot = Object.freeze({
            selfUin,
            peerUin,
            msgSeq,
            clientSequence,
            time,
            recalledBySelf,
            sourceTicket,
        });
        captures.set(snapshot, context);
        return snapshot;
    } catch {
        return undefined;
    }
}

/** Compare only the exact own data fields emitted by the v11 converter. */
export function matchesPrivateRecallEvent(
    event: JsonObject,
    source: PrivateRecallProvenance,
): boolean {
    try {
        if (isProxy(event) || Array.isArray(event)) {
            return false;
        }

        const prototype = Object.getPrototypeOf(event);

        if (prototype !== Object.prototype && prototype !== null) {
            return false;
        }

        const fields = {
            time: source.time,
            self_id: source.selfUin,
            post_type: 'notice',
            notice_type: 'friend_recall',
            user_id: source.peerUin,
            message_id: source.messageId,
        };
        const keys = Reflect.ownKeys(event);
        const expected = Object.keys(fields);

        if (
            keys.length !== expected.length ||
            keys.some((key) => typeof key !== 'string' || !Object.hasOwn(fields, key))
        ) {
            return false;
        }

        return expected.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(event, key);
            return (
                descriptor !== undefined &&
                descriptor.enumerable === true &&
                'value' in descriptor &&
                Object.is(descriptor.value, fields[key as keyof typeof fields])
            );
        });
    } catch {
        return false;
    }
}

/** Bind only the cache-hit ID actually retained by the final v11 event. */
export function rememberPrivateRecallSource(
    context: RecallContext,
    event: JsonObject,
    snapshot: PrivateRecallSnapshot | undefined,
    messageId: number,
): boolean {
    if (
        snapshot === undefined ||
        isProxy(context) ||
        captures.get(snapshot) !== context ||
        typeof messageId !== 'number' ||
        fromV11MessageId(messageId) === null
    ) {
        return false;
    }

    const accountUin = ownDataDescriptor(context, 'uin');
    const accountSelf = ownDataDescriptor(context, 'selfId');

    if (
        !accountUin ||
        !accountSelf ||
        fromV11AccountId(snapshot.selfUin) !== accountUin.value ||
        fromV11AccountId(accountSelf.value) !== accountUin.value
    ) {
        return false;
    }

    const source = Object.freeze({ ...snapshot, messageId });

    if (
        !matchesPrivateRecallEvent(event, source) ||
        !sameDataDescriptor(context, 'uin', accountUin) ||
        !sameDataDescriptor(context, 'selfId', accountSelf)
    ) {
        return false;
    }

    let byEvent = sources.get(context);

    if (!byEvent) {
        byEvent = new WeakMap();
        sources.set(context, byEvent);
    }

    byEvent.set(event, source);
    return true;
}

export function getPrivateRecallSource(
    context: RecallContext,
    event: JsonObject,
): PrivateRecallProvenance | undefined {
    return sources.get(context)?.get(event);
}

/** Internal-only conversion; callers separately verify the original live ticket. */
export function convertPrivateRecallEvent(
    event: JsonObject,
    self: V12Self,
    source: PrivateRecallProvenance,
): V12PrivateMessageDeleteEvent | null {
    const selfId = fromV11AccountId(source.selfUin);
    const peerId = fromV11AccountId(source.peerUin);
    const messageId = fromV11MessageId(source.messageId);

    if (
        self.platform !== 'qq' ||
        selfId === null ||
        self.user_id !== selfId ||
        peerId === null ||
        messageId === null ||
        typeof source.selfUin !== 'number' ||
        typeof source.peerUin !== 'number' ||
        typeof source.messageId !== 'number' ||
        typeof source.recalledBySelf !== 'boolean' ||
        !Number.isSafeInteger(source.msgSeq) ||
        source.msgSeq < 0 ||
        !Number.isSafeInteger(source.clientSequence) ||
        source.clientSequence <= 0 ||
        !isV12Time(source.time) ||
        !matchesPrivateRecallEvent(event, source)
    ) {
        return null;
    }

    const converted: V12PrivateMessageDeleteEvent = {
        id: randomUUID(),
        time: source.time,
        type: 'notice',
        detail_type: 'private_message_delete',
        sub_type: '',
        self: Object.freeze({ ...self }),
        message_id: messageId,
        user_id: source.recalledBySelf ? selfId : peerId,
    };
    // Subscribers share this new event; protect later deliveries from earlier
    // subscribers without freezing or mutating the runtime's account identity.
    return Object.freeze(converted);
}
