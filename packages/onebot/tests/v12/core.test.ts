import { describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { convertEvent } from '../../src/event-converter';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import {
    convertV11Event,
    createConnectEvent,
    createHeartbeatEvent,
    createStatusUpdateEvent,
    V12UnsupportedEventError,
} from '../../src/v12/events';
import type { V12CoreOptions } from '../../src/v12/types';

const self = { platform: 'qq', user_id: '10001' };
const request = (action: string, params: Record<string, unknown> = {}, extra: object = {}) => ({
    action,
    params,
    ...extra,
});
const text = (value: string) => [{ type: 'text', data: { text: value } }];

function setup(overrides: Partial<V12CoreOptions> = {}) {
    const sendPrivateMessage = vi.fn(async () => ({ messageId: -123 }));
    const sendGroupMessage = vi.fn(async () => ({ messageId: -123 }));
    const deleteMessage = vi.fn(async () => undefined);
    const context = {
        sendPrivateMessage,
        sendGroupMessage,
        deleteMessage,
        getMessageMeta: vi.fn(async () => ({ sequenceAuthoritative: true, sequence: 42 })),
    } as unknown as ApiActionContext;
    const api = new ApiHandler(context);
    const getSentMessageTime = vi.fn(async () => 1700000000);
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'jiyu', version: '1.0.0' },
        api,
        getStatus: () => ({ good: false, online: true }),
        getSentMessageTime,
        ...overrides,
    });
    return { dispatcher, sendPrivateMessage, sendGroupMessage, deleteMessage, getSentMessageTime };
}

describe('V12 dispatcher with real v11 ApiHandler', () => {
    it('returns complete meta responses and preserves falsy data', async () => {
        const { dispatcher } = setup();
        expect(await dispatcher.handle(request('get_version', {}, { echo: 'e' }))).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { impl: 'jiyu', version: '1.0.0', onebot_version: '12' },
            echo: 'e',
        });
        expect((await dispatcher.handle(request('get_status'))).data).toEqual({
            good: false,
            bots: [{ self, online: true }],
        });
        expect((await dispatcher.handle(request('get_supported_actions'))).data).toEqual([
            'get_version',
            'get_status',
            'get_supported_actions',
            'get_self_info',
            'send_message',
            'delete_message',
        ]);
        expect(await dispatcher.handle(request('get_version', {}, { echo: '' }))).toMatchObject({
            status: 'ok',
            echo: '',
        });
        expect(await dispatcher.handle(request('unknown_action', {}, { echo: '' }))).toMatchObject({
            status: 'failed',
            retcode: 10002,
            echo: '',
        });
        expect(await dispatcher.handle({ action: 'get_version', echo: '' })).toMatchObject({
            status: 'failed',
            retcode: 10001,
            echo: '',
        });
        expect(await dispatcher.handle(request('get_version'))).not.toHaveProperty('echo');
    });

    it('rejects accessors and hostile proxies without executing getters or exposing errors', async () => {
        const { dispatcher, sendGroupMessage } = setup();
        let getterCalls = 0;
        const actionGetter = { params: {}, echo: '' };
        Object.defineProperty(actionGetter, 'action', {
            enumerable: true,
            get() {
                getterCalls++;
                throw new Error('private-action-marker');
            },
        });
        const nestedGetter = request(
            'send_message',
            { detail_type: 'group', group_id: '42', message: text('hi') },
            { echo: 'safe' },
        );
        Object.defineProperty(nestedGetter.params, 'message', {
            enumerable: true,
            get() {
                getterCalls++;
                throw new Error('private-message-marker');
            },
        });
        const echoGetter = request('get_version');
        Object.defineProperty(echoGetter, 'echo', {
            enumerable: true,
            get() {
                getterCalls++;
                throw new Error('private-echo-marker');
            },
        });
        let trapCalls = 0;

        const trap = () => {
            trapCalls++;
            throw new Error('private-proxy-marker');
        };

        const traps = {
            ownKeys: trap,
            get: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        };
        const hostile = new Proxy(request('get_version', {}, { echo: '' }), traps);
        const nestedProxy = request('get_version', new Proxy({}, traps), { echo: 'safe' });

        for (const [value, echo] of [
            [actionGetter, ''],
            [nestedGetter, 'safe'],
            [echoGetter, undefined],
            [hostile, undefined],
            [nestedProxy, 'safe'],
        ] as const) {
            const result = await dispatcher.handle(value);
            expect(result).toMatchObject({
                status: 'failed',
                retcode: 10001,
                message: 'invalid action request',
            });

            if (echo === undefined) {
                expect(result).not.toHaveProperty('echo');
            } else {
                expect(result.echo).toBe(echo);
            }

            expect(JSON.stringify(result)).not.toContain('private-');
        }

        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        expect(await dispatcher.handle(revoked.proxy)).toMatchObject({
            status: 'failed',
            retcode: 10001,
        });
        expect(getterCalls).toBe(0);
        expect(trapCalls).toBe(0);
        expect(sendGroupMessage).not.toHaveBeenCalled();
    });

    it('enforces bounded JSON snapshots and rejects cycles before executing actions', async () => {
        const { dispatcher } = setup();
        const cycle: Record<string, unknown> = {};
        cycle.loop = cycle;

        for (const params of [
            cycle,
            { huge: new Array(4097).fill(null) },
            { invalid: Number.NaN },
        ]) {
            expect(
                await dispatcher.handle(request('get_version', params, { echo: '' })),
            ).toMatchObject({
                status: 'failed',
                retcode: 10001,
                echo: '',
            });
        }
    });

    it('normalizes v12 string and single-segment messages through the real handler', async () => {
        const { dispatcher, sendPrivateMessage } = setup();

        for (const message of [
            '[CQ:at,qq=123]',
            { type: 'text', data: { text: '[CQ:at,qq=123]' } },
        ]) {
            expect(
                await dispatcher.handle(
                    request('send_message', { detail_type: 'private', user_id: '42', message }),
                ),
            ).toMatchObject({ status: 'ok', retcode: 0 });
        }

        expect(sendPrivateMessage).toHaveBeenCalledTimes(2);
        expect(sendPrivateMessage).toHaveBeenNthCalledWith(
            1,
            42,
            text('[CQ:at,qq=123]'),
            false,
            undefined,
        );
        expect(sendPrivateMessage).toHaveBeenNthCalledWith(
            2,
            42,
            text('[CQ:at,qq=123]'),
            false,
            undefined,
        );
        expect(
            (
                await dispatcher.handle(
                    request('send_message', {
                        detail_type: 'private',
                        user_id: '42',
                        message: { type: 'image', data: { file_id: 'x' } },
                    }),
                )
            ).retcode,
        ).toBe(10005);
        expect(
            (
                await dispatcher.handle(
                    request('send_message', {
                        detail_type: 'private',
                        user_id: '42',
                        message: { type: 'text', data: { text: 'a', ignored: false } },
                    }),
                )
            ).retcode,
        ).toBe(10007);
        expect(
            (
                await dispatcher.handle(
                    request('send_message', {
                        detail_type: 'private',
                        user_id: '42',
                        message: false,
                    }),
                )
            ).retcode,
        ).toBe(10003);
        expect(sendPrivateMessage).toHaveBeenCalledTimes(2);
    });

    it('calls the real registered send and delete actions with safe IDs', async () => {
        const {
            dispatcher,
            sendPrivateMessage,
            sendGroupMessage,
            deleteMessage,
            getSentMessageTime,
        } = setup();
        expect(
            await dispatcher.handle(
                request(
                    'send_message',
                    { detail_type: 'private', user_id: '42', message: text('hello') },
                    { self, echo: '42' },
                ),
            ),
        ).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '42',
            data: { message_id: '-123', time: 1700000000 },
        });
        expect(sendPrivateMessage).toHaveBeenCalledWith(42, text('hello'), false, undefined);
        expect(getSentMessageTime).toHaveBeenCalledWith(-123);
        expect(
            (
                await dispatcher.handle(
                    request('send_message', {
                        detail_type: 'group',
                        group_id: '44',
                        message: text('hi'),
                    }),
                )
            ).status,
        ).toBe('ok');
        expect(sendGroupMessage).toHaveBeenCalledWith(44, text('hi'), false);
        expect(await dispatcher.handle(request('delete_message', { message_id: '-123' }))).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: null,
        });
        expect(deleteMessage).toHaveBeenCalledWith(-123, expect.objectContaining({ sequence: 42 }));
    });

    it('rejects cross-account, malformed and alias identities without executing', async () => {
        const { dispatcher, sendPrivateMessage } = setup();
        const params = { detail_type: 'private', user_id: '42', message: text('x') };

        for (const other of [
            { platform: 'other', user_id: '10001' },
            { platform: 'qq', user_id: '010001' },
            { platform: 'qq', user_id: '10002' },
        ]) {
            expect(
                (
                    await dispatcher.handle(
                        request('send_message', params, { self: other, echo: 'c' }),
                    )
                ).retcode,
            ).toBe(10102);
        }

        expect(
            (
                await dispatcher.handle(
                    request('send_message', params, { self: { platform: 'qq', user_id: 10001 } }),
                )
            ).retcode,
        ).toBe(10001);
        expect((await dispatcher.handle({ action: 'send_message', params, echo: 0 })).retcode).toBe(
            10001,
        );

        for (const user_id of [
            '001',
            '1e20',
            '100000000000000000000',
            '9007199254740992',
            42,
            '0',
        ]) {
            expect(
                (await dispatcher.handle(request('send_message', { ...params, user_id }))).retcode,
            ).toBe(10003);
        }

        for (const message_id of ['-0', '0001', '-0123', '-2147483649', '1e20', 123]) {
            expect(
                (await dispatcher.handle(request('delete_message', { message_id }))).retcode,
            ).toBe(10003);
        }

        expect(sendPrivateMessage).not.toHaveBeenCalled();
    });

    it('validates fields, segments and unknown capabilities', async () => {
        const { dispatcher, sendGroupMessage } = setup();
        expect((await dispatcher.handle({ action: 'get_version' })).retcode).toBe(10001);
        expect((await dispatcher.handle(request('unsupported'))).retcode).toBe(10002);
        expect((await dispatcher.handle(request('get_version', { x: false }))).retcode).toBe(10004);
        const base = { detail_type: 'group', group_id: '44' };
        expect(
            (
                await dispatcher.handle(
                    request('send_message', {
                        ...base,
                        message: [{ type: 'image', data: { file_id: 'x' } }],
                    }),
                )
            ).retcode,
        ).toBe(10005);
        expect(
            (
                await dispatcher.handle(
                    request('send_message', {
                        ...base,
                        message: [{ type: 'text', data: { text: 0 } }],
                    }),
                )
            ).retcode,
        ).toBe(10006);
        expect(
            (
                await dispatcher.handle(
                    request('send_message', {
                        ...base,
                        message: [{ type: 'text', data: { text: '', hidden: false } }],
                    }),
                )
            ).retcode,
        ).toBe(10007);
        expect(
            (
                await dispatcher.handle(
                    request('send_message', { ...base, user_id: '3', message: text('a') }),
                )
            ).retcode,
        ).toBe(10004);
        expect(sendGroupMessage).not.toHaveBeenCalled();
    });

    it('preserves the recorded timestamp estimate and rejects missing or non-finite values after a single send', async () => {
        const payload = request('send_message', {
            detail_type: 'group',
            group_id: '42',
            message: text('hi'),
        });
        // The stored value can have originated from the Bridge's local-clock fallback;
        // the V12 core must pass it through, not claim a QQ-confirmed timestamp.
        const estimated = setup({ getSentMessageTime: async () => 1700000001 });
        expect((await estimated.dispatcher.handle(payload)).data).toEqual({
            message_id: '-123',
            time: 1700000001,
        });

        for (const time of [null, NaN, Infinity, 0]) {
            const instance = setup({ getSentMessageTime: async () => time });
            const result = await instance.dispatcher.handle(payload);
            expect(result).toMatchObject({ status: 'failed', retcode: 20001 });
            expect(result.message).toContain('message sent');
            expect(result.message).toContain('do not retry');
            expect(instance.sendGroupMessage).toHaveBeenCalledTimes(1);
        }
    });

    it('warns against retry when delete succeeds but returns invalid data', async () => {
        let effects = 0;
        const api = {
            handle: vi.fn(async () => {
                effects++;
                return { status: 'ok' as const, retcode: 0, data: { unexpected: true } };
            }),
        };
        const { dispatcher } = setup({ api });
        expect(
            await dispatcher.handle(
                request('delete_message', { message_id: '-123' }, { echo: '' }),
            ),
        ).toEqual({
            status: 'failed',
            retcode: 20001,
            data: null,
            message: 'action outcome unavailable; do not retry automatically',
            echo: '',
        });
        expect(effects).toBe(1);
        expect(api.handle).toHaveBeenCalledTimes(1);
    });

    it('classifies v11 errors conservatively and rejects contradictory envelopes', async () => {
        const cases = [
            { status: 'failed' as const, retcode: 1400, expected: 10003 },
            { status: 'failed' as const, retcode: 1404, expected: 20001 },
            { status: 'failed' as const, retcode: 1200, expected: 20002 },
            { status: 'failed' as const, retcode: 100, expected: 20002 },
            { status: 'failed' as const, retcode: 9999, expected: 20002 },
            { status: 'failed' as const, retcode: 0, expected: 20001 },
            { status: 'ok' as const, retcode: 100, expected: 20001 },
        ];

        for (const test of cases) {
            const api = {
                handle: vi.fn(async () => ({
                    status: test.status,
                    retcode: test.retcode,
                    data: null,
                    wording: 'fixture-secret',
                })),
            };
            const { dispatcher } = setup({ api });

            for (const payload of [
                request(
                    'send_message',
                    { detail_type: 'group', group_id: '42', message: text('hi') },
                    { echo: '' },
                ),
                request('delete_message', { message_id: '-123' }, { echo: '' }),
            ]) {
                const result = await dispatcher.handle(payload);
                expect(result).toMatchObject({
                    status: 'failed',
                    retcode: test.expected,
                    echo: '',
                });
                expect(result.message).toContain('do not retry automatically');
                expect(JSON.stringify(result)).not.toContain('fixture-secret');
            }
        }
    });

    it('sanitizes bridge and metadata errors without replaying sends', async () => {
        const handler = {
            handle: vi.fn(async () => ({
                status: 'failed' as const,
                retcode: 100,
                data: null,
                wording: 'secret peer data',
            })),
        };
        const { dispatcher } = setup({ api: handler });
        const payload = request(
            'send_message',
            { detail_type: 'group', group_id: '42', message: text('secret') },
            { echo: 'x' },
        );
        const failed = await dispatcher.handle(payload);
        expect(failed).toMatchObject({ status: 'failed', retcode: 20002, echo: 'x' });
        expect(JSON.stringify(failed)).not.toContain('secret');
        expect(handler.handle).toHaveBeenCalledTimes(1);
        const sent = setup({
            getSentMessageTime: async () => {
                throw new Error('sensitive');
            },
        });
        const unavailable = await sent.dispatcher.handle(payload);
        expect(unavailable).toMatchObject({ status: 'failed', retcode: 20002 });
        expect(unavailable.message).toContain('message sent');
        expect(unavailable.message).toContain('do not retry');
        expect(JSON.stringify(unavailable)).not.toContain('sensitive');
        expect(sent.sendGroupMessage).toHaveBeenCalledTimes(1);
    });
});

describe('V12 message and lifecycle event conversion', () => {
    it('accepts real converter output and marks self-sent or missing IDs explicitly', async () => {
        const ctx = {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: () => -123,
            mediaSegmentSink: null,
        };
        const inbound = {
            kind: 'friend_message' as const,
            time: 1700000000,
            selfUin: 10001,
            senderUin: 42,
            senderNick: 'peer',
            msgSeq: 1,
            msgId: 1,
            elements: [{ type: 'text' as const, text: 'hi' }],
        };
        const converted = await convertEvent(ctx, inbound);
        expect(convertV11Event(converted, self)).toMatchObject({
            detail_type: 'private',
            user_id: '42',
            message_id: '-123',
            message: text('hi'),
        });
        const sent = await convertEvent(ctx, { ...inbound, senderUin: 10001, peerUin: 42 });
        expect(sent).toMatchObject({ post_type: 'message_sent', user_id: 10001, target_id: 42 });
        expect(() => convertV11Event(sent, self)).toThrow(V12UnsupportedEventError);
        const missingId = { ...converted };
        delete missingId.message_id;
        expect(() => convertV11Event(missingId, self)).toThrow('invalid V11 message event');
    });
    const event = {
        time: 1700000000,
        self_id: 10001,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: -123,
        user_id: 42,
        message: text('hello'),
        raw_message: 'hello',
    };
    it('converts mandatory fields, preserving signed IDs and unique event IDs', () => {
        const result = convertV11Event(event, self)!;
        expect(result).toMatchObject({
            type: 'message',
            detail_type: 'private',
            sub_type: '',
            self,
            message_id: '-123',
            user_id: '42',
            alt_message: 'hello',
            message: text('hello'),
            time: 1700000000,
        });
        expect(result.id).toBeTruthy();
        expect(convertV11Event(event, self)!.id).not.toBe(result.id);
        const escaped = convertV11Event(
            { ...event, message: text('[x]'), raw_message: '&#91;x&#93;' },
            self,
        );
        expect(escaped?.type === 'message' ? escaped.alt_message : undefined).toBe('[x]');
        expect(
            convertV11Event(
                { ...event, message_type: 'group', sub_type: 'normal', group_id: 43 },
                self,
            ),
        ).toMatchObject({ detail_type: 'group', group_id: '43' });
    });
    it('refuses malformed inputs, identity aliases and lossy or unknown segments', () => {
        for (const invalid of [
            { ...event, self_id: 10002 },
            { ...event, message_id: 1e20 },
            { ...event, user_id: '00042' },
            { ...event, message: [{ type: 'image', data: { file: 'x' } }] },
            { ...event, message_type: 'private', sub_type: 'group' },
            { ...event, post_type: 'unknown' },
        ]) {
            expect(() => convertV11Event(invalid, self)).toThrow();
        }

        expect(() => convertV11Event(event, { platform: 'qq', user_id: '010001' })).toThrow();
        expect(convertV11Event({ self_id: 10001, post_type: 'notice' }, self)).toBeNull();
    });
    it('builds proper connect, heartbeat and status events from explicit observations', () => {
        expect(createConnectEvent({ impl: 'jiyu', version: '1.0' }, 100)).toMatchObject({
            time: 100,
            type: 'meta',
            detail_type: 'connect',
            sub_type: '',
            version: { impl: 'jiyu', version: '1.0', onebot_version: '12' },
        });
        expect(createHeartbeatEvent(30000, 101)).toMatchObject({
            time: 101,
            detail_type: 'heartbeat',
            interval: 30000,
        });
        expect(createStatusUpdateEvent(self, { good: false, online: false }, 102)).toMatchObject({
            detail_type: 'status_update',
            status: { good: false, bots: [{ self, online: false }] },
        });
        expect(() => createHeartbeatEvent(0)).toThrow();
    });
});
