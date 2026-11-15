import { describe, expect, it } from 'vitest';
import {
    COMMAND,
    deadline,
    deferred,
    joinBody,
    loginFields,
    setup,
    waitFor,
} from './fixtures/wt-multiplex-pipeline-synthetic';

describe('synthetic WT producer through direct parser and memory pipeline', () => {
    it('releases queued friend and group through the bus after registration, then wipes bodies', async () => {
        const f = setup({ holdRegister: true, registrationPushes: true });
        const release = deferred<void>();
        const asyncText: string[] = [];
        f.bus.onAny(async (event) => {
            await release.promise;

            if (event.kind === 'friend_message' || event.kind === 'group_message') {
                const element = event.elements[0];

                if (element?.type === 'text') {
                    asyncText.push(element.text);
                }
            }
        });

        try {
            await f.start();
            const work = f.session.loginAndRegister(loginFields);
            await deadline(f.registerEntered.promise, 'registration entered');
            expect(f.captured).toEqual([]);
            expect(f.borrowed).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();
            f.allowRegister.resolve();
            expect(await deadline(work, 'registration')).toEqual({ status: 'success' });
            await waitFor(() => f.captured.length === 2 && f.borrowed.length === 2, 'both pushes');
            await waitFor(
                () =>
                    f.borrowed.length === 2 &&
                    f.borrowed.every((body) => body.length > 0 && body.every((byte) => byte === 0)),
                'both borrowed bodies wiped',
            );
            expect(f.handled).toEqual([52, 53]);
            expect(f.dispatch.mock.calls.map(([trace]) => trace)).toEqual([
                { serviceCmd: COMMAND, seqId: 52 },
                { serviceCmd: COMMAND, seqId: 53 },
            ]);
            expect(f.captured).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: 123,
                    senderUin: 456,
                    msgSeq: 152,
                    elements: [{ type: 'text', text: 'friend 123' }],
                },
                {
                    kind: 'group_message',
                    selfUin: 123,
                    groupId: 789,
                    msgSeq: 153,
                    elements: [{ type: 'text', text: 'group 123' }],
                },
            ]);
            expect(
                f.borrowed.every((body) => body.length > 0 && body.every((byte) => byte === 0)),
            ).toBe(true);
            expect(asyncText).toEqual([]);
            release.resolve();
            await waitFor(() => asyncText.length === 2, 'asynchronous text observations');
            expect(asyncText).toEqual(['friend 123', 'group 123']);
            expect(f.parseErrors).toEqual([]);
            expect(f.failures).toEqual([]);
        } finally {
            release.resolve();
            await f.cleanup();
        }
    });

    it('does not dispatch when the parser identity differs from the delivered account', async () => {
        const f = setup({ identityAccount: '234' });

        try {
            await f.start();
            expect(await deadline(f.session.loginAndRegister(loginFields), 'registration')).toEqual(
                { status: 'success' },
            );
            await waitFor(() => f.parseErrors.length === 1, 'identity mismatch');
            expect(f.parseErrors[0]).toBeInstanceOf(TypeError);
            expect(String(f.parseErrors[0])).toMatch(/identity UIN mismatch/);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
            expect(f.identity.findUinByUid('synthetic-sender-123')).toBeNull();
        } finally {
            await f.cleanup();
        }
    });

    it('isolates account identity and actual system-message dedup state', async () => {
        const a = setup({ account: '123', keyByte: 0x21 });
        const b = setup({ account: '234', keyByte: 0x43 });

        try {
            await Promise.all([a.start(), b.start()]);
            expect(
                await Promise.all([
                    deadline(a.session.loginAndRegister(loginFields), 'register A'),
                    deadline(b.session.loginAndRegister(loginFields), 'register B'),
                ]),
            ).toEqual([{ status: 'success' }, { status: 'success' }]);
            await waitFor(
                () => a.captured.length === 1 && b.captured.length === 1,
                'account messages',
            );
            expect(a.dedup).not.toBe(b.dedup);
            expect(a.identity.findUinByUid('synthetic-sender-123')).toBe(456);
            expect(b.identity.findUinByUid('synthetic-sender-234')).toBe(456);
            expect(a.identity.findUinByUid('synthetic-sender-234')).toBeNull();
            expect(b.identity.findUinByUid('synthetic-sender-123')).toBeNull();
            expect(a.captured[0]).toMatchObject({
                selfUin: 123,
                elements: [{ text: 'friend 123' }],
            });
            expect(b.captured[0]).toMatchObject({
                selfUin: 234,
                elements: [{ text: 'friend 234' }],
            });
            const body = joinBody();
            a.stream.emit('data', Buffer.concat([a.push(201, body), a.push(202, body)]));
            b.stream.emit('data', Buffer.concat([b.push(201, body), b.push(202, body)]));
            await waitFor(
                () => a.handlerSettled.length === 3 && b.handlerSettled.length === 3,
                'dedup handlers settle',
            );
            expect(a.handlerStarted).toEqual([52, 201, 202]);
            expect(b.handlerStarted).toEqual([52, 201, 202]);
            expect(a.handlerSettled).toEqual(a.handlerStarted);
            expect(b.handlerSettled).toEqual(b.handlerStarted);
            expect(a.dispatch).toHaveBeenCalledTimes(3);
            expect(b.dispatch).toHaveBeenCalledTimes(3);
            expect(a.captured).toHaveLength(2);
            expect(b.captured).toHaveLength(2);
            expect(a.captured.filter((event) => event.kind === 'group_member_join')).toHaveLength(
                1,
            );
            expect(b.captured.filter((event) => event.kind === 'group_member_join')).toHaveLength(
                1,
            );
            expect(a.captured[1]).toMatchObject({
                selfUin: 123,
                groupId: 789,
                userUid: 'synthetic-new',
            });
            expect(b.captured[1]).toMatchObject({
                selfUin: 234,
                groupId: 789,
                userUid: 'synthetic-new',
            });
            expect(a.parseErrors).toEqual([]);
            expect(b.parseErrors).toEqual([]);
        } finally {
            await Promise.all([a.cleanup(), b.cleanup()]);
        }
    });

    it('wipes during a pending handler on close; an async text subscriber has its own completion', async () => {
        const f = setup({ holdHandler: true });
        const entered = deferred<void>();
        const release = deferred<void>();
        const completed = deferred<void>();
        let observedText: string | undefined;
        f.bus.on('friend_message', async (event) => {
            entered.resolve();
            await release.promise;
            observedText = event.elements[0]?.type === 'text' ? event.elements[0].text : undefined;
            completed.resolve();
        });

        try {
            await f.start();
            expect(await deadline(f.session.loginAndRegister(loginFields), 'registration')).toEqual(
                { status: 'success' },
            );
            await deadline(entered.promise, 'subscriber entered');
            await deadline(f.handlerEntered.promise, 'pipeline finished inside handler');
            expect(f.handlerStarted).toEqual([52]);
            expect(f.handlerSettled).toEqual([]);
            expect(f.borrowed[0]?.some((byte) => byte !== 0)).toBe(true);
            f.session.close();
            await deadline(f.session.whenClosed, 'closed while handler pending');
            expect(f.borrowed[0]?.every((byte) => byte === 0)).toBe(true);
            expect(f.handlerSettled).toEqual([]);
            expect(observedText).toBeUndefined();
            f.allowHandler.resolve();
            await waitFor(() => f.handlerSettled.length === 1, 'handler settles after release');
            expect(f.handlerSettled).toEqual([52]);
            expect(observedText).toBeUndefined();
            release.resolve();
            await deadline(completed.promise, 'subscriber completion');
            // This assertion concerns this text fixture, not all decoded binary fields.
            expect(observedText).toBe('friend 123');
            expect(f.handled).toEqual([52]);
        } finally {
            release.resolve();
            await f.cleanup();
        }
    });
});
