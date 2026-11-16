import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';
import type { JsonObject } from '../../src/types';

// Do not load real network adapters or create a network transport.
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
    message_type: 'private',
    sub_type: 'friend',
    message_id: -123,
    user_id: 10001,
    target_id: 42,
    message: [text('hello ['), at('42'), text('] '), at('all')],
    raw_message: 'synthetic CQ text',
};
const expected = {
    id: expect.any(String),
    time: sent.time,
    type: 'message',
    detail_type: 'private',
    sub_type: '',
    self,
    message_id: '-123',
    user_id: '10001',
    'qq.target_id': '42',
    message: [
        text('hello ['),
        { type: 'mention', data: { user_id: '42' } },
        text('] '),
        { type: 'mention_all', data: {} },
    ],
    alt_message: 'hello [@42] @全体成员',
};
const context = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: () => -123,
    mediaSegmentSink: null,
};
const friend = {
    kind: 'friend_message' as const,
    time: 1700000000,
    selfUin: 10001,
    senderUin: 10001,
    peerUin: 42,
    senderNick: 'synthetic self',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text' as const, text: 'private hello' }],
};
const group = {
    kind: 'group_message' as const,
    time: 1700000000,
    selfUin: 10001,
    groupId: 43,
    groupName: 'synthetic group',
    senderUin: 10001,
    senderNick: 'synthetic self',
    senderCard: '',
    senderRole: 'member',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text' as const, text: 'group hello' }],
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

async function runtimeFixture(uin: string) {
    const generation = new SourceGeneration();
    let runtime!: V12Runtime;
    runtime = new V12Runtime(
        { name: V12_ADAPTER_NAME, enabled: true, host: 'fake', port: 1, allowNonLoopback: false },
        { uin, api: {} as never, buildLifecycleEvent: () => ({}), buildHeartbeatEvent: () => ({}) },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: async () => null,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
            isSourceCurrent: (source, binding) => generation.isCurrent(source, binding),
        },
    );
    await runtime.open();
    generation.setOnline(true);
    const source = generation.capture(runtime[captureBinding]());
    const owner = activateOrderedPollOwner(runtime);
    const options = fixture.options;

    if (!source || owner.status !== 'ready' || !options) {
        await runtime.close();
        throw new Error('synthetic runtime setup failed');
    }

    const orderedContext = {};
    prepareOrderedContext(orderedContext, runtime);

    if (!installOrderedReady(orderedContext, runtime, owner.owner)) {
        owner.owner.invalidate();
        await runtime.close();
        throw new Error('synthetic ordered setup failed');
    }

    const published = vi.fn();
    const unsubscribe = options.subscribe(published);
    published.mockClear();
    return {
        runtime,
        generation,
        source,
        owner: owner.owner,
        orderedContext,
        published,
        unsubscribe,
    };
}

type RuntimeFixture = Awaited<ReturnType<typeof runtimeFixture>>;

async function admit(f: RuntimeFixture, event: JsonObject) {
    const admission = bindOrderedContext(
        f.orderedContext,
        reserveOrderedContext(f.orderedContext),
        f.source,
        true,
    );
    expect(admission.kind).toBe('eligible');
    await withOrderedScope(f.runtime, 'runtime', event, admission, () =>
        f.runtime[receiveSourceEvent](event, {} as never, f.source),
    );
}

async function poll(f: RuntimeFixture) {
    const sink = new Sink();
    const outcome = await f.owner.start(
        {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        },
        sink,
    ).result;
    return { outcome, sink };
}

async function close(f: RuntimeFixture) {
    f.unsubscribe();
    f.owner.invalidate();
    await f.runtime.close();
}

describe('synthetic private self-sent mapping', () => {
    it('preserves the peer extension, signed id, mentions and raw input', () => {
        const input = structuredClone(sent);
        const before = structuredClone(input);
        const event = convertV11Event(input, self)!;
        expect(event).toEqual(expected);
        expect(input).toEqual(before);
        expect(event.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(convertV11Event(input, self)!.id).not.toBe(event.id);
        expect(parseOneBot12EventJson(serializeOneBot12Event(event))).toEqual(event);
    });

    it('uses real V11 friend and group converters and the SDK JSON parser', async () => {
        const inputs = structuredClone([friend, group]);
        const privateV11 = await convertEvent(context, friend);
        const groupV11 = await convertEvent(context, group);
        expect(privateV11).toMatchObject({
            post_type: 'message_sent',
            message_type: 'private',
            sub_type: 'friend',
            self_id: 10001,
            user_id: 10001,
            target_id: 42,
            message_id: -123,
            message: [text('private hello')],
            raw_message: 'private hello',
        });
        expect(groupV11).toMatchObject({ post_type: 'message_sent', group_id: 43 });
        const before = structuredClone([privateV11, groupV11]);
        const privateV12 = convertV11Event(privateV11, self)!;
        const groupV12 = convertV11Event(groupV11, self)!;
        expect(privateV12).toMatchObject({
            detail_type: 'private',
            user_id: '10001',
            message_id: '-123',
            'qq.target_id': '42',
            message: [text('private hello')],
            alt_message: 'private hello',
        });
        expect(groupV12).toMatchObject({ detail_type: 'group', group_id: '43', user_id: '10001' });
        expect(Object.hasOwn(groupV12, 'qq.target_id')).toBe(false);

        for (const event of [privateV12, groupV12]) {
            expect(parseOneBot12EventJson(serializeOneBot12Event(event))).toEqual(event);
        }

        expect([friend, group]).toEqual(inputs);
        expect([privateV11, groupV11]).toEqual(before);
    });

    it('does not invent a peer when the real friend converter has none', async () => {
        const withoutPeer: Omit<typeof friend, 'peerUin'> & { peerUin?: number } = { ...friend };
        delete withoutPeer.peerUin;
        const v11 = await convertEvent(context, withoutPeer);
        expect(Object.hasOwn(v11!, 'target_id')).toBe(false);
        expect(() => convertV11Event(v11, self)).toThrow(V12UnsupportedEventError);
        const zeroPeer = await convertEvent(context, { ...friend, peerUin: 0 });
        expect(Object.hasOwn(zeroPeer!, 'target_id')).toBe(false);
        expect(() => convertV11Event(zeroPeer, self)).toThrow(V12UnsupportedEventError);
    });

    it.each([-2147483648, -1, 1, 2147483647])('keeps signed message id %s', (message_id) => {
        expect(convertV11Event({ ...sent, message_id }, self)).toMatchObject({
            message_id: String(message_id),
            'qq.target_id': '42',
        });
    });

    it('accepts canonical numeric and string peers, including a self conversation', () => {
        for (const target_id of [42, '42', 10001, '10001']) {
            expect(convertV11Event({ ...sent, target_id }, self)).toMatchObject({
                'qq.target_id': String(target_id),
                user_id: '10001',
            });
        }

        expect(
            convertV11Event({ ...sent, self_id: '10001', user_id: '10001', message: [] }, self),
        ).toMatchObject({ message: [], alt_message: '', 'qq.target_id': '42' });
    });

    it('treats a missing, malformed or accessor target as unsupported without invoking it', () => {
        const missing: Omit<typeof sent, 'target_id'> & { target_id?: number } = { ...sent };
        delete missing.target_id;
        const proxy = new Proxy(
            {},
            {
                get() {
                    throw new Error('target getter must not run');
                },
            },
        );

        for (const target_id of [
            undefined,
            null,
            0,
            '0',
            -1,
            '-1',
            '042',
            '+42',
            ' 42',
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            {},
            true,
            proxy,
        ]) {
            expect(() => convertV11Event({ ...sent, target_id }, self)).toThrow(
                V12UnsupportedEventError,
            );
        }

        expect(() => convertV11Event(missing, self)).toThrow(V12UnsupportedEventError);
        const getter = vi.fn(() => 42);
        const input = { ...missing };
        Object.defineProperty(input, 'target_id', { enumerable: true, get: getter });
        expect(() => convertV11Event(input, self)).toThrow(V12UnsupportedEventError);
        expect(getter).not.toHaveBeenCalled();
    });

    it('rejects safely observed contradictory sender metadata without invoking getters', () => {
        expect(() => convertV11Event({ ...sent, sender: { user_id: 42 } }, self)).toThrow(
            V12UnsupportedEventError,
        );
        expect(convertV11Event({ ...sent, sender: { user_id: 10001 } }, self)).toMatchObject({
            user_id: '10001',
            'qq.target_id': '42',
        });
        const getter = vi.fn(() => 42);
        const sender = Object.defineProperty({}, 'user_id', { enumerable: true, get: getter });
        expect(convertV11Event({ ...sent, sender }, self)).toMatchObject({
            user_id: '10001',
            'qq.target_id': '42',
        });
        expect(getter).not.toHaveBeenCalled();
        const proxy = new Proxy(
            {},
            {
                getOwnPropertyDescriptor: () => {
                    throw new Error('trap');
                },
            },
        );
        expect(convertV11Event({ ...sent, sender: proxy }, self)).toMatchObject({
            user_id: '10001',
            'qq.target_id': '42',
        });
    });

    it('distinguishes invalid sender from another sender and mismatched accounts', () => {
        for (const user_id of [
            undefined,
            null,
            0,
            -1,
            '010001',
            1.5,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => convertV11Event({ ...sent, user_id }, self)).toThrow();

            try {
                convertV11Event({ ...sent, user_id }, self);
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect(error).not.toBeInstanceOf(V12UnsupportedEventError);
            }
        }

        expect(() => convertV11Event({ ...sent, user_id: 42 }, self)).toThrow(
            V12UnsupportedEventError,
        );

        for (const self_id of [undefined, null, 0, -1, '010001', 10002]) {
            expect(() => convertV11Event({ ...sent, self_id }, self)).toThrow();
        }

        expect(() => convertV11Event(sent, { ...self, user_id: '10002' })).toThrow();

        for (const sub_type of ['group', 'other', '', undefined]) {
            expect(() => convertV11Event({ ...sent, sub_type }, self)).toThrow(
                V12UnsupportedEventError,
            );
        }
    });

    it('rejects invalid time, message ids and segment shapes', () => {
        for (const time of [undefined, null, -1, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => convertV11Event({ ...sent, time }, self)).toThrow();
        }

        for (const time of [0, 1700000000.25, Number.MAX_SAFE_INTEGER]) {
            const event = convertV11Event({ ...sent, time }, self)!;
            expect(event.time).toBe(time);
            expect(parseOneBot12EventJson(serializeOneBot12Event(event))).toEqual(event);
        }

        for (const message_id of [undefined, 0, -2147483649, 2147483648, 1.5, '-0', '01']) {
            expect(() => convertV11Event({ ...sent, message_id }, self)).toThrow();
        }

        for (const invalid of [
            { raw_message: undefined },
            { message: null },
            { message: [text('ok'), { type: 'image', data: { file: 'fixture' } }] },
            { message: [{ type: 'reply', data: { id: '-123' } }] },
            { message: [at('042')] },
            { message: [{ type: 'at', data: { qq: '42', extra: true } }] },
            { message: [{ type: 'text', data: { text: 1 } }] },
        ]) {
            expect(() => convertV11Event({ ...sent, ...invalid }, self)).toThrow();
        }
    });

    it('does not leak incoming-only auto_reply semantics onto self-sent events', async () => {
        const marked = await convertEvent(context, { ...friend, autoReply: true });
        expect(marked).toMatchObject({ auto_reply: true, target_id: 42 });
        const v12 = convertV11Event(marked, self)!;
        expect(v12).toMatchObject({ 'qq.target_id': '42' });
        expect(Object.hasOwn(v12, 'qq.auto_reply')).toBe(false);
        expect(parseOneBot12EventJson(serializeOneBot12Event(v12))).toEqual(v12);
        const getter = vi.fn(() => true);
        const input = { ...sent };
        Object.defineProperty(input, 'auto_reply', { enumerable: true, get: getter });
        expect(Object.hasOwn(convertV11Event(input, self)!, 'qq.auto_reply')).toBe(false);
        expect(getter).not.toHaveBeenCalled();
    });

    it('keeps received private messages distinct from self-sent target extensions', () => {
        const received = { ...sent, post_type: 'message', user_id: 42 };
        const event = convertV11Event(received, self)!;
        expect(event).toMatchObject({ detail_type: 'private', user_id: '42' });
        expect(Object.hasOwn(event, 'qq.target_id')).toBe(false);
    });
});

describe('private self-sent ordered fake runtime', () => {
    it('skips an unknown peer and delivers real private and group conversions in order', async () => {
        vi.useFakeTimers();
        let f: RuntimeFixture | undefined;

        try {
            f = await runtimeFixture('10001');
            const privateV11 = await convertEvent(context, friend);
            const groupV11 = await convertEvent(context, group);

            if (!privateV11 || !groupV11) {
                throw new Error('fixture conversion failed');
            }

            await admit(f, { ...sent, target_id: 0 });
            expect(f.published).not.toHaveBeenCalled();
            await admit(f, privateV11);
            await admit(f, groupV11);
            await vi.advanceTimersByTimeAsync(0);
            expect(f.published).toHaveBeenCalledTimes(2);
            const { outcome, sink } = await poll(f);
            expect(outcome.kind).toBe('local_finish');
            const events = JSON.parse(sink.body).data as unknown[];
            expect(events).toEqual(f.published.mock.calls.map(([event]) => event));
            expect(events[0]).toMatchObject({
                detail_type: 'private',
                user_id: '10001',
                'qq.target_id': '42',
            });
            expect(events[1]).toMatchObject({ detail_type: 'group', group_id: '43' });

            for (const event of events) {
                expect(parseOneBot12EventJson(serializeOneBot12Event(event))).toEqual(event);
            }

            expect(pollOwnerStats(f.runtime)).toMatchObject({ ordering_gap: false, invalid: 0 });
        } finally {
            if (f) {
                await close(f);
            }

            fixture.options = null;
            vi.useRealTimers();
        }
    });

    it('does not publish or poll an event addressed to a different runtime account', async () => {
        vi.useFakeTimers();
        let f: RuntimeFixture | undefined;

        try {
            f = await runtimeFixture('10002');
            await admit(f, sent);
            await vi.advanceTimersByTimeAsync(0);
            expect(f.published).not.toHaveBeenCalled();
            const result = await poll(f);
            expect(result.outcome.kind).toBe('epoch_invalid');
            expect(result.sink.body).toBe('');
        } finally {
            if (f) {
                await close(f);
            }

            fixture.options = null;
            vi.useRealTimers();
        }
    });

    it('keeps another account isolated and invalidates a retired generation before polling', async () => {
        vi.useFakeTimers();
        let a: RuntimeFixture | undefined;
        let b: RuntimeFixture | undefined;

        try {
            a = await runtimeFixture('10001');
            b = await runtimeFixture('10002');
            await admit(a, sent);
            expect(a.published).toHaveBeenCalledOnce();
            expect(b.published).not.toHaveBeenCalled();
            await admit(b, { ...sent, self_id: 10002, user_id: 10002, target_id: 43 });
            expect(b.published).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(0);
            a.generation.setOnline(false);
            expect(a.runtime[verifySource](a.source)).toBe(false);
            const retired = await poll(a);
            expect(retired.outcome.kind).toBe('epoch_invalid');
            expect(retired.sink.body).toBe('');
            const other = await poll(b);
            expect(other.outcome.kind).toBe('local_finish');
            const delivered = JSON.parse(other.sink.body).data;
            expect(delivered).toEqual([b.published.mock.calls[0][0]]);
            expect(delivered[0]).toMatchObject({
                self: { platform: 'qq', user_id: '10002' },
                'qq.target_id': '43',
            });
            expect(JSON.stringify(delivered)).not.toContain('10001');
        } finally {
            if (a) {
                await close(a);
            }

            if (b) {
                await close(b);
            }

            fixture.options = null;
            vi.useRealTimers();
        }
    });
});
