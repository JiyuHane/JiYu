import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { markAsUntransferable, Worker } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
    createManifestWorkerData,
    createManifestWorkerHandler,
    createPreflightWorkerData,
    createPreflightWorkerHandler,
    readManifestWorkerResult,
} from '../src/webui/plugin-install/preflight-worker-protocol';
import {
    PreflightWorkerTask,
    type PreflightWorker,
} from '../src/webui/plugin-install/preflight-worker-task';
import * as parser from '../src/webui/plugin-install/zip-preflight';

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;

    for (const byte of bytes) {
        crc ^= byte;

        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function zip(content: string, method: 0 | 8 = 0, name = 'package.json'): Buffer {
    const data = Buffer.from(content);
    const filename = Buffer.from(name);
    const body = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + filename.length, 12);
    end.writeUInt32LE(30 + filename.length + body.length, 16);
    return Buffer.concat([local, filename, body, central, filename, end]);
}

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const port = () => ({ postMessage: vi.fn(), close: vi.fn() });
const digest = 'ab'.repeat(32);
const success = () => ({
    kind: 'zip-manifest-result',
    version: 2,
    sha256: digest,
    result: { ok: true, sha256: digest, manifest: { main: 'string', type: 'module' } },
});
const failed = (code = 'integrity') => ({
    kind: 'zip-manifest-result',
    version: 2,
    sha256: digest,
    result: { ok: false, code },
});
const protocolUrl = new URL(
    '../src/webui/plugin-install/preflight-worker-protocol.ts',
    import.meta.url,
).href;
const zipUrl = new URL('../src/webui/plugin-install/zip-preflight.ts', import.meta.url).href;
const workerScript = `
  const {parentPort, workerData} = require('node:worker_threads');
  Promise.all([import(${JSON.stringify(protocolUrl)}), import(${JSON.stringify(zipUrl)})])
    .then(([protocol]) => protocol.createManifestWorkerHandler({
      postMessage: (m) => parentPort.postMessage(m),
      close: () => parentPort.close(),
    })(workerData));
`;

async function runWorker(data: unknown, transferList: ArrayBuffer[] = [], script = workerScript) {
    const worker = new Worker(script, { eval: true, workerData: data, transferList });
    const messages: unknown[] = [];
    const errors: string[] = [];
    worker.on('message', (message: unknown) => messages.push(message));
    worker.on('error', (error) => errors.push(error.message));
    const code = await new Promise<number>((resolve) => worker.on('exit', resolve));
    return { code, messages, errors };
}

describe('offline manifest worker v2', () => {
    it('runs real one-shot source Workers for stored, deflate and failure snapshots', async () => {
        const broken = zip('{"type":"module"}');
        broken[30 + 'package.json'.length] ^= 1;
        const fixtures = [
            zip('{"main":"private/marker.js","type":"module"}'),
            zip('{"main":"private/marker.js","type":"commonjs"}', 8),
            zip('{'),
            zip('{}', 0, 'other.json'),
            broken,
            Buffer.from([1, 2]),
            Buffer.alloc(0),
        ];

        for (const fixture of fixtures) {
            const wrapped = Buffer.concat([Buffer.from([5]), fixture, Buffer.from([6])]);
            const input = wrapped.subarray(1, -1);
            const expected = parser.inspectZipManifest(input);
            const workerData = createManifestWorkerData(input);
            const run = runWorker(workerData, [workerData.bytes]);
            expect(workerData.bytes.byteLength).toBe(0);
            const output = await run;
            expect(output.code).toBe(0);
            expect(output.errors).toEqual([]);
            expect(output.messages).toEqual([
                { kind: 'zip-manifest-result', version: 2, sha256: hash(input), result: expected },
            ]);
            const validated = readManifestWorkerResult(output.messages[0], hash(input));
            expect(validated).toEqual(output.messages[0]);
            expect(Object.isFrozen(validated)).toBe(true);
            expect(Object.isFrozen(validated!.result)).toBe(true);

            if (validated!.result.ok) {
                expect(Object.isFrozen(validated!.result.manifest)).toBe(true);
            }

            expect(JSON.stringify(output.messages)).not.toContain('private/marker');
            expect(JSON.stringify(output.messages)).not.toContain('package.json');
            expect(wrapped.byteLength).toBe(fixture.length + 2);
            expect(input.equals(fixture)).toBe(true);
        }
    }, 30000);

    it('returns zero messages for bad request and nonzero natural exit for send/close failures', async () => {
        const bad = createManifestWorkerData(Uint8Array.of(1));
        const invalid = await runWorker({ ...bad, kind: 'zip-preflight' }, [bad.bytes]);
        expect(invalid).toEqual({ code: 0, messages: [], errors: [] });

        for (const phase of ['send', 'close'] as const) {
            const data = createManifestWorkerData(Uint8Array.of(1));
            const script = workerScript.replace(
                phase === 'send'
                    ? 'postMessage: (m) => parentPort.postMessage(m)'
                    : 'close: () => parentPort.close()',
                phase === 'send'
                    ? "postMessage: (m) => { parentPort.postMessage(m); throw Error('private-secret'); }"
                    : "close: () => { parentPort.close(); throw Error('private-secret'); }",
            );
            const output = await runWorker(data, [data.bytes], script);
            expect(output.code).toBe(1);
            expect(output.messages).toHaveLength(1);
            expect(output.errors).toEqual([
                phase === 'send' ? 'preflight_send_failed' : 'preflight_close_failed',
            ]);
            expect(JSON.stringify(output)).not.toContain('private-secret');
        }
    }, 30000);

    it('copies only the input subview and transfers all local aliases', () => {
        const input = Uint8Array.of(9, 1, 2, 3, 8);
        const data = createManifestWorkerData(input.subarray(1, 4));
        const alias = new Uint8Array(data.bytes);
        const fake = port();
        expect(createManifestWorkerHandler(fake)(data)).toBe('sent');
        expect(data.bytes.byteLength).toBe(0);
        expect(alias.byteLength).toBe(0);
        expect([...input]).toEqual([9, 1, 2, 3, 8]);
        expect(fake.postMessage).toHaveBeenCalledOnce();
        expect(fake.postMessage.mock.calls[0][0]).toEqual({
            kind: 'zip-manifest-result',
            version: 2,
            sha256: hash(Uint8Array.of(1, 2, 3)),
            result: { ok: false, code: 'malformed' },
        });
        expect(fake.close).toHaveBeenCalledOnce();
    });

    it('rejects bad requests and invalid buffers before processing without executing accessors', () => {
        let reads = 0;
        const getter = Object.defineProperty({ kind: 'zip-manifest', version: 2 }, 'bytes', {
            get() {
                reads++;
                throw Error('secret');
            },
            enumerable: true,
        });
        const detached = new ArrayBuffer(1);
        structuredClone(detached, { transfer: [detached] });
        const marked = new ArrayBuffer(1);
        markAsUntransferable(marked);
        const Resize = ArrayBuffer as unknown as {
            new (length: number, options: { maxByteLength: number }): ArrayBuffer;
        };
        const decorated = new ArrayBuffer(1);
        Object.defineProperty(decorated, 'x', {
            get() {
                reads++;
                return 'secret';
            },
        });
        const inputs: unknown[] = [
            null,
            {},
            new Proxy({}, {}),
            getter,
            { kind: 'zip-preflight', version: 1, bytes: new ArrayBuffer(1) },
            { kind: 'zip-manifest', version: 3, bytes: new ArrayBuffer(1) },
            { kind: 'zip-manifest', version: 2, bytes: new SharedArrayBuffer(1) },
            { kind: 'zip-manifest', version: 2, bytes: new Uint8Array(1) },
            { kind: 'zip-manifest', version: 2, bytes: new Proxy(new ArrayBuffer(1), {}) },
            { kind: 'zip-manifest', version: 2, bytes: detached },
            { kind: 'zip-manifest', version: 2, bytes: marked },
            { kind: 'zip-manifest', version: 2, bytes: new Resize(1, { maxByteLength: 2 }) },
            { kind: 'zip-manifest', version: 2, bytes: decorated },
            { kind: 'zip-manifest', version: 2, bytes: new ArrayBuffer(32 * 1024 * 1024 + 1) },
            { kind: 'zip-manifest', version: 2, bytes: new ArrayBuffer(1), extra: 1 },
            { kind: 'zip-manifest', version: 2, bytes: new ArrayBuffer(1), [Symbol('x')]: 1 },
            Object.assign(Object.create({ inherited: 1 }), {
                kind: 'zip-manifest',
                version: 2,
                bytes: new ArrayBuffer(1),
            }),
        ];

        for (const input of inputs) {
            const fake = port();
            expect(createManifestWorkerHandler(fake)(input)).toBe('invalid_request');
            expect(fake.postMessage).not.toHaveBeenCalled();
            expect(fake.close).toHaveBeenCalledOnce();
        }

        expect(reads).toBe(0);
        expect(() => new Worker('', { eval: true, workerData: new Proxy({}, {}) })).toThrow();
    });

    it('helper rejects proxy, shared, detached, over-limit and invalid views', () => {
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });

        for (const input of [
            null,
            new Proxy(Uint8Array.of(1), {}),
            new Uint8Array(new SharedArrayBuffer(1)),
            detached,
            new Uint8Array(32 * 1024 * 1024 + 1),
        ]) {
            expect(() => createManifestWorkerData(input)).toThrow('invalid_preflight_input');
        }
    });

    it('shares sticky ownership across v1 and v2 wrappers in both orders', () => {
        for (const v1First of [true, false]) {
            const fake = port();
            const first = v1First
                ? createPreflightWorkerHandler(fake)
                : createManifestWorkerHandler(fake);
            const second = v1First
                ? createManifestWorkerHandler(fake)
                : createPreflightWorkerHandler(fake);
            const firstData = v1First
                ? createPreflightWorkerData(Uint8Array.of(1))
                : createManifestWorkerData(Uint8Array.of(1));
            const secondData = v1First
                ? createManifestWorkerData(Uint8Array.of(2))
                : createPreflightWorkerData(Uint8Array.of(2));
            expect(first(firstData)).toBe('sent');
            expect(second(secondData)).toBe('already_handled');
            expect(first(firstData)).toBe('already_handled');
            expect(secondData.bytes.byteLength).toBe(1);
            expect(fake.postMessage).toHaveBeenCalledOnce();
            expect(fake.close).toHaveBeenCalledOnce();
        }
    });

    it('reserves before port reentry and translates send/close errors', () => {
        let nested = '';
        const data = createManifestWorkerData(Uint8Array.of(1));
        let handler: ReturnType<typeof createManifestWorkerHandler>;
        const fake = {
            postMessage: vi.fn(() => {
                nested = handler(data);
                throw Error('secret path');
            }),
            close: vi.fn(() => {
                throw Error('secret path');
            }),
        };
        handler = createManifestWorkerHandler(fake);
        expect(() => handler(data)).toThrow('preflight_close_failed');
        expect(nested).toBe('already_handled');
        expect(fake.postMessage).toHaveBeenCalledOnce();
        expect(fake.close).toHaveBeenCalledOnce();
        const fake2 = {
            postMessage: () => {
                throw Error('secret');
            },
            close: vi.fn(),
        };
        expect(() =>
            createManifestWorkerHandler(fake2)(createManifestWorkerData(Uint8Array.of(1))),
        ).toThrow('preflight_send_failed');
        expect(fake2.close).toHaveBeenCalledOnce();
        expect(createManifestWorkerHandler(null)(createManifestWorkerData(Uint8Array.of(1)))).toBe(
            'invalid_port',
        );
    });

    it('closes without a message when parser throws', () => {
        const spy = vi.spyOn(parser, 'inspectZipManifest').mockImplementationOnce(() => {
            throw Error('secret');
        });
        const fake = port();

        try {
            expect(
                createManifestWorkerHandler(fake)(createManifestWorkerData(Uint8Array.of(1))),
            ).toBe('invalid_request');
            expect(fake.postMessage).not.toHaveBeenCalled();
            expect(fake.close).toHaveBeenCalledOnce();
        } finally {
            spy.mockRestore();
        }
    });

    it('validates exact hashes, enum, envelope, error set, and preserves no references', () => {
        const value = success();
        const result = readManifestWorkerResult(value, digest);
        expect(result).toEqual(value);
        expect(result).not.toBe(value);
        expect(result!.result).not.toBe(value.result);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result!.result)).toBe(true);

        if (result!.result.ok) {
            expect(Object.isFrozen(result!.result.manifest)).toBe(true);
            expect(result!.result.manifest).not.toBe(value.result.manifest);
        }

        value.result.manifest.main = 'changed';
        expect(result).toEqual(success());

        for (const code of [
            'malformed',
            'unsupported',
            'unsafe_path',
            'collision',
            'integrity',
            'limit',
            'invalid_input',
            'internal',
            'manifest_missing',
            'manifest_too_large',
            'manifest_invalid',
            'manifest_internal',
        ]) {
            expect(readManifestWorkerResult(failed(code), digest)).toEqual(failed(code));
        }

        for (const expected of [
            null,
            '',
            digest.toUpperCase(),
            'g'.repeat(64),
            digest + 'a',
            new Proxy({}, {}),
        ]) {
            expect(readManifestWorkerResult(success(), expected)).toBeNull();
        }

        const altered = success();
        altered.result.sha256 = '00'.repeat(32);
        const checks: unknown[] = [
            null,
            new Proxy(success(), {}),
            { ...success(), extra: 1 },
            { ...success(), [Symbol('x')]: 1 },
            { ...success(), version: 1 },
            { ...success(), kind: 'result' },
            { ...success(), sha256: '00'.repeat(32) },
            altered,
            { ...failed(), result: { ok: false, code: 'secret' } },
            { ...failed(), result: { ok: false, code: 'internal', extra: 1 } },
            { ...success(), result: { ...success().result, extra: 1 } },
            {
                ...success(),
                result: { ...success().result, manifest: { main: 'private/path', type: 'module' } },
            },
            {
                ...success(),
                result: { ...success().result, manifest: { main: 'string', type: 'bad' } },
            },
            {
                ...success(),
                result: {
                    ...success().result,
                    manifest: { main: 'string', type: 'module', extra: 1 },
                },
            },
            { ...success(), result: new Proxy(success().result, {}) },
            { ...success(), result: { ...success().result, manifest: new Proxy({}, {}) } },
            { kind: 'result', result: { ok: false, code: 'integrity' } },
            { ...failed(), result: { ok: 0, code: 'integrity' } },
            Object.assign(Object.create({ inherited: true }), success()),
        ];

        for (const item of checks) {
            expect(readManifestWorkerResult(item, digest)).toBeNull();
        }
    });

    it('accepts only the supported classification values and detached failure copies', () => {
        for (const main of ['absent', 'empty', 'string', 'non_string']) {
            for (const type of ['absent', 'module', 'commonjs', 'other_string', 'non_string']) {
                const input = {
                    ...success(),
                    result: { ok: true, sha256: digest, manifest: { main, type } },
                };
                expect(readManifestWorkerResult(input, digest)).toEqual(input);
            }
        }

        const input = failed('manifest_invalid');
        const output = readManifestWorkerResult(input, digest);
        expect(output).toEqual(input);
        expect(output).not.toBe(input);
        expect(output!.result).not.toBe(input.result);
        expect(Object.isFrozen(output!.result)).toBe(true);
        input.result.code = 'secret';
        expect(output).toEqual(failed('manifest_invalid'));
    });

    it('rejects accessor properties without calling them, including polluted prototypes', () => {
        let reads = 0;

        const getter = () => {
            reads++;
            throw Error('secret');
        };

        for (const key of ['kind', 'version', 'sha256', 'result']) {
            const value = success();
            Object.defineProperty(value, key, { enumerable: true, get: getter });
            expect(readManifestWorkerResult(value, digest)).toBeNull();
        }

        const raw = success();
        Object.defineProperty(raw.result, 'ok', { get: getter, enumerable: true });
        expect(readManifestWorkerResult(raw, digest)).toBeNull();
        const value = success();
        Object.defineProperty(value.result.manifest, 'main', { get: getter, enumerable: true });
        expect(readManifestWorkerResult(value, digest)).toBeNull();
        Object.defineProperty(Object.prototype, 'workerProbe', { get: getter, configurable: true });

        try {
            expect(readManifestWorkerResult(success(), digest)).toEqual(success());
        } finally {
            delete (Object.prototype as { workerProbe?: unknown }).workerProbe;
        }

        expect(reads).toBe(0);
    });

    it('v1 task rejects v2 success and overlapping error code envelopes', async () => {
        class FakeWorker extends EventEmitter implements PreflightWorker {
            terminate() {
                return Promise.resolve();
            }
        }

        for (const value of [success(), failed('malformed')]) {
            const worker = new FakeWorker();
            const task = new PreflightWorkerTask(() => worker).start(Uint8Array.of(1), {
                timeoutMs: 1000,
            });
            worker.emit('message', value);
            expect(await task.outcome).toEqual({ kind: 'failure', code: 'invalid_result' });
            worker.emit('exit', 1);
            expect(await task.cleanup).toBe('released');
        }
    });
});
