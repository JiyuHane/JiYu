import { createHash } from 'node:crypto';
import { markAsUntransferable, MessageChannel, Worker } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { PreflightWorkerTask } from '../src/webui/plugin-install/preflight-worker-task';
import {
    createPreflightWorkerData,
    createPreflightWorkerHandler,
} from '../src/webui/plugin-install/preflight-worker-protocol';
import * as zipModule from '../src/webui/plugin-install/zip-preflight';

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;

    for (const byte of bytes) {
        crc ^= byte;

        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function fixture(method: 0 | 8): Buffer {
    const name = Buffer.from('file.txt');
    const data = Buffer.from('123456789');
    const payload = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + payload.length, 16);
    return Buffer.concat([local, name, payload, central, name, end]);
}

const protocolUrl = new URL(
    '../src/webui/plugin-install/preflight-worker-protocol.ts',
    import.meta.url,
).href;
const zipUrl = new URL('../src/webui/plugin-install/zip-preflight.ts', import.meta.url).href;
const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(${JSON.stringify(protocolUrl)}), import(${JSON.stringify(zipUrl)})])
        .then(([protocol]) => protocol.createPreflightWorkerHandler({
            postMessage: (value) => parentPort.postMessage(value),
            close: () => parentPort.close(),
        })(workerData));
`;

function fakePort() {
    return { postMessage: vi.fn(), close: vi.fn() };
}

describe('offline preflight worker protocol', () => {
    it('bridges real workers and controller for stored, deflate, bad CRC and malformed ZIPs', async () => {
        const stored = fixture(0);
        const deflated = fixture(8);
        const badCrc = Buffer.from(stored);
        badCrc[30 + Buffer.byteLength('file.txt')] ^= 1;

        for (const sample of [stored, deflated, badCrc, Buffer.from([1, 2, 3]), Buffer.alloc(0)]) {
            const wrapped = Buffer.concat([Buffer.from([42]), sample, Buffer.from([43])]);
            const input = wrapped.subarray(1, -1);
            const expected = zipModule.preflightZip(input);
            const controller = new PreflightWorkerTask((owned) => {
                const data = createPreflightWorkerData(new Uint8Array(owned));
                const worker = new Worker(script, {
                    eval: true,
                    workerData: data,
                    transferList: [data.bytes],
                });
                expect(data.bytes.byteLength).toBe(0);
                return worker;
            });
            const task = controller.start(input, { timeoutMs: 10000 });
            const outcome = await task.outcome;
            expect(outcome).toEqual({ kind: 'result', result: expected });
            expect(await task.cleanup).toBe('released');
            expect(wrapped.byteLength).toBe(sample.length + 2);
            expect(input.equals(sample)).toBe(true);

            if (outcome.kind === 'result' && outcome.result.ok) {
                expect(outcome.result.sha256).toBe(
                    createHash('sha256').update(sample).digest('hex'),
                );
                expect(Object.isFrozen(outcome.result)).toBe(true);
                expect(Object.isFrozen(outcome.result.entries)).toBe(true);
                expect(outcome.result.entries.every(Object.isFrozen)).toBe(true);
                expect(outcome.result.entries[0].crc32).toBe(0xcbf43926);
            }
        }
    }, 30000);

    it('maps invalid requests and post-send adapter failures to controller failure', async () => {
        for (const mode of ['invalid', 'send', 'close'] as const) {
            const exits: number[] = [];
            const controller = new PreflightWorkerTask((owned) => {
                const data = createPreflightWorkerData(new Uint8Array(owned));
                const workerData = mode === 'invalid' ? { ...data, version: 2 } : data;
                const workerScript = script
                    .replace(
                        'postMessage: (value) => parentPort.postMessage(value)',
                        mode === 'send'
                            ? "postMessage: (value) => { parentPort.postMessage(value); throw Error('secret'); }"
                            : 'postMessage: (value) => parentPort.postMessage(value)',
                    )
                    .replace(
                        'close: () => parentPort.close()',
                        mode === 'close'
                            ? "close: () => { parentPort.close(); throw Error('secret'); }"
                            : 'close: () => parentPort.close()',
                    );
                const worker = new Worker(workerScript, {
                    eval: true,
                    workerData,
                    transferList: [data.bytes],
                });
                worker.on('exit', (code) => exits.push(code));
                return worker;
            });
            const task = controller.start(fixture(0), { timeoutMs: 10000 });
            const outcome = await task.outcome;
            expect(outcome.kind).toBe('failure');
            expect(JSON.stringify(outcome)).not.toContain('secret');
            expect(await task.cleanup).toBe('released');
            expect(exits).toEqual([mode === 'invalid' ? 0 : 1]);
        }
    }, 30000);

    it('copies only the visible subview and consumes the request buffer with all aliases', () => {
        const raw = Uint8Array.of(9, 1, 2, 3, 8);
        const data = createPreflightWorkerData(raw.subarray(1, 4));
        const alias = new Uint8Array(data.bytes);
        const port = fakePort();
        expect(createPreflightWorkerHandler(port)(data)).toBe('sent');
        expect(data.bytes.byteLength).toBe(0);
        expect(alias.byteLength).toBe(0);
        expect([...raw]).toEqual([9, 1, 2, 3, 8]);
        expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
            kind: 'result',
            result: { ok: false, code: 'malformed' },
        });
        expect(port.close).toHaveBeenCalledOnce();
    });

    it('rejects invalid data without getters, unneeded payload reads or messages', () => {
        let reads = 0;
        const getter = Object.defineProperty({ kind: 'zip-preflight', version: 1 }, 'bytes', {
            enumerable: true,
            get() {
                reads++;
                throw Error('secret');
            },
        });
        const detached = new ArrayBuffer(1);
        structuredClone(detached, { transfer: [detached] });
        const marked = new ArrayBuffer(1);
        markAsUntransferable(marked);
        const ResizableBuffer = ArrayBuffer as unknown as {
            new (length: number, options: { maxByteLength: number }): ArrayBuffer;
        };
        const decorated = new ArrayBuffer(1);
        Object.defineProperty(decorated, 'secret', {
            get() {
                reads++;
                throw Error('secret');
            },
        });
        const cases: unknown[] = [
            null,
            {},
            new Proxy({}, {}),
            getter,
            { kind: 'other', version: 1, bytes: new ArrayBuffer(1) },
            { kind: 'zip-preflight', version: 2, bytes: new ArrayBuffer(1) },
            { kind: 'zip-preflight', version: 1, bytes: new SharedArrayBuffer(1) },
            { kind: 'zip-preflight', version: 1, bytes: new Uint8Array(1) },
            { kind: 'zip-preflight', version: 1, bytes: new Proxy(new ArrayBuffer(1), {}) },
            { kind: 'zip-preflight', version: 1, bytes: detached },
            { kind: 'zip-preflight', version: 1, bytes: marked },
            {
                kind: 'zip-preflight',
                version: 1,
                bytes: new ResizableBuffer(1, { maxByteLength: 2 }),
            },
            { kind: 'zip-preflight', version: 1, bytes: decorated },
            { kind: 'zip-preflight', version: 1, bytes: new ArrayBuffer(32 * 1024 * 1024 + 1) },
            { kind: 'zip-preflight', version: 1, bytes: new ArrayBuffer(1), extra: 1 },
            { kind: 'zip-preflight', version: 1, bytes: new ArrayBuffer(1), [Symbol('x')]: 1 },
        ];

        for (const request of cases) {
            const port = fakePort();
            expect(createPreflightWorkerHandler(port)(request)).toBe('invalid_request');
            expect(port.postMessage).not.toHaveBeenCalled();
            expect(port.close).toHaveBeenCalledOnce();
        }

        expect(reads).toBe(0);
    });

    it('fails port validation before touching or detaching data', () => {
        let reads = 0;
        const buffer = new ArrayBuffer(1);
        const data = { kind: 'zip-preflight', version: 1, bytes: buffer };
        const getterPort = Object.defineProperty({ close() {} }, 'postMessage', {
            get() {
                reads++;
                throw Error('secret');
            },
            enumerable: true,
        });

        for (const port of [null, {}, new Proxy({}, {}), getterPort]) {
            expect(createPreflightWorkerHandler(port)(data)).toBe('invalid_port');
            expect(buffer.byteLength).toBe(1);
        }

        expect(reads).toBe(0);
    });

    it('prevents reentry and retries, even if send or close throws', () => {
        let nested = '';
        let handler: ReturnType<typeof createPreflightWorkerHandler>;
        const request = createPreflightWorkerData(Uint8Array.of(1));
        const port = {
            postMessage: vi.fn(() => {
                nested = handler(request);
                throw Error('secret');
            }),
            close: vi.fn(() => {
                expect(handler(request)).toBe('already_handled');
                throw Error('secret');
            }),
        };
        handler = createPreflightWorkerHandler(port);
        expect(() => handler(request)).toThrow('preflight_close_failed');
        expect(nested).toBe('already_handled');
        expect(handler(request)).toBe('already_handled');
        expect(createPreflightWorkerHandler(port)(request)).toBe('already_handled');
        expect(port.postMessage).toHaveBeenCalledOnce();
        expect(port.close).toHaveBeenCalledOnce();
        const sendFailure = {
            postMessage: () => {
                throw Error('secret');
            },
            close: vi.fn(),
        };
        expect(() =>
            createPreflightWorkerHandler(sendFailure)(createPreflightWorkerData(Uint8Array.of(1))),
        ).toThrow('preflight_send_failed');
        expect(sendFailure.close).toHaveBeenCalledOnce();
    });

    it('closes without sending on unexpected parser exception', () => {
        const spy = vi.spyOn(zipModule, 'preflightZip').mockImplementationOnce(() => {
            throw Error('secret path');
        });
        const port = fakePort();
        expect(
            createPreflightWorkerHandler(port)(createPreflightWorkerData(Uint8Array.of(1))),
        ).toBe('invalid_request');
        expect(port.postMessage).not.toHaveBeenCalled();
        expect(port.close).toHaveBeenCalledOnce();
        spy.mockRestore();
    });

    it('validates helper inputs without accessing getters and does not detach originals', () => {
        const detached = new ArrayBuffer(1);
        const detachedView = new Uint8Array(detached);
        structuredClone(detached, { transfer: [detached] });

        for (const value of [
            new Proxy(Uint8Array.of(1), {}),
            new Uint8Array(new SharedArrayBuffer(1)),
            detachedView,
            new Uint8Array(32 * 1024 * 1024 + 1),
            null,
        ]) {
            expect(() => createPreflightWorkerData(value)).toThrow('invalid_preflight_input');
        }
    });

    it('distinguishes local Proxy rejection from structured-clone rejection', () => {
        const value = new Proxy({}, {});
        expect(() => new Worker('', { eval: true, workerData: value })).toThrow();
        const port = fakePort();
        expect(createPreflightWorkerHandler(port)(value)).toBe('invalid_request');
    });

    it('handles a closed port as no delivery, not evidence of successful worker output', async () => {
        const { port1, port2 } = new MessageChannel();
        port1.close();
        const messages: unknown[] = [];
        port2.on('message', (value) => messages.push(value));
        const status = createPreflightWorkerHandler({
            postMessage: (value: unknown) => port1.postMessage(value),
            close: () => port1.close(),
        })(createPreflightWorkerData(Uint8Array.of(1)));
        expect(status).toBe('sent');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(messages).toEqual([]);
        port2.close();
    });
});
