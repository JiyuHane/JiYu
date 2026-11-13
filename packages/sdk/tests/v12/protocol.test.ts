import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    isOneBot12ActionRequest,
    isOneBot12ActionResponse,
    isOneBot12Event,
    isOneBot12MessageSegment,
    ONEBOT12_JSON_MAX_BYTES,
    parseOneBot12ActionRequest,
    parseOneBot12ActionRequestJson,
    parseOneBot12ActionResponse,
    parseOneBot12ActionResponseJson,
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12ActionRequest,
    serializeOneBot12ActionResponse,
    serializeOneBot12Event,
} from '../../src/v12/protocol.js';

const self = { platform: 'telegram', user_id: '000900719925474099300' };
const request = {
    action: 'custom.action',
    params: { 'qq.option': [1, true, null] },
    echo: '',
    self,
};
const response = {
    status: 'failed',
    retcode: 10002,
    data: null,
    message: 'unsupported',
    echo: '',
    extra: { value: 3 },
};
const event = {
    id: 'event-1',
    time: 1632847927.599013,
    type: 'message',
    detail_type: 'group',
    sub_type: '',
    self,
    message_id: 'non-numeric/90071992547409930',
    user_id: 'user-x',
    group_id: 'group-001',
    message: [
        { type: 'text', data: { text: 'hello' } },
        { type: 'vendor.segment', data: { custom: 'x' } },
    ],
    alt_message: 'hello',
    'qq.extra': { test: true },
};

describe('OneBot 12 JSON contracts', () => {
    it('round trips requests without replacing empty echo or coercing ids', () => {
        const parsed = parseOneBot12ActionRequestJson(serializeOneBot12ActionRequest(request));
        expect(parsed).toEqual(request);
        expect(parsed.self?.user_id).toBe('000900719925474099300');
        expect(isOneBot12ActionRequest(parsed)).toBe(true);
        expect(parseOneBot12ActionRequest({ action: 'x', params: {} })).toEqual({
            action: 'x',
            params: {},
        });
        expect(() => parseOneBot12ActionRequest({ action: 'x' })).toThrow();
        expect(() => parseOneBot12ActionRequest({ action: 'x', params: {}, echo: null })).toThrow();
    });

    it('keeps all response fields and does not turn business failure into transport failure', () => {
        const parsed = parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response));
        expect(parsed).toEqual(response);
        expect(isOneBot12ActionResponse(parsed)).toBe(true);

        for (const invalid of [
            { status: 'async', retcode: 0, data: null, message: '' },
            { status: 'ok', retcode: 0, message: '' },
            { status: 'ok', retcode: 0, data: null },
            { status: 'ok', retcode: 0.5, data: null, message: '' },
            { status: 'ok', retcode: 0, data: null, message: '', echo: null },
        ]) {
            expect(isOneBot12ActionResponse(invalid)).toBe(false);
        }
    });

    it('checks the original retcode literal before numeric precision is lost', () => {
        const wire = (number: string) =>
            `{"status":"failed","retcode":${number},"data":null,"message":""}`;

        for (const valid of ['0', '-1', '10002.0', '1e3', '9007199254740991']) {
            expect(parseOneBot12ActionResponseJson(wire(valid)).retcode).toBe(Number(valid));
        }

        for (const invalid of [
            '9007199254740992',
            '9007199254740991.1',
            '1.00000000000000001',
            '1e-400',
            '1e9999',
        ]) {
            expect(() => parseOneBot12ActionResponseJson(wire(invalid))).toThrow();
        }

        // An object has already lost its input number spelling and is checked as represented.
        expect(parseOneBot12ActionResponse(JSON.parse(wire('1.00000000000000001'))).retcode).toBe(
            1,
        );
    });

    it('audits every original numeric literal, including nested and overwritten keys', () => {
        const action = (body: string) => `{"action":"x","params":${body}}`;
        const wireResponse = (body: string) =>
            `{"status":"ok","retcode":0,"data":${body},"message":""}`;
        const wireEvent = (extra: string) =>
            `{"id":"m","time":0.1,"type":"meta","detail_type":"connect","sub_type":"","extra":${extra}}`;

        for (const parseWire of [
            (body: string) => parseOneBot12ActionRequestJson(action(body)),
            (body: string) => parseOneBot12ActionResponseJson(wireResponse(body)),
            (body: string) => parseOneBot12EventJson(wireEvent(body)),
        ]) {
            expect(() => parseWire('{"nested":[9007199254740991.1]}')).toThrow();
            expect(() => parseWire('{"tiny":1e-400}')).toThrow();
            expect(() => parseWire('{"x":1e9999}')).toThrow();
            expect(() => parseWire('{"x":9007199254740991.1,"x":1}')).toThrow();
            expect(() => parseWire('{"x":1,"x":1e-400}')).toThrow();
            expect(() => parseWire('{"x":1.00000000000000001}')).toThrow();
            expect(() => parseWire('{"x":1e20}')).toThrow();
            expect(() => parseWire('{"x":0e' + '0'.repeat(255) + '}')).toThrow(
                'numeric precision policy',
            );
            expect(
                parseWire(
                    '{"str":"escaped \\"1e-400\\" \\u0039","n":0.1,"power":1e3,"negzero":-0,"small":5e-324,"zero":0e1001}',
                ),
            ).toBeDefined();
        }

        const parsed = parseOneBot12ActionRequestJson(action('{"negzero":-0,"n":0.1,"power":1e3}'));
        expect(Object.is(parsed.params.negzero, -0)).toBe(true);
        expect(parsed.params.n).toBe(0.1);
        expect(parsed.params.power).toBe(1000);
        expect(() => parseOneBot12ActionRequestJson(action('{"\\u006e":1e-400}'))).toThrow(
            'numeric precision policy',
        );
        const sensitive = action('{"private":"secret-value","x":1e-400}');

        try {
            parseOneBot12ActionRequestJson(sensitive);
            throw new Error('expected failure');
        } catch (error) {
            expect(String(error)).not.toContain('secret-value');
        }
    });

    it('preserves negative zero through every JSON codec at top-level and nested paths', () => {
        const requestWire = '{"action":"x","params":{"a":-0,"nested":[-0]},"extra":-0}';
        const requestRoundTrip = parseOneBot12ActionRequestJson(
            serializeOneBot12ActionRequest(parseOneBot12ActionRequestJson(requestWire)),
        );
        expect(Object.is(requestRoundTrip.extra, -0)).toBe(true);
        expect(Object.is(requestRoundTrip.params.a, -0)).toBe(true);
        expect(Object.is((requestRoundTrip.params.nested as number[])[0], -0)).toBe(true);

        const responseWire =
            '{"status":"ok","retcode":-0,"data":{"nested":[-0]},"message":"","extra":-0}';
        const responseRoundTrip = parseOneBot12ActionResponseJson(
            serializeOneBot12ActionResponse(parseOneBot12ActionResponseJson(responseWire)),
        );
        expect(Object.is(responseRoundTrip.retcode, -0)).toBe(true);
        expect(Object.is(responseRoundTrip.extra, -0)).toBe(true);
        expect(Object.is((responseRoundTrip.data as { nested: number[] }).nested[0], -0)).toBe(
            true,
        );

        const eventWire =
            '{"id":"m","time":-0,"type":"meta","detail_type":"connect","sub_type":"","extra":{"nested":[-0]}}';
        const eventRoundTrip = parseOneBot12EventJson(
            serializeOneBot12Event(parseOneBot12EventJson(eventWire)),
        );
        expect(Object.is(eventRoundTrip.time, -0)).toBe(true);
        expect(Object.is((eventRoundTrip.extra as { nested: number[] }).nested[0], -0)).toBe(true);
    });

    it('boolean inspection does not claim the original proxy was narrowed', () => {
        const target = { action: 'x', params: {} };
        const proxy = new Proxy(target, {
            get() {
                return null;
            },
        });
        expect(isOneBot12ActionRequest(proxy)).toBe(true);
        expectTypeOf(isOneBot12ActionRequest(proxy)).toEqualTypeOf<boolean>();
        expect(proxy.action).toBeNull();
        expect(parseOneBot12ActionRequest(proxy).action).toBe('x');
    });

    it('accepts meta without self and preserves event extensions and fractional times', () => {
        const meta = {
            id: 'm',
            time: 0,
            type: 'meta',
            detail_type: 'connect',
            sub_type: '',
            version: { impl: 'a', version: '1', onebot_version: '12' },
        };
        expect(parseOneBot12Event(meta)).toEqual(meta);
        expect(parseOneBot12EventJson(serializeOneBot12Event(event))).toEqual(event);
        expect(
            parseOneBot12Event({ ...event, self: { platform: 'qq', user_id: '123' } }).self
                ?.platform,
        ).toBe('qq');
        expect(isOneBot12Event({ ...event, type: 'vendor' })).toBe(false);
        expect(isOneBot12Event({ ...event, self: undefined })).toBe(false);
        expect(isOneBot12Event({ ...event, time: Infinity })).toBe(false);
        expect(isOneBot12Event({ ...event, sub_type: undefined })).toBe(false);
        expect(isOneBot12Event({ ...event, detail_type: 'vendor.some', message: ['opaque'] })).toBe(
            true,
        );
        expect(isOneBot12Event({ ...event, message: 'not an array' })).toBe(false);
        expect(isOneBot12Event({ ...event, message_id: 42 })).toBe(false);
        expect(
            isOneBot12Event({ ...event, message: [{ type: 'text', data: { type: 'x' } }] }),
        ).toBe(false);
        expect(isOneBot12MessageSegment({ type: 'custom', data: { x: 'ok' } })).toBe(true);
    });

    it('returns a deep owned copy and preserves __proto__ as harmless data', () => {
        const raw = '{"action":"x","params":{"__proto__":{"polluted":true},"nested":{"x":1}}}';
        const input = JSON.parse(raw) as { action: string; params: { nested: { x: number } } };
        const output = parseOneBot12ActionRequest(input);
        expect(Object.hasOwn(output.params, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(output.params)).toBeNull();
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
        input.params.nested.x = 9;
        expect(output.params.nested).toEqual({ x: 1 });
        expect(JSON.parse(serializeOneBot12ActionRequest(output))).toEqual(JSON.parse(raw));
    });

    it('rejects accessor, proxy errors, prototype tricks, sparse arrays and non-JSON values', () => {
        let calls = 0;
        const getter = Object.defineProperty({}, 'bad', {
            enumerable: true,
            get() {
                calls++;
                return 1;
            },
        });
        expect(() => parseOneBot12ActionRequest({ action: 'x', params: getter })).toThrow();
        expect(calls).toBe(0);
        const throwing = new Proxy(
            {},
            {
                ownKeys() {
                    throw new Error('sensitive data');
                },
            },
        );
        expect(isOneBot12ActionRequest({ action: 'x', params: throwing })).toBe(false);
        expect(() => parseOneBot12ActionRequest({ action: 'x', params: throwing })).toThrow(
            'Invalid or oversized OneBot 12 JSON value',
        );
        expect(isOneBot12ActionRequest({ action: 'x', params: Object.create({ a: 1 }) })).toBe(
            false,
        );
        const sparse = new Array<number>(3);
        sparse[0] = 1;
        sparse[2] = 3;
        expect(isOneBot12ActionRequest({ action: 'x', params: { value: sparse } })).toBe(false);
        expect(isOneBot12ActionRequest({ action: 'x', params: { value: undefined } })).toBe(false);
        expect(isOneBot12ActionRequest({ action: 'x', params: { value: NaN } })).toBe(false);
        expect(isOneBot12ActionRequest({ action: 'x', params: { value: 2 ** 53 } })).toBe(false);
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(isOneBot12ActionRequest({ action: 'x', params: cycle })).toBe(false);
    });

    it('enforces the documented SDK byte/depth limits', () => {
        expect(() =>
            parseOneBot12ActionRequest({
                action: 'x',
                params: { text: 'a'.repeat(ONEBOT12_JSON_MAX_BYTES + 1) },
            }),
        ).toThrow();
        let deep: unknown = null;

        for (let index = 0; index < 70; index++) {
            deep = [deep];
        }

        expect(() => parseOneBot12ActionRequest({ action: 'x', params: { deep } })).toThrow();
        const deepWire =
            '{"action":"x","params":{"deep":' +
            '['.repeat(10_000) +
            '0' +
            ']'.repeat(10_000) +
            '}}';
        expect(() => parseOneBot12ActionRequestJson(deepWire)).toThrow('SDK nesting limit');
        expect(() => parseOneBot12EventJson('{')).toThrow();
    });
});
