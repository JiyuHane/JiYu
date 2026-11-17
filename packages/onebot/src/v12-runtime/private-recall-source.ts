import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { QQEventVariant } from '@snowluma/protocol/events';
import type { OneBotInstanceContext } from '../instance-context';
import type { JsonObject } from '../types';
import type { V12PrivateMessageDeleteEvent, V12Self } from '../v12/types';
import { fromV11AccountId, fromV11MessageId, parseAccountId } from '../v12/validation';
import { sameSourceEpoch, type V12Source } from './source-ticket';

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

// Compile-time brands only: these tokens have no runtime properties, including symbols.
declare const privateRecallPollProofBrand: unique symbol;
export type PrivateRecallPollProof = { readonly [privateRecallPollProofBrand]: never };
declare const privateRecallPollEpochAccountScopeBrand: unique symbol;
export type PrivateRecallPollEpochAccountScope = {
    readonly [privateRecallPollEpochAccountScopeBrand]: never;
};

type PrivateRecallBinding = {
    readonly context: RecallContext;
    readonly event: JsonObject;
};

type PrivateRecallReverseBinding = {
    readonly context: WeakRef<RecallContext>;
    readonly event: WeakRef<JsonObject>;
};

type PrivateRecallPollBinding = PrivateRecallBinding & {
    readonly source: PrivateRecallProvenance;
    readonly sourceTicket: V12Source;
    readonly self: V12Self;
    readonly candidate: object;
    readonly candidateId: string;
};

// Both the instance context and the exact converted event are weak keys. Nothing
// is attached to the public v11 event, its clones, or its serialized payload.
const sources = new WeakMap<object, WeakMap<object, PrivateRecallProvenance>>();
const captures = new WeakMap<PrivateRecallSnapshot, RecallContext>();
// The reverse association is weak; a retained ticket or other object may retain its own graph.
const sourceBindings = new WeakMap<PrivateRecallProvenance, PrivateRecallReverseBinding>();
// This conversion association does not itself retain its source, v11 event, or self.
const convertedBindings = new WeakMap<
    object,
    {
        readonly source: WeakRef<PrivateRecallProvenance>;
        readonly event: WeakRef<JsonObject>;
        readonly self: WeakRef<V12Self>;
    }
>();
const pollProofs = new WeakMap<PrivateRecallPollProof, PrivateRecallPollBinding>();
type PrivateRecallPollEpochAccountBinding = {
    readonly ownerSource: unknown;
    readonly self: Readonly<{ platform: 'qq'; user_id: string }>;
};
const pollEpochAccountScopes = new WeakMap<
    PrivateRecallPollEpochAccountScope,
    PrivateRecallPollEpochAccountBinding
>();

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

    const previous = byEvent.get(event);
    sourceBindings.set(source, { context: new WeakRef(context), event: new WeakRef(event) });

    try {
        byEvent.set(event, source);
    } catch (error) {
        sourceBindings.delete(source);
        throw error;
    }

    if (previous) {
        sourceBindings.delete(previous);
    }

    return true;
}

export function getPrivateRecallSource(
    context: RecallContext,
    event: JsonObject,
): PrivateRecallProvenance | undefined {
    return sources.get(context)?.get(event);
}

function isNonProxyObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null && !isProxy(value);
}

function isPlainNonProxyObject(value: unknown): value is object {
    if (!isNonProxyObject(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasPrivateRecallConversion(
    candidate: unknown,
    event: JsonObject,
    source: PrivateRecallProvenance,
    self: V12Self,
): boolean {
    if (!isNonProxyObject(candidate)) {
        return false;
    }

    const converted = convertedBindings.get(candidate);
    return (
        converted !== undefined &&
        converted.event.deref() === event &&
        converted.source.deref() === source &&
        converted.self.deref() === self
    );
}

function hasExactOwnKeys(target: object, expected: readonly string[]): boolean {
    const keys = Reflect.ownKeys(target);
    return (
        keys.length === expected.length &&
        keys.every((key) => typeof key === 'string' && expected.includes(key))
    );
}

function hasEnumerableDataValue(target: object, key: string, value: unknown): boolean {
    const descriptor = ownDataDescriptor(target, key);
    return (
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        Object.is(descriptor.value, value)
    );
}

/** These checks use only module-created bindings and own data properties. */
function isPrivateRecallBindingCurrent(binding: PrivateRecallPollBinding): boolean {
    const { context, event, source, sourceTicket, self } = binding;

    if (
        !isNonProxyObject(context) ||
        !isNonProxyObject(event) ||
        !isNonProxyObject(source) ||
        !isNonProxyObject(sourceTicket) ||
        !isPlainNonProxyObject(self) ||
        !hasExactOwnKeys(self, ['platform', 'user_id'])
    ) {
        return false;
    }

    const reverse = sourceBindings.get(source);

    if (
        !reverse ||
        reverse.context.deref() !== context ||
        reverse.event.deref() !== event ||
        sources.get(context)?.get(event) !== source
    ) {
        return false;
    }

    const sourceSelf = ownDataDescriptor(source, 'selfUin');
    const sourceTicketField = ownDataDescriptor(source, 'sourceTicket');
    const accountUin = ownDataDescriptor(context, 'uin');
    const accountSelf = ownDataDescriptor(context, 'selfId');
    const selfPlatform = ownDataDescriptor(self, 'platform');
    const selfUser = ownDataDescriptor(self, 'user_id');

    if (
        !sourceSelf ||
        typeof sourceSelf.value !== 'number' ||
        !sourceTicketField ||
        sourceTicketField.value !== sourceTicket ||
        !accountUin ||
        !accountSelf ||
        !selfPlatform ||
        selfPlatform.enumerable !== true ||
        !selfUser ||
        selfUser.enumerable !== true
    ) {
        return false;
    }

    const selfId = fromV11AccountId(sourceSelf.value);
    return (
        selfId !== null &&
        accountUin.value === selfId &&
        fromV11AccountId(accountSelf.value) === selfId &&
        selfPlatform.value === 'qq' &&
        selfUser.value === selfId &&
        matchesPrivateRecallEvent(event, source)
    );
}

/** Return the candidate ID only for the exact supported own-data projection. */
function privateRecallCandidateId(
    candidate: unknown,
    source: PrivateRecallProvenance,
): string | undefined {
    if (
        !isPlainNonProxyObject(candidate) ||
        !hasExactOwnKeys(candidate, [
            'id',
            'time',
            'type',
            'detail_type',
            'sub_type',
            'self',
            'message_id',
            'user_id',
        ])
    ) {
        return undefined;
    }

    const id = ownDataDescriptor(candidate, 'id');
    const self = ownDataDescriptor(candidate, 'self');
    const selfId = fromV11AccountId(source.selfUin);
    const peerId = fromV11AccountId(source.peerUin);
    const messageId = fromV11MessageId(source.messageId);

    if (
        !id ||
        id.enumerable !== true ||
        typeof id.value !== 'string' ||
        id.value.length === 0 ||
        !self ||
        self.enumerable !== true ||
        !isPlainNonProxyObject(self.value) ||
        selfId === null ||
        peerId === null ||
        messageId === null ||
        typeof source.recalledBySelf !== 'boolean' ||
        !hasExactOwnKeys(self.value, ['platform', 'user_id']) ||
        !hasEnumerableDataValue(self.value, 'platform', 'qq') ||
        !hasEnumerableDataValue(self.value, 'user_id', selfId) ||
        !hasEnumerableDataValue(candidate, 'time', source.time) ||
        !hasEnumerableDataValue(candidate, 'type', 'notice') ||
        !hasEnumerableDataValue(candidate, 'detail_type', 'private_message_delete') ||
        !hasEnumerableDataValue(candidate, 'sub_type', '') ||
        !hasEnumerableDataValue(candidate, 'message_id', messageId) ||
        !hasEnumerableDataValue(candidate, 'user_id', source.recalledBySelf ? selfId : peerId)
    ) {
        return undefined;
    }

    return id.value;
}

/**
 * Create an internal local-binding proof; QQ authenticity is outside its scope.
 * It does not verify online state, owner, or source epoch. A future owner must
 * check those separately at the same linearization point. The proof holds exact
 * objects strongly while retained; the owner bounds the number it queues. The
 * reverse source association itself is weak; the ticket or other objects may
 * retain their own graphs. An event or candidate can subsequently grow; this
 * primitive neither manages queues nor bounds RSS/CPU. Multiple proofs or
 * conversions can exist for one event/ticket; the future owner must deduplicate
 * those local admissions. This primitive does not establish global QQ event
 * idempotency.
 */
export function createPrivateRecallPollProof(
    event: JsonObject,
    source: PrivateRecallProvenance,
    sourceTicket: V12Source,
    self: V12Self,
    candidate: unknown,
): PrivateRecallPollProof | undefined {
    try {
        if (
            !isNonProxyObject(event) ||
            !isNonProxyObject(source) ||
            !isNonProxyObject(sourceTicket) ||
            !isPlainNonProxyObject(self) ||
            !isNonProxyObject(candidate)
        ) {
            return undefined;
        }

        const reverse = sourceBindings.get(source);
        const context = reverse?.context.deref();

        if (
            !context ||
            reverse?.event.deref() !== event ||
            !hasPrivateRecallConversion(candidate, event, source, self)
        ) {
            return undefined;
        }

        const candidateId = privateRecallCandidateId(candidate, source);

        if (candidateId === undefined) {
            return undefined;
        }

        const binding: PrivateRecallPollBinding = {
            context,
            event,
            source,
            sourceTicket,
            self,
            candidate,
            candidateId,
        };

        if (!isPrivateRecallBindingCurrent(binding)) {
            return undefined;
        }

        // A null prototype also prevents inherited serialization hooks.
        const proof = Object.freeze(Object.create(null)) as PrivateRecallPollProof;
        pollProofs.set(proof, binding);
        return proof;
    } catch {
        return undefined;
    }
}

/** Check the original v11 binding synchronously without calling host code. */
export function isPrivateRecallPollProofCurrent(proof: unknown): boolean {
    try {
        if (!isNonProxyObject(proof)) {
            return false;
        }

        const binding = pollProofs.get(proof as PrivateRecallPollProof);
        return binding !== undefined && isPrivateRecallBindingCurrent(binding);
    } catch {
        return false;
    }
}

/**
 * Compare the proof's exact ticket and account to an owner's value snapshot.
 * This does not verify online state, manager ownership, or epoch: the owner must
 * separately check sameSourceEpoch(exactTicket, owner.source) at its live
 * linearization point. A different ticket from the same epoch is not exact.
 */
export function isPrivateRecallPollProofBoundTo(
    proof: unknown,
    exactTicket: unknown,
    ownerSelf: unknown,
): boolean {
    try {
        if (!isNonProxyObject(proof)) {
            return false;
        }

        const binding = pollProofs.get(proof as PrivateRecallPollProof);

        if (
            !binding ||
            binding.sourceTicket !== exactTicket ||
            !isPrivateRecallBindingCurrent(binding) ||
            !isPlainNonProxyObject(ownerSelf) ||
            !hasExactOwnKeys(ownerSelf, ['platform', 'user_id'])
        ) {
            return false;
        }

        const selfId = fromV11AccountId(ownDataDescriptor(binding.source, 'selfUin')?.value);
        return (
            selfId !== null &&
            hasEnumerableDataValue(ownerSelf, 'platform', 'qq') &&
            hasEnumerableDataValue(ownerSelf, 'user_id', selfId) &&
            isPrivateRecallBindingCurrent(binding)
        );
    } catch {
        return false;
    }
}

/**
 * Capture an internal epoch/account comparison scope, not an owner authority.
 * The caller must obtain source and self together from the trusted owner lifecycle
 * and separately verify the live source, manager, binding, gate and source scope.
 * A genuine ticket can be supplied with a different account value; this factory
 * does not prove which context or manager issued it. Old tickets can still compare
 * as the same epoch after going offline. This is not a same-process security boundary.
 *
 * The independent frozen self is retained with the original source while the scope
 * remains live. Keep scopes, proofs and tickets out of v12 event JSON and logs;
 * retirement releases this map's references, not references retained elsewhere.
 * These checks assume untampered built-ins and do not bound RSS or CPU.
 */
export function createPrivateRecallPollEpochAccountScope(
    ownerSource: unknown,
    ownerSelf: unknown,
): PrivateRecallPollEpochAccountScope | undefined {
    try {
        if (
            !isNonProxyObject(ownerSource) ||
            sameSourceEpoch(ownerSource, ownerSource) !== 'same' ||
            !isPlainNonProxyObject(ownerSelf) ||
            !hasExactOwnKeys(ownerSelf, ['platform', 'user_id'])
        ) {
            return undefined;
        }

        const platform = ownDataDescriptor(ownerSelf, 'platform');
        const user = ownDataDescriptor(ownerSelf, 'user_id');

        if (
            !platform ||
            platform.enumerable !== true ||
            platform.value !== 'qq' ||
            !user ||
            user.enumerable !== true ||
            typeof user.value !== 'string' ||
            parseAccountId(user.value) === null
        ) {
            return undefined;
        }

        const self = Object.freeze({
            __proto__: null,
            platform: 'qq' as const,
            user_id: user.value,
        });
        const scope = Object.freeze(Object.create(null)) as PrivateRecallPollEpochAccountScope;
        pollEpochAccountScopes.set(scope, Object.freeze({ ownerSource, self }));
        return scope;
    } catch {
        return undefined;
    }
}

/**
 * Check only whether the exact issued scope remains unretired. This does not
 * establish current online, owner or gate state. A false result is not evidence
 * that an individual proof is stale and must not by itself trigger its pruning.
 */
export function isPrivateRecallPollEpochAccountScopeActive(scope: unknown): boolean {
    try {
        return (
            isNonProxyObject(scope) &&
            pollEpochAccountScopes.has(scope as PrivateRecallPollEpochAccountScope)
        );
    } catch {
        return false;
    }
}

/**
 * Check the exact original event ticket against the proof and the separately
 * captured owner epoch/account scope without invoking caller callbacks. A distinct
 * owner ticket from the same epoch is valid; a substituted event ticket is not.
 * Matching account values and epoch still do not establish that the ticket was
 * issued for that account or owner. Distinct scopes with equal inputs can both pass;
 * a future queue must bind the exact owner's scope and do separate live checks.
 */
export function isPrivateRecallPollProofInEpochAccountScope(
    proof: unknown,
    exactEventTicket: unknown,
    scope: unknown,
): boolean {
    try {
        if (!isNonProxyObject(proof) || !isNonProxyObject(scope)) {
            return false;
        }

        const binding = pollEpochAccountScopes.get(scope as PrivateRecallPollEpochAccountScope);

        return (
            binding !== undefined &&
            isPrivateRecallPollProofBoundTo(proof, exactEventTicket, binding.self) &&
            sameSourceEpoch(exactEventTicket, binding.ownerSource) === 'same' &&
            isPrivateRecallPollProofBoundTo(proof, exactEventTicket, binding.self) &&
            pollEpochAccountScopes.get(scope as PrivateRecallPollEpochAccountScope) === binding
        );
    } catch {
        return false;
    }
}

/** Retire only the exact issued scope; repeated or foreign retirements do nothing. */
export function retirePrivateRecallPollEpochAccountScope(scope: unknown): boolean {
    try {
        return (
            isNonProxyObject(scope) &&
            pollEpochAccountScopes.delete(scope as PrivateRecallPollEpochAccountScope)
        );
    } catch {
        return false;
    }
}

/**
 * Recheck the same candidate reference, its original ID, and the full projection.
 * Before enqueueing, the caller must snapshot that same candidate and recheck
 * after callbacks; the queue should retain independent immutable JSON, not read a
 * mutable candidate again at commit. Owner/epoch checks remain separate.
 */
export function isPrivateRecallPollProofFor(proof: unknown, candidate: unknown): boolean {
    try {
        if (!isNonProxyObject(proof)) {
            return false;
        }

        const binding = pollProofs.get(proof as PrivateRecallPollProof);

        if (
            !binding ||
            binding.candidate !== candidate ||
            !hasPrivateRecallConversion(candidate, binding.event, binding.source, binding.self) ||
            !isPrivateRecallBindingCurrent(binding) ||
            privateRecallCandidateId(candidate, binding.source) !== binding.candidateId
        ) {
            return false;
        }

        return isPrivateRecallBindingCurrent(binding);
    } catch {
        return false;
    }
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
    const result = Object.freeze(converted);

    try {
        // This optional brand must never affect the existing conversion or WS path.
        if (
            isNonProxyObject(event) &&
            isNonProxyObject(source) &&
            isPlainNonProxyObject(self) &&
            hasExactOwnKeys(self, ['platform', 'user_id']) &&
            hasEnumerableDataValue(self, 'platform', 'qq') &&
            hasEnumerableDataValue(self, 'user_id', selfId)
        ) {
            const reverse = sourceBindings.get(source);
            const context = reverse?.context.deref();

            if (
                context &&
                reverse?.event.deref() === event &&
                sources.get(context)?.get(event) === source
            ) {
                convertedBindings.set(result, {
                    source: new WeakRef(source),
                    event: new WeakRef(event),
                    self: new WeakRef(self),
                });
            }
        }
    } catch {
        // Proof creation fails closed when optional branding is unavailable.
    }

    return result;
}
