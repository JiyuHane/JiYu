import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    OneBot12HttpClient,
    parseOneBot12EventJson,
    serializeOneBot12Event,
} from '../../../sdk/src/v12/index';
import { convertEvent } from '../../src/event-converter';
import { convertV11Event, V12UnsupportedEventError } from '../../src/v12/events';
import {
    activateOrderedPollOwner,
    createPollGate,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import { SourceGeneration, type V12Source } from '../../src/v12-runtime/source-generation';

const self = { platform: 'qq', user_id: '10001' };
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
    senderUin: 42,
    senderNick: 'peer',
    msgSeq: 1,
    msgId: 1,
    elements: [
        { type: 'text' as const, text: 'hi' },
        { type: 'at' as const, targetUin: 123, uid: 'private-source-uid' },
    ],
};
const group = {
    kind: 'group_message' as const,
    time: 1700000000,
    selfUin: 10001,
    groupId: 43,
    groupName: 'group',
    senderUin: 42,
    senderNick: 'peer',
    senderCard: '',
    senderRole: 'member',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text' as const, text: 'hi' }],
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function ownerFixture() {
    const binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    const runtime = {};
    registerPollHost(
        runtime,
        {
            self,
            captureBinding: () => binding,
            captureSource: () => generation.capture(binding),
            verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
        },
        createPollGate(),
    );
    const active = activateOrderedPollOwner(runtime);

    if (active.status !== 'ready') {
        throw new Error('owner not ready');
    }

    return { runtime, owner: active.owner, source: generation.capture(binding)! };
}

function publish(fixture: ReturnType<typeof ownerFixture>, event: unknown) {
    const parent = fixture.owner.begin(fixture.source)!;
    const child = parent.child()!;
    expect(parent.seal()).toBe(true);
    expect(child.resolve(event)).toBe(true);
}

describe('private QQ auto-reply extension', () => {
    it('preserves the real v11 converter output through ordered owner JSON and SDK', async () => {
        const markedV11 = await convertEvent(context, { ...friend, autoReply: true });
        const plainV11 = await convertEvent(context, friend);
        expect(markedV11).toMatchObject({ auto_reply: true, message_id: -123 });
        expect(Object.hasOwn(plainV11!, 'auto_reply')).toBe(false);
        const original = structuredClone([markedV11, plainV11]);
        const marked = convertV11Event(markedV11, self)!;
        const plain = convertV11Event(plainV11, self)!;
        expect(marked).toEqual({ ...plain, id: marked.id, 'qq.auto_reply': true });
        expect(Object.hasOwn(marked, 'qq.auto_reply')).toBe(true);
        expect(Object.hasOwn(plain, 'qq.auto_reply')).toBe(false);
        expect(marked).toMatchObject({
            message_id: '-123',
            user_id: '42',
            alt_message: 'hi@123',
            message: [
                { type: 'text', data: { text: 'hi' } },
                { type: 'mention', data: { user_id: '123' } },
            ],
        });
        expect([markedV11, plainV11]).toEqual(original);
        expect(parseOneBot12EventJson(serializeOneBot12Event(marked))).toEqual(marked);
        vi.useFakeTimers();
        const fixture = ownerFixture();
        let body = '';

        try {
            publish(fixture, marked);
            publish(fixture, plain);
            await vi.advanceTimersByTimeAsync(0);
            expect(pollOwnerStats(fixture.runtime)).toMatchObject({
                accepted: 2,
                invalid: 0,
                ordering_gap: false,
            });
            const listeners = new Map<string, () => void>();
            const sink = {
                isOpen: () => true,
                on: (event: string, listener: () => void) => listeners.set(event, listener),
                off: (event: string) => listeners.delete(event),
                writeHead: vi.fn(),
                end: vi.fn((value: string) => {
                    body = value;
                    listeners.get('finish')?.();
                }),
            };
            const poll = fixture.owner.start(
                {
                    limit: 2,
                    timeoutMs: 0,
                    maxOutputBytes: 4096,
                    responseDeadline: performance.now() + 1000,
                    echo: 'fixture-echo',
                },
                sink,
            );
            expect(await poll.result).toEqual({ kind: 'local_finish', response: 'events' });
            expect(JSON.parse(body)).toEqual({
                status: 'ok',
                retcode: 0,
                data: [marked, plain],
                message: '',
                echo: 'fixture-echo',
            });
            expect(body).not.toContain('private-source-uid');
        } finally {
            fixture.owner.invalidate();
            vi.useRealTimers();
        }

        const fakeFetch = vi.fn(async () => new Response(body, { status: 200 }));
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.invalid',
            fetch: fakeFetch,
        });
        const response = await client.getLatestEvents(
            { limit: 2, timeout: 0 },
            { echo: 'fixture-echo' },
        );
        expect(response).toEqual(JSON.parse(body));
        expect(response.data).toEqual([marked, plain]);
        expect(fakeFetch).toHaveBeenCalledOnce();
    });

    it('ignores non-true v11 values and group fields without synthesizing false', async () => {
        const v11 = (await convertEvent(context, friend))!;

        for (const value of [false, 0, 1, 'true', null]) {
            const converted = convertV11Event({ ...v11, auto_reply: value }, self)!;
            expect(Object.hasOwn(converted, 'qq.auto_reply')).toBe(false);
        }

        const inherited = Object.assign(Object.create({ auto_reply: true }), v11);
        expect(Object.hasOwn(convertV11Event(inherited, self)!, 'qq.auto_reply')).toBe(false);
        const groupV11 = (await convertEvent(context, group))!;
        const convertedGroup = convertV11Event({ ...groupV11, auto_reply: true }, self)!;
        expect(convertedGroup).toMatchObject({
            detail_type: 'group',
            message_id: '-123',
            group_id: '43',
        });
        expect(Object.hasOwn(convertedGroup, 'qq.auto_reply')).toBe(false);
        const sent = await convertEvent(context, { ...friend, senderUin: 10001, autoReply: true });
        expect(() => convertV11Event(sent, self)).toThrow(V12UnsupportedEventError);
    });

    it('ignores hidden and accessor v11 extras without invoking the getter', async () => {
        const v11 = (await convertEvent(context, friend))!;
        const getter = vi.fn(() => true);
        const hidden = { ...v11 };
        const accessor = { ...v11 };
        Object.defineProperty(hidden, 'auto_reply', { value: true, enumerable: false });
        Object.defineProperty(accessor, 'auto_reply', { get: getter, enumerable: true });

        for (const event of [hidden, accessor]) {
            const converted = convertV11Event(event, self)!;
            expect(Object.hasOwn(converted, 'qq.auto_reply')).toBe(false);
        }

        expect(getter).not.toHaveBeenCalled();
    });

    it('ordered owner accepts only a true private extension', async () => {
        const v11 = (await convertEvent(context, friend))!;
        const event = convertV11Event(v11, self)!;
        vi.useFakeTimers();
        const fixture = ownerFixture();

        try {
            publish(fixture, { ...event, 'qq.auto_reply': true });
            await vi.advanceTimersByTimeAsync(0);
            expect(pollOwnerStats(fixture.runtime)).toMatchObject({
                accepted: 1,
                invalid: 0,
                ordering_gap: false,
            });
        } finally {
            fixture.owner.invalidate();
        }
    });

    it.each([false, 0, 1, 'true', null])(
        'ordered owner rejects private extension value %j',
        async (value) => {
            const v11 = (await convertEvent(context, friend))!;
            const event = convertV11Event(v11, self)!;
            vi.useFakeTimers();
            const fixture = ownerFixture();

            try {
                publish(fixture, { ...event, 'qq.auto_reply': value });
                await vi.advanceTimersByTimeAsync(0);
                expect(pollOwnerStats(fixture.runtime)).toMatchObject({
                    accepted: 0,
                    invalid: 1,
                    ordering_gap: true,
                });
            } finally {
                fixture.owner.invalidate();
            }
        },
    );

    it('ordered owner rejects the extension on a notice and rejects additional fields', async () => {
        const friendV11 = (await convertEvent(context, friend))!;
        const privateEvent = convertV11Event(friendV11, self)!;
        const notice = convertV11Event(
            {
                time: 1,
                self_id: 10001,
                post_type: 'notice',
                notice_type: 'friend_add',
                user_id: 42,
            },
            self,
        )!;
        vi.useFakeTimers();

        for (const candidate of [
            { ...notice, 'qq.auto_reply': true },
            { ...privateEvent, 'qq.auto_reply': true, extra: true },
        ]) {
            const fixture = ownerFixture();

            try {
                publish(fixture, candidate);
                await vi.advanceTimersByTimeAsync(0);
                expect(pollOwnerStats(fixture.runtime)).toMatchObject({
                    accepted: 0,
                    invalid: 1,
                    ordering_gap: true,
                });
            } finally {
                fixture.owner.invalidate();
            }
        }
    });

    it.each(['nonenumerable', 'accessor', 'proxy'])(
        'rejects %s at ingress without invoking handlers',
        async (kind) => {
            const v11 = (await convertEvent(context, friend))!;
            const event = convertV11Event(v11, self)!;
            const getter = vi.fn(() => true);
            const trap = vi.fn(Reflect.ownKeys);
            let candidate: unknown = { ...event };

            if (kind === 'nonenumerable') {
                Object.defineProperty(candidate, 'qq.auto_reply', {
                    value: true,
                    enumerable: false,
                });
            } else if (kind === 'accessor') {
                Object.defineProperty(candidate, 'qq.auto_reply', {
                    get: getter,
                    enumerable: true,
                });
            } else {
                candidate = new Proxy({ ...event, 'qq.auto_reply': true }, { ownKeys: trap });
            }

            vi.useFakeTimers();
            const fixture = ownerFixture();

            try {
                const parent = fixture.owner.begin(fixture.source)!;
                const child = parent.child()!;
                expect(child.resolve(candidate)).toBe(false);
                await vi.advanceTimersByTimeAsync(0);
                expect(getter).not.toHaveBeenCalled();
                expect(trap).not.toHaveBeenCalled();
                expect(pollOwnerStats(fixture.runtime)).toMatchObject({
                    accepted: 0,
                    ordering_gap: true,
                });
            } finally {
                fixture.owner.invalidate();
            }
        },
    );

    it('ordered owner rejects the extension on group events', async () => {
        const v11 = (await convertEvent(context, group))!;
        const event = convertV11Event(v11, self)!;
        vi.useFakeTimers();
        const fixture = ownerFixture();

        try {
            publish(fixture, { ...event, 'qq.auto_reply': true });
            await vi.advanceTimersByTimeAsync(0);
            expect(pollOwnerStats(fixture.runtime)).toMatchObject({
                accepted: 0,
                invalid: 1,
                ordering_gap: true,
            });
        } finally {
            fixture.owner.invalidate();
        }
    });
});
