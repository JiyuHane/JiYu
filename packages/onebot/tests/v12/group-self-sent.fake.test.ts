import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';

// The runtime's network barrel exports real adapters. Replace it with only the
// abstract base, and replace the transport itself before importing the runtime.
const fixture = vi.hoisted(() => ({ options: null as V12TransportOptions | null }));
vi.mock('../../src/network', async () => ({
    IOneBotNetworkAdapter: (await import('../../src/network/adapter')).IOneBotNetworkAdapter,
}));
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: V12TransportOptions) {
            fixture.options = options;
        }
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));

import { parseOneBot12EventJson, serializeOneBot12Event } from '../../../sdk/src/v12/protocol';
import { convertEvent } from '../../src/event-converter';
import { convertV11Event, V12UnsupportedEventError } from '../../src/v12/events';
import { V12Runtime } from '../../src/v12-runtime/runtime';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import { activateOrderedPollOwner, pollOwnerStats } from '../../src/v12-runtime/poll-owner';
import {
    bindOrderedContext,
    captureBinding,
    installOrderedReady,
    prepareOrderedContext,
    receiveSourceEvent,
    reserveOrderedContext,
    SourceGeneration,
    verifySource,
    withOrderedScope,
} from '../../src/v12-runtime/source-generation';

const self = { platform: 'qq', user_id: '10001' };
const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: string | number) => ({ type: 'at', data: { qq } });
const sent = {
    time: 1700000000.25,
    self_id: 10001,
    post_type: 'message_sent',
    message_type: 'group',
    sub_type: 'normal',
    message_id: -123,
    group_id: 43,
    user_id: 10001,
    message: [text('你好['), at('42'), text('] '), at('all'), text('!')],
    raw_message: 'synthetic CQ text',
};
const expected = {
    id: expect.any(String),
    time: sent.time,
    type: 'message',
    detail_type: 'group',
    sub_type: '',
    self,
    message_id: '-123',
    group_id: '43',
    user_id: '10001',
    message: [
        text('你好['),
        { type: 'mention', data: { user_id: '42' } },
        text('] '),
        { type: 'mention_all', data: {} },
        text('!'),
    ],
    alt_message: '你好[@42] @全体成员!',
};

class Sink extends EventEmitter {
    body = '';
    isOpen() {
        return true;
    }
    writeHead() {}
    end(body: string) {
        this.body = body;
        this.emit('finish');
    }
}

describe('synthetic V11 group self-sent to V12', () => {
    it('converts a synthetic group self message through V11, V12 and the SDK JSON parser', async () => {
        const context = {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: () => -123,
            mediaSegmentSink: null,
        };
        const input = {
            kind: 'group_message' as const,
            time: 1700000000,
            selfUin: 10001,
            groupId: 43,
            groupName: 'synthetic group',
            senderUin: 10001,
            senderNick: 'self',
            senderCard: '',
            senderRole: 'member',
            msgSeq: 1,
            msgId: 1,
            elements: [
                { type: 'text' as const, text: 'hello ' },
                { type: 'at' as const, targetUin: 42, uid: 'synthetic-uid' },
            ],
        };
        const inputBefore = structuredClone(input);
        const v11 = await convertEvent(context, input);
        expect(v11).toMatchObject({
            post_type: 'message_sent',
            message_type: 'group',
            sub_type: 'normal',
            self_id: 10001,
            user_id: 10001,
            group_id: 43,
            message_id: -123,
            message: [text('hello '), at('42')],
            raw_message: 'hello [CQ:at,qq=42]',
        });
        const v11Before = structuredClone(v11);
        const v12 = convertV11Event(v11, self)!;
        expect(v12).toEqual({
            id: expect.any(String),
            time: input.time,
            type: 'message',
            detail_type: 'group',
            sub_type: '',
            self,
            message_id: '-123',
            group_id: '43',
            user_id: '10001',
            message: [text('hello '), { type: 'mention', data: { user_id: '42' } }],
            alt_message: 'hello @42',
        });
        expect(parseOneBot12EventJson(serializeOneBot12Event(v12))).toEqual(v12);
        expect(input).toEqual(inputBefore);
        expect(v11).toEqual(v11Before);
    });

    it('preserves identity, signed id and ordered text and mentions without mutating the input', () => {
        const input = structuredClone(sent);
        const before = structuredClone(input);
        const result = convertV11Event(input, self);
        expect(result).toEqual(expected);
        expect(input).toEqual(before);
        expect(result!.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(convertV11Event(input, self)!.id).not.toBe(result!.id);
    });

    it.each([-2147483648, -1, 1, 2147483647])('preserves message id %s', (message_id) => {
        expect(convertV11Event({ ...sent, message_id }, self)).toMatchObject({
            message_id: String(message_id),
            user_id: self.user_id,
            group_id: '43',
        });
    });

    it('preserves a fractional timestamp and rejects an unsafe self-sent timestamp', () => {
        expect(convertV11Event({ ...sent, time: 1700000000.25 }, self)).toMatchObject({
            time: 1700000000.25,
        });
        expect(() => convertV11Event({ ...sent, time: 1e20 }, self)).toThrow();
        expect(
            convertV11Event({ ...sent, post_type: 'message', user_id: 42, time: 1e20 }, self),
        ).toMatchObject({ time: 1e20, user_id: '42' });
    });

    it('accepts canonical string account identifiers, an empty message and empty text', () => {
        expect(
            convertV11Event(
                { ...sent, self_id: '10001', user_id: '10001', group_id: '43', message: [] },
                self,
            ),
        ).toMatchObject({ self, user_id: '10001', group_id: '43', message: [], alt_message: '' });
        expect(convertV11Event({ ...sent, message: [text('')] }, self)).toMatchObject({
            message: [text('')],
            alt_message: '',
        });
    });

    it('rejects account mismatch, malformed identities and a different sender', () => {
        for (const self_id of [undefined, null, 0, '010001', 10002]) {
            expect(() => convertV11Event({ ...sent, self_id }, self)).toThrow();
        }

        for (const user_id of [undefined, null, 0, '010001', -1, 1.5]) {
            expect(() => convertV11Event({ ...sent, user_id }, self)).toThrow();
        }

        expect(() => convertV11Event({ ...sent, user_id: 42 }, self)).toThrow(
            V12UnsupportedEventError,
        );
        expect(() => convertV11Event(sent, { ...self, user_id: '10002' })).toThrow();
    });

    it('fails conservatively for malformed message fields, unsupported segments and subtypes', () => {
        for (const message_id of [undefined, 0, -2147483649, 2147483648, 1.5]) {
            expect(() => convertV11Event({ ...sent, message_id }, self)).toThrow();
        }

        for (const group_id of [undefined, 0, '043', -1]) {
            expect(() => convertV11Event({ ...sent, group_id }, self)).toThrow();
        }

        for (const time of [undefined, -1, NaN, Infinity, '1']) {
            expect(() => convertV11Event({ ...sent, time }, self)).toThrow();
        }

        for (const invalid of [
            { message: null },
            { raw_message: undefined },
            { sub_type: 'anonymous' },
            { message: [text('before'), { type: 'image', data: { file: 'fixture' } }] },
            { message: [at('042')] },
            { message: [{ type: 'at', data: { qq: '42', extra: true } }] },
        ]) {
            expect(() => convertV11Event({ ...sent, ...invalid }, self)).toThrow();
        }
    });

    it('keeps private self-sent with an unknown target unsupported', () => {
        expect(() =>
            convertV11Event(
                { ...sent, message_type: 'private', sub_type: 'friend', target_id: 0 },
                self,
            ),
        ).toThrow(V12UnsupportedEventError);
    });

    it('keeps the ordinary group received path and sender independent of self', () => {
        const received = { ...sent, post_type: 'message', user_id: 42 };
        expect(convertV11Event(received, self)).toEqual({ ...expected, user_id: '42' });
    });

    it.each([
        { type: 'image', data: { file: 'synthetic-image' } },
        { type: 'reply', data: { id: '-123' } },
    ])('records an ordered gap for a self-sent unsupported $type segment', async (segment) => {
        vi.useFakeTimers();
        const generation = new SourceGeneration();
        let runtime!: V12Runtime;
        runtime = new V12Runtime(
            {
                name: V12_ADAPTER_NAME,
                enabled: true,
                host: 'fake',
                port: 1,
                allowNonLoopback: false,
            },
            {
                uin: '10001',
                api: {} as never,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
            {
                getStatus: () => ({ good: true, online: true }),
                getSentMessageTime: async () => null,
                trackAction: (_label, start) => start(),
                canAccept: () => true,
                captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
                isSourceCurrent: (source, binding) => generation.isCurrent(source, binding),
            },
        );
        let owner: ReturnType<typeof activateOrderedPollOwner> | undefined;

        try {
            await runtime.open();
            generation.setOnline(true);
            const source = generation.capture(runtime[captureBinding]());
            owner = activateOrderedPollOwner(runtime);

            if (owner.status !== 'ready' || !source || !fixture.options) {
                throw new Error('synthetic runtime setup failed');
            }

            const context = {};
            prepareOrderedContext(context, runtime);
            expect(installOrderedReady(context, runtime, owner.owner)).not.toBeNull();
            const published = vi.fn();
            const unsubscribe = fixture.options.subscribe(published);
            published.mockClear();
            const input = { ...sent, message: [text('before'), segment] };
            const admission = bindOrderedContext(
                context,
                reserveOrderedContext(context),
                source,
                true,
            );
            expect(admission.kind).toBe('eligible');
            await withOrderedScope(runtime, 'runtime', input, admission, () =>
                runtime[receiveSourceEvent](input, {} as never, source),
            );
            await vi.advanceTimersByTimeAsync(0);

            for (let i = 0; i < 20; i++) {
                await Promise.resolve();
            }

            expect(published).not.toHaveBeenCalled();
            expect(pollOwnerStats(runtime)).toMatchObject({
                active: false,
                ordering_gap: true,
                ordering_reason: 'child_failed',
            });
            expect(activateOrderedPollOwner(runtime).status).toBe('degraded');
            const sink = new Sink();
            const outcome = await owner.owner.start(
                {
                    limit: 0,
                    timeoutMs: 0,
                    maxOutputBytes: 65536,
                    responseDeadline: performance.now() + 5000,
                },
                sink,
            ).result;
            expect(outcome.kind).toBe('epoch_invalid');
            expect(sink.body).toBe('');

            // Fanout remains separate from the failed ordered polling owner.
            await runtime.onEvent(sent);
            expect(published).toHaveBeenCalledOnce();
            expect(published).toHaveBeenCalledWith(expected);
            expect(pollOwnerStats(runtime)?.ordering_gap).toBe(true);
            expect(activateOrderedPollOwner(runtime).status).toBe('degraded');
            unsubscribe();
        } finally {
            if (owner?.status === 'ready') {
                owner.owner.invalidate();
            }

            await runtime.close();
            fixture.options = null;
            vi.useRealTimers();
        }
    });

    it('publishes and polls a real conversion through an explicitly admitted fake source', async () => {
        vi.useFakeTimers();
        const generation = new SourceGeneration();
        let runtime!: V12Runtime;
        runtime = new V12Runtime(
            {
                name: V12_ADAPTER_NAME,
                enabled: true,
                host: 'fake',
                port: 1,
                allowNonLoopback: false,
            },
            {
                uin: '10001',
                api: {} as never,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
            {
                getStatus: () => ({ good: true, online: true }),
                getSentMessageTime: async () => null,
                trackAction: (_label, start) => start(),
                canAccept: () => true,
                captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
                isSourceCurrent: (source, binding) => generation.isCurrent(source, binding),
            },
        );
        let owner: ReturnType<typeof activateOrderedPollOwner> | undefined;

        try {
            await runtime.open();
            generation.setOnline(true);
            const source = generation.capture(runtime[captureBinding]());
            expect(source).toBeDefined();
            expect(runtime[verifySource](source)).toBe(true);
            owner = activateOrderedPollOwner(runtime);

            if (owner.status !== 'ready' || !source || !fixture.options) {
                throw new Error('synthetic runtime setup failed');
            }

            const context = {};
            prepareOrderedContext(context, runtime);
            expect(installOrderedReady(context, runtime, owner.owner)).not.toBeNull();
            const published = vi.fn();
            const unsubscribe = fixture.options.subscribe(published);
            published.mockClear();
            const admission = bindOrderedContext(
                context,
                reserveOrderedContext(context),
                source,
                true,
            );
            expect(admission.kind).toBe('eligible');
            const payload = {} as never;
            await withOrderedScope(runtime, 'runtime', sent, admission, () =>
                runtime[receiveSourceEvent](sent, payload, source),
            );
            expect(published).toHaveBeenCalledOnce();
            expect(published).toHaveBeenCalledWith(expected);
            await vi.advanceTimersByTimeAsync(0);
            const sink = new Sink();
            const outcome = await owner.owner.start(
                {
                    limit: 0,
                    timeoutMs: 0,
                    maxOutputBytes: 65536,
                    responseDeadline: performance.now() + 5000,
                },
                sink,
            ).result;
            expect(outcome.kind).toBe('local_finish');
            expect(JSON.parse(sink.body).data).toEqual([published.mock.calls[0][0]]);
            expect(pollOwnerStats(runtime)?.ordering_gap).toBe(false);
            generation.setOnline(false);
            expect(runtime[verifySource](source)).toBe(false);
            unsubscribe();
        } finally {
            if (owner?.status === 'ready') {
                owner.owner.invalidate();
            }

            await runtime.close();
            fixture.options = null;
            vi.useRealTimers();
        }
    });
});
