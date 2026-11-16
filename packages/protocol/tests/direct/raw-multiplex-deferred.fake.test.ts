import { describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexClient,
    type RawMultiplexClientOptions,
    type RawMultiplexIdentity,
    type RawMultiplexPushRoute,
    type RawMultiplexRoute,
} from '../../src/direct/raw-multiplex-client';
import type { Sso12RawOptions } from '../../src/direct/sso12-packet-client';

// Entirely synthetic framing and explicit classifier metadata. No socket or runtime owner.
const A = 41;
const B = 42;
const C = 43;
const D = 44;
const R = 17;

type Seen = {
    event: string;
    bytes?: number[];
    identity?: RawMultiplexIdentity;
    route?: RawMultiplexPushRoute;
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 100; i++) {
        await Promise.resolve();
    }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let state: { value: T } | { error: unknown } | undefined;
    void promise.then(
        (value) => {
            state = { value };
        },
        (error: unknown) => {
            state = { error };
        },
    );
    await flush();

    if (!state) {
        throw new Error('synthetic microtask watchdog expired');
    }

    if ('error' in state) {
        throw state.error;
    }

    return state.value;
}

function frame(tag: number): Uint8Array {
    const bytes = new Uint8Array(14);
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes[4] = tag;

    for (let i = 5; i < bytes.length; i++) {
        bytes[i] = (tag + i * 7) & 0xff;
    }

    return bytes;
}

function frameSnapshot(tag: number): number[] {
    const bytes = frame(tag);
    const snapshot = Array.from(bytes);
    bytes.fill(0);
    return snapshot;
}

function join(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;

    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }

    return out;
}

function fixture(
    extra: Partial<RawMultiplexClientOptions> = {},
    mode: 'enabled' | 'false' | 'absent' = 'enabled',
) {
    const events: Seen[] = [];
    const borrowed: Uint8Array[] = [];
    const owned: Uint8Array[] = [];
    const writeGate = deferred<void>();
    const verifyGate = deferred<boolean>();
    const consumeGate = deferred<void>();
    const pushGate = deferred<void>();
    const pushVerifyGate = deferred<boolean>();
    const classifierGate = deferred<void>();
    const buildGate = deferred<void>();
    let written = false;
    let staged = false;
    let replay: 'push' | 'defer' | 'response' | 'reject' | 'throw' = 'push';
    let pushAccepted: unknown = true;
    let holdWrite = false;
    let holdVerify = false;
    let holdConsume = false;
    let holdPush = false;
    let holdPushVerify = false;
    let holdReplayClassifier = false;
    let lateClassifierResult: 'push' | 'reject' = 'push';
    let holdBuild = false;
    let cDefer = false;

    const save = (
        event: string,
        bytes?: Uint8Array,
        identity?: RawMultiplexIdentity,
        route?: RawMultiplexPushRoute,
    ) => {
        if (bytes) {
            borrowed.push(bytes);
        }

        events.push({
            event,
            ...(bytes ? { bytes: Array.from(bytes) } : {}),
            ...(identity ? { identity: { ...identity } } : {}),
            ...(route ? { route: { ...route } } : {}),
        });
    };

    const config = {
        uin: '123',
        initialSequence: 17,
        defaultTimeoutMs: 5000,
        maxFrameBytes: 1024,
        maxBufferedBytes: 4096,
        maxFrames: 16,
        maxPushFrames: 8,
        maxPushBytes: 4096,
        ...(mode === 'enabled'
            ? { allowDeferredFrames: true }
            : mode === 'false'
              ? { allowDeferredFrames: false }
              : {}),
        write: async (bytes: Uint8Array) => {
            save('write', bytes);
            written = true;

            if (holdWrite) {
                await writeGate.promise;
            }
        },
        classify: (
            bytes: Uint8Array,
            identity: RawMultiplexIdentity,
        ): RawMultiplexRoute | Promise<RawMultiplexRoute> => {
            const tag = bytes[4];
            save(`classify:${tag}`, bytes, identity);

            if (tag === A && staged && holdReplayClassifier) {
                return classifierGate.promise.then(() => {
                    save(`classify-resumed:${A}`);
                    return lateClassifierResult === 'reject'
                        ? { kind: 'reject' as const }
                        : { kind: 'push' as const, name: 'synthetic', id: tag };
                });
            }

            if (tag === A || tag === D) {
                if (!staged || replay === 'defer') {
                    return { kind: 'defer' } as RawMultiplexRoute;
                }

                if (replay === 'throw') {
                    throw new Error('synthetic classifier failure');
                }

                if (replay === 'response') {
                    return { kind: 'response', sequence: R };
                }

                if (replay === 'reject') {
                    return { kind: 'reject' };
                }
            }

            if (tag === C && cDefer) {
                return { kind: 'defer' } as RawMultiplexRoute;
            }

            if (tag === R) {
                return { kind: 'response', sequence: R };
            }

            return { kind: 'push', name: 'synthetic', id: tag };
        },
        verifyPush: async (bytes: Uint8Array, route: RawMultiplexPushRoute) => {
            save(`verifyPush:${route.id}`, bytes, undefined, route);

            if (holdPushVerify && route.id === A) {
                const accepted = await pushVerifyGate.promise;
                save(`verifyPush-resumed:${A}`);
                return accepted;
            }

            return pushAccepted as boolean;
        },
        onPush: async (bytes: Uint8Array, route: RawMultiplexPushRoute) => {
            save(`push:${route.id}`, bytes, undefined, route);

            if (holdPush && route.id === A) {
                await pushGate.promise;
            }
        },
        ...extra,
    } as RawMultiplexClientOptions;
    const client = createRawMultiplexClient(config);

    const makeFrame = (tag: number) => {
        const bytes = frame(tag);
        owned.push(bytes);
        return bytes;
    };

    const feed = (tags: number[], fragmented = false) => {
        const bytes = join(tags.map(makeFrame));
        owned.push(bytes);

        if (fragmented) {
            for (const [start, end] of [
                [0, 1],
                [1, 3],
                [3, 8],
                [8, 14],
                [14, 19],
                [19, bytes.length],
            ]) {
                if (start < bytes.length) {
                    client.feed(bytes.subarray(start, Math.min(end, bytes.length)));
                }
            }
        } else {
            client.feed(bytes);
        }
    };

    const request = (
        extraRequest: Partial<Sso12RawOptions<null, string>> = {},
    ): Sso12RawOptions<null, string> => ({
        buildRequest: async (identity) => {
            save('build', undefined, identity);

            if (holdBuild) {
                await buildGate.promise;
            }

            return { frame: makeFrame(99), context: null };
        },
        verifyCandidate: async (bytes, _context, identity) => {
            save('verifyResponse', bytes, identity);
            return holdVerify ? await verifyGate.promise : true;
        },
        consumeCandidate: async (bytes, _context, identity) => {
            save('consume', bytes, identity);

            if (holdConsume) {
                await consumeGate.promise;
            }

            staged = true;
            return 'accepted';
        },
        ...extraRequest,
    });

    const cleanup = async () => {
        client.close();
        writeGate.resolve();
        verifyGate.resolve(true);
        consumeGate.resolve();
        pushGate.resolve();
        pushVerifyGate.resolve(true);
        classifierGate.resolve();
        buildGate.resolve();
        await flush();

        for (const bytes of [...owned, ...borrowed]) {
            bytes.fill(0);
        }
    };

    return {
        client,
        events,
        borrowed,
        feed,
        makeFrame,
        request,
        cleanup,
        writeGate,
        verifyGate,
        consumeGate,
        pushGate,
        pushVerifyGate,
        classifierGate,
        buildGate,
        setHoldWrite: () => {
            holdWrite = true;
        },
        setHoldVerify: () => {
            holdVerify = true;
        },
        setHoldConsume: () => {
            holdConsume = true;
        },
        setHoldPush: () => {
            holdPush = true;
        },
        setHoldPushVerify: () => {
            holdPushVerify = true;
        },
        setHoldReplayClassifier: (value: 'push' | 'reject') => {
            holdReplayClassifier = true;
            lateClassifierResult = value;
        },
        setHoldBuild: () => {
            holdBuild = true;
        },
        setReplay: (value: typeof replay) => {
            replay = value;
        },
        setPushAccepted: (value: unknown) => {
            pushAccepted = value;
        },
        setCDefer: () => {
            cDefer = true;
        },
        get written() {
            return written;
        },
    };
}

const names = (events: Seen[]) => events.map((event) => event.event);
const identity = { uin: '123', sequence: R };

describe('raw multiplex deferred frames (synthetic memory only)', () => {
    it.each(['coalesced', 'fragmented'] as const)(
        'scans a written response across a parked frame and preserves FIFO (%s)',
        async (layout) => {
            const f = fixture();
            f.setHoldWrite();
            f.setHoldVerify();
            f.setHoldConsume();
            f.setHoldPush();
            f.setHoldPushVerify();
            const result = f.client.transactRaw(f.request());
            let settled = false;
            void result.then(() => {
                settled = true;
            });

            try {
                await flush();
                expect(f.written).toBe(true);

                if (layout === 'fragmented') {
                    for (const tag of [A, B, R, C]) {
                        f.feed([tag], true);
                        await flush();
                    }
                } else {
                    f.feed([A, B, R, C]);
                    await flush();
                }

                expect(names(f.events)).toEqual([
                    'build',
                    'write',
                    `classify:${A}`,
                    `classify:${B}`,
                    `classify:${R}`,
                ]);
                expect(settled).toBe(false);
                f.writeGate.resolve();
                await flush();
                expect(names(f.events)).toEqual([
                    'build',
                    'write',
                    `classify:${A}`,
                    `classify:${B}`,
                    `classify:${R}`,
                    'verifyResponse',
                ]);
                f.verifyGate.resolve(true);
                await flush();
                expect(names(f.events).at(-1)).toBe('consume');
                expect(names(f.events)).not.toContain(`classify:${C}`);
                expect(settled).toBe(false);
                f.consumeGate.resolve();
                await flush();
                expect(names(f.events).filter((x) => x.startsWith('verifyPush:'))).toEqual([
                    `verifyPush:${A}`,
                ]);
                expect(names(f.events)).not.toContain(`classify:${C}`);
                expect(settled).toBe(false);
                expect(f.events.find((x) => x.event === `verifyPush:${A}`)).toMatchObject({
                    bytes: frameSnapshot(A),
                    route: { kind: 'push', name: 'synthetic', id: A },
                });
                f.pushVerifyGate.resolve(true);
                expect(await bounded(result)).toEqual({
                    kind: 'response',
                    sequence: R,
                    value: 'accepted',
                    writeState: 'written',
                });
                await flush();
                const events = names(f.events);
                expect(events.filter((x) => x === `classify:${A}`)).toHaveLength(2);
                expect(events.filter((x) => x === `classify:${B}`)).toHaveLength(1);
                expect(events.filter((x) => x.startsWith('classify:'))).toEqual([
                    `classify:${A}`,
                    `classify:${B}`,
                    `classify:${R}`,
                    `classify:${A}`,
                    `classify:${C}`,
                ]);
                expect(events.filter((x) => x.startsWith('verifyPush:'))).toEqual([
                    `verifyPush:${A}`,
                    `verifyPush:${B}`,
                    `verifyPush:${C}`,
                ]);
                expect(events.filter((x) => x.startsWith('push:'))).toEqual([`push:${A}`]);
                expect(events.indexOf(`verifyPush:${A}`)).toBeGreaterThan(
                    events.indexOf('consume'),
                );

                for (const entry of f.events.filter(
                    (x) =>
                        x.event.startsWith('classify:') ||
                        x.event === 'verifyResponse' ||
                        x.event === 'consume',
                )) {
                    const tag = entry.event.startsWith('classify:')
                        ? Number(entry.event.split(':')[1])
                        : R;
                    expect(entry.identity).toEqual(identity);
                    expect(entry.bytes).toEqual(frameSnapshot(tag));
                }

                for (const entry of f.events.filter(
                    (x) => x.event.startsWith('verifyPush:') || x.event.startsWith('push:'),
                )) {
                    const tag = Number(entry.event.split(':')[1]);
                    expect(entry.bytes).toEqual(frameSnapshot(tag));
                    expect(entry.route).toEqual({ kind: 'push', name: 'synthetic', id: tag });
                }

                f.pushGate.resolve();
                await flush();
                expect(names(f.events).filter((x) => x.startsWith('push:'))).toEqual([
                    `push:${A}`,
                    `push:${B}`,
                    `push:${C}`,
                ]);

                for (const entry of f.events.filter((x) => x.event.startsWith('push:'))) {
                    const tag = Number(entry.event.split(':')[1]);
                    expect(entry.bytes).toEqual(frameSnapshot(tag));
                    expect(entry.route).toEqual({ kind: 'push', name: 'synthetic', id: tag });
                }

                expect(f.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('replays multiple distinct initially deferred frames exactly once each in FIFO order', async () => {
        const f = fixture();
        f.setHoldConsume();
        const result = f.client.transactRaw(f.request());

        try {
            await flush();
            f.feed([A, D, B, R, C]);
            await flush();
            expect(names(f.events)).toEqual([
                'build',
                'write',
                `classify:${A}`,
                `classify:${D}`,
                `classify:${B}`,
                `classify:${R}`,
                'verifyResponse',
                'consume',
            ]);
            f.consumeGate.resolve();
            expect(await bounded(result)).toMatchObject({
                kind: 'response',
                sequence: R,
                value: 'accepted',
            });
            await flush();
            const classified = f.events.filter((event) => event.event.startsWith('classify:'));
            expect(classified.map((event) => event.event)).toEqual([
                `classify:${A}`,
                `classify:${D}`,
                `classify:${B}`,
                `classify:${R}`,
                `classify:${A}`,
                `classify:${D}`,
                `classify:${C}`,
            ]);

            for (const entry of classified) {
                expect(entry.bytes).toEqual(frameSnapshot(Number(entry.event.split(':')[1])));
                expect(entry.identity).toEqual(identity);
            }

            expect(names(f.events).filter((event) => event.startsWith('verifyPush:'))).toEqual([
                `verifyPush:${A}`,
                `verifyPush:${D}`,
                `verifyPush:${B}`,
                `verifyPush:${C}`,
            ]);
            expect(names(f.events).filter((event) => event.startsWith('push:'))).toEqual([
                `push:${A}`,
                `push:${D}`,
                `push:${B}`,
                `push:${C}`,
            ]);

            for (const entry of f.events.filter(
                (event) => event.event.startsWith('verifyPush:') || event.event.startsWith('push:'),
            )) {
                const tag = Number(entry.event.split(':')[1]);
                expect(entry.bytes).toEqual(frameSnapshot(tag));
                expect(entry.route).toEqual({ kind: 'push', name: 'synthetic', id: tag });
            }

            expect(f.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        } finally {
            await f.cleanup();
        }
    });

    it.each(['absent', 'false'] as const)('keeps defer invalid with option %s', async (mode) => {
        const f = fixture({}, mode);
        const result = f.client.transactRaw(f.request());

        try {
            await flush();
            f.feed([A, R]);
            expect(await bounded(result)).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(await bounded(f.client.whenClosed)).toEqual({
                kind: 'handler-error',
                code: 'frame-handler-failed',
            });
            expect(names(f.events)).toEqual(['build', 'write', `classify:${A}`]);
            expect(f.events.at(-1)).toMatchObject({ identity, bytes: frameSnapshot(A) });
        } finally {
            await f.cleanup();
        }
    });

    it.each(['idle', 'before-write', 'after-response'] as const)(
        'fails closed for invalid defer position: %s',
        async (mode) => {
            const f = fixture(mode === 'after-response' ? { holdFollowingFrames: () => true } : {});
            let result: ReturnType<typeof f.client.transactRaw> | undefined;

            try {
                if (mode === 'before-write') {
                    f.setHoldBuild();
                }

                if (mode !== 'idle') {
                    result = f.client.transactRaw(f.request());
                    await flush();
                }

                if (mode === 'after-response') {
                    f.setHoldConsume();
                    f.setCDefer();
                    f.feed([R, C]);
                    await flush();
                    expect(names(f.events)).toContain('consume');
                    f.consumeGate.resolve();
                } else {
                    f.feed([A]);
                }

                expect(await bounded(f.client.whenClosed)).toEqual({
                    kind: 'protocol-error',
                    code: 'frame-rejected',
                });

                if (result) {
                    expect(await bounded(result)).toMatchObject({
                        kind: 'failure',
                        code: 'frame-rejected',
                    });
                }

                const classified = f.events.filter((x) => x.event.startsWith('classify:'));
                expect(classified.map((x) => x.event)).toEqual(
                    mode === 'after-response'
                        ? [`classify:${R}`, `classify:${C}`]
                        : [`classify:${A}`],
                );

                if (mode === 'after-response') {
                    expect(classified[1]).toMatchObject({ identity, bytes: frameSnapshot(C) });
                }

                expect(classified[0].bytes).toEqual(
                    frameSnapshot(mode === 'after-response' ? R : A),
                );
                expect(classified[0].identity).toEqual(mode === 'idle' ? { uin: '123' } : identity);
                expect(names(f.events).some((x) => x.startsWith('push:'))).toBe(false);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(['defer', 'response', 'reject', 'throw'] as const)(
        'rejects replay classified as %s without dispatching it',
        async (route) => {
            const f = fixture();
            f.setReplay(route);
            const result = f.client.transactRaw(f.request());

            try {
                await flush();
                f.feed([A, B, R, C]);
                const reason =
                    route === 'throw'
                        ? { kind: 'handler-error', code: 'frame-handler-failed' }
                        : {
                              kind: 'protocol-error',
                              code: route === 'response' ? 'unexpected-response' : 'frame-rejected',
                          };
                expect(await bounded(result)).toMatchObject({
                    kind: 'failure',
                    writeState: 'unknown',
                    code: reason.code,
                });
                expect(await bounded(f.client.whenClosed)).toEqual(reason);
                const classifiedA = f.events.filter((x) => x.event === `classify:${A}`);
                expect(classifiedA).toHaveLength(2);
                expect(classifiedA.map((x) => x.bytes)).toEqual([
                    frameSnapshot(A),
                    frameSnapshot(A),
                ]);
                expect(classifiedA.map((x) => x.identity)).toEqual([identity, identity]);
                expect(names(f.events)).toContain('consume');
                expect(
                    names(f.events).some(
                        (x) => x.startsWith('verifyPush:') || x.startsWith('push:'),
                    ),
                ).toBe(false);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each([false, 1, null, undefined])(
        'requires literal true from replay push verifier (%s)',
        async (accepted) => {
            const f = fixture();
            f.setPushAccepted(accepted);
            const result = f.client.transactRaw(f.request());

            try {
                await flush();
                f.feed([A, B, R]);
                expect(await bounded(result)).toMatchObject({
                    kind: 'failure',
                    code: 'push-rejected',
                });
                expect(await bounded(f.client.whenClosed)).toEqual({
                    kind: 'protocol-error',
                    code: 'push-rejected',
                });
                const verify = f.events.filter((x) => x.event.startsWith('verifyPush:'));
                expect(verify).toHaveLength(1);
                expect(verify[0]).toMatchObject({
                    event: `verifyPush:${A}`,
                    bytes: frameSnapshot(A),
                });
                expect(names(f.events).some((x) => x.startsWith('push:'))).toBe(false);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('fails with the handler error when replay push verification rejects', async () => {
        const f = fixture();
        f.setHoldPushVerify();
        const result = f.client.transactRaw(f.request());

        try {
            await flush();
            f.feed([A, B, R, C]);
            await flush();
            expect(names(f.events).filter((x) => x.startsWith('verifyPush:'))).toEqual([
                `verifyPush:${A}`,
            ]);
            expect(f.events.find((x) => x.event === `verifyPush:${A}`)).toMatchObject({
                bytes: frameSnapshot(A),
                route: { kind: 'push', name: 'synthetic', id: A },
            });
            f.pushVerifyGate.reject(new Error('synthetic rejection'));
            expect(await bounded(result)).toMatchObject({
                kind: 'failure',
                code: 'frame-handler-failed',
                writeState: 'unknown',
            });
            expect(await bounded(f.client.whenClosed)).toEqual({
                kind: 'handler-error',
                code: 'frame-handler-failed',
            });
            expect(names(f.events).some((x) => x.startsWith('push:'))).toBe(false);
            expect(names(f.events)).not.toContain(`classify:${C}`);
        } finally {
            await f.cleanup();
        }
    });

    it.each(['close', 'abort', 'timeout'] as const)(
        'fences replay verification released after %s',
        async (mode) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
            let f: ReturnType<typeof fixture> | undefined;

            try {
                f = fixture();
                f.setHoldPushVerify();
                const controller = new AbortController();
                const result = f.client.transactRaw(
                    f.request({ signal: controller.signal, timeoutMs: 100 }),
                );
                let settlements = 0;
                void result.then(() => {
                    settlements++;
                });
                await flush();
                f.feed([A, B, R, C]);
                await flush();
                expect(names(f.events)).toEqual([
                    'build',
                    'write',
                    `classify:${A}`,
                    `classify:${B}`,
                    `classify:${R}`,
                    'verifyResponse',
                    'consume',
                    `classify:${A}`,
                    `verifyPush:${A}`,
                ]);
                expect(f.events.at(-1)).toMatchObject({
                    bytes: frameSnapshot(A),
                    route: { kind: 'push', name: 'synthetic', id: A },
                });
                expect(settlements).toBe(0);

                if (mode === 'close') {
                    f.client.close();
                } else if (mode === 'abort') {
                    controller.abort();
                } else {
                    vi.advanceTimersByTime(100);
                }

                const code =
                    mode === 'close'
                        ? 'local-close'
                        : mode === 'abort'
                          ? 'raw-cancelled'
                          : 'raw-timeout';
                expect(await bounded(result)).toEqual({
                    kind: 'failure',
                    code,
                    writeState: 'unknown',
                });
                expect(await bounded(f.client.whenClosed)).toEqual({ kind: 'local', code });
                await flush();
                expect(settlements).toBe(1);
                expect(f.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
                const before = names(f.events);
                f.pushVerifyGate.resolve(true);
                await flush();
                expect(names(f.events)).toEqual([...before, `verifyPush-resumed:${A}`]);
                expect(settlements).toBe(1);
                expect(f.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                if (f) {
                    await f.cleanup();
                }

                vi.useRealTimers();
            }
        },
    );

    it.each([
        ['abort', 'push'],
        ['abort', 'reject'],
        ['close', 'push'],
        ['close', 'reject'],
    ] as const)('fences replay classifier after %s with late %s', async (mode, route) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let f: ReturnType<typeof fixture> | undefined;

        try {
            f = fixture();
            f.setHoldReplayClassifier(route);
            const controller = new AbortController();
            const result = f.client.transactRaw(f.request({ signal: controller.signal }));
            await flush();
            f.feed([A, B, R, C]);
            await flush();
            expect(names(f.events)).toEqual([
                'build',
                'write',
                `classify:${A}`,
                `classify:${B}`,
                `classify:${R}`,
                'verifyResponse',
                'consume',
                `classify:${A}`,
            ]);
            expect(f.events.at(-1)).toMatchObject({ identity, bytes: frameSnapshot(A) });

            if (mode === 'abort') {
                controller.abort();
            } else {
                f.client.close();
            }

            const code = mode === 'abort' ? 'raw-cancelled' : 'local-close';
            expect(await bounded(result)).toEqual({ kind: 'failure', code, writeState: 'unknown' });
            expect(await bounded(f.client.whenClosed)).toEqual({ kind: 'local', code });
            const before = names(f.events);
            f.classifierGate.resolve();
            await flush();
            expect(names(f.events)).toEqual([...before, `classify-resumed:${A}`]);
            expect(
                names(f.events).some((x) => x.startsWith('verifyPush:') || x.startsWith('push:')),
            ).toBe(false);
            expect(await bounded(result)).toEqual({ kind: 'failure', code, writeState: 'unknown' });
            expect(f.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            if (f) {
                await f.cleanup();
            }

            vi.useRealTimers();
        }
    });

    it.each(['abort', 'close', 'timeout'] as const)(
        'fences late consume after %s',
        async (mode) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
            let f: ReturnType<typeof fixture> | undefined;

            try {
                f = fixture();
                f.setHoldConsume();
                const controller = new AbortController();
                const result = f.client.transactRaw(
                    f.request({ signal: controller.signal, timeoutMs: 100 }),
                );
                await flush();
                f.feed([A, B, R, C]);
                await flush();
                expect(names(f.events)).toEqual([
                    'build',
                    'write',
                    `classify:${A}`,
                    `classify:${B}`,
                    `classify:${R}`,
                    'verifyResponse',
                    'consume',
                ]);

                if (mode === 'abort') {
                    controller.abort();
                } else if (mode === 'close') {
                    f.client.close();
                } else {
                    vi.advanceTimersByTime(100);
                }

                const failure = await bounded(result);
                expect(failure).toMatchObject({
                    kind: 'failure',
                    writeState: 'unknown',
                    code:
                        mode === 'abort'
                            ? 'raw-cancelled'
                            : mode === 'close'
                              ? 'local-close'
                              : 'raw-timeout',
                });
                await bounded(f.client.whenClosed);
                const before = names(f.events);
                f.consumeGate.resolve();
                await flush();
                expect(names(f.events)).toEqual(before);
                expect(f.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                if (f) {
                    await f.cleanup();
                }

                vi.useRealTimers();
            }
        },
    );

    it.each(['frames', 'bytes'] as const)(
        'charges a parked frame plus an active push to %s capacity',
        async (budget) => {
            const gate = deferred<void>();
            const records: { bytes: number[]; route: RawMultiplexPushRoute }[] = [];
            const f = fixture({
                maxPushFrames: budget === 'frames' ? 1 : 8,
                maxPushBytes: budget === 'bytes' ? 14 : 4096,
                onPush: async (bytes, route) => {
                    records.push({ bytes: Array.from(bytes), route: { ...route } });
                    await gate.promise;
                },
            });

            try {
                f.feed([B]);
                await flush();
                expect(records).toEqual([
                    { bytes: frameSnapshot(B), route: { kind: 'push', name: 'synthetic', id: B } },
                ]);
                const result = f.client.transactRaw(f.request());
                await flush();
                f.feed([A]);
                expect(await bounded(result)).toMatchObject({
                    kind: 'failure',
                    code: 'push-capacity',
                });
                expect(await bounded(f.client.whenClosed)).toMatchObject({ code: 'push-capacity' });
                expect(names(f.events)).toContain(`classify:${A}`);
                gate.resolve();
                await flush();
                expect(records).toEqual([
                    { bytes: frameSnapshot(B), route: { kind: 'push', name: 'synthetic', id: B } },
                ]);
            } finally {
                gate.resolve();
                await f.cleanup();
            }
        },
    );

    it.each(['frames', 'bytes'] as const)(
        'includes a parked frame in %s input reservations',
        async (budget) => {
            const f = fixture({
                maxFrames: budget === 'frames' ? 2 : 8,
                maxBufferedBytes: budget === 'bytes' ? 28 : 4096,
            });
            f.setHoldWrite();
            const result = f.client.transactRaw(f.request());

            try {
                await flush();
                f.feed([A]);
                await flush();
                f.feed([R]);
                await flush();
                expect(f.client.closed).toBe(false);
                f.feed([C]);
                expect(await bounded(result)).toMatchObject({
                    kind: 'failure',
                    code: 'invalid-stream',
                });
                expect(await bounded(f.client.whenClosed)).toMatchObject({
                    code: 'invalid-stream',
                });
                expect(names(f.events).filter((x) => x.startsWith('classify:'))).toEqual([
                    `classify:${A}`,
                    `classify:${R}`,
                ]);
                expect(names(f.events)).not.toContain('verifyResponse');
            } finally {
                await f.cleanup();
            }
        },
    );

    it('reuses capacity after deferred dispatch and completed push delivery', async () => {
        const f = fixture({
            maxFrames: 3,
            maxBufferedBytes: 42,
            maxPushFrames: 1,
            maxPushBytes: 14,
        });

        try {
            const first = f.client.transactRaw(f.request());
            await flush();
            f.feed([A]);
            await flush();
            f.feed([R]);
            expect(await bounded(first)).toMatchObject({ kind: 'response' });
            await flush();
            expect(names(f.events)).toContain(`push:${A}`);
            f.feed([B]);
            await flush();
            expect(names(f.events).filter((x) => x.startsWith('push:'))).toEqual([
                `push:${A}`,
                `push:${B}`,
            ]);
            expect(f.client.closed).toBe(false);
        } finally {
            await f.cleanup();
        }
    });

    it('keeps the first-byte assembly deadline while a deferred frame is parked', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let f: ReturnType<typeof fixture> | undefined;

        try {
            f = fixture({ frameAssemblyTimeoutMs: 100 });
            f.setHoldWrite();
            const result = f.client.transactRaw(f.request());
            await flush();
            f.feed([A]);
            await flush();
            const response = f.makeFrame(R);
            f.client.feed(response.subarray(0, 1));
            vi.advanceTimersByTime(70);
            f.client.feed(response.subarray(1, 2));
            vi.advanceTimersByTime(29);
            await flush();
            expect(f.client.closed).toBe(false);
            vi.advanceTimersByTime(1);
            expect(await bounded(f.client.whenClosed)).toEqual({
                kind: 'protocol-error',
                code: 'frame-assembly-timeout',
            });
            expect(await bounded(result)).toMatchObject({
                kind: 'failure',
                code: 'frame-assembly-timeout',
            });
            f.writeGate.resolve();
            await flush();
            expect(names(f.events)).toEqual(['build', 'write', `classify:${A}`]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            if (f) {
                await f.cleanup();
            }

            vi.useRealTimers();
        }
    });
});
