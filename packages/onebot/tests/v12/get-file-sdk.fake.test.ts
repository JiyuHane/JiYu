import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { ApiHandler, type ApiActionContext, type ActionRecord } from '../../src/api-handler';
import { actions as extendedActions } from '../../src/actions/extended';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler } from '../../src/v12/types';

// No HTTP server, socket, live account or media download is involved. The SDK
// receives only a fake fetch, and each real handler sees its own in-memory cache.
const marker = 'synthetic-private-file-marker';
const selfA = { platform: 'qq', user_id: '10001' };
const selfB = { platform: 'qq', user_id: '10002' };
const endpoint = 'http://fixture.invalid/';
const fileId = 'opaque-file-id';
const validUrl = 'https://fixture.invalid/media';
const request = (params: unknown = { file_id: fileId, type: 'url' }, extra: object = {}) => ({
    action: 'get_file',
    params,
    ...extra,
});
const ok = (data: unknown) => ({ status: 'ok', retcode: 0, data });
const row = (name = 'fixture.bin', url = validUrl) => ({ file_name: name, url });
const defaultFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch');
});
const defaultWebSocket = vi.fn(function forbiddenWebSocket() {
    throw new Error('unexpected global WebSocket');
});

beforeEach(() => {
    defaultFetch.mockClear();
    defaultWebSocket.mockClear();
    vi.stubGlobal('fetch', defaultFetch);
    vi.stubGlobal('WebSocket', defaultWebSocket);
});

afterEach(() => {
    const fetchCalls = defaultFetch.mock.calls.length;
    const socketCalls = defaultWebSocket.mock.calls.length;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(fetchCalls).toBe(0);
    expect(socketCalls).toBe(0);
});

function dispatcher(api: V11ActionHandler, self = selfA) {
    return new V12Dispatcher({
        api,
        self,
        version: { impl: 'fixture', version: '1' },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });
}

type Media = {
    file: string;
    file_name: string;
    file_size: string;
    url: string;
    headers: { Authorization: string };
    hash: string;
    sha256: string;
    md5: string;
};

function media(name: string, url: string): Media {
    return {
        file: `memory:${name}`,
        file_name: name,
        file_size: '42',
        url,
        headers: { Authorization: marker },
        hash: marker,
        sha256: marker,
        md5: marker,
    };
}

function memoryAccount(
    self = selfA,
    images: ReadonlyArray<readonly [string, Media]> = [],
    records: ReadonlyArray<readonly [string, Media]> = [],
) {
    const imageCache = new Map(images);
    const recordCache = new Map(records);
    const getImageInfo = vi.fn(async (id: string) => imageCache.get(id) ?? null);
    const getRecordInfo = vi.fn(async (id: string) => recordCache.get(id) ?? null);
    const api = new ApiHandler({ getImageInfo, getRecordInfo } as unknown as ApiActionContext);
    const subject = dispatcher(api, self);
    return { self, api, subject, handle: vi.spyOn(api, 'handle'), getImageInfo, getRecordInfo };
}

function fakeClient(accounts: ReturnType<typeof memoryAccount>[]) {
    const seen: unknown[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe(endpoint);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toBeInstanceOf(Headers);
        expect((init?.headers as Headers).get('content-type')).toBe('application/json');
        expect((init?.headers as Headers).get('accept')).toBe('application/json');
        expect(typeof init?.body).toBe('string');
        const body = JSON.parse(init!.body as string) as {
            self?: { platform?: string; user_id?: string };
        };
        seen.push(body);
        const account = accounts.find(
            (candidate) =>
                body.self?.platform === candidate.self.platform &&
                body.self?.user_id === candidate.self.user_id,
        );

        if (!account) {
            throw new Error('unknown fake account route');
        }

        return new Response(JSON.stringify(await account.subject.handle(body)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    return {
        client: new OneBot12HttpClient({ baseUrl: endpoint, fetch: fakeFetch }),
        fakeFetch,
        seen,
    };
}

function synthetic(fn: () => Promise<unknown>) {
    const handle = vi.fn(fn);
    return { handle, subject: dispatcher({ handle } as unknown as V11ActionHandler) };
}

function failure(result: unknown, code: 10004 | 20001 | 20002, echo = 'e') {
    const message =
        code === 10004
            ? 'file URL unavailable'
            : code === 20001
              ? 'invalid file result'
              : 'file unavailable';
    expect(result).toEqual({ status: 'failed', retcode: code, message, data: null, echo });
    expect(JSON.stringify(result)).not.toContain(marker);
}

function accessor(value: object, key: string, get: () => never) {
    const copy = { ...value };
    Object.defineProperty(copy, key, { enumerable: true, get });
    return copy;
}

describe('get_file through the real SDK, dispatcher, handler and extended registry', () => {
    it('uses image first, falls back to record and isolates accounts', async () => {
        const definition = extendedActions.find((action) => action.names.includes('get_file'));
        expect(definition?.describe().readOnly).toBe(true);
        const opaque = '  \u0000id/../?x=%2F#🪶 ';
        const sourceUrl = 'HTTPS://Example.COM:443/a/../b?sig=%2f%2F+&a=1#frag';
        const aImage = media('image A.jpg', sourceUrl);
        const aRecord = media('voice A.amr', 'http://fixture.invalid/voice?key=%2F');
        const bImage = media('image B.jpg', 'https://fixture.invalid/B');
        const a = memoryAccount(selfA, [[opaque, aImage]], [['record', aRecord]]);
        const b = memoryAccount(selfB, [[opaque, bImage]]);
        const { client, fakeFetch, seen } = fakeClient([a, b]);

        const first = await client.request(
            'get_file',
            { file_id: opaque, type: 'url' },
            {
                self: selfA,
                echo: '',
            },
        );
        expect(first).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: { name: 'image A.jpg', url: sourceUrl },
        });
        expect(a.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: opaque });
        expect(a.getImageInfo).toHaveBeenCalledExactlyOnceWith(opaque);
        expect(a.getRecordInfo).not.toHaveBeenCalled();
        expect(b.handle).not.toHaveBeenCalled();
        expect(JSON.stringify(first)).not.toContain(marker);
        expect(first.data).not.toHaveProperty('headers');
        expect(first.data).not.toHaveProperty('hash');
        expect(first.data).not.toHaveProperty('sha256');
        expect(first.data).not.toHaveProperty('md5');

        const second = await client.request(
            'get_file',
            { file_id: 'record', type: 'url' },
            {
                self: selfA,
                echo: 'record-echo',
            },
        );
        expect(second).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'record-echo',
            data: { name: 'voice A.amr', url: aRecord.url },
        });
        expect(a.handle).toHaveBeenCalledTimes(2);
        expect(a.handle).toHaveBeenNthCalledWith(2, 'get_file', { file_id: 'record' });
        expect(a.getImageInfo).toHaveBeenNthCalledWith(2, 'record');
        expect(a.getRecordInfo).toHaveBeenCalledExactlyOnceWith('record');

        const third = await client.request(
            'get_file',
            { file_id: opaque, type: 'url' },
            {
                self: selfB,
                echo: 'b',
            },
        );
        expect(third).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'b',
            data: { name: 'image B.jpg', url: bImage.url },
        });
        expect(b.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: opaque });
        expect(b.getImageInfo).toHaveBeenCalledExactlyOnceWith(opaque);
        expect(b.getRecordInfo).not.toHaveBeenCalled();
        expect(fakeFetch).toHaveBeenCalledTimes(3);
        expect(seen).toEqual([
            { action: 'get_file', params: { file_id: opaque, type: 'url' }, self: selfA, echo: '' },
            {
                action: 'get_file',
                params: { file_id: 'record', type: 'url' },
                self: selfA,
                echo: 'record-echo',
            },
            {
                action: 'get_file',
                params: { file_id: opaque, type: 'url' },
                self: selfB,
                echo: 'b',
            },
        ]);
    });

    it('maps double misses and provider exceptions to a fixed error with no retry', async () => {
        for (const mode of ['miss', 'image-error', 'record-error'] as const) {
            const a = memoryAccount();

            if (mode === 'image-error') {
                a.getImageInfo.mockRejectedValueOnce(new Error(marker));
            }

            if (mode === 'record-error') {
                a.getRecordInfo.mockRejectedValueOnce(new Error(marker));
            }

            const { client, fakeFetch } = fakeClient([a]);
            const result = await client.request(
                'get_file',
                { file_id: fileId, type: 'url' },
                {
                    self: selfA,
                    echo: 'e',
                },
            );
            failure(result, 20002);
            expect(fakeFetch).toHaveBeenCalledOnce();
            expect(a.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
            expect(a.getImageInfo).toHaveBeenCalledExactlyOnceWith(fileId);

            if (mode === 'image-error') {
                expect(a.getRecordInfo).not.toHaveBeenCalled();
            } else {
                expect(a.getRecordInfo).toHaveBeenCalledExactlyOnceWith(fileId);
            }
        }
    });

    it('rejects a cached URL getter through the real action without invoking it', async () => {
        let reads = 0;
        const image = media('image.jpg', validUrl);
        Object.defineProperty(image, 'url', {
            enumerable: true,
            get() {
                reads++;
                throw new Error(marker);
            },
        });
        const account = memoryAccount(selfA, [[fileId, image]]);
        const { client, fakeFetch } = fakeClient([account]);
        const result = await client.request(
            'get_file',
            { file_id: fileId, type: 'url' },
            {
                self: selfA,
                echo: 'e',
            },
        );
        failure(result, 20001);
        expect(reads).toBe(0);
        expect(fakeFetch).toHaveBeenCalledOnce();
        expect(account.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        expect(account.getImageInfo).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(account.getRecordInfo).not.toHaveBeenCalled();
    });

    it('keeps a signed source URL out of name while leaving the v11 action and observer intact', async () => {
        const source = 'https://fixture.invalid/source?sig=synthetic-source-token';
        const returnedUrl = 'https://fixture.invalid/result?sig=synthetic-result-token';
        const image = media(source, returnedUrl);
        const account = memoryAccount(selfA, [[fileId, image]]);
        const records: ActionRecord[] = [];
        account.api.setObserver((record) => records.push(record));
        const { client, fakeFetch } = fakeClient([account]);
        const result = await client.request(
            'get_file',
            { file_id: fileId, type: 'url' },
            {
                self: selfA,
                echo: 'e',
            },
        );
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { name: '', url: returnedUrl },
            echo: 'e',
        });
        expect(result.data).not.toHaveProperty('file_name');
        expect(JSON.stringify(result)).not.toContain('synthetic-source-token');
        expect(account.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        expect(account.getImageInfo).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(account.getRecordInfo).not.toHaveBeenCalled();
        expect(fakeFetch).toHaveBeenCalledOnce();
        expect(records).toHaveLength(1);
        expect(records[0]?.params).toEqual({ file_id: fileId });
        expect(records[0]?.response).toEqual({ status: 'ok', retcode: 0, data: image });
        expect(records[0]?.response.data).toBe(image);

        expect(await account.api.handle('get_file', { file_id: fileId })).toEqual({
            status: 'ok',
            retcode: 0,
            data: image,
        });
        expect(records).toHaveLength(2);
        expect(records[1]?.response.data).toBe(image);
    });

    it('leaves the v11 action and its file alias response unchanged', async () => {
        const image = media('still-v11.jpg', validUrl);
        const record = media('still-v11.amr', 'http://fixture.invalid/audio');
        const account = memoryAccount(
            selfA,
            [['same', image]],
            [
                ['same', record],
                ['voice', record],
            ],
        );
        expect(await account.api.handle('get_file', { file_id: 'same' })).toEqual({
            status: 'ok',
            retcode: 0,
            data: image,
        });
        expect(account.getImageInfo).toHaveBeenCalledExactlyOnceWith('same');
        expect(account.getRecordInfo).not.toHaveBeenCalled();
        expect(await account.api.handle('get_file', { file: 'voice' })).toEqual({
            status: 'ok',
            retcode: 0,
            data: record,
        });
        expect(account.getImageInfo).toHaveBeenNthCalledWith(2, 'voice');
        expect(account.getRecordInfo).toHaveBeenCalledExactlyOnceWith('voice');
        expect(await account.api.handle('get_file', {})).toEqual({
            status: 'failed',
            retcode: 1400,
            data: null,
            wording: 'file_id is required',
        });
    });

    it('advertises get_file exactly once and does not call the v11 handler', async () => {
        const account = memoryAccount();
        const result = await account.subject.handle({
            action: 'get_supported_actions',
            params: {},
        });
        expect(result.status).toBe('ok');
        expect(Array.isArray(result.data)).toBe(true);
        expect((result.data as unknown[]).filter((action) => action === 'get_file')).toHaveLength(
            1,
        );
        expect(account.handle).not.toHaveBeenCalled();
        expect(account.getImageInfo).not.toHaveBeenCalled();
        expect(account.getRecordInfo).not.toHaveBeenCalled();
    });
});

describe('get_file input boundaries and dispatcher response validation', () => {
    it('validates extra keys, file_id, type, self and echo before calling the real handler', async () => {
        const account = memoryAccount();
        const cases: Array<[unknown, number]> = [
            [request({}, { echo: '' }), 10003],
            [request({ file_id: fileId }, { echo: '' }), 10003],
            [request({ type: 'url' }, { echo: '' }), 10003],
            ...[null, false, 0, 12, [], {}, '', 'x'.repeat(4097), '🪶'.repeat(2048) + 'a'].map(
                (id): [unknown, number] => [
                    request({ file_id: id, type: 'url' }, { echo: '' }),
                    10003,
                ],
            ),
            ...[null, false, 0, 1, [], {}].map((type): [unknown, number] => [
                request({ file_id: fileId, type }, { echo: '' }),
                10003,
            ]),
            ...['', 'data', 'path', 'URL', ' url'].map((type): [unknown, number] => [
                request({ file_id: fileId, type }, { echo: '' }),
                10004,
            ]),
            [request({ file_id: '', type: 1, extra: false }, { echo: '' }), 10004],
            [request({ file_id: fileId, type: 'url', file: 'alias' }, { echo: '' }), 10004],
            [request({ file_id: fileId, type: 'url' }, { self: selfB, echo: '' }), 10102],
            [request({ file_id: '', type: 'url', extra: 1 }, { self: selfB, echo: '' }), 10102],
            [
                request(
                    { file_id: fileId, type: 'url' },
                    { self: { ...selfA, extra: 1 }, echo: '' },
                ),
                10004,
            ],
            [
                request(
                    { file_id: fileId, type: 'url' },
                    { self: { platform: 'qq', user_id: 1 }, echo: '' },
                ),
                10001,
            ],
            [request({ file_id: fileId, type: 'url' }, { unexpected: 1, echo: '' }), 10004],
            [request({ file_id: fileId, type: 'url', extra: undefined }, { echo: '' }), 10001],
            [request(null, { echo: '' }), 10001],
            [{ action: 'get_file', echo: '' }, 10001],
        ];

        for (const [input, code] of cases) {
            const result = await account.subject.handle(input);
            expect(result).toMatchObject({ status: 'failed', retcode: code, data: null, echo: '' });
            expect(JSON.stringify(result)).not.toContain(marker);
        }

        expect(account.handle).not.toHaveBeenCalled();
        expect(account.getImageInfo).not.toHaveBeenCalled();
        expect(account.getRecordInfo).not.toHaveBeenCalled();
    });

    it('accepts opaque IDs unchanged at 4096 UTF-16 units, empty names and URL bounds', async () => {
        const id = '🪶'.repeat(2048);
        const prefix = 'https://fixture.invalid/';
        const maxUrl = prefix + 'x'.repeat(8192 - prefix.length);

        for (const [name, url] of [
            ['', 'HTTP://EXAMPLE.COM:80/a/../b?token=%2f#x'],
            ['name', 'https://fixture.invalid/@path?token=a@b%20c'],
            ['ipv6', 'http://[2001:db8::1]:8080/a?token=%2f'],
            ['unicode', 'https://fixture.invalid/🪶?token=%2f'],
            ['escaped-slash', 'https://fixture.invalid/%2F'],
            ['escaped-space', 'https://fixture.invalid/%20'],
            ['escaped-unicode', 'https://fixture.invalid/%E4%BD%A0?value=%2F%20%E4%BD%A0'],
            ['🪶'.repeat(512), maxUrl],
        ] as const) {
            const f = synthetic(async () => ok(row(name, url)));
            const result = await f.subject.handle(
                request({ file_id: id, type: 'url' }, { self: selfA, echo: '' }),
            );
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                data: { name, url },
                echo: '',
            });
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: id });
        }

        const noEcho = synthetic(async () => ok(row()));
        expect(await noEcho.subject.handle(request())).not.toHaveProperty('echo');
        expect(noEcho.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
    });

    it('preserves Linux basenames and clears slash, NUL, dot and dot-dot labels', async () => {
        const cases: Array<[string, string]> = [
            ['https://fixture.invalid/source?sig=synthetic-source-token', ''],
            ['/private/media.jpg', ''],
            ['relative/media.jpg', ''],
            ['.', ''],
            ['..', ''],
            ['', ''],
            ['label.txt', 'label.txt'],
            ['report:2025.jpg', 'report:2025.jpg'],
            ['https:host', 'https:host'],
            ['mailto:someone@example.invalid', 'mailto:someone@example.invalid'],
            ['C:relative.txt', 'C:relative.txt'],
            ['C:\\private\\media.jpg', 'C:\\private\\media.jpg'],
            ['relative\\media.jpg', 'relative\\media.jpg'],
            ['back\\slash', 'back\\slash'],
            ['opaque-id_42', 'opaque-id_42'],
            ['id%2Fopaque', 'id%2Fopaque'],
            ['  ', '  '],
            ['🪶', '🪶'],
            ...[...Array.from({ length: 32 }, (_, code) => code), 127].map(
                (code): [string, string] => {
                    const label = 'before' + String.fromCharCode(code) + 'after';
                    return [label, code === 0 ? '' : label];
                },
            ),
        ];
        const url = 'https://fixture.invalid/result?token=%2F%20';

        for (const [name, expected] of cases) {
            const f = synthetic(async () => ok(row(name, url)));
            const result = await f.subject.handle(request(undefined, { echo: 'e' }));
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                data: { name: expected, url },
                echo: 'e',
            });
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        }
    });

    it('rejects hostile request accessors and proxies without invoking them', async () => {
        let reads = 0;

        const trap = (): never => {
            reads++;
            throw new Error(marker);
        };

        const account = memoryAccount();
        const params = { file_id: fileId, type: 'url' };
        const inputs = [
            request(accessor(params, 'file_id', trap), { echo: '' }),
            request(accessor(params, 'type', trap), { echo: '' }),
            request(
                new Proxy(params, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }),
                { echo: '' },
            ),
        ];

        for (const input of inputs) {
            expect(await account.subject.handle(input)).toEqual({
                status: 'failed',
                retcode: 10001,
                data: null,
                message: 'invalid action request',
                echo: '',
            });
        }

        expect(reads).toBe(0);
        expect(account.handle).not.toHaveBeenCalled();
    });

    it('requires own success-envelope and bounded own data properties', async () => {
        const valid = row();
        const bad: unknown[] = [
            null,
            [],
            {},
            Object.create({ status: 'ok', retcode: 0, data: valid }),
            Object.assign(Object.create({ status: 'ok' }), { retcode: 0, data: valid }),
            Object.assign(Object.create({ retcode: 0 }), { status: 'ok', data: valid }),
            Object.assign(Object.create({ data: valid }), { status: 'ok', retcode: 0 }),
            { status: 'ok', retcode: '0', data: valid },
            { status: 'ok', retcode: 100, data: valid },
            ok(null),
            ok([]),
            ok({}),
            ok(Object.create(valid)),
            ok(Object.assign(Object.create({ file_name: valid.file_name }), { url: valid.url })),
            ok(Object.assign(Object.create({ url: valid.url }), { file_name: valid.file_name })),
            ok({ file_name: 'name' }),
            ok({ url: validUrl }),
            ...[null, undefined, 1, false, {}, [], 'x'.repeat(1025), '🪶'.repeat(513)].map((name) =>
                ok({ file_name: name, url: validUrl }),
            ),
            ...[null, undefined, 1, false, {}, [], 'x'.repeat(8193)].map((url) =>
                ok({ file_name: 'name', url }),
            ),
        ];

        for (const value of bad) {
            const f = synthetic(async () => value);
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        }
    });

    it('distinguishes unsupported schemes from malformed, unsafe or oversized URLs', async () => {
        const cases: Array<[string, 10004 | 20001]> = [
            ['', 10004],
            ['ftp://fixture.invalid/file', 10004],
            ['file:///tmp/fixture', 10004],
            ['mailto:fixture@example.invalid', 10004],
            ['https:fixture.invalid/a', 20001],
            ['https:/fixture.invalid/a', 20001],
            ['https:///example.com/a', 20001],
            ['https:///@example.com/a', 20001],
            ['https:////example.com/a', 20001],
            ['https:\\\\fixture.invalid\\a', 20001],
            ['https://fixture.invalid/a\\b', 20001],
            ['https://example.com/\ud800', 20001],
            ['https://example.com/\udc00', 20001],
            ['https://fixture.invalid/%', 20001],
            ['https://fixture.invalid/%2', 20001],
            ['https://fixture.invalid/%zz', 20001],
            ['https://fixture.invalid/%0g', 20001],
            ['https://fixture.invalid/?value=%', 20001],
            ['https://fixture.invalid/?value=%2', 20001],
            ['https://fixture.invalid/?value=%zz', 20001],
            ['https://fixture.invalid/?value=%0g', 20001],
            ['https://@fixture.invalid/a', 20001],
            ['https://user@fixture.invalid/a', 20001],
            ['https://user:password@fixture.invalid/a', 20001],
            ['https://:password@fixture.invalid/a', 20001],
            ...[...Array.from({ length: 33 }, (_, code) => code), 127].map(
                (code): [string, 20001] => [
                    'https://fixture.invalid/a' + String.fromCharCode(code) + 'b',
                    20001,
                ],
            ),
            ['https://', 20001],
            ['https://[::1', 20001],
            ['not a url', 20001],
            ['https://fixture.invalid/' + 'a'.repeat(8192), 20001],
        ];

        for (const [url, code] of cases) {
            const f = synthetic(async () => ok(row('name', url)));
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), code);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        }
    });

    it('classifies v11 retcodes, contradictions and throws without exposing their wording', async () => {
        const cases: Array<[unknown, 20001 | 20002]> = [
            ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100'].map(
                (retcode): [unknown, 20001] => [
                    { status: 'failed', retcode, wording: marker },
                    20001,
                ],
            ),
            ...[1400, 1404].map((retcode): [unknown, 20001] => [
                { status: 'failed', retcode, wording: marker },
                20001,
            ]),
            ...[1, 100, 1200, Number.MAX_SAFE_INTEGER].map((retcode): [unknown, 20002] => [
                { status: 'failed', retcode, wording: marker },
                20002,
            ]),
        ];

        for (const [value, code] of cases) {
            const f = synthetic(async () => value);
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), code);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        }

        const f = synthetic(async () => {
            throw new Error(marker);
        });
        failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20002);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
    });

    it('uses descriptors and leaves irrelevant and nested then getters untouched', async () => {
        let reads = 0;

        const trap = (): never => {
            reads++;
            throw new Error(marker);
        };

        const good = row();
        Object.defineProperty(good, 'then', { enumerable: true, get: trap });
        Object.defineProperty(good, 'headers', { enumerable: true, get: trap });
        Object.defineProperty(good, 'sha256', { enumerable: true, get: trap });
        const envelope = ok(good);
        Object.defineProperty(envelope, 'extra', { enumerable: true, get: trap });
        const accepted = synthetic(async () => envelope);
        expect(await accepted.subject.handle(request(undefined, { echo: 'e' }))).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { name: good.file_name, url: good.url },
            echo: 'e',
        });
        expect(accepted.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        const traps = {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        };
        const bad = [
            ...['status', 'retcode', 'data'].map((key) => accessor(ok(row()), key, trap)),
            ...['file_name', 'url'].map((key) => ok(accessor(row(), key, trap))),
            ok(new Proxy(row(), traps)),
        ];

        for (const value of bad) {
            const f = synthetic(async () => value);
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        }

        expect(reads).toBe(0);
    });

    it('accounts for outer await thenable assimilation before proxy inspection', async () => {
        let thenReads = 0;
        let traps = 0;
        const proxy = new Proxy(ok(row()), {
            get(_target, key) {
                if (key === 'then') {
                    thenReads++;
                    return undefined;
                }

                traps++;
                throw new Error(marker);
            },
            ownKeys() {
                traps++;
                throw new Error(marker);
            },
            getOwnPropertyDescriptor() {
                traps++;
                throw new Error(marker);
            },
        });
        const f = synthetic(async () => proxy);
        failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
        expect(thenReads).toBeGreaterThan(0);
        expect(traps).toBe(0);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
        let reads = 0;
        const throwing = ok(row());
        Object.defineProperty(throwing, 'then', {
            get() {
                reads++;
                throw new Error(marker);
            },
        });
        const g = synthetic(async () => throwing);
        failure(await g.subject.handle(request(undefined, { echo: 'e' })), 20002);
        expect(reads).toBe(1);
        expect(g.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: fileId });
    });
});
