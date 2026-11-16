import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import { classifyFileUrl, type FileUrlClassification } from '../../src/v12/file-url';
import type { V11ActionHandler } from '../../src/v12/types';

// The classifier and dispatcher fixtures do not fetch, open sockets or use an account.
const blockedFetch = vi.fn(() => {
    throw new Error('unexpected fetch in file URL fixture');
});
const blockedWebSocket = vi.fn(function forbiddenWebSocket() {
    throw new Error('unexpected WebSocket in file URL fixture');
});

beforeEach(() => {
    blockedFetch.mockClear();
    blockedWebSocket.mockClear();
    vi.stubGlobal('fetch', blockedFetch);
    vi.stubGlobal('WebSocket', blockedWebSocket);
});

afterEach(() => {
    const fetchCalls = blockedFetch.mock.calls.length;
    const socketCalls = blockedWebSocket.mock.calls.length;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(fetchCalls).toBe(0);
    expect(socketCalls).toBe(0);
});

type UrlCase = { label: string; value: unknown; expected: FileUrlClassification };
const valid = (url: string): FileUrlClassification => ({ kind: 'valid', url });
const invalid: FileUrlClassification = { kind: 'invalid' };
const unsupported: FileUrlClassification = { kind: 'unsupported' };
const prefix = 'https://fixture.invalid/';
const maxUrl = prefix + 'a'.repeat(8192 - prefix.length);
const maxUnicodeUrl = prefix + 'a'.repeat(8192 - prefix.length - 2) + '🪶';

const cases: UrlCase[] = [
    {
        label: 'HTTP',
        value: 'http://fixture.invalid/path',
        expected: valid('http://fixture.invalid/path'),
    },
    {
        label: 'original spelling is not normalized',
        value: 'HTTPS://Example.COM:443/a/../b?token=%2f%2F+&a=1#frag',
        expected: valid('HTTPS://Example.COM:443/a/../b?token=%2f%2F+&a=1#frag'),
    },
    {
        label: 'IPv6 authority',
        value: 'http://[2001:db8::1]:8080/a?token=%2F',
        expected: valid('http://[2001:db8::1]:8080/a?token=%2F'),
    },
    {
        label: 'valid surrogate pair and escapes',
        value: 'https://fixture.invalid/🪶?value=%2f%20%E4%BD%A0',
        expected: valid('https://fixture.invalid/🪶?value=%2f%20%E4%BD%A0'),
    },
    {
        label: 'Unicode hostname and path',
        value: 'https://例子.测试/媒体?emoji=🪶',
        expected: valid('https://例子.测试/媒体?emoji=🪶'),
    },
    {
        label: 'at-sign outside authority',
        value: 'https://fixture.invalid/@path?email=a@b#@fragment',
        expected: valid('https://fixture.invalid/@path?email=a@b#@fragment'),
    },
    {
        label: 'encoded ASCII control is retained',
        value: 'https://fixture.invalid/%00?value=%7f',
        expected: valid('https://fixture.invalid/%00?value=%7f'),
    },
    {
        label: 'non-ASCII whitespace is not silently normalized',
        value: 'https://fixture.invalid/\u00a0',
        expected: valid('https://fixture.invalid/\u00a0'),
    },
    { label: '8192 UTF-16 units', value: maxUrl, expected: valid(maxUrl) },
    { label: '8192 units including emoji', value: maxUnicodeUrl, expected: valid(maxUnicodeUrl) },
    { label: 'empty URL', value: '', expected: unsupported },
    { label: 'FTP', value: 'ftp://fixture.invalid/a', expected: unsupported },
    {
        label: 'FTP userinfo precedes HTTP authority policy',
        value: 'ftp://u:p@fixture.invalid/a',
        expected: unsupported,
    },
    {
        label: 'FTP backslash precedes HTTP authority policy',
        value: 'ftp://fixture.invalid/a\\b',
        expected: unsupported,
    },
    { label: 'file scheme', value: 'file:///tmp/fixture', expected: unsupported },
    { label: 'data scheme', value: 'data:text/plain,fixture', expected: unsupported },
    { label: 'mailto scheme', value: 'mailto:user@fixture.invalid', expected: unsupported },
    { label: 'WebSocket scheme', value: 'ws://fixture.invalid/a', expected: unsupported },
    { label: 'null', value: null, expected: invalid },
    { label: 'undefined', value: undefined, expected: invalid },
    { label: 'number', value: 1, expected: invalid },
    { label: 'boolean', value: false, expected: invalid },
    { label: 'array', value: [], expected: invalid },
    { label: 'object', value: {}, expected: invalid },
    { label: 'symbol', value: Symbol('url'), expected: invalid },
    { label: '8193 UTF-16 units', value: `${maxUrl}a`, expected: invalid },
    {
        label: 'oversized FTP is invalid before scheme',
        value: `ftp://${'a'.repeat(8192)}`,
        expected: invalid,
    },
    { label: 'relative URL', value: '/fixture', expected: invalid },
    { label: 'missing authority', value: 'https://', expected: invalid },
    { label: 'missing two slashes', value: 'https:fixture.invalid/a', expected: invalid },
    { label: 'missing one slash', value: 'https:/fixture.invalid/a', expected: invalid },
    {
        label: 'parser-repaired empty authority',
        value: 'https:///example.com/a',
        expected: invalid,
    },
    { label: 'extra slashes', value: 'https:////example.com/a', expected: invalid },
    { label: 'backslash authority', value: 'https:\\\\fixture.invalid\\a', expected: invalid },
    { label: 'backslash path', value: 'https://fixture.invalid/a\\b', expected: invalid },
    { label: 'empty userinfo marker', value: 'https://@fixture.invalid/a', expected: invalid },
    { label: 'username', value: 'https://user@fixture.invalid/a', expected: invalid },
    {
        label: 'username and password',
        value: 'https://user:password@fixture.invalid/a',
        expected: invalid,
    },
    {
        label: 'password without username',
        value: 'https://:password@fixture.invalid/a',
        expected: invalid,
    },
    { label: 'malformed IPv6 authority', value: 'https://[::1', expected: invalid },
    {
        label: 'unpaired high surrogate',
        value: 'https://fixture.invalid/\ud800',
        expected: invalid,
    },
    { label: 'unpaired low surrogate', value: 'https://fixture.invalid/\udc00', expected: invalid },
    {
        label: 'high followed by high',
        value: 'https://fixture.invalid/\ud800🪶',
        expected: invalid,
    },
    { label: 'bare percent', value: 'https://fixture.invalid/%', expected: invalid },
    { label: 'short percent escape', value: 'https://fixture.invalid/%2', expected: invalid },
    { label: 'non-hex percent escape', value: 'https://fixture.invalid/%zz', expected: invalid },
    {
        label: 'partially non-hex escape',
        value: 'https://fixture.invalid/?x=%0g',
        expected: invalid,
    },
    {
        label: 'invalid escape before FTP scheme result',
        value: 'ftp://fixture.invalid/%zz',
        expected: invalid,
    },
    {
        label: 'invalid escape before data scheme result',
        value: 'data:text/plain,%2',
        expected: invalid,
    },
    ...Array.from({ length: 33 }, (_, code): UrlCase => ({
        label: `ASCII whitespace/control ${code}`,
        value: `https://fixture.invalid/a${String.fromCharCode(code)}b`,
        expected: invalid,
    })),
    { label: 'ASCII DEL', value: 'https://fixture.invalid/a\u007fb', expected: invalid },
];

/** A fixed in-memory handler exercises the existing dispatcher without a transport. */
function dispatcherFor(url: unknown): V12Dispatcher {
    const api = {
        handle: vi.fn(async () => ({
            status: 'ok',
            retcode: 0,
            data: { file_name: '', url },
        })),
    } as unknown as V11ActionHandler;
    return new V12Dispatcher({
        api,
        self: { platform: 'qq', user_id: '10001' },
        version: { impl: 'fixture', version: '1' },
        getStatus: () => ({ good: false, online: false }),
        getSentMessageTime: () => null,
    });
}

describe('classifyFileUrl', () => {
    it.each(cases)('$label', ({ value, expected }) => {
        expect(classifyFileUrl(value)).toEqual(expected);
    });

    it('matches the current dispatcher URL branch for every fixture', async () => {
        for (const { label, value, expected } of cases) {
            const result = await dispatcherFor(value).handle({
                action: 'get_file',
                params: { file_id: 'fixture-id', type: 'url' },
            });

            if (expected.kind === 'valid') {
                expect(result, label).toEqual({
                    status: 'ok',
                    retcode: 0,
                    data: { name: '', url: expected.url },
                    message: '',
                });
            } else {
                expect(result.retcode, label).toBe(expected.kind === 'unsupported' ? 10004 : 20001);
            }
        }
    });

    it('does not coerce non-string inputs or execute proxy traps', () => {
        const trap = vi.fn(() => {
            throw new Error('unexpected property read');
        });
        const value = new Proxy({}, { get: trap });
        expect(classifyFileUrl(value)).toEqual(invalid);
        expect(trap).not.toHaveBeenCalled();
    });

    it('checks empty, length and malformed percent before invoking URL parsing', () => {
        const parse = vi.fn(function forbiddenUrl() {
            throw new Error('unexpected URL parsing');
        });
        vi.stubGlobal('URL', parse);

        expect(classifyFileUrl('')).toEqual(unsupported);
        expect(classifyFileUrl(`${maxUrl}a`)).toEqual(invalid);
        expect(classifyFileUrl('ftp://fixture.invalid/%zz')).toEqual(invalid);
        expect(parse).not.toHaveBeenCalled();
        expect(classifyFileUrl('https://fixture.invalid/a')).toEqual(invalid);
        expect(parse).toHaveBeenCalledOnce();
    });
});
