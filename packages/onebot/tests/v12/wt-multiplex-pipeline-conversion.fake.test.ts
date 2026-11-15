import type { QQEventVariant } from '@snowluma/protocol/events';
import { describe, expect, it, vi } from 'vitest';
import {
    deadline,
    deferred,
    loginFields,
    setup,
    textBody,
    waitFor,
} from '../../../protocol/tests/direct/fixtures/wt-multiplex-pipeline-synthetic';
import { convertEvent, type ConverterContext } from '../../src/event-converter';
import { convertV11Event } from '../../src/v12/events';

// This manually subscribed bridge is local to the test; it is not a OneBot runtime.
function subscribe(f: ReturnType<typeof setup>, gate: Promise<void>) {
    const pending: Promise<void>[] = [];
    const v11: Awaited<ReturnType<typeof convertEvent>>[] = [];
    const v12: ReturnType<typeof convertV11Event>[] = [];
    const context: ConverterContext = {
        selfId: Number(f.account),
        imageUrlResolver: null,
        mediaUrlResolver: null,
        messageIdResolver: vi.fn(() => -123),
        mediaSegmentSink: null,
    };
    const unsubscribe = f.bus.onAny((event: QQEventVariant) => {
        const work = (async () => {
            // Test-owned binding check on the event emitted from the parser path;
            // the production pipeline does not authenticate this association.
            if (event.selfUin !== Number(f.account)) {
                throw new Error('synthetic event account mismatch');
            }

            await gate;
            const converted = await convertEvent(context, event);
            v11.push(converted);
            v12.push(convertV11Event(converted, { platform: 'qq', user_id: f.account }));
        })();
        pending.push(work);
        return work;
    });
    return { pending, v11, v12, unsubscribe, context };
}

// Preserve the test failure alongside teardown failures rather than masking either.
async function withCleanup(work: () => Promise<void>, cleanup: () => Promise<void>) {
    const errors: unknown[] = [];

    try {
        await work();
    } catch (error) {
        errors.push(error);
    }

    try {
        await cleanup();
    } catch (error) {
        errors.push(error);
    }

    if (errors.length === 1) {
        throw errors[0];
    }

    if (errors.length > 1) {
        throw new AggregateError(errors, 'test and cleanup failed');
    }
}

async function cleanupFixtures(
    pending: Promise<void>[],
    fixtures: ReturnType<typeof setup>[],
    label: string,
) {
    const errors: unknown[] = [];

    try {
        const results = await deadline(Promise.allSettled(pending), `${label} conversion join`);

        for (const result of results) {
            if (result.status === 'rejected') {
                errors.push(result.reason);
            }
        }
    } catch (error) {
        errors.push(error);
    }

    try {
        const results = await deadline(
            Promise.allSettled(fixtures.map((fixture) => fixture.cleanup())),
            `${label} fixture cleanup`,
            10_000,
        );

        for (const result of results) {
            if (result.status === 'rejected') {
                errors.push(result.reason);
            }
        }
    } catch (error) {
        errors.push(error);
    }

    if (errors.length) {
        throw new AggregateError(errors, `${label} cleanup failed`);
    }
}

// Runner timeout leaves room for per-step deadlines and bounded teardown; it does
// not cancel non-cooperative promises or prove that they have settled.
const TEST_TIMEOUT_MS = 30_000;

describe('synthetic WT multiplex through OneBot conversions', () => {
    it(
        'separates accounts and joins already-entered subscribers after close',
        async () => {
            const a = setup({ account: '123', keyByte: 0x21, holdHandler: true });
            const b = setup({ account: '234', keyByte: 0x43, holdHandler: true });
            const gate = deferred<void>();
            const outA = subscribe(a, gate.promise);
            const outB = subscribe(b, gate.promise);

            await withCleanup(
                async () => {
                    await Promise.all([a.start(), b.start()]);
                    expect(
                        await Promise.all([
                            deadline(a.session.loginAndRegister(loginFields), 'register A'),
                            deadline(b.session.loginAndRegister(loginFields), 'register B'),
                        ]),
                    ).toEqual([{ status: 'success' }, { status: 'success' }]);
                    await Promise.all([
                        deadline(a.handlerEntered.promise, 'handler A entered'),
                        deadline(b.handlerEntered.promise, 'handler B entered'),
                    ]);
                    // These values come directly from the parser, before pipeline/conversion.
                    expect(a.parsedEvents).toMatchObject([
                        [{ selfUin: 123, kind: 'friend_message' }],
                    ]);
                    expect(b.parsedEvents).toMatchObject([
                        [{ selfUin: 234, kind: 'friend_message' }],
                    ]);
                    expect(a.identity.findUinByUid('synthetic-sender-123')).toBe(456);
                    expect(b.identity.findUinByUid('synthetic-sender-234')).toBe(456);
                    expect(a.identity.findUinByUid('synthetic-sender-234')).toBeNull();
                    expect(b.identity.findUinByUid('synthetic-sender-123')).toBeNull();
                    expect(outA.context.selfId).toBe(123);
                    expect(outB.context.selfId).toBe(234);
                    expect(outA.pending).toHaveLength(1);
                    expect(outB.pending).toHaveLength(1);
                    expect(outA.v12).toEqual([]);
                    expect(outB.v12).toEqual([]);
                    a.session.close();
                    b.session.close();
                    await Promise.all([
                        deadline(a.session.whenClosed, 'close A'),
                        deadline(b.session.whenClosed, 'close B'),
                    ]);
                    expect(a.borrowed).toHaveLength(1);
                    expect(b.borrowed).toHaveLength(1);
                    expect(a.borrowed[0].every((byte) => byte === 0)).toBe(true);
                    expect(b.borrowed[0].every((byte) => byte === 0)).toBe(true);
                    expect(a.handlerSettled).toEqual([]);
                    expect(b.handlerSettled).toEqual([]);
                    outA.unsubscribe();
                    outB.unsubscribe();
                    // Unsubscription and close do not cancel callbacks already in flight.
                    gate.resolve();
                    const settled = await deadline(
                        Promise.allSettled([...outA.pending, ...outB.pending]),
                        'join conversions',
                    );
                    expect(settled.map((result) => result.status)).toEqual([
                        'fulfilled',
                        'fulfilled',
                    ]);
                    expect(outA.v11).toMatchObject([
                        {
                            self_id: 123,
                            message_id: -123,
                            message: [{ type: 'text', data: { text: 'friend 123' } }],
                        },
                    ]);
                    expect(outB.v11).toMatchObject([
                        {
                            self_id: 234,
                            message_id: -123,
                            message: [{ type: 'text', data: { text: 'friend 234' } }],
                        },
                    ]);
                    expect(outA.v12).toMatchObject([
                        {
                            self: { platform: 'qq', user_id: '123' },
                            message_id: '-123',
                            alt_message: 'friend 123',
                        },
                    ]);
                    expect(outB.v12).toMatchObject([
                        {
                            self: { platform: 'qq', user_id: '234' },
                            message_id: '-123',
                            alt_message: 'friend 234',
                        },
                    ]);
                    expect(a.failures).toEqual([]);
                    expect(b.failures).toEqual([]);
                    expect(a.parseErrors).toEqual([]);
                    expect(b.parseErrors).toEqual([]);
                },
                async () => {
                    gate.resolve();
                    outA.unsubscribe();
                    outB.unsubscribe();
                    await cleanupFixtures([...outA.pending, ...outB.pending], [a, b], 'positive');
                },
            );
        },
        TEST_TIMEOUT_MS,
    );

    it.each(['wrong-outer-uin', 'nonzero-ret-code'] as const)(
        'handles %s at the correct layer while the other account continues',
        async (mode) => {
            const a = setup({ account: '123', keyByte: 0x21 });
            const b = setup({ account: '234', keyByte: 0x43 });
            const gate = deferred<void>();
            const outA = subscribe(a, gate.promise);
            const outB = subscribe(b, gate.promise);
            gate.resolve();

            await withCleanup(
                async () => {
                    await Promise.all([a.start(), b.start()]);
                    expect(
                        await Promise.all([
                            deadline(a.session.loginAndRegister(loginFields), 'register A'),
                            deadline(b.session.loginAndRegister(loginFields), 'register B'),
                        ]),
                    ).toEqual([{ status: 'success' }, { status: 'success' }]);
                    await waitFor(
                        () => outA.pending.length === 1 && outB.pending.length === 1,
                        'initial callbacks',
                    );
                    expect(
                        (
                            await deadline(
                                Promise.allSettled([...outA.pending, ...outB.pending]),
                                'initial conversion join',
                            )
                        ).map((x) => x.status),
                    ).toEqual(['fulfilled', 'fulfilled']);
                    expect(a.parsedEvents).toMatchObject([[{ selfUin: 123 }]]);
                    expect(b.parsedEvents).toMatchObject([[{ selfUin: 234 }]]);

                    const badBody = textBody(300, '123', false, 'rejected A');
                    const badFrame = a.pushWithMetadata(
                        300,
                        badBody,
                        mode === 'wrong-outer-uin' ? '234' : '123',
                        mode === 'nonzero-ret-code' ? 7 : 0,
                    );
                    badBody.fill(0);
                    a.stream.emit('data', badFrame);

                    if (mode === 'wrong-outer-uin') {
                        const reason = await deadline(
                            a.session.whenClosed,
                            'wrong outer UIN closes A',
                        );
                        expect(reason).toMatchObject({
                            kind: 'protocol-error',
                            code: 'frame-rejected',
                        });
                        expect(a.stream.destroyed).toBe(true);
                        expect(a.bodyMetadata).toHaveLength(1);
                        expect(a.parseErrors).toEqual([]);
                    } else {
                        await waitFor(
                            () => a.parseErrors.length === 1,
                            'nonzero retCode parser rejection',
                        );
                        expect(a.bodyMetadata[1]).toMatchObject({
                            uin: '123',
                            sequence: 300,
                            retCode: 7,
                        });
                        expect(String(a.parseErrors[0])).toMatch(
                            /invalid direct push metadata or body/,
                        );
                        await waitFor(
                            () =>
                                a.handlerSettled.includes(300) &&
                                a.borrowed[1]?.every((byte) => byte === 0),
                            'rejected body wiped',
                        );
                        expect(a.stream.destroyed).toBe(false);
                    }

                    expect(a.parsedEvents).toHaveLength(1);
                    expect(outA.pending).toHaveLength(1);
                    expect(outA.v12).toHaveLength(1);
                    expect(a.dispatch).toHaveBeenCalledTimes(1);

                    const goodBody = textBody(301, '234', false, 'independent B');
                    const goodFrame = b.push(301, goodBody);
                    goodBody.fill(0);
                    b.stream.emit('data', goodFrame);
                    await waitFor(() => outB.pending.length === 2, 'B callback after A failure');
                    expect(
                        (await deadline(Promise.allSettled(outB.pending), 'B conversion join')).map(
                            (x) => x.status,
                        ),
                    ).toEqual(['fulfilled', 'fulfilled']);
                    expect(b.parsedEvents).toMatchObject([[{ selfUin: 234 }], [{ selfUin: 234 }]]);
                    expect(outB.v12).toMatchObject([
                        { self: { user_id: '234' }, alt_message: 'friend 234' },
                        { self: { user_id: '234' }, alt_message: 'independent B' },
                    ]);
                    expect(b.stream.destroyed).toBe(false);
                    expect(b.parseErrors).toEqual([]);
                    await waitFor(
                        () =>
                            b.borrowed.length === 2 &&
                            b.borrowed.every((body) => body.every((byte) => byte === 0)),
                        'B bodies wiped',
                    );
                },
                async () => {
                    gate.resolve();
                    outA.unsubscribe();
                    outB.unsubscribe();
                    await cleanupFixtures([...outA.pending, ...outB.pending], [a, b], 'negative');
                },
            );
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'rejects a locally mismatched parser identity without conversion',
        async () => {
            const f = setup({ account: '123', identityAccount: '234', keyByte: 0x21 });
            const gate = deferred<void>();
            const out = subscribe(f, gate.promise);

            await withCleanup(
                async () => {
                    await f.start();
                    expect(
                        await deadline(
                            f.session.loginAndRegister(loginFields),
                            'register mismatch',
                        ),
                    ).toEqual({ status: 'success' });
                    await waitFor(() => f.parseErrors.length === 1, 'parser mismatch');
                    expect(String(f.parseErrors[0])).toMatch(/identity UIN mismatch/);
                    expect(f.parsedEvents).toEqual([]);
                    expect(f.dispatch).not.toHaveBeenCalled();
                    expect(out.pending).toEqual([]);
                    expect(out.v11).toEqual([]);
                    expect(out.v12).toEqual([]);
                    await waitFor(
                        () => f.borrowed.length === 1 && f.borrowed[0].every((byte) => byte === 0),
                        'mismatch body wiped',
                    );
                },
                async () => {
                    gate.resolve();
                    out.unsubscribe();
                    await cleanupFixtures(out.pending, [f], 'mismatch');
                },
            );
        },
        TEST_TIMEOUT_MS,
    );
});
