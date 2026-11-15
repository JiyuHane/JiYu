import { describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { parseMessage } from '../../src/message-parser';
import type { JsonValue } from '../../src/types';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V12CoreOptions } from '../../src/v12/types';

// Pure in-memory fakes: a successful result does not establish QQ delivery,
// client rendering, or resolution of a numeric account ID to a QQ UID.
const SELF_A = { platform: 'qq', user_id: '10001' };
const SELF_B = { platform: 'qq', user_id: '10002' };
const ECHO = '{"id":[1,false,null],"text":"你好"}';
const text = (value: string) => ({ type: 'text', data: { text: value } });
const mention = (user_id: unknown) => ({ type: 'mention', data: { user_id } });
const mentionAll = () => ({ type: 'mention_all', data: {} });
const payload = (message: unknown, extra: Record<string, unknown> = {}) => ({
    action: 'send_message',
    params: { detail_type: 'group', group_id: '44', message },
    ...extra,
});

function setup(self = SELF_A, resultId = -123, time: number | null = 1700000000) {
    const sendGroupMessage = vi.fn(
        async (_groupId: number, _message: JsonValue, _autoEscape: boolean) => ({
            messageId: resultId,
        }),
    );
    const sendPrivateMessage = vi.fn(async () => ({ messageId: resultId }));
    const api = new ApiHandler({
        sendGroupMessage,
        sendPrivateMessage,
    } as unknown as ApiActionContext);
    const action = vi.spyOn(api, 'handle');
    const getSentMessageTime = vi.fn(async () => time);
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
    });
    return { dispatcher, action, sendGroupMessage, sendPrivateMessage, getSentMessageTime };
}

function setupSynthetic(
    api: V12CoreOptions['api'],
    time: V12CoreOptions['getSentMessageTime'] = async () => 1700000000,
) {
    return new V12Dispatcher({
        self: SELF_A,
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: time,
    });
}

describe('V12 group send mentions through in-memory handlers', () => {
    it('preserves order, action, numeric target, false auto_escape and independent echo', async () => {
        const f = setup();
        const input = payload([text('A[CQ:at,qq=99]'), mention('42'), mentionAll(), text('Z')], {
            self: SELF_A,
            echo: ECHO,
        });
        const before = structuredClone(input);
        const result = await f.dispatcher.handle(input);
        expect(input).toEqual(before);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { message_id: '-123', time: 1700000000 },
            echo: ECHO,
        });
        const expected = [
            { type: 'text', data: { text: 'A[CQ:at,qq=99]' } },
            { type: 'at', data: { qq: '42' } },
            { type: 'at', data: { qq: 'all' } },
            { type: 'text', data: { text: 'Z' } },
        ];
        expect(f.action).toHaveBeenCalledTimes(1);
        expect(f.action).toHaveBeenCalledWith('send_group_msg', {
            group_id: 44,
            message: expected,
            auto_escape: false,
        });
        expect(f.sendGroupMessage).toHaveBeenCalledTimes(1);
        expect(f.sendGroupMessage).toHaveBeenCalledWith(44, expected, false);
        expect(f.sendPrivateMessage).not.toHaveBeenCalled();
        expect(f.getSentMessageTime).toHaveBeenCalledTimes(1);
        expect(f.getSentMessageTime).toHaveBeenCalledWith(-123);
        // Parse captured arguments outside the fake and the handler's catch boundary.
        const captured = f.sendGroupMessage.mock.calls[0] as unknown as [number, unknown, boolean];
        expect(await parseMessage(captured[1], captured[2])).toEqual([
            { type: 'text', text: 'A[CQ:at,qq=99]' },
            { type: 'at', targetUin: 42 },
            { type: 'at', targetUin: 0, uid: 'all', text: '@全体成员 ' },
            { type: 'text', text: 'Z' },
        ]);
    });

    it('accepts message shapes, uint32 maximum mention and safe maximum group ID', async () => {
        const f = setup();
        const cases = [
            {
                group: '1',
                message: mention('1'),
                expected: [{ type: 'at', data: { qq: '1' } }],
                target: 1,
            },
            {
                group: '9007199254740991',
                message: [mention('4294967295'), mentionAll()],
                expected: [
                    { type: 'at', data: { qq: '4294967295' } },
                    { type: 'at', data: { qq: 'all' } },
                ],
                target: 9007199254740991,
            },
            {
                group: '44',
                message: mentionAll(),
                expected: [{ type: 'at', data: { qq: 'all' } }],
                target: 44,
            },
            {
                group: '44',
                message: '[CQ:at,qq=42]',
                expected: [{ type: 'text', data: { text: '[CQ:at,qq=42]' } }],
                target: 44,
            },
            {
                group: '44',
                message: text('plain'),
                expected: [{ type: 'text', data: { text: 'plain' } }],
                target: 44,
            },
        ];

        for (const [index, item] of cases.entries()) {
            expect(
                await f.dispatcher.handle({
                    action: 'send_message',
                    params: { detail_type: 'group', group_id: item.group, message: item.message },
                }),
            ).toMatchObject({ status: 'ok', retcode: 0 });
            expect(f.action).toHaveBeenNthCalledWith(index + 1, 'send_group_msg', {
                group_id: item.target,
                message: item.expected,
                auto_escape: false,
            });
            expect(f.sendGroupMessage).toHaveBeenNthCalledWith(
                index + 1,
                item.target,
                item.expected,
                false,
            );
        }

        expect(f.action).toHaveBeenCalledTimes(cases.length);
        expect(f.sendGroupMessage).toHaveBeenCalledTimes(cases.length);
        const maximum = f.sendGroupMessage.mock.calls[1]!;
        expect(await parseMessage(maximum[1], maximum[2])).toEqual([
            { type: 'at', targetUin: 4294967295 },
            { type: 'at', targetUin: 0, uid: 'all', text: '@全体成员 ' },
        ]);
    });

    it('isolates account results and rejects a cross-account self before the action', async () => {
        const a = setup(SELF_A, -123, 1700000000);
        const b = setup(SELF_B, -456, 1700000001);
        const message = [mention('42'), mentionAll()];
        const [ra, rb] = await Promise.all([
            a.dispatcher.handle(payload(message, { self: SELF_A, echo: 'a' })),
            b.dispatcher.handle(payload(message, { self: SELF_B, echo: 'b' })),
        ]);
        expect(ra).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { message_id: '-123', time: 1700000000 },
            echo: 'a',
        });
        expect(rb).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { message_id: '-456', time: 1700000001 },
            echo: 'b',
        });
        expect(await a.dispatcher.handle(payload(message, { self: SELF_B }))).toMatchObject({
            status: 'failed',
            retcode: 10102,
        });
        expect(a.action).toHaveBeenCalledTimes(1);
        expect(b.action).toHaveBeenCalledTimes(1);
        expect(a.getSentMessageTime).toHaveBeenCalledTimes(1);
        expect(a.getSentMessageTime).toHaveBeenCalledWith(-123);
        expect(b.getSentMessageTime).toHaveBeenCalledTimes(1);
        expect(b.getSentMessageTime).toHaveBeenCalledWith(-456);
    });

    it('consumes an ordinary preflight snapshot once despite caller mutations', async () => {
        const f = setup();
        const self = { ...SELF_A };
        const targetMention = mention('42');
        const segments = [text('before'), targetMention, mentionAll()];
        const input = {
            action: 'send_message',
            params: { detail_type: 'group', group_id: '44', message: segments },
            self,
            echo: ECHO,
        };
        // This internal seam is not a running HTTP server or production poll.
        const checked = f.dispatcher.createInternalHttpPreflight().classify(input);
        expect(checked.kind).toBe('ordinary');

        if (checked.kind !== 'ordinary') {
            throw new Error('expected ordinary preflight token');
        }

        targetMention.data.user_id = '99';
        segments.splice(0, segments.length, text('after'));
        self.user_id = SELF_B.user_id;
        input.params.group_id = '55';
        input.echo = 'changed';
        expect(await f.dispatcher.handlePreparedOrdinary(checked.token)).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { message_id: '-123', time: 1700000000 },
            echo: ECHO,
        });
        expect(f.action).toHaveBeenCalledTimes(1);
        expect(f.action).toHaveBeenCalledWith('send_group_msg', {
            group_id: 44,
            message: [
                { type: 'text', data: { text: 'before' } },
                { type: 'at', data: { qq: '42' } },
                { type: 'at', data: { qq: 'all' } },
            ],
            auto_escape: false,
        });
        expect(f.sendGroupMessage).toHaveBeenCalledTimes(1);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-123);
        expect(await f.dispatcher.handlePreparedOrdinary(checked.token)).toMatchObject({
            status: 'failed',
            retcode: 10001,
        });
        expect(f.action).toHaveBeenCalledTimes(1);
        expect(f.sendGroupMessage).toHaveBeenCalledTimes(1);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-123);
        expect(f.sendPrivateMessage).not.toHaveBeenCalled();
    });

    it('rejects each invalid mention ID before any downstream call', async () => {
        const f = setup();

        for (const id of [
            '',
            ' ',
            ' 42',
            '42 ',
            '042',
            '0',
            'all',
            'ALL',
            '-1',
            '+1',
            '1e3',
            '4294967296', // Must never wrap to zero and become an at-all.
            '4294967297',
            '9007199254740991',
            '9007199254740992',
            42,
            0,
            false,
            null,
            {},
            [],
        ]) {
            const result = await f.dispatcher.handle(
                payload([text('before'), mention(id)], { echo: 'invalid' }),
            );
            expect(result, `id ${JSON.stringify(id)}`).toMatchObject({
                status: 'failed',
                retcode: 10006,
                echo: 'invalid',
            });
            expect(f.action).not.toHaveBeenCalled();
        }

        expect(f.sendGroupMessage).not.toHaveBeenCalled();
    });

    it('checks exact known-segment schema, unsupported types and complete messages before dispatch', async () => {
        const f = setup();
        const cases: Array<[unknown, number]> = [
            [{ type: 'mention', data: {} }, 10006],
            [{ type: 'mention', data: null }, 10006],
            [{ type: 'mention' }, 10006],
            [{ type: 'mention_all', data: null }, 10006],
            [{ type: 'mention_all' }, 10006],
            [{ type: 'mention', data: { user_id: '42', extra: false } }, 10007],
            [{ type: 'mention', data: { user_id: '42' }, extra: false }, 10007],
            [{ type: 'mention_all', data: { user_id: '42' } }, 10007],
            [{ type: 'mention_all', data: {}, extra: false }, 10007],
            [{ type: 'mention', data: { extra: false } }, 10007],
            [{ type: 'image', data: { file_id: 'fake' } }, 10005],
            [{ type: 'unknown', data: {} }, 10005],
            [{ type: 'text', data: { text: 42 } }, 10006],
            [{ type: 'text', data: { text: 'ok', extra: 1 } }, 10007],
            [null, 10006],
        ];

        for (const [segment, code] of cases) {
            const result = await f.dispatcher.handle(
                payload([text('valid'), mention('42'), segment]),
            );
            expect(result, JSON.stringify(segment)).toMatchObject({
                status: 'failed',
                retcode: code,
            });
            expect(f.action).not.toHaveBeenCalled();
        }

        expect(f.sendGroupMessage).not.toHaveBeenCalled();
    });

    it('validates a private mention before rejecting its supported shape immediately', async () => {
        const f = setup();
        const send = (message: unknown) => ({
            action: 'send_message',
            params: { detail_type: 'private', user_id: '42', message },
        });
        const cases: Array<[unknown, number]> = [
            [mention('42'), 10005],
            [mentionAll(), 10005],
            [[mention('42'), mention('0')], 10005],
            [[mentionAll(), { type: 'image', data: {} }], 10005],
            [mention('0'), 10006],
            [{ type: 'mention', data: {} }, 10006],
            [{ type: 'mention', data: { user_id: '42', extra: false } }, 10007],
            [{ type: 'mention_all', data: { extra: false } }, 10007],
            [{ type: 'mention_all', data: null }, 10006],
        ];

        for (const [message, code] of cases) {
            expect(await f.dispatcher.handle(send(message)), JSON.stringify(message)).toMatchObject(
                { status: 'failed', retcode: code },
            );
        }

        expect(f.action).not.toHaveBeenCalled();
        expect(f.sendPrivateMessage).not.toHaveBeenCalled();
    });

    it('rejects bad group targets, action, self, empty message and extra parameters before effects', async () => {
        const f = setup();

        for (const group_id of [
            '',
            ' 44',
            '44 ',
            '044',
            '0',
            'all',
            '9007199254740992',
            44,
            null,
        ]) {
            expect(
                await f.dispatcher.handle({
                    action: 'send_message',
                    params: { detail_type: 'group', group_id, message: mention('42') },
                }),
            ).toMatchObject({ status: 'failed', retcode: 10003 });
        }

        for (const [input, code] of [
            [
                {
                    action: 'other',
                    params: { detail_type: 'group', group_id: '44', message: mention('42') },
                },
                10002,
            ],
            [payload(mention('42'), { self: SELF_B }), 10102],
            [payload(mention('42'), { self: { platform: 'qq', user_id: 10001 } }), 10001],
            [payload([], { echo: '' }), 10003],
            [
                {
                    action: 'send_message',
                    params: {
                        detail_type: 'group',
                        group_id: '44',
                        message: mention('42'),
                        extra: false,
                    },
                },
                10004,
            ],
            [payload(mention('42'), { extra: false }), 10004],
            [payload(mention('42'), { echo: { id: 1 } }), 10001],
        ] as const) {
            expect(await f.dispatcher.handle(input)).toMatchObject({
                status: 'failed',
                retcode: code,
            });
        }

        expect(f.action).not.toHaveBeenCalled();
        expect(f.sendGroupMessage).not.toHaveBeenCalled();
    });

    it('rejects cycles, proxies and accessors without invoking traps or getters', async () => {
        const f = setup();
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('private trap');
        };

        const proxy = new Proxy(
            {},
            { ownKeys: trap, get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap },
        );
        const getter = { type: 'mention', data: {} };
        Object.defineProperty(getter.data, 'user_id', { enumerable: true, get: trap });
        const cycle: Record<string, unknown> = {};
        cycle.loop = cycle;

        for (const segment of [proxy, getter, { type: 'mention', data: cycle }]) {
            const result = await f.dispatcher.handle(
                payload([text('valid'), segment], { echo: 'snapshot' }),
            );
            expect(result).toMatchObject({ status: 'failed', retcode: 10001, echo: 'snapshot' });
            expect(JSON.stringify(result)).not.toContain('private trap');
        }

        expect(calls).toBe(0);
        expect(f.action).not.toHaveBeenCalled();
        expect(f.sendGroupMessage).not.toHaveBeenCalled();
    });

    it('does not retry a failed or thrown synthetic API call or missing/throwing timestamp', async () => {
        const body = payload([mention('42'), mentionAll()], { echo: ECHO });

        for (const mode of ['failed', 'throw'] as const) {
            const handle = vi.fn(async () => {
                if (mode === 'throw') {
                    throw new Error('fixture-private');
                }

                return {
                    status: 'failed' as const,
                    retcode: 100,
                    data: null,
                    wording: 'fixture-private',
                };
            });
            const result = await setupSynthetic({ handle }).handle(body);
            expect(result).toMatchObject({ status: 'failed', retcode: 20002, echo: ECHO });
            expect(result.message).toContain('do not retry');
            expect(JSON.stringify(result)).not.toContain('fixture-private');
            expect(handle).toHaveBeenCalledTimes(1);
            expect(handle).toHaveBeenCalledWith('send_group_msg', {
                group_id: 44,
                message: [
                    { type: 'at', data: { qq: '42' } },
                    { type: 'at', data: { qq: 'all' } },
                ],
                auto_escape: false,
            });
        }

        for (const mode of ['missing', 'throw'] as const) {
            const f = setup();

            if (mode === 'missing') {
                f.getSentMessageTime.mockResolvedValue(null);
            } else {
                f.getSentMessageTime.mockRejectedValue(new Error('fixture-private'));
            }

            const result = await f.dispatcher.handle(body);
            expect(result).toMatchObject({
                status: 'failed',
                retcode: mode === 'missing' ? 20001 : 20002,
                echo: ECHO,
            });
            expect(result.message).toContain('do not retry');
            expect(JSON.stringify(result)).not.toContain('fixture-private');
            expect(f.action).toHaveBeenCalledTimes(1);
            expect(f.sendGroupMessage).toHaveBeenCalledTimes(1);
            expect(f.getSentMessageTime).toHaveBeenCalledTimes(1);
            expect(f.getSentMessageTime).toHaveBeenCalledWith(-123);
        }
    });
});
