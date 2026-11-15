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
            expect(Object.hasOwn(result!, 'qq.invitor_id')).toBe(false);
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

    it('preserves known independent inviters as a string extension without changing V11', () => {
        for (const invitor_id of [
            1,
            '1',
            44,
            45,
            Number.MAX_SAFE_INTEGER,
            String(Number.MAX_SAFE_INTEGER),
        ]) {
            const v11 = { ...increase, invitor_id, invitor_status: 'known' };
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
                'qq.invitor_id': String(invitor_id),
            });
            expect(result!.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expect(convertV11Event(v11, self)!.id).not.toBe(result!.id);
            expect(v11).toEqual(before);
        }
    });

    it.each([
        [10001, 44, 44, 'approve'],
        [10001, 44, 45, 'invite'],
        [10002, 55, 55, 'invite'],
        [10002, 55, 56, 'approve'],
        [10002, 55, Number.MAX_SAFE_INTEGER, 'approve'],
        [10002, 55, String(Number.MAX_SAFE_INTEGER), 'invite'],
    ] as const)(
        'converts a supplied inviter for account %s, operator %s and inviter %s',
        async (account, operator, inviter, joinType) => {
            const accountSelf = { platform: 'qq', user_id: String(account) };
            const v11 = await convertEvent(
                { ...context, selfId: account },
                {
                    kind: 'group_member_join',
                    time: 1,
                    selfUin: account,
                    groupId: 43,
                    userUin: 42,
                    operatorUin: operator,
                    invitorUin: inviter as number,
                    joinType,
                },
            );
            expect(v11).toEqual({
                ...increase,
                time: 1,
                self_id: account,
                sub_type: joinType,
                operator_id: operator,
                invitor_id: inviter,
                invitor_status: 'known',
            });
            const before = structuredClone(v11);
            const v12 = convertV11Event(v11, accountSelf);
            expect(v12).toEqual({
                id: expect.any(String),
                time: 1,
                type: 'notice',
                detail_type: 'group_member_increase',
                sub_type: '',
                self: accountSelf,
                group_id: '43',
                user_id: '42',
                operator_id: String(operator),
                'qq.invitor_id': String(inviter),
            });
            expect(v11).toEqual(before);
            expect(() =>
                convertV11Event(v11, {
                    ...accountSelf,
                    user_id: account === 10001 ? '10002' : '10001',
                }),
            ).toThrow();
        },
    );

    it.each([0, undefined])(
        'omits the extension for unresolved inviter %s from convertEvent',
        async (invitorUin) => {
            const v11 = await convertEvent(context, {
                kind: 'group_member_join',
                time: 1,
                selfUin: 10001,
                groupId: 43,
                userUin: 42,
                operatorUin: 44,
                invitorUin,
                joinType: 'approve',
            });
            expect(v11).toMatchObject({ invitor_id: 0, invitor_status: 'unknown' });
            const v12 = convertV11Event(v11, self);
            expect(v12).toMatchObject({ user_id: '42', operator_id: '44', sub_type: '' });
            expect(Object.hasOwn(v12!, 'qq.invitor_id')).toBe(false);
        },
    );

    it.each([NaN, -1, '0', '01', '1e3', ' 45', '9007199254740992', Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid inviter %s after the real V11 conversion',
        async (invitorUin) => {
            const v11 = await convertEvent(context, {
                kind: 'group_member_join',
                time: 1,
                selfUin: 10001,
                groupId: 43,
                userUin: 42,
                operatorUin: 44,
                invitorUin: invitorUin as number,
                joinType: 'invite',
            });
            const before = structuredClone(v11);
            expect(() => convertV11Event(v11, self)).toThrow(
                'invalid or unsupported V11 group increase event',
            );
            expect(v11).toEqual(before);
        },
    );

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

        for (const fields of [
            { invitor_id: '01', invitor_status: 'known' },
            { invitor_id: 45, invitor_status: 'unknown' },
            { group_id: 0, time: NaN, extra: true },
        ]) {
            expect(
                convertV11Event({ ...increase, ...fields, sub_type: 'future' }, self),
            ).toBeNull();
            expect(() =>
                convertV11Event(
                    { ...increase, ...fields, sub_type: 'future', self_id: 10002 },
                    self,
                ),
            ).toThrow();
        }

        expect(() =>
            convertV11Event({ ...increase, sub_type: 'future', self_id: 10002 }, self),
        ).toThrow();
    });

    it.each([
        'nonempty subtype',
        'missing field',
        'extra field',
        'wrong self',
        'inviter zero',
        'inviter leading zero',
        'inviter whitespace',
        'inviter exponent',
        'inviter unsafe',
        'inviter number',
        'inviter null',
        'decrease extension',
        'friend extension',
        'delete extension',
        'message extension',
    ] as const)('keeps %s out of the FIFO and records a same-epoch gap', async (caseName) => {
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
                verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
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
                value['qq.invitor_id'] = '45';
                break;
            case 'inviter zero':
                value['qq.invitor_id'] = '0';
                break;
            case 'inviter leading zero':
                value['qq.invitor_id'] = '045';
                break;
            case 'inviter whitespace':
                value['qq.invitor_id'] = ' 45';
                break;
            case 'inviter exponent':
                value['qq.invitor_id'] = '1e3';
                break;
            case 'inviter unsafe':
                value['qq.invitor_id'] = '9007199254740992';
                break;
            case 'inviter number':
                value['qq.invitor_id'] = 45;
                break;
            case 'inviter null':
                value['qq.invitor_id'] = null;
                break;
            case 'decrease extension':
                value.detail_type = 'group_member_decrease';
                value['qq.invitor_id'] = '45';
                break;
            case 'friend extension':
                value.detail_type = 'friend_increase';
                delete value.group_id;
                delete value.operator_id;
                value['qq.invitor_id'] = '45';
                break;
            case 'delete extension':
                value.detail_type = 'group_message_delete';
                value.message_id = '1';
                value['qq.invitor_id'] = '45';
                break;
            case 'message extension':
                value.type = 'message';
                value.detail_type = 'group';
                delete value.operator_id;
                value.message_id = '1';
                value.message = [];
                value.alt_message = '';
                value['qq.invitor_id'] = '45';
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
    });

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
                invitorUin: 45,
                joinType: 'approve',
            });
            const result = convertV11Event(v11, self);
            expect(result).toEqual({
                id: expect.any(String),
                time: 1,
                type: 'notice',
                detail_type: 'group_member_increase',
                sub_type: '',
                self,
                group_id: '43',
                user_id: '42',
                operator_id: '44',
                'qq.invitor_id': '45',
            });
            const unknownV11 = await convertEvent(context, {
                kind: 'group_member_join',
                time: 2,
                selfUin: 10001,
                groupId: 43,
                userUin: 46,
                operatorUin: 44,
                joinType: 'invite',
            });
            const unknown = convertV11Event(unknownV11, self);
            expect(Object.hasOwn(unknown!, 'qq.invitor_id')).toBe(false);

            const first = owner.begin(generation.capture(binding)!)!;
            const firstChild = first.child()!;
            first.seal();
            const second = owner.begin(generation.capture(binding)!)!;
            const secondChild = second.child()!;
            second.seal();
            expect(secondChild.resolve(unknown)).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(spy).not.toHaveBeenCalled();
            expect(firstChild.resolve(result)).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(spy.mock.calls.map(([event]) => event)).toEqual([result, unknown]);
            expect(pollOwnerStats(runtime)).toMatchObject({ accepted: 2, ordering_gap: false });

            const makeSink = () => {
                const listeners = new Map<string, () => void>();
                return {
                    isOpen: () => true,
                    on: (event: string, listener: () => void) => {
                        listeners.set(event, listener);
                    },
                    off: (event: string) => {
                        listeners.delete(event);
                    },
                    writeHead: vi.fn(),
                    end: vi.fn((_body: string) => {
                        listeners.get('finish')?.();
                    }),
                };
            };

            const echo = '雪';
            const body = JSON.stringify({
                status: 'ok',
                retcode: 0,
                data: [result],
                message: '',
                echo,
            });
            const required = Buffer.byteLength(body, 'utf8');
            expect(required).toBeGreaterThan(body.length);
            const blockedSink = makeSink();
            const blocked = owner.start(
                {
                    limit: 1,
                    timeoutMs: 0,
                    maxOutputBytes: required - 1,
                    responseDeadline: performance.now() + 1000,
                    echo,
                },
                blockedSink,
            );
            expect(await blocked.result).toEqual({ kind: 'blocked' });
            expect(blockedSink.writeHead).not.toHaveBeenCalled();
            expect(blockedSink.end).not.toHaveBeenCalled();
            expect(pollOwnerStats(runtime)).toMatchObject({ accepted: 2, ordering_gap: false });

            const sink = makeSink();
            const poll = owner.start(
                {
                    limit: 1,
                    timeoutMs: 0,
                    maxOutputBytes: required,
                    responseDeadline: performance.now() + 1000,
                    echo,
                },
                sink,
            );
            expect(await poll.result).toEqual({ kind: 'local_finish', response: 'events' });
            expect(sink.end).toHaveBeenCalledExactlyOnceWith(body);
            const nextSink = makeSink();
            const next = owner.start(
                {
                    limit: 1,
                    timeoutMs: 0,
                    maxOutputBytes: 1024,
                    responseDeadline: performance.now() + 1000,
                },
                nextSink,
            );
            expect(await next.result).toEqual({ kind: 'local_finish', response: 'events' });
            expect(nextSink.end).toHaveBeenCalledExactlyOnceWith(
                JSON.stringify({ status: 'ok', retcode: 0, data: [unknown], message: '' }),
            );
        } finally {
            owner.invalidate();
        }
    });
});
