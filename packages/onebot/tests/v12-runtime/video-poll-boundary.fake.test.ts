import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12VideoFileTokens } from '../../src/v12/image-file-token';
import type { OrderedPollOwner } from '../../src/v12-runtime/poll-owner';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12Source } from '../../src/v12-runtime/source-generation';

// A regression in the subject imports must not load native storage or transports.
vi.mock('@snowluma/sqlite', () => {
    throw new Error('SQLite import is outside this in-memory fixture');
});
vi.mock('@snowluma/websocket', () => {
    throw new Error('WebSocket module import is outside this in-memory fixture');
});

let pollApi: typeof import('../../src/v12-runtime/poll-owner');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let tokenApi: typeof import('../../src/v12/image-file-token');
let guards: Array<{ mock: { calls: unknown[] } }> = [];
const owners: OrderedPollOwner[] = [];
const issuers: V12VideoFileTokens[] = [];

function forbidden(): never {
    throw new Error('unexpected network, child process, or native operation in video fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    const fetchGuard = vi.fn(forbidden);
    const webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    const eventSourceGuard = vi.fn(function ForbiddenEventSource() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    vi.stubGlobal('EventSource', eventSourceGuard);
    guards = [
        fetchGuard,
        webSocketGuard,
        eventSourceGuard,
        vi.spyOn(net, 'createServer').mockImplementation(forbidden),
        vi.spyOn(net, 'createConnection').mockImplementation(forbidden),
        vi.spyOn(net, 'connect').mockImplementation(forbidden),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(forbidden),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(http, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http, 'request').mockImplementation(forbidden),
        vi.spyOn(http, 'get').mockImplementation(forbidden),
        vi.spyOn(https, 'createServer').mockImplementation(forbidden),
        vi.spyOn(https, 'request').mockImplementation(forbidden),
        vi.spyOn(https, 'get').mockImplementation(forbidden),
        vi.spyOn(http2, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'connect').mockImplementation(forbidden),
        vi.spyOn(tls, 'createServer').mockImplementation(forbidden),
        vi.spyOn(tls, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram, 'createSocket').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];
    // Named Node built-in imports observe the same guards as the default exports.
    syncBuiltinESMExports();
    sourceApi = await import('../../src/v12-runtime/source-generation');
    pollApi = await import('../../src/v12-runtime/poll-owner');
    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
    tokenApi = await import('../../src/v12/image-file-token');
});

afterEach(async () => {
    let cleanupFailed = false;

    try {
        for (const owner of owners.splice(0)) {
            try {
                owner.invalidate();
            } catch {
                cleanupFailed = true;
            }
        }

        for (const issuer of issuers.splice(0)) {
            try {
                issuer.revoke();
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        vi.clearAllTimers();
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        guards = [];
        expect(cleanupFailed).toBe(false);
        expect(calls).toEqual(calls.map(() => 0));
    }
});

const self = { platform: 'qq', user_id: '12345' };
const VIDEO_URL = 'https://fixture.invalid/synthetic-video.mp4';

class MemorySink extends EventEmitter implements PollSink {
    body = '';
    writeHead = vi.fn();

    isOpen(): boolean {
        return true;
    }

    end(body: string): void {
        this.body = body;
        this.emit('finish');
    }
}

function required<T>(value: T | null | undefined, name: string): T {
    if (value === null || value === undefined) {
        throw new Error(`synthetic ${name} missing`);
    }

    return value;
}

function fixture() {
    const runtime = {};
    let binding = {};
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    pollApi.registerPollHost(runtime, {
        self: { ...self },
        captureBinding: () => binding,
        captureSource: () => generation.capture(binding),
        verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
    });

    function activate(): OrderedPollOwner {
        const result = pollApi.activateOrderedPollOwner(runtime);

        if (result.status !== 'ready') {
            throw new Error(`synthetic ordered owner: ${result.status}`);
        }

        owners.push(result.owner);
        return result.owner;
    }

    const owner = activate();
    return {
        runtime,
        generation,
        owner,
        activate,
        source: () => required(generation.capture(binding), 'source ticket'),
        binding: () => binding,
        replaceBinding: () => {
            binding = {};
        },
    };
}

function issueVideo(): string {
    const issuer = new tokenApi.V12VideoFileTokens(self.user_id);
    issuers.push(issuer);
    // URL is a local string input only; issue() performs no fetch or file access.
    return issuer.issue(VIDEO_URL);
}

function event(id: number, message: unknown[]) {
    return {
        id: `synthetic-event-${id}`,
        // Descending time makes it observable that this fixture uses FIFO, not time order.
        time: 100 - id,
        type: 'message',
        detail_type: 'private',
        sub_type: '',
        self: { ...self },
        message_id: String(-id),
        message,
        alt_message: '[synthetic message]',
        user_id: '23456',
    };
}

function request(limit = 0) {
    return {
        limit,
        timeoutMs: 0,
        maxOutputBytes: 65536,
        responseDeadline: performance.now() + 10000,
    };
}

async function settle(): Promise<void> {
    for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
    }
}

describe('ordered video poll boundaries (in-process fixture only)', () => {
    it('keeps mixed media FIFO and leaves empty polls unresolved', async () => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const emptyBefore = new MemorySink();
        expect(await f.owner.start(request(), emptyBefore).result).toEqual({
            kind: 'empty_unresolved',
            reason: 'empty',
        });
        expect(emptyBefore.writeHead).not.toHaveBeenCalled();
        expect(emptyBefore.body).toBe('');

        const video = issueVideo();
        expect(video.startsWith(tokenApi.V12_VIDEO_TOKEN_PREFIX)).toBe(true);
        const first = event(1, [
            { type: 'text', data: { text: 'synthetic' } },
            { type: 'image', data: { file_id: 'image-fixture' } },
            { type: 'voice', data: { file_id: 'voice-fixture' } },
            { type: 'video', data: { file_id: video } },
        ]);
        const second = {
            ...event(2, [
                { type: 'mention', data: { user_id: '45678' } },
                { type: 'video', data: { file_id: 'second-video' } },
                { type: 'mention_all', data: {} },
            ]),
            detail_type: 'group',
            group_id: '34567',
        };
        const firstParent = required(f.owner.begin(f.source()), 'first parent');
        const firstChild = required(firstParent.child(), 'first child');
        expect(firstParent.seal()).toBe(true);
        const secondParent = required(f.owner.begin(f.source()), 'second parent');
        const secondChild = required(secondParent.child(), 'second child');
        expect(secondParent.seal()).toBe(true);
        expect(secondChild.resolve(second)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(enqueue).not.toHaveBeenCalled();
        expect(firstChild.resolve(first)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(enqueue.mock.calls.map(([value]) => value)).toEqual([first, second]);
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 2,
            invalid: 0,
            ordering_gap: false,
        });

        const firstSink = new MemorySink();
        expect(await f.owner.start(request(1), firstSink).result).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(firstSink.writeHead).toHaveBeenCalledOnce();
        expect(JSON.parse(firstSink.body).data).toEqual([first]);
        const secondSink = new MemorySink();
        expect(await f.owner.start(request(), secondSink).result).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(secondSink.writeHead).toHaveBeenCalledOnce();
        expect(JSON.parse(secondSink.body).data).toEqual([second]);
        const emptyAfter = new MemorySink();
        expect(await f.owner.start(request(), emptyAfter).result).toEqual({
            kind: 'empty_unresolved',
            reason: 'empty',
        });
        expect(emptyAfter.writeHead).not.toHaveBeenCalled();
        expect(emptyAfter.body).toBe('');
    });

    it.each([
        { label: 'one UTF-16 unit', fileId: 'v', length: 1 },
        { label: '4096 ASCII units', fileId: 'v'.repeat(4096), length: 4096 },
        { label: '4096 supplementary units', fileId: '🪶'.repeat(2048), length: 4096 },
    ])('accepts video file_id at $label', async ({ fileId, length }) => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const input = event(1, [{ type: 'video', data: { file_id: fileId } }]);
        expect(fileId.length).toBe(length);
        const parent = required(f.owner.begin(f.source()), 'parent');
        const child = required(parent.child(), 'child');
        expect(child.resolve(input)).toBe(true);
        expect(parent.seal()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.results[0]).toMatchObject({ type: 'return', value: 'accepted' });
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 1,
            invalid: 0,
            ordering_gap: false,
        });
        const sink = new MemorySink();
        expect(await f.owner.start(request(), sink).result).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(JSON.parse(sink.body).data).toEqual([input]);
    });

    it.each([
        { label: 'empty file_id', segment: { type: 'video', data: { file_id: '' } } },
        {
            label: '4097 ASCII units',
            segment: { type: 'video', data: { file_id: 'v'.repeat(4097) } },
        },
        {
            label: '4097 supplementary units',
            segment: { type: 'video', data: { file_id: '🪶'.repeat(2048) + 'v' } },
        },
        { label: 'numeric file_id', segment: { type: 'video', data: { file_id: 1 } } },
        { label: 'null file_id', segment: { type: 'video', data: { file_id: null } } },
        { label: 'boolean file_id', segment: { type: 'video', data: { file_id: false } } },
        { label: 'object file_id', segment: { type: 'video', data: { file_id: {} } } },
        { label: 'array file_id', segment: { type: 'video', data: { file_id: [] } } },
        { label: 'missing file_id', segment: { type: 'video', data: {} } },
        {
            label: 'extra data property',
            segment: { type: 'video', data: { file_id: 'v', extra: true } },
        },
        {
            label: 'extra segment property',
            segment: { type: 'video', data: { file_id: 'v' }, extra: true },
        },
        { label: 'missing data', segment: { type: 'video' } },
        { label: 'null data', segment: { type: 'video', data: null } },
        { label: 'array data', segment: { type: 'video', data: [] } },
        { label: 'unsupported type', segment: { type: 'audio', data: { file_id: 'v' } } },
        { label: 'wrong type case', segment: { type: 'Video', data: { file_id: 'v' } } },
        { label: 'nonstring type', segment: { type: 1, data: { file_id: 'v' } } },
    ])('rejects $label with a visible sticky gap', async ({ segment }) => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const parent = required(f.owner.begin(f.source()), 'parent');
        const child = required(parent.child(), 'child');
        // Snapshot admission is separate from the ordered event schema check.
        expect(child.resolve(event(1, [segment]))).toBe(true);
        expect(parent.seal()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        expect(enqueue).not.toHaveBeenCalled();
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 0,
            invalid: 1,
            ordering_gap: true,
            ordering_reason: 'sink_error',
        });
        const sink = new MemorySink();
        expect(await f.owner.start(request(), sink).result).toEqual({ kind: 'epoch_invalid' });
        expect(sink.writeHead).not.toHaveBeenCalled();
        expect(sink.body).toBe('');
        expect(pollApi.activateOrderedPollOwner(f.runtime).status).toBe('degraded');
    });

    it('keeps the event byte budget for an otherwise valid 4096-unit video ID', async () => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const input = event(1, [{ type: 'video', data: { file_id: 'v'.repeat(4096) } }]);
        input.alt_message = 'x'.repeat(64 * 1024);
        expect(Buffer.byteLength(JSON.stringify(input), 'utf8') + 2).toBeGreaterThan(64 * 1024);
        const parent = required(f.owner.begin(f.source()), 'parent');
        const child = required(parent.child(), 'child');
        expect(child.resolve(input)).toBe(false);
        await settle();
        expect(enqueue).not.toHaveBeenCalled();
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 0,
            ordering_gap: true,
            ordering_reason: 'event_too_large',
        });
        expect(pollApi.activateOrderedPollOwner(f.runtime).status).toBe('degraded');
    });

    it('drops a video when the source goes offline between issue and resolve', async () => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const old = f.source();
        const fileId = issueVideo();
        const parent = required(f.owner.begin(old), 'parent');
        const child = required(parent.child(), 'child');
        const pending = event(1, [{ type: 'video', data: { file_id: fileId } }]);
        expect(f.generation.isCurrent(old, f.binding())).toBe(true);
        f.generation.setOnline(false);
        expect(f.generation.isCurrent(old, f.binding())).toBe(false);
        expect(child.resolve(pending)).toBe(false);
        await settle();
        expect(enqueue).not.toHaveBeenCalled();
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 0,
            ordering_gap: true,
        });
        const sink = new MemorySink();
        expect(await f.owner.start(request(), sink).result).toEqual({ kind: 'epoch_invalid' });
        expect(sink.writeHead).not.toHaveBeenCalled();
        expect(sink.body).toBe('');
    });

    it('does not enqueue when the source expires between resolve and flush', async () => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const old = f.source();
        const fileId = issueVideo();
        const parent = required(f.owner.begin(old), 'parent');
        const child = required(parent.child(), 'child');
        expect(child.resolve(event(1, [{ type: 'video', data: { file_id: fileId } }]))).toBe(true);
        expect(parent.seal()).toBe(true);
        f.generation.setOnline(false);
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        expect(enqueue).not.toHaveBeenCalled();
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 0,
            ordering_gap: true,
        });
        const sink = new MemorySink();
        expect(await f.owner.start(request(), sink).result).toEqual({ kind: 'epoch_invalid' });
        expect(sink.writeHead).not.toHaveBeenCalled();
        expect(sink.body).toBe('');
    });

    it.each(['binding', 'online epoch'] as const)(
        'does not deliver an old issued video after a %s change',
        async (change) => {
            const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
            const f = fixture();
            const old = f.source();
            const oldVideo = issueVideo();
            const parent = required(f.owner.begin(old), 'old parent');
            const child = required(parent.child(), 'old child');
            const oldEvent = event(1, [{ type: 'video', data: { file_id: oldVideo } }]);

            if (change === 'binding') {
                f.replaceBinding();
            } else {
                f.generation.setOnline(false);
                f.generation.setOnline(true);
            }

            const fresh = f.source();
            expect(sourceApi.sameSourceEpoch(old, fresh)).toBe('different');
            expect(f.generation.isCurrent(old, f.binding())).toBe(false);
            expect(child.resolve(oldEvent)).toBe(false);
            await settle();
            expect(enqueue).not.toHaveBeenCalled();
            const oldSink = new MemorySink();
            expect(await f.owner.start(request(), oldSink).result).toEqual({
                kind: 'epoch_invalid',
            });
            expect(oldSink.writeHead).not.toHaveBeenCalled();
            expect(oldSink.body).toBe('');

            const replacement = f.activate();
            expect(replacement.begin(old)).toBeNull();
            const freshParent = required(replacement.begin(fresh), 'fresh parent');
            const freshChild = required(freshParent.child(), 'fresh child');
            // A separate issuer supplies data; the fixture does not manage issuer lifetime.
            const freshEvent = event(2, [{ type: 'video', data: { file_id: issueVideo() } }]);
            expect(freshChild.resolve(freshEvent)).toBe(true);
            expect(freshParent.seal()).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(enqueue).toHaveBeenCalledOnce();
            expect(enqueue.mock.calls[0]?.[0]).toEqual(freshEvent);
            expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 1,
                ordering_gap: false,
            });
            const freshSink = new MemorySink();
            expect(await replacement.start(request(), freshSink).result).toEqual({
                kind: 'local_finish',
                response: 'events',
            });
            expect(JSON.parse(freshSink.body).data).toEqual([freshEvent]);
        },
    );
});

// This explicit ordered-owner fixture does not establish production HTTP admission.
