import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { inflateSync } from 'node:zlib';
import type { SendRichText } from '@snowluma/proto-defs/action';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMessage } from '../../src/message-parser';
import type { ApiResponse, JsonObject } from '../../src/types';
import { V12Dispatcher } from '../../src/v12/dispatcher';

// In-memory only: neither these fakes nor parseMessage send anything. A parsed
// local JSON card is not evidence of delivery or QQ client rendering.
const SELF = { platform: 'qq', user_id: '10001' };
const ECHO = 'synthetic-echo-🧭';
const MESSAGE_ID = -2147483648;
const TIME = 1700000000;
const TITLE_MARKER = 'SYNTHETIC_LOCATION_TITLE_PRIVATE_X731';
const CONTENT_MARKER = 'SYNTHETIC_LOCATION_ADDRESS_PRIVATE_X732';
const EXTRA_MARKER = 'SYNTHETIC_LOCATION_EXTRA_PRIVATE_X733';
const ERROR_MARKER = 'SYNTHETIC_HANDLER_FAILURE_PRIVATE_X734';

type Scene = 'private' | 'group';
type ApiMode = 'ok' | 'failed' | 'throw' | 'invalid-id';
type TimeMode = 'ok' | 'missing' | 'invalid' | 'throw';
type LocationData = { latitude: number; longitude: number; title: string; content: string };

const location = (
    data: LocationData = {
        latitude: 12.25,
        longitude: -34.5,
        title: TITLE_MARKER,
        content: CONTENT_MARKER,
    },
) => ({ type: 'location', data });
const text = (value: unknown) => ({ type: 'text', data: { text: value } });
const mention = (user_id: unknown) => ({ type: 'mention', data: { user_id } });
const mentionAll = () => ({ type: 'mention_all', data: {} });
const request = (scene: Scene, message: unknown) => ({
    action: 'send_message',
    params:
        scene === 'private'
            ? { detail_type: scene, user_id: '42', message }
            : { detail_type: scene, group_id: '44', message },
    self: { ...SELF },
    echo: ECHO,
});

function freezeInput<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) {
            freezeInput(child);
        }

        Object.freeze(value);
    }

    return value;
}

function fixture(apiMode: ApiMode = 'ok', timeMode: TimeMode = 'ok') {
    const parsed: Array<Awaited<ReturnType<typeof parseMessage>>> = [];
    const parse = vi.fn((message: unknown, autoEscape: boolean) =>
        parseMessage(message, autoEscape),
    );
    // This is the structural ApiHandler fake injected into the real dispatcher.
    // The real parser runs inside the fake, not on a reconstructed v11 argument.
    const handle = vi.fn(async (_action: string, params: JsonObject): Promise<ApiResponse> => {
        parsed.push(await parse(params.message, params.auto_escape === true));

        if (apiMode === 'throw') {
            throw new Error(ERROR_MARKER);
        }

        if (apiMode === 'failed') {
            return { status: 'failed', retcode: 123, data: null, wording: ERROR_MARKER };
        }

        return {
            status: 'ok',
            retcode: 0,
            data: { message_id: apiMode === 'invalid-id' ? 0 : MESSAGE_ID },
        };
    });
    const getSentMessageTime = vi.fn(async (_id: number): Promise<number | null> => {
        if (timeMode === 'throw') {
            throw new Error(ERROR_MARKER);
        }

        if (timeMode === 'missing') {
            return null;
        }

        return timeMode === 'invalid' ? NaN : TIME;
    });
    const dispatcher = new V12Dispatcher({
        self: SELF,
        version: { impl: 'synthetic', version: '1' },
        api: { handle },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
    });
    return { dispatcher, handle, parse, parsed, getSentMessageTime };
}

function v11Location(data: LocationData) {
    return {
        type: 'location',
        data: { lat: data.latitude, lon: data.longitude, title: data.title, content: data.content },
    };
}

function expectedCard(data: LocationData) {
    return {
        type: 'json',
        text: JSON.stringify({
            app: 'com.tencent.map',
            view: 'LocationShare',
            prompt: `[位置]${data.title}`,
            meta: {
                Location: {
                    lat: String(data.latitude),
                    lng: String(data.longitude),
                    title: data.title,
                    address: data.content,
                },
            },
        }),
    };
}

function expectedV11(scene: Scene, message: unknown) {
    return {
        ...(scene === 'private' ? { user_id: 42 } : { group_id: 44 }),
        message,
        auto_escape: false,
    };
}

function expectNoEffects(f: ReturnType<typeof fixture>) {
    expect(f.handle).not.toHaveBeenCalled();
    expect(f.parse).not.toHaveBeenCalled();
    expect(f.parsed).toEqual([]);
    expect(f.getSentMessageTime).not.toHaveBeenCalled();
}

function expectNoPrivateDetails(value: unknown) {
    const serialized = JSON.stringify(value);

    for (const marker of [TITLE_MARKER, CONTENT_MARKER, EXTRA_MARKER, ERROR_MARKER]) {
        expect(serialized).not.toContain(marker);
    }
}

let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] } }>;
let nativeGuard: { mock: { calls: unknown[] } };

beforeEach(() => {
    const blocked = () => {
        throw new Error('unexpected network or native operation in synthetic location fixture');
    };

    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function BlockWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    networkGuards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
    ];
    nativeGuard = vi.spyOn(process, 'dlopen').mockImplementation(blocked);
});

afterEach(() => {
    const counts = [
        fetchGuard.mock.calls.length,
        webSocketGuard.mock.calls.length,
        ...networkGuards.map((guard) => guard.mock.calls.length),
        nativeGuard.mock.calls.length,
    ];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(counts).toEqual(counts.map(() => 0));
});

describe('V12 location sends through an in-memory v11 parser', () => {
    it.each([
        {
            name: 'private lower coordinate bounds and empty strings',
            scene: 'private' as const,
            single: true,
            data: { latitude: -90, longitude: -180, title: '', content: '' },
        },
        {
            name: 'group upper coordinate bounds and Unicode',
            scene: 'group' as const,
            single: false,
            data: {
                latitude: 90,
                longitude: 180,
                title: '模拟📍\n标题',
                content: '地址🏙️ & "内容"',
            },
        },
        {
            name: 'private subnormal and exponent coordinates',
            scene: 'private' as const,
            single: false,
            data: { latitude: Number.MIN_VALUE, longitude: -1e-7, title: '甲', content: '乙' },
        },
        {
            name: 'group negative zero coordinates',
            scene: 'group' as const,
            single: true,
            data: { latitude: -0, longitude: -0, title: 'zero', content: '零' },
        },
    ])('maps $name once without modifying its input', async ({ scene, single, data }) => {
        const f = fixture();
        const input = freezeInput(request(scene, single ? location(data) : [location(data)]));
        const before = structuredClone(input);
        const result = await f.dispatcher.handle(input);
        const v11Message = [v11Location(data)];

        expect(input).toEqual(before);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(MESSAGE_ID), time: TIME },
            message: '',
            echo: ECHO,
        });
        expect(f.handle).toHaveBeenCalledExactlyOnceWith(
            scene === 'private' ? 'send_private_msg' : 'send_group_msg',
            expectedV11(scene, v11Message),
        );
        expect(f.parse).toHaveBeenCalledExactlyOnceWith(v11Message, false);
        expect(f.parsed).toEqual([[expectedCard(data)]]);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);

        if (Object.is(data.latitude, -0)) {
            const sent = f.handle.mock.calls[0]![1].message as Array<{
                data: { lat: number; lon: number };
            }>;
            expect(Object.is(sent[0]!.data.lat, -0)).toBe(true);
            expect(Object.is(sent[0]!.data.lon, -0)).toBe(true);
            const card = JSON.parse((f.parsed[0]![0] as { text: string }).text);
            expect(card.meta.Location).toEqual({
                lat: '0',
                lng: '0',
                title: data.title,
                address: data.content,
            });
        }
    });

    it('builds and protobuf-round-trips the parsed location as one deflated lightApp offline', async () => {
        const f = fixture();
        const data = {
            latitude: Number.MIN_VALUE,
            longitude: -0,
            title: '模拟📍',
            content: '合成地址',
        };
        const input = freezeInput(request('group', location(data)));
        const before = structuredClone(input);
        const result = await f.dispatcher.handle(input);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(MESSAGE_ID), time: TIME },
            message: '',
            echo: ECHO,
        });
        expect(input).toEqual(before);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith(
            'send_group_msg',
            expectedV11('group', [v11Location(data)]),
        );
        expect(f.parse).toHaveBeenCalledExactlyOnceWith([v11Location(data)], false);
        expect(f.parsed).toHaveLength(1);
        expect(f.parsed[0]).toEqual([expectedCard(data)]);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);

        // No SendContext, bridge, upload, socket or QQ client is involved.
        const elems = await buildSendElems(f.parsed[0]!);
        expect(elems).toHaveLength(1);
        expect(Object.keys(elems[0]!)).toEqual(['lightApp']);
        const payload = elems[0]!.lightApp?.data;
        expect(payload).toBeInstanceOf(Uint8Array);

        if (!payload) {
            throw new Error('missing synthetic lightApp data');
        }

        expect(payload[0]).toBe(0x01);
        const cardJson = inflateSync(payload.subarray(1)).toString('utf8');
        expect(cardJson).toBe(expectedCard(data).text);
        expect(JSON.parse(cardJson)).toEqual({
            app: 'com.tencent.map',
            view: 'LocationShare',
            prompt: '[位置]模拟📍',
            meta: { Location: { lat: '5e-324', lng: '0', title: '模拟📍', address: '合成地址' } },
        });

        const wire = protobuf_encode<SendRichText>({ elems });
        const decoded = protobuf_decode<SendRichText>(wire);
        expect(decoded.elems).toHaveLength(1);
        const decodedPayload = decoded.elems?.[0]?.lightApp?.data;
        expect(decodedPayload).toBeInstanceOf(Uint8Array);

        if (!decodedPayload) {
            throw new Error('missing synthetic decoded lightApp data');
        }

        expect(Buffer.from(decodedPayload)).toEqual(Buffer.from(payload));
    });

    it('preserves ordinary text and mentions in order without applying the location limits', async () => {
        const f = fixture();
        const longText = '😀'.repeat(16385); // 65,540 UTF-8 bytes; not location content.
        const segments = [
            text(longText),
            mention('42'),
            ...Array.from({ length: 65 }, (_, index) => text(`text-${index}`)),
            mentionAll(),
        ];
        const input = freezeInput(request('group', segments));
        const before = structuredClone(input);
        const expected = [
            { type: 'text', data: { text: longText } },
            { type: 'at', data: { qq: '42' } },
            ...Array.from({ length: 65 }, (_, index) => ({
                type: 'text',
                data: { text: `text-${index}` },
            })),
            { type: 'at', data: { qq: 'all' } },
        ];
        expect(Buffer.byteLength(longText, 'utf8')).toBeGreaterThan(65536);
        const result = await f.dispatcher.handle(input);
        expect(input).toEqual(before);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(MESSAGE_ID), time: TIME },
            message: '',
            echo: ECHO,
        });
        expect(f.handle).toHaveBeenCalledExactlyOnceWith(
            'send_group_msg',
            expectedV11('group', expected),
        );
        expect(f.parse).toHaveBeenCalledExactlyOnceWith(expected, false);
        expect(f.parsed[0]).toEqual([
            { type: 'text', text: longText },
            { type: 'at', targetUin: 42 },
            ...Array.from({ length: 65 }, (_, index) => ({ type: 'text', text: `text-${index}` })),
            { type: 'at', targetUin: 0, uid: 'all', text: '@全体成员 ' },
        ]);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
    });

    it('rejects missing, null, wrong-type and out-of-range location fields before effects', async () => {
        const f = fixture();
        const base: Record<string, unknown> = { ...location().data };
        const cases: Array<{ name: string; data: Record<string, unknown> }> = [];

        for (const key of ['latitude', 'longitude', 'title', 'content']) {
            const missing = { ...base };
            delete missing[key];
            cases.push({ name: `missing ${key}`, data: missing });
            cases.push({ name: `null ${key}`, data: { ...base, [key]: null } });
        }

        for (const key of ['latitude', 'longitude']) {
            for (const value of ['0', '', true, {}, []]) {
                cases.push({
                    name: `${key} wrong type ${JSON.stringify(value)}`,
                    data: { ...base, [key]: value },
                });
            }
        }

        for (const key of ['title', 'content']) {
            for (const value of [0, false, {}, []]) {
                cases.push({
                    name: `${key} wrong type ${JSON.stringify(value)}`,
                    data: { ...base, [key]: value },
                });
            }
        }

        for (const [key, value] of [
            ['latitude', -90.00000000000001],
            ['latitude', 90.00000000000001],
            ['longitude', -180.00000000000003],
            ['longitude', 180.00000000000003],
        ] as const) {
            cases.push({ name: `${key} range ${value}`, data: { ...base, [key]: value } });
        }

        for (const item of cases) {
            const input = freezeInput(request('group', { type: 'location', data: item.data }));
            const before = structuredClone(input);
            const result = await f.dispatcher.handle(input);
            expect(result, item.name).toMatchObject({
                status: 'failed',
                retcode: 10006,
                data: null,
                echo: ECHO,
            });
            expectNoPrivateDetails(result);
            expect(input).toEqual(before);
            expectNoEffects(f);
        }
    });

    it('keeps NaN and infinities at the earlier snapshot boundary with 10001', async () => {
        const f = fixture();

        for (const key of ['latitude', 'longitude']) {
            for (const value of [NaN, Infinity, -Infinity]) {
                const data = { ...location().data, [key]: value };
                const input = freezeInput(request('private', { type: 'location', data }));
                const before = structuredClone(input);
                const result = await f.dispatcher.handle(input);
                expect(result).toEqual({
                    status: 'failed',
                    retcode: 10001,
                    data: null,
                    message: 'invalid action request',
                    echo: ECHO,
                });
                expectNoPrivateDetails(result);
                expect(input).toEqual(before);
                expectNoEffects(f);
            }
        }
    });

    it('distinguishes malformed shapes and extra keys at each level', async () => {
        const f = fixture();
        const valid = location();
        const cases: Array<{ name: string; input: unknown; code: number }> = [
            { name: 'missing data', input: request('group', { type: 'location' }), code: 10006 },
            {
                name: 'null data',
                input: request('group', { type: 'location', data: null }),
                code: 10006,
            },
            {
                name: 'array data',
                input: request('group', { type: 'location', data: [] }),
                code: 10006,
            },
            {
                name: 'segment extra',
                input: request('group', { ...valid, extra: EXTRA_MARKER }),
                code: 10007,
            },
            {
                name: 'data extra',
                input: request('group', { ...valid, data: { ...valid.data, extra: EXTRA_MARKER } }),
                code: 10007,
            },
            {
                name: 'extra before missing',
                input: request('group', { type: 'location', data: { extra: EXTRA_MARKER } }),
                code: 10007,
            },
            {
                name: 'request extra',
                input: { ...request('group', valid), extra: EXTRA_MARKER },
                code: 10004,
            },
            {
                name: 'self extra',
                input: { ...request('group', valid), self: { ...SELF, extra: EXTRA_MARKER } },
                code: 10004,
            },
            {
                name: 'params extra',
                input: {
                    ...request('group', valid),
                    params: {
                        detail_type: 'group',
                        group_id: '44',
                        message: valid,
                        extra: EXTRA_MARKER,
                    },
                },
                code: 10004,
            },
        ];

        for (const item of cases) {
            const before = structuredClone(item.input);
            const result = await f.dispatcher.handle(freezeInput(item.input));
            expect(result, item.name).toMatchObject({
                status: 'failed',
                retcode: item.code,
                data: null,
                echo: ECHO,
            });
            expectNoPrivateDetails(result);
            expect(item.input).toEqual(before);
            expectNoEffects(f);
        }
    });

    it('rejects location combinations without a partial action after validating supported segment fields', async () => {
        const f = fixture();
        const valid = location();
        const malformedLocation = { type: 'location', data: { ...valid.data, latitude: '12.25' } };
        const extraLocation = { ...valid, data: { ...valid.data, extra: EXTRA_MARKER } };
        const cases: Array<{ scene: Scene; message: unknown; code: number }> = [
            { scene: 'private', message: [valid, text('before')], code: 10005 },
            { scene: 'private', message: [text('after'), valid], code: 10005 },
            { scene: 'group', message: [valid, mention('42')], code: 10005 },
            { scene: 'group', message: [mentionAll(), valid], code: 10005 },
            { scene: 'group', message: [valid, valid], code: 10005 },
            { scene: 'group', message: Array.from({ length: 64 }, () => valid), code: 10005 },
            { scene: 'group', message: Array.from({ length: 65 }, () => valid), code: 10005 },
            { scene: 'group', message: [valid, malformedLocation], code: 10006 },
            { scene: 'group', message: [malformedLocation, valid], code: 10006 },
            { scene: 'group', message: [valid, extraLocation], code: 10007 },
            {
                scene: 'group',
                message: [valid, location({ ...valid.data, title: 'x'.repeat(65537) })],
                code: 10006,
            },
            { scene: 'group', message: [valid, text(null)], code: 10006 },
            { scene: 'group', message: [valid, mention('0')], code: 10006 },
            {
                scene: 'group',
                message: [
                    text('ok'),
                    valid,
                    { type: 'text', data: { text: 'x', extra: EXTRA_MARKER } },
                ],
                code: 10007,
            },
        ];

        for (const item of cases) {
            const input = freezeInput(request(item.scene, item.message));
            const before = structuredClone(input);
            const result = await f.dispatcher.handle(input);
            expect(result).toMatchObject({
                status: 'failed',
                retcode: item.code,
                data: null,
                echo: ECHO,
            });
            expectNoPrivateDetails(result);
            expect(input).toEqual(before);
            expectNoEffects(f);
        }
    });

    it.each([
        {
            name: 'ASCII split across both fields',
            title: 'a'.repeat(32768),
            content: 'b'.repeat(32768),
        },
        {
            name: 'multibyte split across both fields',
            title: '中'.repeat(10000),
            content: '😀'.repeat(8884),
        },
        { name: 'single field', title: 'a'.repeat(65536), content: '' },
        {
            name: 'separately encoded surrogate halves',
            title: `${'a'.repeat(65530)}\ud800`,
            content: '\udc00',
        },
    ])('measures exactly 65536 UTF-8 bytes for $name', async ({ title, content }) => {
        const f = fixture();
        const data = { latitude: 1, longitude: -2, title, content };
        const input = freezeInput(request('group', location(data)));
        const before = structuredClone(input);
        const bytes = Buffer.byteLength(title, 'utf8') + Buffer.byteLength(content, 'utf8');
        expect(bytes).toBe(65536);
        const result = await f.dispatcher.handle(input);
        const v11Message = [v11Location(data)];
        expect(input).toEqual(before);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(MESSAGE_ID), time: TIME },
            message: '',
            echo: ECHO,
        });
        expect(f.handle).toHaveBeenCalledExactlyOnceWith(
            'send_group_msg',
            expectedV11('group', v11Message),
        );
        expect(f.parse).toHaveBeenCalledExactlyOnceWith(v11Message, false);
        expect(f.parsed).toEqual([[expectedCard(data)]]);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
    });

    it.each([
        {
            name: 'ASCII split',
            title: TITLE_MARKER + 'a'.repeat(32768 - TITLE_MARKER.length),
            content: CONTENT_MARKER + 'b'.repeat(32769 - CONTENT_MARKER.length),
        },
        { name: 'multibyte split', title: '中'.repeat(10000), content: `${'😀'.repeat(8884)}x` },
        { name: 'single field', title: '', content: 'b'.repeat(65537) },
        {
            name: 'separately encoded surrogate halves',
            title: `${'a'.repeat(65531)}\ud800`,
            content: '\udc00',
        },
    ])('rejects 65537 UTF-8 bytes for $name before any action', async ({ title, content }) => {
        const f = fixture();
        const data = { latitude: 1, longitude: -2, title, content };
        const input = freezeInput(request('private', location(data)));
        const before = structuredClone(input);
        expect(Buffer.byteLength(title, 'utf8') + Buffer.byteLength(content, 'utf8')).toBe(65537);
        const result = await f.dispatcher.handle(input);
        expect(result).toMatchObject({ status: 'failed', retcode: 10006, data: null, echo: ECHO });
        expectNoPrivateDetails(result);
        expect(input).toEqual(before);

        if (title.length > 0) {
            expect(result.message).not.toContain(title);
        }

        if (content.length > 0) {
            expect(result.message).not.toContain(content);
        }

        expectNoEffects(f);
    });

    it.each([
        { apiMode: 'failed' as const, timeMode: 'ok' as const, code: 20002, times: 0 },
        { apiMode: 'throw' as const, timeMode: 'ok' as const, code: 20002, times: 0 },
        { apiMode: 'invalid-id' as const, timeMode: 'ok' as const, code: 20001, times: 0 },
        { apiMode: 'ok' as const, timeMode: 'missing' as const, code: 20001, times: 1 },
        { apiMode: 'ok' as const, timeMode: 'invalid' as const, code: 20001, times: 1 },
        { apiMode: 'ok' as const, timeMode: 'throw' as const, code: 20002, times: 1 },
    ])(
        'does not repeat a v11 action for $apiMode / $timeMode',
        async ({ apiMode, timeMode, code, times }) => {
            const f = fixture(apiMode, timeMode);
            const data = location().data;
            const input = freezeInput(request('group', location(data)));
            const before = structuredClone(input);
            const result = await f.dispatcher.handle(input);
            const v11Message = [v11Location(data)];
            expect(input).toEqual(before);
            expect(result).toMatchObject({
                status: 'failed',
                retcode: code,
                data: null,
                echo: ECHO,
            });
            expect(result.message).toContain('do not retry');
            expectNoPrivateDetails(result);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith(
                'send_group_msg',
                expectedV11('group', v11Message),
            );
            expect(f.parse).toHaveBeenCalledExactlyOnceWith(v11Message, false);
            expect(f.parsed).toEqual([[expectedCard(data)]]);
            expect(f.getSentMessageTime).toHaveBeenCalledTimes(times);

            if (times === 1) {
                expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
            }
        },
    );
});
