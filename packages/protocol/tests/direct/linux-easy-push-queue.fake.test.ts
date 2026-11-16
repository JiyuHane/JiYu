import { describe, expect, it, vi } from 'vitest';
import { createLinuxEasyPushQueue } from '../../src/direct/linux-easy-push-queue';

// Pure in-memory fixtures: neither enqueue nor drain establishes authentication or delivery.
const limits = { maxFrameBytes: 4, maxQueuedFrames: 2, maxQueuedBytes: 6 } as const;
const queued = { kind: 'queued' } as const;
const rejected = (reason: 'closed' | 'invalid' | 'capacity' | 'reentrant') =>
    ({
        kind: 'rejected',
        reason,
    }) as const;
const meta = (sequence = 1) => ({ uin: '123', sequence, command: 'Synthetic.Push', retCode: 0 });
const bytes = (...values: number[]) => new Uint8Array(values);

function requireTake(queue: ReturnType<typeof createLinuxEasyPushQueue>) {
    const item = queue.take();
    expect(item).toBeDefined();

    if (!item) {
        throw new Error('expected synthetic queued item');
    }

    return item;
}

describe('linux easy push queue: synthetic in-memory contract', () => {
    it('holds FIFO behind the local drain latch and copies both bytes and metadata', () => {
        const queue = createLinuxEasyPushQueue(limits);
        const source = bytes(1, 2, 3);
        const input = meta(10);
        expect(queue.enqueue(source, input)).toEqual(queued);
        expect(queue.enqueue(bytes(4, 5), meta(11))).toEqual(queued);
        source.fill(9);
        input.command = 'changed';
        input.sequence = 999;
        expect(queue.take()).toBeUndefined();
        expect(queue.enableDrain()).toBe(true);
        const first = requireTake(queue);
        expect([...first.frame]).toEqual([1, 2, 3]);
        expect(first.meta).toEqual(meta(10));
        expect(first.frame).not.toBe(source);
        expect(queue.take()).toBeUndefined();
        first.release();
        expect([...first.frame]).toEqual([0, 0, 0]);
        expect([...source]).toEqual([9, 9, 9]);
        const second = requireTake(queue);
        expect([...second.frame]).toEqual([4, 5]);
        expect(second.meta).toEqual(meta(11));
        second.release();
        expect(queue.take()).toBeUndefined();
    });

    it('enforces exact frame, byte and count limits without evicting older items', () => {
        const queue = createLinuxEasyPushQueue(limits);
        expect(queue.enqueue(bytes(1, 2, 3, 4, 5), meta())).toEqual(rejected('invalid'));
        expect(queue.enqueue(bytes(1, 2, 3, 4), meta(1))).toEqual(queued);
        expect(queue.enqueue(bytes(5, 6, 7), meta(2))).toEqual(rejected('capacity'));
        expect(queue.enqueue(bytes(5, 6), meta(2))).toEqual(queued);
        expect(queue.enqueue(bytes(7), meta(3))).toEqual(rejected('capacity'));
        queue.enableDrain();
        const first = requireTake(queue);
        expect([...first.frame]).toEqual([1, 2, 3, 4]);
        expect(queue.enqueue(bytes(7), meta(3))).toEqual(rejected('capacity'));
        first.release();
        expect(queue.enqueue(bytes(7, 8, 9, 10), meta(3))).toEqual(queued);
        const second = requireTake(queue);
        expect([...second.frame]).toEqual([5, 6]);
        second.release();
        const third = requireTake(queue);
        expect([...third.frame]).toEqual([7, 8, 9, 10]);
        third.release();
    });

    it('keeps a taken frame charged until release and never double-credits', () => {
        const queue = createLinuxEasyPushQueue({
            maxFrameBytes: 4,
            maxQueuedFrames: 1,
            maxQueuedBytes: 4,
        });
        expect(queue.enqueue(bytes(1, 2, 3, 4), meta(1))).toEqual(queued);
        queue.enableDrain();
        const first = requireTake(queue);
        expect(queue.enqueue(bytes(5), meta(2))).toEqual(rejected('capacity'));
        expect(queue.take()).toBeUndefined();
        first.release();
        expect(queue.enqueue(bytes(5, 6, 7, 8), meta(2))).toEqual(queued);
        first.release();
        expect(queue.enqueue(bytes(9), meta(3))).toEqual(rejected('capacity'));
        const second = requireTake(queue);
        expect([...second.frame]).toEqual([5, 6, 7, 8]);
        first.frame.fill(42);
        first.release();
        expect([...first.frame]).toEqual([0, 0, 0, 0]);
        expect([...second.frame]).toEqual([5, 6, 7, 8]);
        expect(queue.enqueue(bytes(9), meta(3))).toEqual(rejected('capacity'));
        second.release();
        expect(queue.enqueue(bytes(9), meta(3))).toEqual(queued);
        queue.close();
    });

    it('closes synchronously, wipes the in-flight copy, preserves the caller, and remains closed', () => {
        const queue = createLinuxEasyPushQueue(limits);
        const original = bytes(3, 1, 4);
        expect(queue.enqueue(original, meta())).toEqual(queued);
        expect(queue.enqueue(bytes(2), meta(2))).toEqual(queued);
        queue.enableDrain();
        const held = requireTake(queue);
        queue.close();
        expect([...held.frame]).toEqual([0, 0, 0]);
        expect([...original]).toEqual([3, 1, 4]);
        expect(queue.take()).toBeUndefined();
        expect(queue.enableDrain()).toBe(false);
        expect(queue.enqueue(bytes(1), meta())).toEqual(rejected('closed'));
        held.frame.fill(77);
        held.release();
        expect([...held.frame]).toEqual([0, 0, 0]);
        held.release();
        queue.close();
        expect(queue.enqueue(bytes(1), meta())).toEqual(rejected('closed'));
    });

    it('isolates independent queues and a fresh queue starts with drain disabled', () => {
        const a = createLinuxEasyPushQueue(limits);
        const b = createLinuxEasyPushQueue(limits);
        expect(a.enqueue(bytes(1, 2, 3, 4), meta(1))).toEqual(queued);
        expect(b.enqueue(bytes(5, 6, 7, 8), meta(2))).toEqual(queued);
        a.enableDrain();
        const first = requireTake(a);
        expect(b.take()).toBeUndefined();
        b.enableDrain();
        const second = requireTake(b);
        a.close();
        expect([...first.frame]).toEqual([0, 0, 0, 0]);
        expect([...second.frame]).toEqual([5, 6, 7, 8]);
        first.release();
        second.release();
        const fresh = createLinuxEasyPushQueue(limits);
        expect(fresh.enqueue(bytes(9), meta())).toEqual(queued);
        expect(fresh.take()).toBeUndefined();
        fresh.close();
    });

    it('returns independent frozen metadata with immutable own data properties', () => {
        const queue = createLinuxEasyPushQueue(limits);
        const input = {
            uin: '4294967295',
            sequence: 4294967295,
            command: 'X',
            retCode: -2147483648,
        };
        expect(queue.enqueue(bytes(1), input)).toEqual(queued);
        queue.enableDrain();
        const item = requireTake(queue);
        expect(item.meta).not.toBe(input);
        expect(Object.isFrozen(item.meta)).toBe(true);
        expect(Reflect.ownKeys(item.meta).sort()).toEqual([
            'command',
            'retCode',
            'sequence',
            'uin',
        ]);

        for (const key of ['uin', 'sequence', 'command', 'retCode'] as const) {
            expect(Object.getOwnPropertyDescriptor(item.meta, key)).toMatchObject({
                value: input[key],
                writable: false,
                configurable: false,
                enumerable: true,
            });
        }

        expect(Reflect.set(item.meta, 'uin', '0')).toBe(false);
        expect(item.meta.uin).toBe('4294967295');
        item.release();
        expect(
            queue.enqueue(bytes(2), { uin: '1', sequence: 0, command: 'X', retCode: 2147483647 }),
        ).toEqual(queued);
        requireTake(queue).release();
    });

    it('rejects invalid numerical options synchronously', () => {
        for (const key of ['maxFrameBytes', 'maxQueuedFrames', 'maxQueuedBytes'] as const) {
            for (const value of [
                0,
                -1,
                1.5,
                NaN,
                Infinity,
                -Infinity,
                Number.MAX_SAFE_INTEGER + 1,
            ]) {
                expect(() => createLinuxEasyPushQueue({ ...limits, [key]: value })).toThrow();
            }
        }
    });

    it('rejects option accessors and proxies without invoking user code', () => {
        let calls = 0;
        const options = { ...limits };
        Object.defineProperty(options, 'maxFrameBytes', {
            get() {
                calls++;
                throw new Error('unexpected option getter');
            },
        });
        const proxy = new Proxy(
            { ...limits },
            {
                getPrototypeOf() {
                    calls++;
                    throw new Error('unexpected option proxy trap');
                },
            },
        );
        expect(() => createLinuxEasyPushQueue(options)).toThrow();
        expect(() => createLinuxEasyPushQueue(proxy)).toThrow();
        expect(calls).toBe(0);
    });

    it('accepts exact hard ceilings, rejects larger limits, and permits a smaller byte quota', () => {
        const ceilings = {
            maxFrameBytes: 65536,
            maxQueuedFrames: 4096,
            maxQueuedBytes: 64 * 1024 * 1024,
        };
        const queue = createLinuxEasyPushQueue(ceilings);
        queue.close();

        for (const key of ['maxFrameBytes', 'maxQueuedFrames', 'maxQueuedBytes'] as const) {
            expect(() =>
                createLinuxEasyPushQueue({ ...ceilings, [key]: ceilings[key] + 1 }),
            ).toThrow();
        }

        const small = createLinuxEasyPushQueue({
            maxFrameBytes: 4,
            maxQueuedFrames: 2,
            maxQueuedBytes: 2,
        });
        expect(small.enqueue(bytes(1, 2, 3), meta())).toEqual(rejected('capacity'));
        expect(small.enqueue(bytes(1, 2), meta())).toEqual(queued);
        small.close();
    });

    it('enforces the command ceiling in UTF-16 code units', () => {
        const queue = createLinuxEasyPushQueue(limits);
        expect(queue.enqueue(bytes(1), { ...meta(), command: '😀'.repeat(128) })).toEqual(queued);
        expect(queue.enqueue(bytes(2), { ...meta(), command: '😀'.repeat(128) + 'X' })).toEqual(
            rejected('invalid'),
        );
        queue.enableDrain();
        const item = requireTake(queue);
        expect(item.meta.command).toBe('😀'.repeat(128));
        item.release();
    });

    it('rejects malformed metadata and leaves capacity and FIFO intact', () => {
        const queue = createLinuxEasyPushQueue(limits);
        const invalid: unknown[] = [
            null,
            [],
            'meta',
            {},
            { ...meta(), extra: true },
            { ...meta(), uin: '' },
            { ...meta(), uin: '0' },
            { ...meta(), uin: '01' },
            { ...meta(), uin: '-1' },
            { ...meta(), uin: '4294967296' },
            { ...meta(), uin: 123 },
            { ...meta(), sequence: -1 },
            { ...meta(), sequence: 4294967296 },
            { ...meta(), sequence: 1.5 },
            { ...meta(), sequence: NaN },
            { ...meta(), command: '' },
            { ...meta(), command: 1 },
            { ...meta(), retCode: -2147483649 },
            { ...meta(), retCode: 2147483648 },
            { ...meta(), retCode: Infinity },
            { ...meta(), retCode: 0.5 },
            { ...meta(), [Symbol('extra')]: 1 },
        ];
        expect(queue.enqueue(bytes(7), meta(7))).toEqual(queued);

        for (const value of invalid) {
            expect(queue.enqueue(bytes(8), value)).toEqual(rejected('invalid'));
        }

        expect(queue.enqueue(bytes(9), meta(9))).toEqual(queued);
        queue.enableDrain();
        const first = requireTake(queue);
        expect(first.meta.sequence).toBe(7);
        first.release();
        const second = requireTake(queue);
        expect(second.meta.sequence).toBe(9);
        second.release();
    });

    it('never invokes metadata getters or proxy traps, including reentry attempts', () => {
        const queue = createLinuxEasyPushQueue(limits);
        let calls = 0;
        const accessor = { ...meta() };
        Object.defineProperty(accessor, 'command', {
            enumerable: true,
            get() {
                calls++;
                queue.close();
                throw new Error('getter should not run');
            },
        });
        const traps: ProxyHandler<object> = {
            get() {
                calls++;
                throw new Error('get trap');
            },
            getPrototypeOf() {
                calls++;
                throw new Error('prototype trap');
            },
            ownKeys() {
                calls++;
                queue.enqueue(bytes(3), meta());
                throw new Error('keys trap');
            },
            getOwnPropertyDescriptor() {
                calls++;
                throw new Error('descriptor trap');
            },
        };
        const proxyMeta = new Proxy(meta(), traps);
        const proxyFrame = new Proxy(bytes(1), traps);
        expect(queue.enqueue(bytes(1), accessor)).toEqual(rejected('invalid'));
        expect(queue.enqueue(bytes(1), proxyMeta)).toEqual(rejected('invalid'));
        expect(queue.enqueue(proxyFrame, meta())).toEqual(rejected('invalid'));
        expect(calls).toBe(0);
        expect(queue.enqueue(bytes(2), meta())).toEqual(queued);
        queue.enableDrain();
        const item = requireTake(queue);
        expect([...item.frame]).toEqual([2]);
        item.release();
    });

    it('contains synchronous reentry and descriptor exceptions without losing capacity', async () => {
        const original = Object.getOwnPropertyDescriptor;
        const attackMeta = meta(10);
        let mode: 'idle' | 'reenter' | 'throw' = 'idle';
        let queue: ReturnType<typeof createLinuxEasyPushQueue> | undefined;
        let nested: unknown;
        let nestedEnable: boolean | undefined;
        let nestedTake: unknown;
        vi.resetModules();

        try {
            Object.getOwnPropertyDescriptor = (target: object, key: PropertyKey) => {
                if (target === attackMeta && key === 'uin' && mode !== 'idle') {
                    const action = mode;
                    mode = 'idle';

                    if (action === 'throw') {
                        throw new Error('synthetic descriptor exception');
                    }

                    nested = queue!.enqueue(bytes(9), meta(99));
                    nestedEnable = queue!.enableDrain();
                    nestedTake = queue!.take();
                }

                return original(target, key);
            };

            const fresh = await import('../../src/direct/linux-easy-push-queue');
            Object.getOwnPropertyDescriptor = original;
            queue = fresh.createLinuxEasyPushQueue(limits);
            mode = 'throw';
            expect(queue.enqueue(bytes(1), attackMeta)).toEqual(rejected('invalid'));
            mode = 'reenter';
            expect(queue.enqueue(bytes(2), attackMeta)).toEqual(queued);
            expect(nested).toEqual(rejected('reentrant'));
            expect(nestedEnable).toBe(false);
            expect(nestedTake).toBeUndefined();
            expect(queue.enqueue(bytes(3), meta(11))).toEqual(queued);
            expect(queue.enableDrain()).toBe(true);
            expect(queue.enableDrain()).toBe(true);
            const first = requireTake(queue);
            expect(first.meta.sequence).toBe(10);
            first.release();
            const second = requireTake(queue);
            expect(second.meta.sequence).toBe(11);
            second.release();
        } finally {
            Object.getOwnPropertyDescriptor = original;
            queue?.close();
            vi.resetModules();
        }
    });

    it('rejects shared, detached and resizable storage without touching valid input', () => {
        const queue = createLinuxEasyPushQueue(limits);
        const shared = new Uint8Array(new SharedArrayBuffer(2));
        shared.set([1, 2]);
        expect(queue.enqueue(shared, meta())).toEqual(rejected('invalid'));
        expect([...shared]).toEqual([1, 2]);
        const storage = new ArrayBuffer(2);
        const detached = new Uint8Array(storage);
        structuredClone(storage, { transfer: [storage] });
        expect(queue.enqueue(detached, meta())).toEqual(rejected('invalid'));
        const ResizableBuffer = ArrayBuffer as unknown as {
            new (length: number, options: { maxByteLength: number }): ArrayBuffer;
        };
        const candidate = new ResizableBuffer(2, { maxByteLength: 4 });
        const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

        if (resizable && Reflect.apply(resizable, candidate, [])) {
            expect(queue.enqueue(new Uint8Array(candidate), meta())).toEqual(rejected('invalid'));
        }

        const valid = bytes(4, 5);
        expect(queue.enqueue(valid, meta())).toEqual(queued);
        queue.close();
        expect([...valid]).toEqual([4, 5]);
    });

    it('restores each Object.prototype pollution and keeps queue operations isolated', () => {
        for (const key of ['0', 'value', 'command'] as const) {
            const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
            let setterCalls = 0;
            let result: unknown;
            let taken: ReturnType<ReturnType<typeof createLinuxEasyPushQueue>['take']>;
            const queue = createLinuxEasyPushQueue(limits);
            const payload = bytes(1, 2);
            const input = meta();

            try {
                Object.defineProperty(Object.prototype, key, {
                    configurable: true,
                    get() {
                        return 'polluted';
                    },
                    set() {
                        setterCalls++;
                    },
                });
                result = queue.enqueue(payload, input);
                queue.enableDrain();
                taken = queue.take();
            } finally {
                if (previous) {
                    Object.defineProperty(Object.prototype, key, previous);
                } else {
                    Reflect.deleteProperty(Object.prototype, key);
                }
            }

            expect(result).toEqual(queued);
            expect(setterCalls).toBe(0);
            expect(taken).toBeDefined();

            if (taken) {
                expect([...taken.frame]).toEqual([1, 2]);
                expect(taken.meta).toEqual(meta());
                taken.release();
            }

            queue.close();
        }
    });
});
