import {
    brotliCompressSync,
    brotliDecompressSync,
    deflateSync,
    gunzipSync,
    gzipSync,
    inflateSync,
} from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';

const baseUrl = 'http://fixture.invalid/';
const envelope = { status: 'ok', retcode: 0, data: null, message: '' };
const decoded = Buffer.from(JSON.stringify(envelope));

function fixture(headers: HeadersInit, chunks: Uint8Array[] = [decoded], status = 200) {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        const chunk = chunks.shift();

        if (chunk) {
            controller.enqueue(chunk);
        } else {
            controller.close();
        }
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(body, { headers, status });
    const fetchImpl = vi.fn(async () => response);
    return { body, cancel, fetchImpl, pull, response };
}

function client(fetchImpl: typeof fetch, maxResponseBytes = decoded.byteLength) {
    return new OneBot12HttpClient({ baseUrl, fetch: fetchImpl, maxResponseBytes });
}

describe('OneBot 12 HTTP content encoding (in-memory fetch)', () => {
    beforeEach(() => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
            throw new Error('Unexpected network fetch');
        });
    });

    afterEach(() => {
        expect(globalThis.fetch).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it.each([
        ['gzip', gzipSync, gunzipSync],
        ['deflate', deflateSync, inflateSync],
        ['br', brotliCompressSync, brotliDecompressSync],
    ])(
        'accepts decoded JSON at the exact limit with larger real %s bytes',
        async (encoding, compress, decompress) => {
            const compressed = compress(decoded);
            expect(compressed.byteLength).toBeGreaterThan(decoded.byteLength);
            expect(decompress(compressed)).toEqual(decoded);
            const fake = fixture({
                'Content-Encoding': encoding,
                'Content-Length': String(compressed.byteLength),
            });
            await expect(client(fake.fetchImpl).request('x')).resolves.toEqual(envelope);
            expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
            expect(fake.pull).toHaveBeenCalled();
            expect(fake.cancel).not.toHaveBeenCalled();
        },
    );

    it.each([' GZip ', 'gzip, br', 'unknown', ''])(
        'treats non-identity encoding %j conservatively',
        async (encoding) => {
            const fake = fixture({
                'Content-Encoding': encoding,
                'Content-Length': String(decoded.byteLength + 10),
            });
            await expect(client(fake.fetchImpl).request('x')).resolves.toEqual(envelope);
            expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
            expect(fake.pull).toHaveBeenCalled();
        },
    );

    it.each([undefined, 'identity', '  IdEnTiTy  '])(
        'accepts exact Content-Length for encoding %j',
        async (encoding) => {
            const headers = new Headers({ 'Content-Length': ` ${decoded.byteLength} ` });

            if (encoding !== undefined) {
                headers.set('Content-Encoding', encoding);
            }

            const fake = fixture(headers);
            await expect(client(fake.fetchImpl).request('x')).resolves.toEqual(envelope);
            expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
        },
    );

    it.each([undefined, 'identity', '  IDENTITY  '])(
        'rejects oversized declared length before reading encoding %j',
        async (encoding) => {
            const headers = new Headers({ 'Content-Length': ` ${decoded.byteLength + 1} ` });

            if (encoding !== undefined) {
                headers.set('Content-Encoding', encoding);
            }

            const fake = fixture(headers);
            await expect(client(fake.fetchImpl).request('x')).rejects.toMatchObject({
                code: 'limit',
            });
            expect(fake.cancel).toHaveBeenCalledTimes(1);
            expect(fake.pull).not.toHaveBeenCalled();
            expect(fake.body.locked).toBe(false);
            expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['not-a-number', '-1', '1.0', '999999x'])(
        'ignores invalid Content-Length %j',
        async (length) => {
            const fake = fixture({ 'Content-Length': length });
            await expect(client(fake.fetchImpl).request('x')).resolves.toEqual(envelope);
            expect(fake.pull).toHaveBeenCalled();
            expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
        },
    );

    it('limits decoded chunks, cancels the reader and never retries or leaks the body', async () => {
        const secret = 'sensitive-response';
        const oversized = Buffer.from(JSON.stringify({ ...envelope, data: secret.repeat(30) }));
        const compressed = gzipSync(oversized);
        expect(gunzipSync(compressed)).toEqual(oversized);
        expect(compressed.byteLength).toBeLessThan(oversized.byteLength);
        const fake = fixture(
            { 'Content-Encoding': 'gzip', 'Content-Length': String(compressed.byteLength) },
            [oversized.subarray(0, decoded.byteLength), oversized.subarray(decoded.byteLength)],
        );
        const error = await client(fake.fetchImpl)
            .request('x')
            .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ code: 'limit' });
        expect(String(error)).not.toContain(secret);
        expect(fake.pull).toHaveBeenCalledTimes(2);
        expect(fake.cancel).toHaveBeenCalledTimes(1);
        expect(fake.body.locked).toBe(false);
        expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])(
        'counts split multibyte UTF-8 chunks at the exact boundary: %s',
        async (atBoundary) => {
            const value = { ...envelope, data: '你好' };
            const json = JSON.stringify(value);
            const bytes = Buffer.from(json);
            const compressed = gzipSync(bytes);
            const split = bytes.indexOf(Buffer.from('你'));
            expect(bytes.byteLength).toBeGreaterThan(json.length);
            expect(split).toBeGreaterThan(-1);
            expect(gunzipSync(compressed)).toEqual(bytes);
            const fake = fixture(
                { 'Content-Encoding': 'gzip', 'Content-Length': String(compressed.byteLength) },
                [bytes.subarray(0, split + 1), bytes.subarray(split + 1)],
            );
            const request = client(fake.fetchImpl, bytes.byteLength - (atBoundary ? 0 : 1)).request(
                'x',
            );

            if (atBoundary) {
                await expect(request).resolves.toEqual(value);
                expect(fake.cancel).not.toHaveBeenCalled();
            } else {
                await expect(request).rejects.toMatchObject({ code: 'limit' });
                expect(fake.cancel).toHaveBeenCalledTimes(1);
                expect(fake.body.locked).toBe(false);
            }

            expect(fake.pull).toHaveBeenCalledTimes(atBoundary ? 3 : 2);
            expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
        },
    );

    it('cancels a non-200 response body without reading or retrying', async () => {
        const fake = fixture({ 'Content-Encoding': 'gzip' }, [decoded], 503);
        await expect(client(fake.fetchImpl).request('x')).rejects.toMatchObject({
            code: 'http_status',
            status: 503,
        });
        expect(fake.pull).not.toHaveBeenCalled();
        expect(fake.cancel).toHaveBeenCalledTimes(1);
        expect(fake.body.locked).toBe(false);
        expect(fake.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending decoded read on abort without retry', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
        const fetchImpl = vi.fn(
            async () =>
                new Response(body, {
                    headers: { 'Content-Encoding': 'gzip', 'Content-Length': '1' },
                }),
        );
        const controller = new AbortController();
        const request = client(fetchImpl).request('x', {}, { signal: controller.signal });
        await vi.waitFor(() => expect(body.locked).toBe(true));
        controller.abort();
        await expect(request).rejects.toMatchObject({ code: 'aborted' });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
