import { createHash } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { markAsUntransferable, Worker } from 'node:worker_threads';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
    createManifestWorkerData,
    createManifestWorkerHandler,
    createPluginEntryWorkerData,
    createPluginEntryWorkerHandler,
    createPreflightWorkerData,
    createPreflightWorkerHandler,
    readPluginEntryWorkerResult,
} from '../src/webui/plugin-install/preflight-worker-protocol';
import {
    ManifestPreflightWorkerTask,
    PluginEntryPreflightWorkerTask,
    PreflightWorkerTask,
    type PreflightWorker,
} from '../src/webui/plugin-install/preflight-worker-task';
import { inspectZipPluginEntry } from '../src/webui/plugin-install/zip-preflight';

function archive(method: 0 | 8, manifest: string, member: string): Buffer {
    const locals: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;

    for (const [path, text] of [
        ['package.json', manifest],
        [member, '// inert fixture'],
    ]) {
        const name = Buffer.from(path);
        const bytes = Buffer.from(text);
        const body = method === 8 ? deflateRawSync(bytes) : bytes;
        const crc = crc32(bytes);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(bytes.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(bytes.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        directory.push(central, name);
        offset += local.length + name.length + body.length;
    }

    const central = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(2, 8);
    end.writeUInt16LE(2, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, central, end]);
}

const stored = archive(
    0,
    '{"main":"fixture-marker/entry.js","type":"module"}',
    'fixture-marker/entry.js',
);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = hash(stored);
const otherHash = 'ab'.repeat(32);
const request = (bytes: unknown) => ({ kind: 'zip-plugin-entry', version: 3, bytes });
const envelope = (result: unknown, sha256 = digest) => ({
    kind: 'zip-plugin-entry-result',
    version: 3,
    sha256,
    result,
});
const candidate = () => ({
    ok: true,
    sha256: digest,
    manifest: { main: 'string', type: 'module' },
    entry: { source: 'declared', status: 'candidate', format: 'js' },
});
const archiveFailure = (code: string) => ({ ok: false, code });
const taskFailure = (code: string) => ({ kind: 'failure', code });
const fakePort = () => ({ postMessage: vi.fn<(message: unknown) => void>(), close: vi.fn() });

function observationProbe() {
    const observe = vi.fn((): never => {
        throw new Error('unexpected observation');
    });
    return {
        observe,
        getter: { get: observe },
        traps: {
            get: observe,
            getPrototypeOf: observe,
            ownKeys: observe,
            getOwnPropertyDescriptor: observe,
        },
    };
}

class FakeWorker extends EventEmitter implements PreflightWorker {
    terminate = vi.fn(async () => 0);
}

function start(worker: FakeWorker) {
    return new PluginEntryPreflightWorkerTask(
        () => worker,
        20,
        () => 0,
    ).start(stored, {
        timeoutMs: 1000,
    });
}

describe('offline plugin entry worker v3', () => {
    it.each([
        ['stored', stored, candidate()],
        [
            'DEFLATE',
            archive(8, '{}', 'index.mjs'),
            {
                ok: true,
                manifest: { main: 'absent', type: 'absent' },
                entry: { source: 'fallback', status: 'candidate', format: 'mjs' },
            },
        ],
        ['invalid manifest', archive(0, '{', 'index.mjs'), archiveFailure('manifest_invalid')],
        ['invalid ZIP', Buffer.from([1]), archiveFailure('malformed')],
    ] as const)(
        'posts only the exact offline %s projection for a copied view',
        (_, bytes, shape) => {
            const wrapped = Buffer.concat([Buffer.from([9]), bytes, Buffer.from([8])]);
            const view = wrapped.subarray(1, -1);
            const data = createPluginEntryWorkerData(view);
            const alias = new Uint8Array(data.bytes);
            expect(data).toStrictEqual(request(data.bytes));
            expect(Buffer.from(alias)).toEqual(bytes);
            const port = fakePort();
            const handle = createPluginEntryWorkerHandler(port);
            const result = inspectZipPluginEntry(bytes);
            const sha256 = hash(bytes);
            expect(result).toStrictEqual(shape.ok ? { ...shape, sha256 } : shape);
            expect(handle(data)).toBe('sent');
            expect(handle(data)).toBe('already_handled');
            expect(alias.byteLength).toBe(0);
            expect(view).toEqual(bytes);
            expect(wrapped.length).toBe(bytes.length + 2);
            expect(port.postMessage).toHaveBeenCalledExactlyOnceWith(envelope(result, sha256));
            expect(port.close).toHaveBeenCalledOnce();
        },
    );

    it('rejects invalid buffers and adapter data without observing input properties', () => {
        const { observe, getter, traps } = observationProbe();
        const bytes = new ArrayBuffer(1);
        const detached = new ArrayBuffer(1);
        structuredClone(detached, { transfer: [detached] });
        const marked = new ArrayBuffer(1);
        markAsUntransferable(marked);
        const oversized = new ArrayBuffer(32 * 1024 * 1024 + 1);
        const Resizable = ArrayBuffer as unknown as new (
            length: number,
            options: { maxByteLength: number },
        ) => ArrayBuffer;
        const shared = new SharedArrayBuffer(1);
        const decorated = Object.defineProperty(new ArrayBuffer(1), 'extra', getter);

        for (const value of [
            Object.defineProperty(request(bytes), 'bytes', getter),
            { ...request(bytes), extra: true },
            { ...request(bytes), version: 2 },
            { ...request(bytes), kind: 'zip-manifest' },
            new Proxy(request(bytes), traps),
            ...[
                new Proxy(bytes, traps),
                new Uint8Array(1),
                detached,
                marked,
                shared,
                oversized,
                new Resizable(1, { maxByteLength: 2 }),
                decorated,
            ].map(request),
        ]) {
            const port = fakePort();
            expect(createPluginEntryWorkerHandler(port)(value)).toBe('invalid_request');
            expect(port.postMessage).not.toHaveBeenCalled();
            expect(port.close).toHaveBeenCalledOnce();
        }

        for (const port of [
            Object.defineProperty(fakePort(), 'postMessage', getter),
            new Proxy(fakePort(), traps),
        ]) {
            expect(createPluginEntryWorkerHandler(port)(request(bytes))).toBe('invalid_port');
        }

        for (const input of [
            new Proxy(Uint8Array.of(1), traps),
            new Uint8Array(shared),
            new Uint8Array(oversized),
        ]) {
            expect(() => createPluginEntryWorkerData(input)).toThrow('invalid_preflight_input');
        }

        expect(marked.byteLength).toBe(1);
        expect(bytes.byteLength).toBe(1);
        expect(observe).not.toHaveBeenCalled();
    });

    it('rejects mixed requests and shares one-shot port ownership with v1 and v2', () => {
        for (const [legacyHandler, legacyData] of [
            [createPreflightWorkerHandler, createPreflightWorkerData],
            [createManifestWorkerHandler, createManifestWorkerData],
        ] as const) {
            const v3 = createPluginEntryWorkerData(stored);
            const legacy = legacyData(stored);

            for (const [first, wrong, second, right] of [
                [createPluginEntryWorkerHandler, legacy, legacyHandler, legacy],
                [legacyHandler, v3, createPluginEntryWorkerHandler, v3],
            ] as const) {
                const port = fakePort();
                expect(first(port)(wrong)).toBe('invalid_request');
                expect(second(port)(right)).toBe('already_handled');
                expect(right.bytes.byteLength).toBe(stored.length);
                expect(port.postMessage).not.toHaveBeenCalled();
                expect(port.close).toHaveBeenCalledOnce();
            }
        }
    });

    it.each(['postMessage', 'close'] as const)(
        'normalizes %s failures and blocks reentry',
        (phase) => {
            const data = createPluginEntryWorkerData(stored);
            const port = fakePort();
            const handle = createPluginEntryWorkerHandler(port);
            let nested: unknown;
            port[phase].mockImplementation(() => {
                nested = handle(data);
                throw new Error('fixture-private');
            });
            const expected =
                phase === 'postMessage' ? 'preflight_send_failed' : 'preflight_close_failed';
            expect(() => handle(data)).toThrow(new Error(expected));
            expect(nested).toBe('already_handled');
            expect(port.postMessage).toHaveBeenCalledOnce();
            expect(port.close).toHaveBeenCalledOnce();
        },
    );
});

describe('v3 worker result reader', () => {
    it('copies and freezes all DTO layers and accepts only existing failure codes', () => {
        const raw = candidate();
        const message = envelope(raw);
        const projected = readPluginEntryWorkerResult(message, digest);
        expect(projected).toStrictEqual(message);

        if (!projected?.result.ok) {
            throw new Error('expected a successful projection');
        }

        for (const [actual, input] of [
            [projected, message],
            [projected.result, raw],
            [projected.result.manifest, raw.manifest],
            [projected.result.entry, raw.entry],
        ]) {
            expect(actual).not.toBe(input);
            expect(Object.isFrozen(actual)).toBe(true);
        }

        raw.manifest.main = 'changed';
        raw.entry.format = 'changed';
        expect(projected).toStrictEqual(envelope(candidate()));

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
            const value = envelope(archiveFailure(code));
            const output = readPluginEntryWorkerResult(value, digest);
            expect(output).toStrictEqual(value);
            expect(Object.isFrozen(output?.result)).toBe(true);
        }
    });

    it('accepts only coherent main/type/source/status/format combinations', () => {
        for (const [valid, main, type, source, status, format] of [
            [true, 'absent', 'module', 'fallback', 'candidate', 'js'],
            [true, 'string', 'non_string', 'declared', 'candidate', 'mjs'],
            [true, 'string', 'module', 'declared', 'scope_unknown'],
            [true, 'absent', 'commonjs', 'fallback', 'module_type_required'],
            [true, 'empty', 'module', 'declared', 'invalid_main'],
            [true, 'non_string', 'absent', 'declared', 'invalid_main'],
            [true, 'string', 'module', 'declared', 'invalid_main'],
            [true, 'absent', 'absent', 'fallback', 'missing'],
            [true, 'string', 'other_string', 'declared', 'unsupported_extension'],
            [true, 'absent', 'absent', 'fallback', 'directory'],
            [false, 'absent', 'module', 'declared', 'candidate', 'js'],
            [false, 'string', 'module', 'fallback', 'candidate', 'js'],
            [false, 'absent', 'module', 'fallback', 'invalid_main'],
            [false, 'absent', 'module', 'fallback', 'unsupported_extension'],
            [false, 'absent', 'module', 'fallback', 'scope_unknown'],
            [false, 'string', 'commonjs', 'declared', 'candidate', 'js'],
            [false, 'string', 'absent', 'declared', 'scope_unknown'],
            [false, 'string', 'module', 'declared', 'module_type_required'],
            [false, 'empty', 'module', 'declared', 'candidate', 'mjs'],
            [false, 'non_string', 'absent', 'declared', 'missing'],
            [false, 'string', 'module', 'declared', 'candidate', 'cjs'],
            [false, 'string', 'module', 'declared', 'candidate'],
            [false, 'string', 'module', 'declared', 'directory', 'mjs'],
        ] as const) {
            const entry = format === undefined ? { source, status } : { source, status, format };
            const value = envelope({ ...candidate(), manifest: { main, type }, entry });
            expect(
                readPluginEntryWorkerResult(value, digest),
                JSON.stringify(value.result),
            ).toStrictEqual(valid ? value : null);
        }
    });

    it('rejects inexact DTOs, hash mismatches, and any accessor or Proxy without invoking it', () => {
        const { observe, getter, traps } = observationProbe();
        const raw = candidate();

        for (const value of [
            Object.defineProperty(envelope(raw), 'sha256', getter),
            envelope(Object.defineProperty(candidate(), 'ok', getter)),
            envelope({
                ...raw,
                manifest: Object.defineProperty({ ...raw.manifest }, 'main', getter),
            }),
            envelope({ ...raw, entry: Object.defineProperty({ ...raw.entry }, 'format', getter) }),
            new Proxy(envelope(raw), traps),
            envelope(new Proxy(raw, traps)),
            envelope({ ...raw, manifest: new Proxy(raw.manifest, traps) }),
            envelope({ ...raw, entry: new Proxy(raw.entry, traps) }),
            { ...envelope(raw), [Symbol('extra')]: true },
            envelope({ ...raw, extra: true }),
            envelope({ ...raw, manifest: { ...raw.manifest, extra: true } }),
            envelope({
                ...raw,
                entry: Object.defineProperty({ ...raw.entry }, 'extra', { value: true }),
            }),
            envelope({ ...archiveFailure('integrity'), sha256: digest }),
            envelope(archiveFailure('invalid_main')),
            envelope(archiveFailure('integrity'), otherHash),
            envelope({ ...raw, sha256: otherHash }),
            { ...envelope(raw), version: 2 },
            { ...envelope(raw), kind: 'zip-manifest-result' },
        ]) {
            expect(readPluginEntryWorkerResult(value, digest)).toBeNull();
        }

        expect(readPluginEntryWorkerResult(envelope(raw), digest.toUpperCase())).toBeNull();
        expect(observe).not.toHaveBeenCalled();
    });
});

describe('v3 preflight worker task', () => {
    it('transfers a private archive snapshot to a one-shot source Worker', async () => {
        const protocol = new URL(
            '../src/webui/plugin-install/preflight-worker-protocol.ts',
            import.meta.url,
        ).href;
        // Only this constant adapter is executed. Archive members are data.
        const script = `
            const { parentPort, workerData } = require('node:worker_threads');
            import(${JSON.stringify(protocol)}).then(({ createPluginEntryWorkerHandler }) => {
                createPluginEntryWorkerHandler({
                    postMessage: (value) => parentPort.postMessage(value),
                    close: () => parentPort.close(),
                })(workerData);
            });
        `;
        const transfers: ArrayBuffer[] = [];
        const controller = new PluginEntryPreflightWorkerTask((owned) => {
            transfers.push(owned);
            return new Worker(script, {
                eval: true,
                workerData: request(owned),
                transferList: [owned],
            });
        });

        for (const input of [archive(8, '{}', 'index.mjs'), archive(0, '{', 'index.mjs')]) {
            const expected = inspectZipPluginEntry(input);
            const wrapped = Buffer.concat([Buffer.from([9]), input, Buffer.from([8])]);
            const view = wrapped.subarray(1, -1);
            const handle = controller.start(view, { timeoutMs: 4000 });
            expect(await handle.outcome).toStrictEqual({ kind: 'result', result: expected });
            expect(await handle.cleanup).toBe('released');
            expect(transfers.at(-1)?.byteLength).toBe(0);
            expect(view).toEqual(input);
        }

        expect(transfers).toHaveLength(2);
    }, 12000);

    it('snapshots the subview, holds a frozen candidate until exit zero and releases cleanly', async () => {
        const worker = new FakeWorker();
        const factory = vi.fn((_owned: ArrayBuffer) => worker);
        const controller = new PluginEntryPreflightWorkerTask(factory, 20, () => 0);
        const wrapped = Buffer.concat([Buffer.from([9]), stored, Buffer.from([8])]);
        const view = wrapped.subarray(1, -1);
        const handle = controller.start(view, { timeoutMs: 1000 });
        view.fill(0);
        expect(Buffer.from(factory.mock.calls[0][0])).toEqual(stored);
        const raw = candidate();
        worker.emit('message', envelope(raw));
        expect(await Promise.race([handle.outcome, Promise.resolve('pending')])).toBe('pending');
        expect(await Promise.race([handle.cleanup, Promise.resolve('pending')])).toBe('pending');
        raw.entry.format = 'changed';
        worker.emit('exit', 0);
        const outcome = await handle.outcome;
        expect(outcome).toStrictEqual({ kind: 'result', result: candidate() });
        expect(Object.isFrozen(outcome)).toBe(true);
        expect(await handle.cleanup).toBe('released');
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(worker.eventNames()).toEqual([]);
    });

    it('rejects old envelopes in v3 and v3 in old tasks even for overlapping error codes', async () => {
        for (const [LegacyTask, message] of [
            [PreflightWorkerTask, { kind: 'result', result: archiveFailure('malformed') }],
            [
                ManifestPreflightWorkerTask,
                {
                    ...envelope(archiveFailure('malformed')),
                    kind: 'zip-manifest-result',
                    version: 2,
                },
            ],
        ] as const) {
            const one = new FakeWorker();
            const two = new FakeWorker();
            const v3 = start(one);
            const legacy = new LegacyTask(
                () => two,
                20,
                () => 0,
            ).start(stored, { timeoutMs: 1000 });
            one.emit('message', message);
            two.emit('message', envelope(archiveFailure('malformed')));
            one.emit('exit', 0);
            two.emit('exit', 0);
            expect(await v3.outcome).toStrictEqual(taskFailure('invalid_result'));
            expect(await legacy.outcome).toStrictEqual(taskFailure('invalid_result'));
            expect(await v3.cleanup).toBe('released');
            expect(await legacy.cleanup).toBe('released');
        }
    });

    it('keeps failures fixed on duplicate, wrong digest, worker error and missing/nonzero exit', async () => {
        for (const [hasCandidate, event, value, code] of [
            [true, 'message', envelope(candidate()), 'invalid_result'],
            [false, 'message', envelope(archiveFailure('integrity'), otherHash), 'invalid_result'],
            [false, 'message', envelope({ ...candidate(), sha256: otherHash }), 'invalid_result'],
            [true, 'error', new Error('fixture-private'), 'worker_error'],
            [true, 'messageerror', new Error('fixture-private'), 'message_error'],
            [true, 'exit', 1, 'exit'],
            [false, 'exit', 0, 'exit'],
        ] as const) {
            const worker = new FakeWorker();
            const handle = start(worker);

            if (hasCandidate) {
                worker.emit('message', envelope(candidate()));
            }

            worker.emit(event, value);

            if (event !== 'exit') {
                worker.emit('message', envelope(candidate()));
                worker.emit('exit', 0);
                expect(worker.terminate).toHaveBeenCalledOnce();
            }

            expect(await handle.outcome).toStrictEqual(taskFailure(code));
            expect(await handle.cleanup).toBe('released');
        }
    });

    it('reports abort before cleanup and holds the slot until observed exit, not terminate resolution', async () => {
        vi.useFakeTimers();

        try {
            const worker = new FakeWorker();
            const nextWorker = new FakeWorker();
            const factory = vi.fn(() => nextWorker).mockReturnValueOnce(worker);
            const controller = new PluginEntryPreflightWorkerTask(factory, 20, () => 0);
            const cancellation = new AbortController();
            const handle = controller.start(stored, {
                timeoutMs: 1000,
                signal: cancellation.signal,
            });
            worker.emit('message', envelope(candidate()));
            cancellation.abort();
            expect(await handle.outcome).toStrictEqual(taskFailure('abort'));
            expect(worker.terminate).toHaveBeenCalledOnce();
            expect(await Promise.race([handle.cleanup, Promise.resolve('pending')])).toBe(
                'pending',
            );
            vi.advanceTimersByTime(20);
            expect(await handle.cleanup).toBe('unknown');
            expect(await controller.start(stored, { timeoutMs: 1000 }).outcome).toStrictEqual(
                taskFailure('busy'),
            );
            expect(getEventListeners(cancellation.signal, 'abort')).toEqual([]);
            worker.emit('exit', 0);
            expect(worker.eventNames()).toEqual([]);
            const next = controller.start(stored, { timeoutMs: 1000 });
            const result = archiveFailure('integrity');
            nextWorker.emit('message', envelope(result));
            nextWorker.emit('exit', 0);
            expect(await next.outcome).toStrictEqual({ kind: 'result', result });
            expect(await next.cleanup).toBe('released');
            expect(await handle.cleanup).toBe('unknown');
        } finally {
            vi.useRealTimers();
        }
    });
});
