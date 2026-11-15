import { describe, expect, it, vi } from 'vitest';
import { OneBot12ClientError } from '../../src/v12/client-types.js';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import {
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

type Leaf = 'array' | 'object';

// The envelope is container 1; the terminal value is container `containers`.
function nested(containers: number, leaf: Leaf, scalar = false): unknown {
    let value: unknown = leaf === 'array' ? (scalar ? [1] : []) : scalar ? { value: 1 } : {};

    for (let index = 2; index < containers; index++) {
        value = [value];
    }

    return value;
}

// Independently count the longest container path, including the root envelope.
function maxContainers(value: unknown): number {
    if (value === null || typeof value !== 'object') {
        return 0;
    }

    return 1 + Math.max(0, ...Object.values(value).map(maxContainers));
}

const codecs = [
    {
        name: 'request',
        make: (extra: unknown) => ({ action: 'test.action', params: {}, extra }),
        parse: parseOneBot12ActionRequestJson,
        parseObject: parseOneBot12ActionRequest,
        serialize: serializeOneBot12ActionRequest,
    },
    {
        name: 'response',
        make: (extra: unknown) => ({ status: 'ok', retcode: 0, data: extra, message: '' }),
        parse: parseOneBot12ActionResponseJson,
        parseObject: parseOneBot12ActionResponse,
        serialize: serializeOneBot12ActionResponse,
    },
    {
        name: 'event',
        make: (extra: unknown) => ({
            id: 'event',
            time: 0,
            type: 'meta',
            detail_type: 'connect',
            sub_type: '',
            extra,
        }),
        parse: parseOneBot12EventJson,
        parseObject: parseOneBot12Event,
        serialize: serializeOneBot12Event,
    },
];

describe('OneBot 12 depth boundary in memory', () => {
    for (const codec of codecs) {
        for (const leaf of ['array', 'object'] as const) {
            for (const containers of [64, 65, 66]) {
                it(`${codec.name}: ${containers} containers ending in empty ${leaf}`, () => {
                    const input = codec.make(nested(containers, leaf));
                    const original = JSON.stringify(input);
                    expect(maxContainers(input)).toBe(containers);

                    if (containers <= 65) {
                        expect(codec.parseObject(input)).toEqual(input);
                        const wire = codec.serialize(input);
                        expect(JSON.parse(wire)).toEqual(input);
                        expect(codec.parse(original)).toEqual(input);
                        expect(codec.parse(wire)).toEqual(input);
                        expect(JSON.stringify(input)).toBe(original);
                    } else {
                        expect(() => codec.serialize(input)).toThrow(
                            'Invalid or oversized OneBot 12 JSON value',
                        );
                        expect(() => codec.parse(original)).toThrow(
                            'OneBot 12 JSON exceeds SDK nesting limit',
                        );
                    }
                });
            }

            for (const containers of [64, 65]) {
                it(`${codec.name}: ${containers} containers ending in ${leaf} with scalar child`, () => {
                    const input = codec.make(nested(containers, leaf, true));
                    const original = JSON.stringify(input);
                    expect(maxContainers(input)).toBe(containers);

                    if (containers === 64) {
                        const wire = codec.serialize(input);
                        expect(codec.parse(original)).toEqual(input);
                        expect(JSON.parse(wire)).toEqual(input);
                        expect(codec.parse(wire)).toEqual(input);
                    } else {
                        expect(() => codec.parseObject(input)).toThrow(
                            'Invalid or oversized OneBot 12 JSON value',
                        );
                        expect(() => codec.serialize(input)).toThrow(
                            'Invalid or oversized OneBot 12 JSON value',
                        );
                        expect(() => codec.parse(original)).toThrow(
                            'Invalid or oversized OneBot 12 JSON value',
                        );
                    }
                });
            }
        }
    }

    it('round trips 65 containers through request params.deep', () => {
        const input = { action: 'test.action', params: { deep: nested(64, 'object') } };
        expect(maxContainers(input)).toBe(65);
        const wire = serializeOneBot12ActionRequest(input);
        expect(JSON.parse(wire)).toEqual(input);
        expect(parseOneBot12ActionRequestJson(JSON.stringify(input))).toEqual(input);
        expect(parseOneBot12ActionRequestJson(wire)).toEqual(input);
    });

    it('ignores escaped quotes, backslashes and brackets inside a near-depth string', () => {
        const text = '{["\\\\'.repeat(200) + ']}';
        let value: unknown = { text };

        for (let index = 2; index < 64; index++) {
            value = [value];
        }

        for (const codec of codecs) {
            const input = codec.make(value);
            expect(maxContainers(input)).toBe(64);
            expect(codec.parse(JSON.stringify(input))).toEqual(input);
            expect(codec.parse(codec.serialize(input))).toEqual(input);
        }
    });

    it('rejects 66 balanced containers after escaped closing brackets in a string', () => {
        const noise = '}]"\\\\\\\\'.repeat(200);

        for (const codec of codecs) {
            const input = { noise, ...codec.make(nested(66, 'array')) };
            const wire = JSON.stringify(input);
            expect(JSON.parse(wire)).toEqual(input);
            expect(maxContainers(input)).toBe(66);
            expect(wire.indexOf('noise')).toBeLessThan(
                wire.indexOf(codec.name === 'response' ? 'data' : 'extra'),
            );
            expect(() => codec.parse(wire)).toThrow('OneBot 12 JSON exceeds SDK nesting limit');
        }
    });

    it('preserves negative zero and the existing safe integer numeric policy', () => {
        const input = { action: 'x', params: { minusZero: -0, max: Number.MAX_SAFE_INTEGER } };
        const wire = serializeOneBot12ActionRequest(input);
        const parsed = parseOneBot12ActionRequestJson(wire);
        expect(Object.is(parsed.params.minusZero, -0)).toBe(true);
        expect(parsed.params.max).toBe(Number.MAX_SAFE_INTEGER);
        expect(() =>
            parseOneBot12ActionRequestJson('{"action":"x","params":{"n":9007199254740992}}'),
        ).toThrow('numeric precision policy');
        expect(() =>
            parseOneBot12ActionRequestJson('{"action":"x","params":{"n":1e-400}}'),
        ).toThrow('numeric precision policy');
    });

    it('accepts the depth-64 empty response via an injected in-memory fetch', async () => {
        const input = codecs[1].make(nested(65, 'array'));
        const wire = serializeOneBot12ActionResponse(input);
        const fetchImpl = vi.fn(async () => new Response(wire));
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.invalid/',
            fetch: fetchImpl,
        });
        const received = await client.request('test.action');
        expect(received).toEqual(input);
        expect(received.status).toBe('ok');
        expect(Object.hasOwn(received, 'echo')).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['65 containers with scalar', 65, true],
        ['66 empty containers', 66, false],
    ])(
        'reports %s as invalid_response via an injected in-memory fetch',
        async (_name, count, scalar) => {
            const input = codecs[1].make(nested(count, 'array', scalar));
            const fetchImpl = vi.fn(async () => new Response(JSON.stringify(input)));
            const client = new OneBot12HttpClient({
                baseUrl: 'http://example.invalid/',
                fetch: fetchImpl,
            });
            const error = await client.request('test.action').catch((cause: unknown) => cause);
            expect(error).toBeInstanceOf(OneBot12ClientError);
            expect(error).toMatchObject({ code: 'invalid_response' });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        },
    );
});
