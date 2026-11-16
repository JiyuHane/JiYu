import type { RoutingHead } from '@snowluma/proto-defs/action';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { V12Dispatcher } from '../../src/v12/dispatcher';

// All sends and transport calls below are in-memory fixtures, not delivery evidence.
const self = { platform: 'qq', user_id: '10001' };
const text = [{ type: 'text', data: { text: 'hello' } }];
const privateRequest = (user_id: string, message: unknown = 'hello') => ({
    action: 'send_message',
    params: { detail_type: 'private', user_id, message },
    echo: '',
});

function fixture() {
    const handle = vi.fn(async () => ({
        status: 'ok' as const,
        retcode: 0,
        data: { message_id: -123 },
    }));
    const getSentMessageTime = vi.fn(async (_id: number) => 1700000000);
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'fixture', version: '1' },
        api: { handle },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
    });
    return { dispatcher, handle, getSentMessageTime };
}

describe('V12 private send target uint32 boundary', () => {
    it('shows actual Proton encoding of the synthetic routing schema', () => {
        const truncated = protobuf_encode<RoutingHead>({ c2c: { uin: 4294967338 } });
        const fortyTwo = protobuf_encode<RoutingHead>({ c2c: { uin: 42 } });
        expect(Array.from(truncated)).toEqual(Array.from(fortyTwo));
        expect(protobuf_decode<RoutingHead>(truncated).c2c?.uin).toBe(42);
        const maximum = protobuf_encode<RoutingHead>({ c2c: { uin: 4294967295 } });
        expect(protobuf_decode<RoutingHead>(maximum).c2c?.uin).toBe(4294967295);
        const group = protobuf_encode<RoutingHead>({ grp: { groupCode: 9007199254740991n } });
        expect(protobuf_decode<RoutingHead>(group).grp?.groupCode).toBe(9007199254740991n);
    });

    it('accepts normal private IDs and uint32 maximum without changing signed message IDs', async () => {
        const f = fixture();

        for (const [index, id] of ['42', '4294967295'].entries()) {
            expect(await f.dispatcher.handle(privateRequest(id))).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                data: { message_id: '-123', time: 1700000000 },
                echo: '',
            });
            expect(f.handle).toHaveBeenNthCalledWith(index + 1, 'send_private_msg', {
                user_id: Number(id),
                message: text,
                auto_escape: false,
            });
        }

        expect(f.handle).toHaveBeenCalledTimes(2);
        expect(f.getSentMessageTime).toHaveBeenCalledTimes(2);
        expect(f.getSentMessageTime).toHaveBeenCalledWith(-123);
    });

    it('rejects each safe but oversized private ID before V11 or timestamp calls', async () => {
        const f = fixture();

        for (const id of ['4294967296', '4294967338', '9007199254740991']) {
            expect(await f.dispatcher.handle(privateRequest(id)), id).toEqual({
                status: 'failed',
                retcode: 10003,
                message: 'invalid target or message',
                data: null,
                echo: '',
            });
        }

        expect(f.handle).not.toHaveBeenCalled();
        expect(f.getSentMessageTime).not.toHaveBeenCalled();
    });

    it('keeps the safe maximum group target and its message intact', async () => {
        const f = fixture();
        expect(
            await f.dispatcher.handle({
                action: 'send_message',
                params: { detail_type: 'group', group_id: '9007199254740991', message: 'hello' },
                echo: 'group',
            }),
        ).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { message_id: '-123', time: 1700000000 },
            echo: 'group',
        });
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', {
            group_id: 9007199254740991,
            message: text,
            auto_escape: false,
        });
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-123);
    });

    it('preserves snapshot, self, extra-field and segment validation priority', async () => {
        const f = fixture();
        const id = '4294967338';
        const cases: Array<[unknown, number]> = [
            [{ ...privateRequest(id), self: { platform: 'qq', user_id: '10002' } }, 10102],
            [{ ...privateRequest(id), extra: true }, 10004],
            [
                { ...privateRequest(id), params: { ...privateRequest(id).params, extra: true } },
                10004,
            ],
            [
                { ...privateRequest(id), params: { ...privateRequest(id).params, group_id: '1' } },
                10004,
            ],
            [privateRequest(id, { type: 'image', data: {} }), 10005],
            [privateRequest(id, { type: 'text', data: { text: 1 } }), 10006],
            [privateRequest(id, { type: 'text', data: { text: 'x', extra: true } }), 10007],
            [privateRequest(id, { type: 'mention', data: { user_id: '0' } }), 10006],
            [privateRequest(id, { type: 'mention', data: { user_id: '42' } }), 10005],
            [privateRequest(id, []), 10003],
            [privateRequest(id, NaN), 10001],
        ];

        for (const [input, retcode] of cases) {
            expect(await f.dispatcher.handle(input)).toMatchObject({
                status: 'failed',
                retcode,
                data: null,
                echo: '',
            });
        }

        expect(f.handle).not.toHaveBeenCalled();
        expect(f.getSentMessageTime).not.toHaveBeenCalled();
    });

    it('uses the original ordinary preflight snapshot exactly once', async () => {
        const f = fixture();
        const request = privateRequest('4294967338');
        const checked = f.dispatcher.createInternalHttpPreflight().classify(request);
        expect(checked.kind).toBe('ordinary');

        if (checked.kind !== 'ordinary') {
            throw new Error('expected ordinary preflight token');
        }

        request.params.user_id = '42';
        expect(await f.dispatcher.handlePreparedOrdinary(checked.token)).toEqual({
            status: 'failed',
            retcode: 10003,
            message: 'invalid target or message',
            data: null,
            echo: '',
        });
        expect(await f.dispatcher.handlePreparedOrdinary(checked.token)).toMatchObject({
            status: 'failed',
            retcode: 10001,
        });
        expect(f.handle).not.toHaveBeenCalled();
        expect(f.getSentMessageTime).not.toHaveBeenCalled();
    });

    it('passes rejection and echo through the SDK using only injected fake fetch', async () => {
        const f = fixture();
        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(input).toBe('http://fixture.invalid/');
            expect(init?.method).toBe('POST');
            expect(typeof init?.body).toBe('string');
            const body: unknown = JSON.parse(init?.body as string);
            return new Response(JSON.stringify(await f.dispatcher.handle(body)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const client = new OneBot12HttpClient({
            baseUrl: 'http://fixture.invalid/',
            fetch: fakeFetch,
        });
        expect(
            await client.request(
                'send_message',
                {
                    detail_type: 'private',
                    user_id: '4294967338',
                    message: 'hello',
                },
                { self, echo: 'sdk' },
            ),
        ).toEqual({
            status: 'failed',
            retcode: 10003,
            message: 'invalid target or message',
            data: null,
            echo: 'sdk',
        });
        expect(fakeFetch).toHaveBeenCalledTimes(1);
        expect(f.handle).not.toHaveBeenCalled();
        expect(f.getSentMessageTime).not.toHaveBeenCalled();
    });
});
