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
const increase = {
    time: 1700000000.5,
    self_id: 10001,
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: 'approve',
    group_id: 43,
    user_id: 42,
    operator_id: 44,
    invitor_id: 0,
    invitor_status: 'unknown',
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('v11 group increase to v12 member increase', () => {
    it.each(['approve', 'invite'] as const)(
        'maps converter %s output without claiming a confirmed admission mode',
        async (joinType) => {
            // Synthetic protocol input; no QQ delivery or origin is observed here.
            const v11 = await convertEvent(context, {
                kind: 'group_member_join',
                time: 1700000000.5,
                selfUin: 10001,
                groupId: 43,
                userUin: 42,
                operatorUin: 44,
                joinType,
            });
            expect(v11).toEqual({ ...increase, sub_type: joinType });
            const before = structuredClone(v11);
            const result = convertV11Event(v11, self);
            expect(result).toEqual({
                id: expect.any(String),
                time: 1700000000.5,
                type: 'notice',
                detail_type: 'group_member_increase',
                sub_type: '',
                self,
                group_id: '43',
                user_id: '42',
                operator_id: '44',
            });
            expect(result!.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expect(convertV11Event(v11, self)!.id).not.toBe(result!.id);
            expect(v11).toEqual(before);
        },
    );

    it('preserves a synthetic self-join fallback and the context account independently', async () => {
        // Models the self-join decoder's userUin assignment, not an observed QQ packet.
        const v11 = await convertEvent(context, {
            kind: 'group_member_join',
            time: 1,
            selfUin: 10001,
            groupId: 43,
            userUin: 10001,
            operatorUin: 44,
        });
        expect(v11).toMatchObject({
            sub_type: 'invite',
            self_id: 10001,
            user_id: 10001,
            operator_id: 44,
            invitor_id: 0,
            invitor_status: 'unknown',
        });
        expect(convertV11Event(v11, self)).toMatchObject({
            sub_type: '',
            self,
            user_id: '10001',
            operator_id: '44',
        });
    });

    it('accepts canonical positive safe IDs and permits equal roles', () => {
        for (const value of [1, '1', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
            expect(
                convertV11Event(
                    { ...increase, group_id: value, user_id: value, operator_id: value },
                    self,
                ),
            ).toMatchObject({
                group_id: String(value),
                user_id: String(value),
                operator_id: String(value),
                sub_type: '',
            });
        }

        expect(convertV11Event({ ...increase, self_id: '10001', time: 0 }, self)).toMatchObject({
            self,
            time: 0,
        });
    });

    it('keeps known independent inviters unsupported rather than discarding them', async () => {
        for (const invitor_id of [1, '1', Number.MAX_SAFE_INTEGER]) {
            expect(
                convertV11Event({ ...increase, invitor_id, invitor_status: 'known' }, self),
            ).toBeNull();
        }

        const v11 = await convertEvent(context, {
            kind: 'group_member_join',
            time: 1,
            selfUin: 10001,
            groupId: 43,
            userUin: 42,
            operatorUin: 44,
            invitorUin: 45,
            joinType: 'approve',
        });
        expect(v11).toMatchObject({ operator_id: 44, invitor_id: 45, invitor_status: 'known' });
        expect(convertV11Event(v11, self)).toBeNull();
    });

    it('rejects contradictory, incomplete, invalid or unknown inviter status pairs', () => {
        for (const [invitor_id, invitor_status] of [
            [0, 'known'],
            [45, 'unknown'],
            ['0', 'unknown'],
            [undefined, 'unknown'],
            [0, undefined],
            [0, 'future'],
            [null, null],
            ['01', 'known'],
            [Number.MAX_SAFE_INTEGER + 1, 'known'],
        ]) {
            expect(() =>
                convertV11Event({ ...increase, invitor_id, invitor_status }, self),
            ).toThrow('invalid or unsupported V11 group increase event');
        }
    });

    it('rejects unresolved, invalid and noncanonical group or actor IDs', () => {
        const invalid = [
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
        ];

        for (const field of ['group_id', 'user_id', 'operator_id'] as const) {
            for (const value of invalid) {
                expect(() => convertV11Event({ ...increase, [field]: value }, self)).toThrow();
            }
        }
    });

    it('rejects invalid time, mismatched account and unknown fields', () => {
        for (const time of [undefined, null, -1, NaN, Infinity, -Infinity, '1']) {
            expect(() => convertV11Event({ ...increase, time }, self)).toThrow();
        }

        for (const self_id of [undefined, null, 0, '010001', 10002, '10002', 1e20]) {
            expect(() => convertV11Event({ ...increase, self_id }, self)).toThrow();
        }

        expect(() => convertV11Event(increase, { ...self, user_id: '010001' })).toThrow();
        expect(() => convertV11Event(increase, { ...self, user_id: '10002' })).toThrow();
        expect(() => convertV11Event({ ...increase, extra: false }, self)).toThrow();
        expect(() => convertV11Event({ ...increase, [Symbol('extra')]: 1 }, self)).toThrow();
    });

    it('returns null for missing or unknown subtypes after checking account identity', () => {
        for (const sub_type of ['', 'future', undefined, null, 0]) {
            expect(convertV11Event({ ...increase, sub_type }, self)).toBeNull();
        }

        expect(() =>
            convertV11Event({ ...increase, sub_type: 'future', self_id: 10002 }, self),
        ).toThrow();
    });

    it.each(['nonempty subtype', 'missing field', 'extra field', 'wrong self'] as const)(
        'keeps %s out of the FIFO and records a same-epoch gap',
        async (caseName) => {
            vi.useFakeTimers();
            const enqueue = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
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
                    verify: (source: V12Source | undefined) =>
                        generation.isCurrent(source, binding),
                },
                createPollGate(),
            );
            const active = activateOrderedPollOwner(runtime);
            expect(active.status).toBe('ready');

            if (active.status !== 'ready') {
                throw new Error('owner not ready');
            }

            const owner = active.owner;
            const value: Record<string, unknown> = { ...convertV11Event(increase, self)! };

            switch (caseName) {
                case 'nonempty subtype':
                    value.sub_type = 'join';
                    break;
                case 'missing field':
                    delete value.operator_id;
                    break;
                case 'extra field':
                    value.extra = true;
                    break;
                case 'wrong self':
                    value.self = { platform: 'qq', user_id: '10002' };
                    break;
            }

            const parent = owner.begin(generation.capture(binding)!)!;
            expect(parent.child()!.resolve(value)).toBe(true);
            parent.seal();
            await vi.advanceTimersByTimeAsync(0);

            for (let i = 0; i < 12; i++) {
                await Promise.resolve();
            }

            expect(enqueue).not.toHaveBeenCalled();
            expect(pollOwnerStats(runtime)).toMatchObject({ accepted: 0, ordering_gap: true });
            expect(activateOrderedPollOwner(runtime).status).toBe('degraded');
            const sink = {
                isOpen: () => true,
                on: () => {},
                off: () => {},
                writeHead: vi.fn(),
                end: vi.fn(),
            };
            const poll = owner.start(
                {
                    limit: 0,
                    timeoutMs: 0,
                    maxOutputBytes: 1024,
                    responseDeadline: performance.now() + 1000,
                },
                sink,
            );
            expect((await poll.result).kind).toBe('epoch_invalid');
            expect(sink.writeHead).not.toHaveBeenCalled();
            expect(sink.end).not.toHaveBeenCalled();
            owner.invalidate();
            expect(activateOrderedPollOwner(runtime).status).toBe('degraded');
        },
    );

    it('passes a converted event through a real ordered owner and its in-memory queue', async () => {
        vi.useFakeTimers();
        const spy = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
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
        const activated = activateOrderedPollOwner(runtime);
        expect(activated.status).toBe('ready');

        if (activated.status !== 'ready') {
            throw new Error('owner not ready');
        }

        const owner = activated.owner;

        try {
            const v11 = await convertEvent(context, {
                kind: 'group_member_join',
                time: 1,
                selfUin: 10001,
                groupId: 43,
                userUin: 42,
                operatorUin: 44,
                joinType: 'approve',
            });
            const result = convertV11Event(v11, self);
            expect(result).not.toBeNull();
            const parent = owner.begin(generation.capture(binding)!)!;
            expect(parent.child()!.resolve(result)).toBe(true);
            parent.seal();
            await vi.advanceTimersByTimeAsync(0);
            expect(spy).toHaveBeenCalledExactlyOnceWith(result);
            expect(pollOwnerStats(runtime)).toMatchObject({ accepted: 1, ordering_gap: false });
        } finally {
            owner.invalidate();
        }
    });
});
