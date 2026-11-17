import type { QQEventVariant } from '@snowluma/protocol/events';
import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import {
    capturePrivateRecallSource,
    convertPrivateRecallEvent,
    getPrivateRecallSource,
    isPrivateRecallPollProofBoundTo,
    isPrivateRecallPollProofCurrent,
    isPrivateRecallPollProofFor,
    createPrivateRecallPollProof,
    rememberPrivateRecallSource,
} from '../../src/v12-runtime/private-recall-source';
import { sameSourceEpoch, SourceGeneration } from '../../src/v12-runtime/source-generation';

// Use a deterministic synthetic ID to compare two otherwise identical converter
// outputs. The converter itself and every provenance operation remain real.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomUUID: () => '11111111-1111-4111-8111-111111111111' };
});

// SourceGeneration only needs this import for its separate ordered-poll APIs.
// Do not load an owner, transport, listener, account service, or native module.
vi.mock('../../src/v12-runtime/poll-owner', () => ({
    isCurrentOrderedFacade: () => false,
}));

type Recall = Extract<QQEventVariant, { kind: 'friend_recall' }>;
const SELF = 10001;
const PEER = 20002;
const TIME = 1_700_000_100;
const V11_FIELDS = [
    'time',
    'self_id',
    'post_type',
    'notice_type',
    'user_id',
    'message_id',
] as const;
const V12_FIELDS = [
    'id',
    'time',
    'type',
    'detail_type',
    'sub_type',
    'self',
    'message_id',
    'user_id',
] as const;

type FixtureOptions = {
    selfUin?: number;
    peerUin?: number;
    messageId?: number;
    recalledBySelf?: boolean;
    time?: number;
    afterCapture?: (event: Recall) => void;
};

function fixture(options: FixtureOptions = {}) {
    const selfUin = options.selfUin ?? SELF;
    const peerUin = options.peerUin ?? PEER;
    const messageId = options.messageId ?? -2147483648;
    const time = options.time ?? TIME;
    const recalledBySelf = options.recalledBySelf ?? false;
    const context = { uin: String(selfUin), selfId: selfUin };
    const self = { platform: 'qq', user_id: String(selfUin) };
    const generation = new SourceGeneration();
    const binding = {};
    generation.setOnline(true);
    const ticket = generation.capture(binding);

    if (!ticket) {
        throw new Error('fixture source generation was not online');
    }

    const raw: Recall = {
        kind: 'friend_recall',
        selfUin,
        userUin: peerUin,
        msgSeq: 445,
        clientSeq: 446,
        time,
        recalledBySelf,
    };
    const event: JsonObject = {
        time,
        self_id: selfUin,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: peerUin,
        message_id: messageId,
    };
    const snapshot = capturePrivateRecallSource(context, raw, ticket);

    if (!snapshot) {
        throw new Error('fixture snapshot missing');
    }

    options.afterCapture?.(raw);

    if (!rememberPrivateRecallSource(context, event, snapshot, messageId)) {
        throw new Error('fixture provenance was not remembered');
    }

    const source = getPrivateRecallSource(context, event);

    if (!source) {
        throw new Error('fixture provenance missing');
    }

    const candidate = convertPrivateRecallEvent(event, self, source);

    if (!candidate) {
        throw new Error('fixture conversion failed');
    }

    return { context, self, generation, binding, ticket, raw, event, snapshot, source, candidate };
}

type Fixture = ReturnType<typeof fixture>;

function make(f: Fixture) {
    return createPrivateRecallPollProof(f.event, f.source, f.ticket, f.self, f.candidate);
}

function proof(f: Fixture) {
    const value = make(f);

    if (!value) {
        throw new Error('fixture poll proof missing');
    }

    return value;
}

function candidateCopy(f: Fixture): Record<string, unknown> {
    return { ...f.candidate, self: { ...f.candidate.self } };
}

function makeWithCandidate(f: Fixture, candidate: unknown) {
    return createPrivateRecallPollProof(f.event, f.source, f.ticket, f.self, candidate as never);
}

describe('private recall poll proof (synthetic in-process data only)', () => {
    it.each([
        { recalledBySelf: false, messageId: -2147483648, userId: String(PEER) },
        { recalledBySelf: true, messageId: -2147483648, userId: String(SELF) },
        { recalledBySelf: false, messageId: -1, userId: String(PEER) },
        { recalledBySelf: true, messageId: 2147483647, userId: String(SELF) },
    ])('binds the real conversion for direction=$recalledBySelf and id=$messageId', (test) => {
        const f = fixture(test);
        const token = proof(f);
        expect(f.source.sourceTicket).toBe(f.ticket);
        expect(f.source.recalledBySelf).toBe(test.recalledBySelf);
        expect(f.candidate).toEqual({
            id: expect.any(String),
            time: TIME,
            type: 'notice',
            detail_type: 'private_message_delete',
            sub_type: '',
            self: { platform: 'qq', user_id: String(SELF) },
            message_id: String(test.messageId),
            user_id: test.userId,
        });
        expect(Object.isFrozen(f.candidate)).toBe(true);
        expect(Object.isFrozen(f.candidate.self)).toBe(true);
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
        const ownerSelf = { ...f.self };
        expect(ownerSelf).not.toBe(f.self);
        expect(isPrivateRecallPollProofBoundTo(token, f.ticket, ownerSelf)).toBe(true);
        expect(f.event).toEqual({
            time: TIME,
            self_id: SELF,
            post_type: 'notice',
            notice_type: 'friend_recall',
            user_id: PEER,
            message_id: test.messageId,
        });
    });

    it('keeps the captured primitives when the original QQ event changes later', () => {
        const getter = vi.fn(() => {
            throw new Error('post-capture QQ accessor must not run');
        });
        const f = fixture({
            messageId: -42,
            afterCapture(raw) {
                raw.kind = 'friend_recall';
                raw.selfUin = 70001;
                raw.userUin = 70002;
                raw.msgSeq = 987;
                raw.time = TIME + 100;
                raw.recalledBySelf = true;
                Object.defineProperty(raw, 'clientSeq', { configurable: true, get: getter });
            },
        });
        expect(Object.isFrozen(f.snapshot)).toBe(true);
        expect(f.snapshot).toMatchObject({
            selfUin: SELF,
            peerUin: PEER,
            msgSeq: 445,
            clientSequence: 446,
            time: TIME,
            recalledBySelf: false,
        });
        expect(f.source).toMatchObject({
            selfUin: SELF,
            peerUin: PEER,
            msgSeq: 445,
            clientSequence: 446,
            time: TIME,
            recalledBySelf: false,
            messageId: -42,
        });
        expect(f.candidate).toMatchObject({ time: TIME, user_id: String(PEER), message_id: '-42' });
        const token = proof(f);
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
        expect(getter).not.toHaveBeenCalled();
        // The original v11 event remains an ordinary, unfrozen event with the same fields.
        expect(Object.isFrozen(f.event)).toBe(false);
        expect(Reflect.ownKeys(f.event)).toEqual([...V11_FIELDS]);
    });

    it('requires captured and remembered provenance, rather than matching forged values', () => {
        const f = fixture();
        const unremembered: JsonObject = { ...f.event };
        const missing = capturePrivateRecallSource(f.context, f.raw, undefined);
        expect(missing).toBeUndefined();
        expect(rememberPrivateRecallSource(f.context, unremembered, missing, -2147483648)).toBe(
            false,
        );
        expect(getPrivateRecallSource(f.context, unremembered)).toBeUndefined();
        const fakeSnapshot = Object.freeze({ ...f.snapshot });
        expect(
            rememberPrivateRecallSource(f.context, unremembered, fakeSnapshot, -2147483648),
        ).toBe(false);
        const fakeSource = Object.freeze({ ...f.source });
        expect(
            createPrivateRecallPollProof(f.event, fakeSource, f.ticket, f.self, f.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(
                f.event,
                undefined as never,
                f.ticket,
                f.self,
                f.candidate,
            ),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(unremembered, f.source, f.ticket, f.self, f.candidate),
        ).toBeUndefined();
    });

    it('keeps context, v11 event identity, exact ticket, and account bound together', () => {
        const a = fixture();
        const b = fixture();
        const sameEpochButNewTicket = a.generation.capture(a.binding);

        if (!sameEpochButNewTicket) {
            throw new Error('fixture ticket missing');
        }

        expect(sameEpochButNewTicket).not.toBe(a.ticket);
        expect(sameSourceEpoch(sameEpochButNewTicket, a.ticket)).toBe('same');
        expect(getPrivateRecallSource(b.context, a.event)).toBeUndefined();
        expect(rememberPrivateRecallSource(b.context, a.event, a.snapshot, -2147483648)).toBe(
            false,
        );
        expect(
            createPrivateRecallPollProof(a.event, b.source, b.ticket, a.self, a.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(b.event, a.source, a.ticket, b.self, b.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(a.event, a.source, b.ticket, a.self, a.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(
                a.event,
                a.source,
                sameEpochButNewTicket,
                a.self,
                a.candidate,
            ),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(a.event, a.source, {} as never, a.self, a.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(
                a.event,
                a.source,
                undefined as never,
                a.self,
                a.candidate,
            ),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(
                a.event,
                a.source,
                a.ticket,
                { platform: 'qq', user_id: '10002' },
                a.candidate,
            ),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(
                a.event,
                a.source,
                a.ticket,
                { platform: 'other', user_id: String(SELF) },
                a.candidate,
            ),
        ).toBeUndefined();
        expect(isPrivateRecallPollProofCurrent(proof(a))).toBe(true);
        expect(isPrivateRecallPollProofCurrent(proof(b))).toBe(true);
    });

    it('binds an owner value copy and the exact ticket, without treating an epoch as ticket identity', () => {
        const f = fixture();
        const token = proof(f);
        const ownerSelf = { ...f.self };
        const sameEpochTicket = f.generation.capture(f.binding);

        if (!sameEpochTicket) {
            throw new Error('same-epoch fixture ticket missing');
        }

        const other = fixture();
        expect(ownerSelf).not.toBe(f.self);
        expect(sameEpochTicket).not.toBe(f.ticket);
        expect(sameSourceEpoch(sameEpochTicket, f.ticket)).toBe('same');
        expect(isPrivateRecallPollProofBoundTo(token, f.ticket, ownerSelf)).toBe(true);
        expect(isPrivateRecallPollProofBoundTo(token, sameEpochTicket, ownerSelf)).toBe(false);
        expect(isPrivateRecallPollProofBoundTo(token, other.ticket, ownerSelf)).toBe(false);
        expect(isPrivateRecallPollProofBoundTo(token, {} as never, ownerSelf)).toBe(false);
        expect(isPrivateRecallPollProofBoundTo(token, undefined as never, ownerSelf)).toBe(false);
        expect(
            isPrivateRecallPollProofBoundTo(token, f.ticket, { platform: 'qq', user_id: '10002' }),
        ).toBe(false);
        expect(
            isPrivateRecallPollProofBoundTo(token, f.ticket, {
                platform: 'other',
                user_id: String(SELF),
            }),
        ).toBe(false);
        f.event.user_id = PEER + 1;
        expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
        expect(isPrivateRecallPollProofBoundTo(token, f.ticket, ownerSelf)).toBe(false);
    });

    it.each([
        'array',
        'class',
        'extra',
        'hidden',
        'symbol',
        'platform-hidden',
        'user-hidden',
        'platform-accessor',
        'user-accessor',
        'proxy',
        'revoked-proxy',
    ] as const)('rejects self with %s while leaving the valid proof untouched', (shape) => {
        const f = fixture();
        const token = proof(f);
        const getter = vi.fn(() => {
            throw new Error('self getter must not run');
        });
        const trap = vi.fn(() => {
            throw new Error('self proxy trap must not run');
        });
        let invalid: unknown = { ...f.self };

        if (shape === 'array') {
            invalid = Object.assign([], f.self);
        } else if (shape === 'class') {
            class SyntheticSelf {
                platform = 'qq';
                user_id = String(SELF);
            }
            invalid = new SyntheticSelf();
        } else if (shape === 'extra') {
            Object.assign(invalid as object, { extra: true });
        } else if (shape === 'hidden') {
            Object.defineProperty(invalid as object, 'hidden', { get: getter });
        } else if (shape === 'symbol') {
            Object.defineProperty(invalid as object, Symbol('hidden'), { get: getter });
        } else if (shape === 'platform-hidden' || shape === 'user-hidden') {
            const field = shape === 'platform-hidden' ? 'platform' : 'user_id';
            Object.defineProperty(invalid as object, field, { enumerable: false });
        } else if (shape === 'platform-accessor' || shape === 'user-accessor') {
            const field = shape === 'platform-accessor' ? 'platform' : 'user_id';
            Object.defineProperty(invalid as object, field, {
                configurable: true,
                enumerable: true,
                get: getter,
            });
        } else if (shape === 'proxy') {
            invalid = new Proxy(f.self, {
                get: trap,
                getPrototypeOf: trap,
                ownKeys: trap,
                getOwnPropertyDescriptor: trap,
            });
        } else {
            const revoked = Proxy.revocable(f.self, {});
            revoked.revoke();
            invalid = revoked.proxy;
        }

        expect(
            createPrivateRecallPollProof(
                f.event,
                f.source,
                f.ticket,
                invalid as never,
                f.candidate,
            ),
        ).toBeUndefined();
        expect(isPrivateRecallPollProofBoundTo(token, f.ticket, invalid as never)).toBe(false);
        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
    });

    it.each(['extra', 'symbol', 'non-enumerable', 'accessor'] as const)(
        'invalidates an issued proof when its self gains %s',
        (change) => {
            const f = fixture();
            const token = proof(f);
            const getter = vi.fn(() => {
                throw new Error('mutated self getter must not run');
            });

            if (change === 'extra') {
                Object.assign(f.self, { extra: true });
            } else if (change === 'symbol') {
                Object.defineProperty(f.self, Symbol('hidden'), { get: getter });
            } else if (change === 'non-enumerable') {
                Object.defineProperty(f.self, 'user_id', { enumerable: false });
            } else {
                Object.defineProperty(f.self, 'user_id', {
                    configurable: true,
                    enumerable: true,
                    get: getter,
                });
            }

            expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
            expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(false);
            expect(make(f)).toBeUndefined();
            expect(getter).not.toHaveBeenCalled();
        },
    );

    it('invalidates old proofs when remembered provenance is replaced on the same event', () => {
        const f = fixture();
        const oldProof = proof(f);
        const nextRaw: Recall = { ...f.raw, recalledBySelf: true };
        const nextSnapshot = capturePrivateRecallSource(f.context, nextRaw, f.ticket);
        expect(nextSnapshot).toBeDefined();
        expect(rememberPrivateRecallSource(f.context, f.event, nextSnapshot, -2147483648)).toBe(
            true,
        );
        const nextSource = getPrivateRecallSource(f.context, f.event);

        if (!nextSource) {
            throw new Error('replacement fixture provenance missing');
        }

        expect(nextSource).not.toBe(f.source);
        expect(isPrivateRecallPollProofCurrent(oldProof)).toBe(false);
        expect(isPrivateRecallPollProofFor(oldProof, f.candidate)).toBe(false);
        expect(make(f)).toBeUndefined();
        const nextCandidate = convertPrivateRecallEvent(f.event, f.self, nextSource);

        if (!nextCandidate) {
            throw new Error('replacement fixture conversion failed');
        }

        expect(nextCandidate.user_id).toBe(String(SELF));
        const nextProof = createPrivateRecallPollProof(
            f.event,
            nextSource,
            f.ticket,
            f.self,
            nextCandidate,
        );
        expect(nextProof).toBeDefined();
        expect(isPrivateRecallPollProofCurrent(nextProof!)).toBe(true);
        expect(isPrivateRecallPollProofFor(nextProof!, nextCandidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(nextProof!, f.candidate)).toBe(false);
    });

    it.each(V11_FIELDS)('rejects a changed v11 %s before and after proof issuance', (field) => {
        const f = fixture();
        const token = proof(f);
        const replacements: Record<(typeof V11_FIELDS)[number], string | number> = {
            time: TIME + 1,
            self_id: SELF + 1,
            post_type: 'message',
            notice_type: 'group_recall',
            user_id: PEER + 1,
            message_id: -2,
        };
        f.event[field] = replacements[field];
        expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(false);
        expect(make(f)).toBeUndefined();
    });

    it.each(V11_FIELDS)('rejects a missing v11 %s before and after proof issuance', (field) => {
        const f = fixture();
        const token = proof(f);
        delete f.event[field];
        expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(false);
        expect(make(f)).toBeUndefined();
    });

    it.each(V11_FIELDS)('rejects a v11 %s accessor without invoking it', (field) => {
        const f = fixture();
        const token = proof(f);
        const getter = vi.fn(() => {
            throw new Error('v11 getter must not run');
        });
        Object.defineProperty(f.event, field, {
            configurable: true,
            enumerable: true,
            get: getter,
        });
        expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(false);
        expect(make(f)).toBeUndefined();
        expect(getter).not.toHaveBeenCalled();
    });

    it.each(['extra', 'hidden', 'symbol', 'prototype', 'non-enumerable'] as const)(
        'rejects a v11 %s shape change without reading a hidden getter',
        (change) => {
            const f = fixture();
            const token = proof(f);
            const getter = vi.fn(() => {
                throw new Error('extra getter must not run');
            });

            if (change === 'extra') {
                f.event.extra = true;
            } else if (change === 'hidden') {
                Object.defineProperty(f.event, 'hidden', { configurable: true, get: getter });
            } else if (change === 'symbol') {
                Object.defineProperty(f.event, Symbol('hidden'), {
                    configurable: true,
                    get: getter,
                });
            } else if (change === 'prototype') {
                Object.setPrototypeOf(f.event, {
                    get inherited() {
                        return getter();
                    },
                });
            } else {
                Object.defineProperty(f.event, 'message_id', { enumerable: false });
            }

            expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
            expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(false);
            expect(make(f)).toBeUndefined();
            expect(getter).not.toHaveBeenCalled();
        },
    );

    it('rejects proxy and revoked v11 inputs without triggering traps or changing the real proof', () => {
        const f = fixture();
        const token = proof(f);
        const trap = vi.fn(() => {
            throw new Error('v11 proxy trap must not run');
        });
        const proxied = new Proxy(f.event, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
        });
        const revoked = Proxy.revocable(f.event, {});
        revoked.revoke();
        expect(
            createPrivateRecallPollProof(proxied, f.source, f.ticket, f.self, f.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(revoked.proxy, f.source, f.ticket, f.self, f.candidate),
        ).toBeUndefined();
        expect(trap).not.toHaveBeenCalled();
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
    });

    it.each(['uin', 'selfId'] as const)('invalidates a proof when context %s changes', (field) => {
        const f = fixture();
        const token = proof(f);
        Object.defineProperty(f.context, field, { value: field === 'uin' ? '10002' : 10002 });
        expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(false);
        expect(make(f)).toBeUndefined();
    });

    it.each(['uin', 'selfId'] as const)(
        'rejects missing or accessor context %s without invoking the getter',
        (field) => {
            const missing = fixture();
            const missingProof = proof(missing);
            Reflect.deleteProperty(missing.context, field);
            expect(isPrivateRecallPollProofCurrent(missingProof)).toBe(false);
            expect(make(missing)).toBeUndefined();
            const f = fixture();
            const token = proof(f);
            const getter = vi.fn(() => {
                throw new Error('context getter must not run');
            });
            Object.defineProperty(f.context, field, { configurable: true, get: getter });
            expect(isPrivateRecallPollProofCurrent(token)).toBe(false);
            expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(false);
            expect(make(f)).toBeUndefined();
            expect(getter).not.toHaveBeenCalled();
        },
    );

    it('binds a proof to the exact real DTO, including its generated event id', () => {
        const f = fixture();
        const token = proof(f);
        const identicalClone = candidateCopy(f);
        expect(identicalClone).toEqual(f.candidate);
        expect(makeWithCandidate(f, identicalClone)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(token, identicalClone)).toBe(false);
        const frozenClone = Object.freeze({
            ...f.candidate,
            self: Object.freeze({ ...f.candidate.self }),
        });
        expect(frozenClone).toEqual(f.candidate);
        expect(makeWithCandidate(f, frozenClone)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(token, frozenClone)).toBe(false);
        const otherConversion = convertPrivateRecallEvent(f.event, f.self, f.source);

        if (!otherConversion) {
            throw new Error('second fixture conversion failed');
        }

        expect(otherConversion).not.toBe(f.candidate);
        expect(isPrivateRecallPollProofFor(token, otherConversion)).toBe(false);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
    });

    it.each(V12_FIELDS)('rejects a missing v12 %s at issuance and matching', (field) => {
        const f = fixture();
        const token = proof(f);
        const candidate = candidateCopy(f);
        expect(makeWithCandidate(f, candidate)).toBeUndefined();
        delete candidate[field];
        expect(makeWithCandidate(f, candidate)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(token, candidate)).toBe(false);
    });

    it.each(V12_FIELDS)('rejects a v12 %s accessor without invoking it', (field) => {
        const f = fixture();
        const token = proof(f);
        const candidate = candidateCopy(f);
        expect(makeWithCandidate(f, candidate)).toBeUndefined();
        const getter = vi.fn(() => {
            throw new Error('v12 getter must not run');
        });
        Object.defineProperty(candidate, field, {
            configurable: true,
            enumerable: true,
            get: getter,
        });
        expect(makeWithCandidate(f, candidate)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(token, candidate)).toBe(false);
        expect(getter).not.toHaveBeenCalled();
    });

    it.each([
        ['time', TIME + 1],
        ['type', 'message'],
        ['detail_type', 'group_message_delete'],
        ['sub_type', 'recall'],
        ['self', { platform: 'qq', user_id: '10002' }],
        ['message_id', '-2147483647'],
        ['user_id', '20003'],
    ] as const)('rejects a changed v12 %s at issuance and matching', (field, value) => {
        const f = fixture();
        const token = proof(f);
        const candidate = candidateCopy(f);
        expect(makeWithCandidate(f, candidate)).toBeUndefined();
        candidate[field] = value;
        expect(makeWithCandidate(f, candidate)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(token, candidate)).toBe(false);
    });

    it('keeps the branded converter DTO and its nested self immutable', () => {
        const f = fixture();
        const token = proof(f);
        const getter = vi.fn(() => {
            throw new Error('replacement getter must not run');
        });

        for (const field of V12_FIELDS) {
            expect(Reflect.set(f.candidate, field, 'changed')).toBe(false);
            expect(Reflect.deleteProperty(f.candidate, field)).toBe(false);
            expect(Reflect.defineProperty(f.candidate, field, { get: getter })).toBe(false);
        }

        expect(Reflect.set(f.candidate.self, 'user_id', '10002')).toBe(false);
        expect(Reflect.defineProperty(f.candidate, 'extra', { value: true })).toBe(false);
        expect(getter).not.toHaveBeenCalled();
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
        const changedId = candidateCopy(f);
        changedId.id = 'another-synthetic-event-id';
        expect(makeWithCandidate(f, changedId)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(token, changedId)).toBe(false);
    });

    it.each(['extra', 'hidden', 'symbol', 'prototype', 'self-extra', 'self-accessor'] as const)(
        'rejects v12 %s shape changes without executing accessors',
        (change) => {
            const f = fixture();
            const token = proof(f);
            const candidate = candidateCopy(f);
            expect(makeWithCandidate(f, candidate)).toBeUndefined();
            const getter = vi.fn(() => {
                throw new Error('v12 extra getter must not run');
            });
            const candidateSelf = candidate.self as Record<string, unknown>;

            if (change === 'extra') {
                candidate.extra = true;
            } else if (change === 'hidden') {
                Object.defineProperty(candidate, 'hidden', { get: getter });
            } else if (change === 'symbol') {
                Object.defineProperty(candidate, Symbol('hidden'), { get: getter });
            } else if (change === 'prototype') {
                Object.setPrototypeOf(candidate, {
                    get inherited() {
                        return getter();
                    },
                });
            } else if (change === 'self-extra') {
                candidateSelf.extra = true;
            } else {
                Object.defineProperty(candidateSelf, 'user_id', {
                    configurable: true,
                    enumerable: true,
                    get: getter,
                });
            }

            expect(makeWithCandidate(f, candidate)).toBeUndefined();
            expect(isPrivateRecallPollProofFor(token, candidate)).toBe(false);
            expect(getter).not.toHaveBeenCalled();
        },
    );

    it('rejects proxy and revoked v12 candidates without running traps', () => {
        const f = fixture();
        const token = proof(f);
        const trap = vi.fn(() => {
            throw new Error('v12 proxy trap must not run');
        });
        const proxied = new Proxy(f.candidate, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
        });
        const revoked = Proxy.revocable(f.candidate, {});
        revoked.revoke();
        expect(makeWithCandidate(f, proxied)).toBeUndefined();
        expect(makeWithCandidate(f, revoked.proxy)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(token, proxied)).toBe(false);
        expect(isPrivateRecallPollProofFor(token, revoked.proxy)).toBe(false);
        expect(trap).not.toHaveBeenCalled();
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
    });

    it('binds identical converter DTO twins to their own event, source, and context in both directions', () => {
        const a = fixture();
        const secondEvent: JsonObject = { ...a.event };
        const secondSnapshot = capturePrivateRecallSource(a.context, { ...a.raw }, a.ticket);
        expect(secondSnapshot).toBeDefined();
        expect(
            rememberPrivateRecallSource(a.context, secondEvent, secondSnapshot, -2147483648),
        ).toBe(true);
        const secondSource = getPrivateRecallSource(a.context, secondEvent);

        if (!secondSource) {
            throw new Error('same-context twin source missing');
        }

        const secondCandidate = convertPrivateRecallEvent(secondEvent, a.self, secondSource);

        if (!secondCandidate) {
            throw new Error('same-context twin conversion failed');
        }

        const other = fixture();
        expect(secondEvent).not.toBe(a.event);
        expect(secondEvent).toEqual(a.event);
        expect(secondSource).not.toBe(a.source);
        expect(other.context).not.toBe(a.context);
        expect(other.event).toEqual(a.event);
        expect(secondCandidate).not.toBe(a.candidate);
        expect(secondCandidate).toEqual(a.candidate);
        expect(other.candidate).not.toBe(a.candidate);
        expect(other.candidate).toEqual(a.candidate);

        const firstProof = proof(a);
        const secondProof = createPrivateRecallPollProof(
            secondEvent,
            secondSource,
            a.ticket,
            a.self,
            secondCandidate,
        );
        const otherProof = proof(other);
        expect(secondProof).toBeDefined();
        expect(isPrivateRecallPollProofFor(firstProof, a.candidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(secondProof, secondCandidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(otherProof, other.candidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(firstProof, secondCandidate)).toBe(false);
        expect(isPrivateRecallPollProofFor(secondProof, a.candidate)).toBe(false);
        expect(isPrivateRecallPollProofFor(firstProof, other.candidate)).toBe(false);
        expect(isPrivateRecallPollProofFor(otherProof, a.candidate)).toBe(false);

        expect(
            createPrivateRecallPollProof(secondEvent, secondSource, a.ticket, a.self, a.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(a.event, a.source, a.ticket, a.self, secondCandidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(
                other.event,
                other.source,
                other.ticket,
                other.self,
                a.candidate,
            ),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(a.event, a.source, a.ticket, a.self, other.candidate),
        ).toBeUndefined();
    });

    it('binds each converter DTO to its exact self object, even when self values match', () => {
        const f = fixture();
        const otherSelf = { ...f.self };
        expect(otherSelf).not.toBe(f.self);
        expect(otherSelf).toEqual(f.self);
        const otherCandidate = convertPrivateRecallEvent(f.event, otherSelf, f.source);

        if (!otherCandidate) {
            throw new Error('same-value self fixture conversion failed');
        }

        expect(otherCandidate).toEqual(f.candidate);
        expect(
            createPrivateRecallPollProof(f.event, f.source, f.ticket, otherSelf, f.candidate),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(f.event, f.source, f.ticket, f.self, otherCandidate),
        ).toBeUndefined();
        const first = proof(f);
        const second = createPrivateRecallPollProof(
            f.event,
            f.source,
            f.ticket,
            otherSelf,
            otherCandidate,
        );
        expect(second).toBeDefined();
        expect(isPrivateRecallPollProofFor(first, f.candidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(second, otherCandidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(first, otherCandidate)).toBe(false);
        expect(isPrivateRecallPollProofFor(second, f.candidate)).toBe(false);
        // Unlike factory self provenance, the owner receives an exact value copy.
        expect(isPrivateRecallPollProofBoundTo(first, f.ticket, otherSelf)).toBe(true);
        expect(isPrivateRecallPollProofBoundTo(second, f.ticket, f.self)).toBe(true);
    });

    it.each(['hidden', 'class'] as const)(
        'preserves a converter DTO for %s self but grants it no poll proof',
        (shape) => {
            const f = fixture();
            const getter = vi.fn(() => {
                throw new Error('hidden self getter must not run');
            });
            let otherSelf = { ...f.self };

            if (shape === 'hidden') {
                Object.defineProperty(otherSelf, 'hidden', { get: getter });
            } else {
                class SyntheticSelf {
                    platform = 'qq';
                    user_id = String(SELF);
                }
                otherSelf = new SyntheticSelf();
            }

            const candidate = convertPrivateRecallEvent(f.event, otherSelf, f.source);

            if (!candidate) {
                throw new Error('legacy conversion using unusual self failed');
            }

            expect(candidate).toEqual(f.candidate);
            expect(Object.isFrozen(candidate)).toBe(true);
            expect(Object.isFrozen(candidate.self)).toBe(true);
            expect(
                createPrivateRecallPollProof(f.event, f.source, f.ticket, otherSelf, candidate),
            ).toBeUndefined();
            expect(
                createPrivateRecallPollProof(f.event, f.source, f.ticket, f.self, candidate),
            ).toBeUndefined();
            expect(isPrivateRecallPollProofFor(proof(f), candidate)).toBe(false);
            expect(getter).not.toHaveBeenCalled();
        },
    );

    it('preserves conversion for an unbranded source while withholding a poll proof', () => {
        const f = fixture();
        const unbrandedSource = Object.freeze({ ...f.source });
        const v11Clone: JsonObject = { ...f.event };
        const converted = convertPrivateRecallEvent(v11Clone, f.self, unbrandedSource);

        if (!converted) {
            throw new Error('legacy conversion using unbranded fixture source failed');
        }

        expect(converted).toEqual(f.candidate);
        expect(Reflect.ownKeys(converted)).toEqual([...V12_FIELDS]);
        expect(Object.isFrozen(converted)).toBe(true);
        expect(Object.isFrozen(converted.self)).toBe(true);
        expect(v11Clone).toEqual(f.event);
        expect(Object.isFrozen(v11Clone)).toBe(false);
        expect(
            createPrivateRecallPollProof(v11Clone, unbrandedSource, f.ticket, f.self, converted),
        ).toBeUndefined();
        expect(
            createPrivateRecallPollProof(f.event, f.source, f.ticket, f.self, converted),
        ).toBeUndefined();
        const token = proof(f);
        expect(isPrivateRecallPollProofFor(token, converted)).toBe(false);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
    });

    it('rejects another event or account DTO even while both independent proofs are current', () => {
        const a = fixture({ messageId: -41 });
        const b = fixture({ messageId: -42, peerUin: 20003 });
        const c = fixture({ selfUin: 10002, peerUin: 20003, messageId: -41 });
        const pa = proof(a);
        const pb = proof(b);
        const pc = proof(c);
        expect(isPrivateRecallPollProofFor(pa, b.candidate)).toBe(false);
        expect(isPrivateRecallPollProofFor(pa, c.candidate)).toBe(false);
        expect(makeWithCandidate(a, b.candidate)).toBeUndefined();
        expect(makeWithCandidate(a, c.candidate)).toBeUndefined();
        expect(isPrivateRecallPollProofFor(pa, a.candidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(pb, b.candidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(pc, c.candidate)).toBe(true);
        a.event.message_id = -99;
        expect(isPrivateRecallPollProofCurrent(pa)).toBe(false);
        expect(isPrivateRecallPollProofCurrent(pb)).toBe(true);
        expect(isPrivateRecallPollProofCurrent(pc)).toBe(true);
        expect(isPrivateRecallPollProofFor(pb, b.candidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(pc, c.candidate)).toBe(true);
    });

    it('permits multiple proofs for one candidate without claiming single-consumption semantics', () => {
        const f = fixture();
        const first = proof(f);
        const second = proof(f);
        expect(isPrivateRecallPollProofCurrent(first)).toBe(true);
        expect(isPrivateRecallPollProofCurrent(second)).toBe(true);
        expect(isPrivateRecallPollProofFor(first, f.candidate)).toBe(true);
        expect(isPrivateRecallPollProofFor(second, f.candidate)).toBe(true);
        f.event.message_id = -99;
        expect(isPrivateRecallPollProofCurrent(first)).toBe(false);
        expect(isPrivateRecallPollProofCurrent(second)).toBe(false);
        expect(isPrivateRecallPollProofFor(first, f.candidate)).toBe(false);
        expect(isPrivateRecallPollProofFor(second, f.candidate)).toBe(false);
    });

    it('exposes no proof metadata through own properties, symbols, or JSON', () => {
        const f = fixture();
        const token = proof(f);
        expect(Object.isFrozen(token)).toBe(true);
        expect(Object.keys(token)).toEqual([]);
        expect(Object.getOwnPropertyNames(token)).toEqual([]);
        expect(Object.getOwnPropertySymbols(token)).toEqual([]);
        expect(Reflect.ownKeys(token)).toEqual([]);
        expect(JSON.stringify(token)).toBe('{}');
        expect(JSON.stringify({ proof: token })).toBe('{"proof":{}}');
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
    });

    it('rejects copied, fabricated, proxied, and revoked proofs without invoking traps', () => {
        const f = fixture();
        const token = proof(f);
        const trap = vi.fn(() => {
            throw new Error('proof proxy trap must not run');
        });
        const proxied = new Proxy(token, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
        });
        const revoked = Proxy.revocable(token, {});
        revoked.revoke();

        for (const fake of [{}, { ...token }, proxied, revoked.proxy, null, undefined]) {
            expect(isPrivateRecallPollProofCurrent(fake as never)).toBe(false);
            expect(isPrivateRecallPollProofFor(fake as never, f.candidate)).toBe(false);
            expect(isPrivateRecallPollProofBoundTo(fake as never, f.ticket, f.self)).toBe(false);
        }

        expect(trap).not.toHaveBeenCalled();
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
    });

    it('does not claim the captured ticket is online or establishes a real QQ origin', () => {
        const f = fixture();
        const token = proof(f);
        expect(f.generation.isCurrent(f.ticket, f.binding)).toBe(true);
        f.generation.setOnline(false);
        expect(f.generation.isCurrent(f.ticket, f.binding)).toBe(false);
        // These proofs only bind local in-memory evidence and the DTO. The owner
        // must separately verify its epoch; synthetic evidence proves no QQ origin.
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
        expect(isPrivateRecallPollProofBoundTo(token, f.ticket, { ...f.self })).toBe(true);
        f.generation.setOnline(true);
        expect(f.generation.isCurrent(f.ticket, f.binding)).toBe(false);
        expect(isPrivateRecallPollProofCurrent(token)).toBe(true);
        expect(isPrivateRecallPollProofFor(token, f.candidate)).toBe(true);
        expect(isPrivateRecallPollProofBoundTo(token, f.ticket, { ...f.self })).toBe(true);
    });
});
