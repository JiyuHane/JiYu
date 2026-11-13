import { createHash } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { Worker } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
    ManifestPreflightWorkerTask,
    PreflightWorkerTask,
    type ManifestWorkerTaskOutcome,
    type PreflightWorker,
} from '../src/webui/plugin-install/preflight-worker-task';
import { readManifestWorkerResult as exportedReader } from '../src/webui/plugin-install/preflight-worker-protocol';
import { readManifestWorkerResult as pureReader } from '../src/webui/plugin-install/manifest-worker-result';
import {
    inspectZipManifest,
    type ZipManifestResult,
} from '../src/webui/plugin-install/zip-preflight';

class FakeWorker extends EventEmitter implements PreflightWorker {
    terminate = vi.fn<() => Promise<unknown>>(() => new Promise(() => {}));
}
const input = Uint8Array.of(1, 2, 3);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const failure = (code: string) => ({ kind: 'failure', code });
const candidate = (bytes = input) => ({
    kind: 'zip-manifest-result',
    version: 2,
    sha256: digest(bytes),
    result: { ok: true, sha256: digest(bytes), manifest: { main: 'string', type: 'module' } },
});
const rejected = (code: string, bytes = input) => ({
    kind: 'zip-manifest-result',
    version: 2,
    sha256: digest(bytes),
    result: { ok: false, code },
});

function start(worker: FakeWorker, timeoutMs = 1000, cleanupMs = 20) {
    const controller = new ManifestPreflightWorkerTask(() => worker, cleanupMs);
    return { controller, task: controller.start(input, { timeoutMs }) };
}

function crc32(bytes: Uint8Array): number {
    let value = 0xffffffff;

    for (const byte of bytes) {
        value ^= byte;

        for (let bit = 0; bit < 8; bit++) {
            value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
        }
    }

    return (value ^ 0xffffffff) >>> 0;
}

function zip(content: string, method: 0 | 8 = 0, name = 'package.json'): Buffer {
    const bytes = Buffer.from(content);
    const filename = Buffer.from(name);
    const payload = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + filename.length, 12);
    end.writeUInt32LE(30 + filename.length + payload.length, 16);
    return Buffer.concat([local, filename, payload, central, filename, end]);
}

describe('manifest parent task v2', () => {
    it('preserves the protocol re-export identity', () => {
        expect(exportedReader).toBe(pureReader);
    });

    it('uses an own start, matching function lengths and facade receiver', async () => {
        expect(Object.hasOwn(ManifestPreflightWorkerTask.prototype, 'start')).toBe(true);
        expect(Object.getPrototypeOf(ManifestPreflightWorkerTask.prototype)).toBe(Object.prototype);
        expect(ManifestPreflightWorkerTask.length).toBe(1);
        expect(ManifestPreflightWorkerTask.prototype.start.length).toBe(2);
        const worker = new FakeWorker();
        let controller: ManifestPreflightWorkerTask;
        let calls = 0;
        controller = new ManifestPreflightWorkerTask(
            function (this: ManifestPreflightWorkerTask) {
                expect(this).toBe(controller);
                return worker;
            },
            20,
            function (this: ManifestPreflightWorkerTask) {
                expect(this).toBe(controller);
                calls++;
                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 100 });
        worker.emit('message', candidate());
        worker.emit('exit', 0);
        expect((await task.outcome).kind).toBe('result');
        expect(await task.cleanup).toBe('released');
        expect(calls).toBeGreaterThan(1);
    });

    it('keeps a result candidate until natural exit and deep freezes a detached copy', async () => {
        const worker = new FakeWorker();
        const { task } = start(worker);
        const value = candidate();
        let resolved = false;
        void task.outcome.then(() => {
            resolved = true;
        });
        worker.emit('message', value);
        await Promise.resolve();
        expect(resolved).toBe(false);
        value.result.manifest.main = 'changed/private';
        worker.emit('exit', 0);
        const outcome: ManifestWorkerTaskOutcome = await task.outcome;
        expect(outcome).toEqual({ kind: 'result', result: candidate().result });
        expect(Object.isFrozen(outcome)).toBe(true);

        if (outcome.kind === 'result' && outcome.result.ok) {
            expect(Object.isFrozen(outcome.result)).toBe(true);
            expect(Object.isFrozen(outcome.result.manifest)).toBe(true);
        }

        expect(JSON.stringify(outcome)).not.toContain('changed/private');
        expect(await task.cleanup).toBe('released');
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('accepts every fixed failure only after the outer digest is verified', async () => {
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
            const worker = new FakeWorker();
            const { task } = start(worker);
            worker.emit('message', rejected(code));
            worker.emit('exit', 0);
            expect(await task.outcome).toEqual({ kind: 'result', result: { ok: false, code } });
            expect(await task.cleanup).toBe('released');
        }
    });

    it('rejects bad version/tag/hash, extras, accessors, proxies and wrong result shapes', async () => {
        let invoked = 0;
        const getter = Object.defineProperty(candidate(), 'kind', {
            get() {
                invoked++;
                throw Error('private');
            },
        });
        const nestedGetter = candidate();
        Object.defineProperty(nestedGetter.result.manifest, 'main', {
            get() {
                invoked++;
                throw Error('private');
            },
        });
        const badInner = candidate();
        badInner.result.sha256 = '0'.repeat(64);
        const cases: unknown[] = [
            null,
            new Proxy(candidate(), {}),
            getter,
            nestedGetter,
            { ...candidate(), kind: 'result' },
            { ...candidate(), version: 1 },
            { ...candidate(), sha256: '0'.repeat(64) },
            { ...rejected('malformed'), sha256: '0'.repeat(64) },
            { ...rejected('malformed'), sha256: digest(input).toUpperCase() },
            { kind: 'zip-manifest-result', version: 2, result: { ok: false, code: 'malformed' } },
            { ...candidate(), extra: 'private' },
            { ...candidate(), [Symbol('x')]: 1 },
            badInner,
            { ...rejected('unknown'), result: { ok: false, code: 'private' } },
            { ...rejected('malformed'), result: { ok: false, code: 'malformed', extra: 1 } },
            { ...candidate(), result: new Proxy({}, {}) },
            { ...candidate(), result: { ...candidate().result, manifest: new Proxy({}, {}) } },
            {
                ...candidate(),
                result: {
                    ...candidate().result,
                    manifest: { main: 'private/file', type: 'module' },
                },
            },
            Object.assign(Object.create({ inherited: true }), candidate()),
        ];

        for (const value of cases) {
            const worker = new FakeWorker();
            const { task } = start(worker);
            worker.emit('message', value);
            expect(await task.outcome).toEqual(failure('invalid_result'));
            worker.emit('exit', 1);
            expect(await task.cleanup).toBe('released');
        }

        expect(invoked).toBe(0);
    });

    it('rejects cross-version success and overlapping failures both ways', async () => {
        for (const value of [candidate(), rejected('malformed')]) {
            const worker = new FakeWorker();
            const task = new PreflightWorkerTask(() => worker, 20).start(input, {
                timeoutMs: 1000,
            });
            worker.emit('message', value);
            expect(await task.outcome).toEqual(failure('invalid_result'));
            worker.emit('exit', 1);
            await task.cleanup;
        }

        for (const value of [
            { kind: 'result', result: { ok: false, code: 'malformed' } },
            {
                kind: 'result',
                result: { ok: true, entries: [], totalSize: 0, sha256: digest(input) },
            },
        ]) {
            const worker = new FakeWorker();
            const { task } = start(worker);
            worker.emit('message', value);
            expect(await task.outcome).toEqual(failure('invalid_result'));
            worker.emit('exit', 1);
            await task.cleanup;
        }
    });

    it.each(['nonzero', 'empty', 'error', 'messageerror', 'abort', 'duplicate'] as const)(
        'resolves %s without selecting a candidate prematurely',
        async (mode) => {
            const worker = new FakeWorker();
            const signal = new AbortController();
            const controller = new ManifestPreflightWorkerTask(() => worker, 20);
            const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });

            if (mode !== 'empty') {
                worker.emit('message', candidate());
            }

            if (mode === 'nonzero') {
                worker.emit('exit', 1);
            }

            if (mode === 'empty') {
                worker.emit('exit', 0);
            }

            if (mode === 'error') {
                worker.emit('error', Error('private'));
            }

            if (mode === 'messageerror') {
                worker.emit('messageerror', Error('private'));
            }

            if (mode === 'abort') {
                signal.abort();
            }

            if (mode === 'duplicate') {
                worker.emit('message', candidate());
            }

            const code =
                mode === 'nonzero' || mode === 'empty'
                    ? 'exit'
                    : mode === 'error'
                      ? 'worker_error'
                      : mode === 'messageerror'
                        ? 'message_error'
                        : mode === 'duplicate'
                          ? 'invalid_result'
                          : 'abort';
            expect(await task.outcome).toEqual(failure(code));

            if (mode !== 'nonzero' && mode !== 'empty') {
                worker.emit('exit', 1);
            }

            expect(await task.cleanup).toBe('released');
            expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
        },
    );

    it('retains timeout after a late candidate and exit', async () => {
        const worker = new FakeWorker();
        const { task } = start(worker, 5, 100);
        expect(await task.outcome).toEqual(failure('timeout'));
        worker.emit('message', candidate());
        worker.emit('exit', 0);
        expect(await task.outcome).toEqual(failure('timeout'));
        expect(await task.cleanup).toBe('released');
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it.each(['reject', 'fulfilled', 'hang'] as const)(
        'keeps %s termination unknown until an actual late exit',
        async (mode) => {
            const worker = new FakeWorker();

            if (mode === 'reject') {
                worker.terminate.mockRejectedValue(Error('private'));
            }

            if (mode === 'fulfilled') {
                worker.terminate.mockResolvedValue(0);
            }

            const { controller, task } = start(worker, 5, 10);
            expect(await task.outcome).toEqual(failure('timeout'));
            expect(await task.cleanup).toBe('unknown');
            expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                failure('busy'),
            );
            worker.emit('error', Error('private'));
            worker.emit('exit', 1);
            const next = controller.start(input, { timeoutMs: 100 });
            worker.emit('exit', 0);
            expect(await next.cleanup).toBe('released');
        },
    );

    it('preserves first error against reentrant native abort and deferred exit', async () => {
        const worker = new FakeWorker();
        const signal = new AbortController();
        let fire = false;
        let nested: ReturnType<ManifestPreflightWorkerTask['start']> | undefined;
        const controller = new ManifestPreflightWorkerTask(
            () => worker,
            20,
            () => {
                if (fire) {
                    fire = false;
                    signal.abort();
                    worker.emit('exit', 0);
                    nested = controller.start(input, { timeoutMs: 100 });
                    expect(worker.listenerCount('error')).toBeGreaterThan(0);
                }

                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
        worker.emit('message', candidate());
        fire = true;
        worker.emit('error', Error('private'));
        expect(await nested!.outcome).toEqual(failure('busy'));
        expect(await task.outcome).toEqual(failure('worker_error'));
        expect(await task.cleanup).toBe('released');
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('reserves the instance slot before clock or factory reentry', async () => {
        const worker = new FakeWorker();
        let nestedClock: ReturnType<ManifestPreflightWorkerTask['start']> | undefined;
        let nestedFactory: ReturnType<ManifestPreflightWorkerTask['start']> | undefined;
        let calls = 0;
        let controller: ManifestPreflightWorkerTask;
        controller = new ManifestPreflightWorkerTask(
            function (this: ManifestPreflightWorkerTask) {
                expect(this).toBe(controller);
                nestedFactory = this.start(input, { timeoutMs: 100 });
                return worker;
            },
            20,
            function (this: ManifestPreflightWorkerTask) {
                expect(this).toBe(controller);

                if (++calls === 1) {
                    nestedClock = this.start(input, { timeoutMs: 100 });
                }

                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 100 });
        expect(await nestedClock!.outcome).toEqual(failure('busy'));
        expect(await nestedFactory!.outcome).toEqual(failure('busy'));
        worker.emit('exit', 0);
        expect(await task.cleanup).toBe('released');
    });

    it('dynamically reads replacement callbacks using the borrowed receiver', async () => {
        const worker = new FakeWorker();
        let replacementClocks = 0;
        let originalFactories = 0;
        let replacementFactories = 0;
        const receivers: unknown[] = [];
        const owner = {
            busy: false,
            cleanupTimeoutMs: 20,
            workerFactory(this: unknown) {
                receivers.push(this);
                originalFactories++;
                return worker;
            },
            clock(this: unknown) {
                receivers.push(this);
                return 0;
            },
        };

        const replacement = function (this: unknown) {
            receivers.push(this);
            replacementFactories++;
            return worker;
        };

        owner.clock = function (this: unknown) {
            receivers.push(this);
            owner.workerFactory = replacement;
            return 0;
        };

        const task = ManifestPreflightWorkerTask.prototype.start.call(
            owner as unknown as ManifestPreflightWorkerTask,
            input,
            { timeoutMs: 100 },
        );

        owner.clock = function (this: unknown) {
            receivers.push(this);
            replacementClocks++;
            return 0;
        };

        worker.emit('message', candidate());
        worker.emit('exit', 0);
        expect((await task.outcome).kind).toBe('result');
        expect(await task.cleanup).toBe('released');
        expect(originalFactories).toBe(0);
        expect(replacementFactories).toBe(1);
        expect(replacementClocks).toBeGreaterThan(0);
        expect(receivers.every((receiver) => receiver === owner)).toBe(true);
    });

    it('keeps sticky uncertain cleanup locked and avoids spawning on a pre-aborted signal', async () => {
        const signal = new AbortController();
        signal.abort();
        const factory = vi.fn(() => new FakeWorker());
        const pre = new ManifestPreflightWorkerTask(factory, 20).start(input, {
            timeoutMs: 100,
            signal: signal.signal,
        });
        expect(await pre.outcome).toEqual(failure('abort'));
        expect(await pre.cleanup).toBe('released');
        expect(factory).not.toHaveBeenCalled();
        const worker = new FakeWorker();
        worker.on('removeListener', (event) => {
            if (event === 'message') {
                throw Error('private');
            }
        });
        const { controller, task } = start(worker);
        worker.emit('message', candidate());
        worker.emit('exit', 0);
        expect((await task.outcome).kind).toBe('result');
        expect(await task.cleanup).toBe('unknown');
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
    });

    it('uses independent slots for v1 and v2 instances', async () => {
        const first = new FakeWorker();
        const second = new FakeWorker();
        const one = new PreflightWorkerTask(() => first, 20);
        const two = new ManifestPreflightWorkerTask(() => second, 20);
        const a = one.start(input, { timeoutMs: 1000 });
        const b = two.start(input, { timeoutMs: 1000 });
        expect(await one.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
        expect(await two.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
        first.emit('exit', 0);
        second.emit('exit', 0);
        expect(await a.cleanup).toBe('released');
        expect(await b.cleanup).toBe('released');
    });

    it('fails closed on factory errors and does not expose exception details', async () => {
        for (const factory of [
            () => {
                throw Error('private/path');
            },
            () => ({}) as PreflightWorker,
        ]) {
            const controller = new ManifestPreflightWorkerTask(factory, 20);
            const task = controller.start(input, { timeoutMs: 100 });
            expect(JSON.stringify(await task.outcome)).not.toContain('private');
            expect(await task.cleanup).toBe('unknown');
            expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                failure('busy'),
            );
        }
    });

    it('rejects input proxies, shared, detached and oversized buffers before factory', async () => {
        const factory = vi.fn(() => new FakeWorker());
        const controller = new ManifestPreflightWorkerTask(factory, 20);
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });

        for (const value of [
            new Proxy(input, {}),
            new Uint8Array(new SharedArrayBuffer(1)),
            detached,
        ]) {
            expect(await controller.start(value, { timeoutMs: 1000 }).outcome).toEqual(
                failure('invalid_input'),
            );
        }

        expect(
            await controller.start(new Uint8Array(32 * 1024 * 1024 + 1), { timeoutMs: 1000 })
                .outcome,
        ).toEqual(failure('limit'));
        expect(factory).not.toHaveBeenCalled();
    });
});

describe('synthetic real Node manifest workers', () => {
    const protocolUrl = new URL(
        '../src/webui/plugin-install/preflight-worker-protocol.ts',
        import.meta.url,
    ).href;
    const script = `
        const { parentPort, workerData } = require('node:worker_threads');
        import(${JSON.stringify(protocolUrl)}).then((protocol) => protocol.createManifestWorkerHandler({
            postMessage: (message) => parentPort.postMessage(message),
            close: () => parentPort.close(),
        })(workerData));
    `;

    it('matches synchronous stored, deflate, CRC and missing manifest with transferred private snapshot', async () => {
        const bad = zip('{"type":"module"}');
        bad[30 + Buffer.byteLength('package.json')] ^= 1;

        for (const archive of [
            zip('{"main":"private.js","type":"module"}'),
            zip('{"type":"commonjs"}', 8),
            bad,
            zip('{}', 0, 'other.json'),
            Buffer.from([1, 2]),
        ]) {
            const wrapped = Buffer.concat([Buffer.from([8]), archive, Buffer.from([9])]);
            const view = wrapped.subarray(1, -1);
            const expected: ZipManifestResult = inspectZipManifest(view);
            const controller = new ManifestPreflightWorkerTask(
                (owned) =>
                    new Worker(script, {
                        eval: true,
                        workerData: { kind: 'zip-manifest', version: 2, bytes: owned },
                        transferList: [owned],
                    }),
                2000,
            );
            const task = controller.start(view, { timeoutMs: 5000 });
            expect(await task.outcome).toEqual({ kind: 'result', result: expected });
            expect(await task.cleanup).toBe('released');
            expect(view.equals(archive)).toBe(true);
            expect(wrapped.length).toBe(archive.length + 2);
        }
    }, 30000);

    it('does not accept a candidate from a worker whose send is followed by an exception', async () => {
        const failing = script.replace(
            'postMessage: (message) => parentPort.postMessage(message)',
            "postMessage: (message) => { parentPort.postMessage(message); throw Error('private/path'); }",
        );
        const controller = new ManifestPreflightWorkerTask(
            (owned) =>
                new Worker(failing, {
                    eval: true,
                    workerData: { kind: 'zip-manifest', version: 2, bytes: owned },
                    transferList: [owned],
                }),
            2000,
        );
        const task = controller.start(zip('{}'), { timeoutMs: 5000 });
        const outcome = await task.outcome;
        expect(outcome.kind).toBe('failure');
        expect(JSON.stringify(outcome)).not.toContain('private');
        expect(await task.cleanup).toBe('released');
    }, 10000);
});
