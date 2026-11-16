import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    activateOrderedPollOwner,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import { SourceGeneration } from '../../src/v12-runtime/source-generation';

// The owner and sink are in-process fixtures, not the production HTTP poll path.
function fixture() {
    const runtime = {};
    const binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    registerPollHost(runtime, {
        self: { platform: 'qq', user_id: '10001' },
        captureBinding: () => binding,
        captureSource: () => generation.capture(binding),
        verify: (source) => generation.isCurrent(source, binding),
    });
    const result = activateOrderedPollOwner(runtime);

    if (result.status !== 'ready') {
        throw new Error('fixture owner was not ready');
    }

    return { runtime, owner: result.owner, ticket: () => generation.capture(binding)! };
}

function notice(messageId = '-2147483648', userId = '20002') {
    return {
        id: 'synthetic-recall',
        time: 1700000000,
        type: 'notice',
        detail_type: 'private_message_delete',
        sub_type: '',
        self: { platform: 'qq', user_id: '10001' },
        message_id: messageId,
        user_id: userId,
    };
}

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

async function settle() {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
}

afterEach(() => {
    vi.useRealTimers();
});

describe('private recall ordered owner structural admission (in-process fixture)', () => {
    it('accepts both senders and signed-int32 endpoints in order after a normal skip', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const parent = f.owner.begin(f.ticket());

        if (!parent) {
            throw new Error('fixture parent missing');
        }

        const skipped = parent.child();
        const first = parent.child();
        const second = parent.child();
        const fractional = parent.child();
        const maximumTime = parent.child();

        if (!skipped || !first || !second || !fractional || !maximumTime) {
            throw new Error('fixture child missing');
        }

        expect(
            maximumTime.resolve({ ...notice('2', '10001'), time: Number.MAX_SAFE_INTEGER }),
        ).toBe(true);
        expect(fractional.resolve({ ...notice('1', '20002'), time: 1700000000.5 })).toBe(true);
        expect(second.resolve(notice('2147483647', '10001'))).toBe(true);
        expect(skipped.skip()).toBe(true);
        expect(first.resolve(notice('-2147483648', '20002'))).toBe(true);
        expect(parent.seal()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 4, ordering_gap: false });
        const sink = new Sink();
        const result = await f.owner.start(
            {
                limit: 0,
                timeoutMs: 0,
                maxOutputBytes: 65536,
                responseDeadline: performance.now() + 5000,
            },
            sink,
        ).result;
        expect(result.kind).toBe('local_finish');
        expect(JSON.parse(sink.body).data).toEqual([
            notice('-2147483648', '20002'),
            notice('2147483647', '10001'),
            { ...notice('1', '20002'), time: 1700000000.5 },
            { ...notice('2', '10001'), time: Number.MAX_SAFE_INTEGER },
        ]);
        f.owner.invalidate();
        await settle();
    });

    it.each([
        ['subtype recall', (v: any) => (v.sub_type = 'recall')],
        ['missing subtype', (v: any) => delete v.sub_type],
        ['zero message id', (v: any) => (v.message_id = '0')],
        ['negative zero', (v: any) => (v.message_id = '-0')],
        ['noncanonical message id', (v: any) => (v.message_id = '-01')],
        ['positive overflow', (v: any) => (v.message_id = '2147483648')],
        ['negative overflow', (v: any) => (v.message_id = '-2147483649')],
        ['numeric message id', (v: any) => (v.message_id = -1)],
        ['zero user', (v: any) => (v.user_id = '0')],
        ['leading zero user', (v: any) => (v.user_id = '020002')],
        ['unsafe user', (v: any) => (v.user_id = '9007199254740992')],
        ['wrong account', (v: any) => (v.self.user_id = '10002')],
        ['extra field', (v: any) => (v.operator_id = '20002')],
        ['missing user', (v: any) => delete v.user_id],
        ['negative time', (v: any) => (v.time = -1)],
        ['unsafe time', (v: any) => (v.time = Number.MAX_SAFE_INTEGER + 1)],
        ['NaN time', (v: any) => (v.time = Number.NaN)],
        ['infinite time', (v: any) => (v.time = Number.POSITIVE_INFINITY)],
    ] as const)('marks a malformed %s as a gap, not a normal skip', async (_name, mutate) => {
        vi.useFakeTimers();
        const f = fixture();
        const event: any = notice();
        mutate(event);
        const parent = f.owner.begin(f.ticket());
        const child = parent?.child();

        if (!parent || !child) {
            throw new Error('fixture admission missing');
        }

        child.resolve(event);
        parent.seal();
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 0, ordering_gap: true });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        f.owner.invalidate();
        await settle();
    });
});
