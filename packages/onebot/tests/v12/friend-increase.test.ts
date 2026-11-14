import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertEvent } from '../../src/event-converter';
import { convertV11Event } from '../../src/v12/events';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';
import {
    activateOrderedPollOwner,
    createPollGate,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import { SourceGeneration, type V12Source } from '../../src/v12-runtime/source-generation';

const self = { platform: 'qq', user_id: '10001' };
const context = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: null,
    mediaSegmentSink: null,
};
const friendAdd = {
    time: 1700000000.5,
    self_id: 10001,
    post_type: 'notice',
    notice_type: 'friend_add',
    user_id: 42,
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function createOwner() {
    const binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    const runtime = {};
    registerPollHost(
        runtime,
        {
            self,
            captureBinding: () => binding,
            captureSource: () => generation.capture(binding),
            verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
        },
        createPollGate(),
    );
    const active = activateOrderedPollOwner(runtime);
    if (active.status !== 'ready') {
        throw new Error('owner not ready');
    }
    return { runtime, owner: active.owner, source: generation.capture(binding)! };
}

describe('v11 friend add to v12 friend increase', () => {
    it('maps the real v11 converter output from a synthetic event without changing it', async () => {
        const v11 = await convertEvent(context, {
            kind: 'friend_add',
            time: 1700000000.5,
            selfUin: 99999,
            userUin: 42,
        });
        expect(v11).toEqual(friendAdd);
        const before = structuredClone(v11);
        const result = convertV11Event(v11, self);
        expect(result).toEqual({
            id: expect.any(String),
            time: friendAdd.time,
            type: 'notice',
            detail_type: 'friend_increase',
            sub_type: '',
            self,
            user_id: '42',
        });
        expect(result!.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(convertV11Event(v11, self)!.id).not.toBe(result!.id);
        expect(v11).toEqual(before);
    });

    it('preserves canonical positive safe numbers and large string IDs without rounding', () => {
        for (const user_id of [1, '1', Number.MAX_SAFE_INTEGER, '9007199254740991']) {
            expect(
                convertV11Event({ ...friendAdd, user_id, self_id: '10001', time: 0 }, self),
            ).toMatchObject({ user_id: String(user_id), time: 0 });
        }
    });

    it('rejects invalid IDs, times, account mismatches and additional fields', () => {
        for (const user_id of [
            undefined,
            null,
            0,
            '0',
            -1,
            '-1',
            '01',
            ' 42',
            '42 ',
            '1e3',
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            '9007199254740992',
            false,
            {},
        ]) {
            expect(() => convertV11Event({ ...friendAdd, user_id }, self)).toThrow(
                'invalid or unsupported V11 friend add event',
            );
        }
        for (const time of [undefined, null, -1, NaN, Infinity, -Infinity, '1']) {
            expect(() => convertV11Event({ ...friendAdd, time }, self)).toThrow();
        }
        for (const self_id of [undefined, null, 0, '010001', 10002, '10002', 1e20]) {
            expect(() => convertV11Event({ ...friendAdd, self_id }, self)).toThrow();
        }
        expect(() => convertV11Event(friendAdd, { ...self, user_id: '010001' })).toThrow();
        expect(() => convertV11Event({ ...friendAdd, sub_type: '' }, self)).toThrow();
        expect(() => convertV11Event({ ...friendAdd, extra: true }, self)).toThrow();
        expect(() => convertV11Event({ ...friendAdd, [Symbol('extra')]: 1 }, self)).toThrow();
    });

    it('leaves unrelated notices unsupported and still checks the account', () => {
        for (const notice_type of ['friend_recall', 'notify', 'friend_decrease', 'future']) {
            expect(convertV11Event({ ...friendAdd, notice_type }, self)).toBeNull();
            expect(() =>
                convertV11Event({ ...friendAdd, notice_type, self_id: 10002 }, self),
            ).toThrow();
        }
    });

    it('enqueues the converted event in the ordered in-memory owner', async () => {
        vi.useFakeTimers();
        const enqueue = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const { runtime, owner, source } = createOwner();
        try {
            const event = convertV11Event({ ...friendAdd, user_id: '9007199254740991' }, self);
            const parent = owner.begin(source)!;
            expect(parent.child()!.resolve(event)).toBe(true);
            parent.seal();
            await vi.advanceTimersByTimeAsync(0);
            expect(enqueue).toHaveBeenCalledExactlyOnceWith(event);
            expect(pollOwnerStats(runtime)).toMatchObject({ accepted: 1, ordering_gap: false });
        } finally {
            owner.invalidate();
        }
    });

    it.each([
        'bad user',
        'numeric user',
        'missing user',
        'subtype',
        'group',
        'operator',
        'self',
        'detail',
    ] as const)('rejects %s at the ordered owner and records a gap', async (kind) => {
        vi.useFakeTimers();
        const enqueue = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const { runtime, owner, source } = createOwner();
        const event: Record<string, unknown> = { ...convertV11Event(friendAdd, self)! };
        switch (kind) {
            case 'bad user':
                event.user_id = '9007199254740992';
                break;
            case 'numeric user':
                event.user_id = 42;
                break;
            case 'missing user':
                delete event.user_id;
                break;
            case 'subtype':
                event.sub_type = 'add';
                break;
            case 'group':
                event.group_id = '43';
                break;
            case 'operator':
                event.operator_id = '44';
                break;
            case 'self':
                event.self = { platform: 'qq', user_id: '10002' };
                break;
            case 'detail':
                event.detail_type = 'friend_decrease';
                break;
        }
        const parent = owner.begin(source)!;
        expect(parent.child()!.resolve(event)).toBe(true);
        parent.seal();
        await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 12; i++) {
            await Promise.resolve();
        }
        expect(enqueue).not.toHaveBeenCalled();
        expect(pollOwnerStats(runtime)).toMatchObject({
            accepted: 0,
            invalid: 1,
            ordering_gap: true,
        });
        expect(activateOrderedPollOwner(runtime).status).toBe('degraded');
        owner.invalidate();
    });
});
