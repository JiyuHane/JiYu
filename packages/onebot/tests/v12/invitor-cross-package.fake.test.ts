import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient, parseOneBot12Event } from '../../../sdk/src/v12/index';
import { convertEvent } from '../../src/event-converter';
import { convertV11Event } from '../../src/v12/events';
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
    messageIdResolver: null,
    mediaSegmentSink: null,
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('OneBot producer to SDK v12 through an in-memory transport', () => {
    it('preserves distinct known and unknown inviters across the ordered fake owner', async () => {
        const makeV11 = (invitorUin: number, time: number) =>
            convertEvent(context, {
                kind: 'group_member_join',
                time,
                selfUin: 10001,
                groupId: 43,
                userUin: 42,
                operatorUin: 44,
                invitorUin,
                joinType: 'approve',
            });
        const knownV11 = await makeV11(45, 1);
        const unknownV11 = await makeV11(0, 2);
        const commonV11 = {
            self_id: 10001,
            post_type: 'notice',
            notice_type: 'group_increase',
            sub_type: 'approve',
            group_id: 43,
            user_id: 42,
            operator_id: 44,
        };
        expect(knownV11).toEqual({
            ...commonV11,
            time: 1,
            invitor_id: 45,
            invitor_status: 'known',
        });
        expect(unknownV11).toEqual({
            ...commonV11,
            time: 2,
            invitor_id: 0,
            invitor_status: 'unknown',
        });
        const originalV11 = structuredClone([knownV11, unknownV11]);
        const known = convertV11Event(knownV11, self);
        const unknown = convertV11Event(unknownV11, self);
        expect(known).toEqual({
            id: expect.any(String),
            time: 1,
            type: 'notice',
            detail_type: 'group_member_increase',
            sub_type: '',
            self,
            group_id: '43',
            user_id: '42',
            operator_id: '44',
            'qq.invitor_id': '45',
        });
        expect(unknown).toEqual({
            id: expect.any(String),
            time: 2,
            type: 'notice',
            detail_type: 'group_member_increase',
            sub_type: '',
            self,
            group_id: '43',
            user_id: '42',
            operator_id: '44',
        });
        expect(known).not.toBeNull();
        expect(unknown).not.toBeNull();
        expect(Object.hasOwn(unknown!, 'qq.invitor_id')).toBe(false);
        const originals = structuredClone([known, unknown]);

        vi.useFakeTimers();
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
        expect(active.status).toBe('ready');

        if (active.status !== 'ready') {
            throw new Error('owner not ready');
        }

        let responseBody = '';

        try {
            const first = active.owner.begin(generation.capture(binding)!)!;
            const firstChild = first.child()!;
            first.seal();
            const second = active.owner.begin(generation.capture(binding)!)!;
            const secondChild = second.child()!;
            second.seal();
            expect(secondChild.resolve(unknown)).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(pollOwnerStats(runtime)).toMatchObject({ accepted: 0 });
            expect(firstChild.resolve(known)).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(pollOwnerStats(runtime)).toMatchObject({ accepted: 2, ordering_gap: false });
            const listeners = new Map<string, () => void>();
            const sink = {
                isOpen: () => true,
                on: (event: string, listener: () => void) => listeners.set(event, listener),
                off: (event: string) => listeners.delete(event),
                writeHead: vi.fn(),
                end: vi.fn((body: string) => {
                    responseBody = body;
                    listeners.get('finish')?.();
                }),
            };
            const poll = active.owner.start(
                {
                    limit: 2,
                    timeoutMs: 0,
                    maxOutputBytes: 4096,
                    responseDeadline: performance.now() + 1000,
                },
                sink,
            );
            expect(await poll.result).toEqual({ kind: 'local_finish', response: 'events' });
            expect(sink.end).toHaveBeenCalledOnce();
            expect(JSON.parse(responseBody)).toEqual({
                status: 'ok',
                retcode: 0,
                data: [known, unknown],
                message: '',
            });
        } finally {
            active.owner.invalidate();
            vi.useRealTimers();
        }

        // The callback returns the fake owner's actual serialized output, not a fabricated event.
        const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({
                action: 'get_latest_events',
                params: { limit: 2, timeout: 0 },
            });
            return new Response(responseBody, { status: 200 });
        });
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.invalid',
            fetch: fakeFetch,
        });
        const response = await client.getLatestEvents({ limit: 2, timeout: 0 });
        expect(fakeFetch).toHaveBeenCalledOnce();
        expect(response.status).toBe('ok');
        expect(response.data).toEqual([known, unknown]);

        if (!Array.isArray(response.data)) {
            throw new Error('expected events');
        }

        const parsedKnown = parseOneBot12Event(response.data[0]);
        const parsedUnknown = parseOneBot12Event(response.data[1]);
        expect(parsedKnown).toEqual(known);
        expect(parsedUnknown).toEqual(unknown);
        expect(Object.hasOwn(parsedUnknown, 'qq.invitor_id')).toBe(false);
        expect(parsedKnown).not.toBe(response.data[0]);
        Reflect.set(parsedKnown, 'qq.invitor_id', '99');
        expect(response.data).toEqual([known, unknown]);
        expect([known, unknown]).toEqual(originals);
        expect([knownV11, unknownV11]).toEqual(originalV11);
    });
});
