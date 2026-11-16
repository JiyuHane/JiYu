import { describe, expect, it, vi } from 'vitest';
import { V12Dispatcher } from '../../src/v12/dispatcher';

const self = { platform: 'qq', user_id: '10001' };
const limit = 1_048_576;
const failed = {
    status: 'failed',
    retcode: 10001,
    data: null,
    message: 'invalid action request',
} as const;

function setup() {
    const handle = vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null }));
    const getStatus = vi.fn(() => ({ good: true, online: true }));
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'fixture', version: '1' },
        api: { handle },
        getStatus,
        getSentMessageTime: () => null,
    });
    return { dispatcher, handle, getStatus, http: dispatcher.createInternalHttpPreflight() };
}

function request(action: string, echo: string, params: unknown = {}) {
    return { action, params, echo };
}

function assertInvalidWithoutEcho(result: unknown) {
    expect(result).toEqual(failed);
    expect(Object.hasOwn(result as object, 'echo')).toBe(false);
}

describe('v12 preflight fallback echo size (in-process fixtures)', () => {
    it('accepts the UTF-16 boundary for ASCII, astral and lone-surrogate strings unchanged', async () => {
        const { dispatcher, handle, getStatus } = setup();
        const cases: Array<[string, number]> = [
            ['x'.repeat(limit - 1), limit - 1],
            ['x'.repeat(limit), limit],
            [`${'😀'.repeat(limit / 2 - 1)}x`, limit - 1],
            ['😀'.repeat(limit / 2), limit],
            [`${'x'.repeat(limit - 1)}\ud800`, limit],
        ];

        for (const [echo, expectedLength] of cases) {
            expect(echo.length).toBe(expectedLength);
            const result = await dispatcher.handle(request('get_version', echo));
            expect(result).toMatchObject({
                status: 'ok',
                retcode: 0,
                data: { impl: 'fixture', version: '1', onebot_version: '12' },
                message: '',
            });
            expect(Object.hasOwn(result, 'echo')).toBe(true);
            expect(result.echo === echo).toBe(true);
        }

        expect(handle).not.toHaveBeenCalled();
        expect(getStatus).not.toHaveBeenCalled();
    });

    it('omits over-limit ASCII and astral echoes after snapshot failure before any action', async () => {
        const { dispatcher, handle, getStatus } = setup();
        const echoes = ['x'.repeat(limit + 1), `${'😀'.repeat(limit / 2)}x`];

        for (const echo of echoes) {
            expect(echo.length).toBe(limit + 1);
            assertInvalidWithoutEcho(
                await dispatcher.handle(request('delete_message', echo, { message_id: '-1' })),
            );
        }

        expect(handle).not.toHaveBeenCalled();
        expect(getStatus).not.toHaveBeenCalled();
    });

    it('bounds the saved echo even when a different field fails before the echo is visited', async () => {
        const { dispatcher, handle } = setup();
        const cycle: Record<string, unknown> = {};
        cycle.loop = cycle;
        const echoes = [
            '',
            'x'.repeat(limit),
            '😀'.repeat(limit / 2),
            'x'.repeat(limit + 1),
            `${'😀'.repeat(limit / 2)}x`,
        ];

        for (const echo of echoes) {
            // params precedes echo in insertion order; traversal fails on the cycle first.
            const result = await dispatcher.handle(request('delete_message', echo, cycle));
            expect(result).toMatchObject(failed);

            if (echo.length <= limit) {
                expect(Object.hasOwn(result, 'echo')).toBe(true);
                expect(result.echo === echo).toBe(true);
            } else {
                assertInvalidWithoutEcho(result);
            }
        }

        const tooLongParam = await dispatcher.handle(
            request('delete_message', 'small', { x: 'x'.repeat(limit + 1) }),
        );
        expect(tooLongParam).toEqual({ ...failed, echo: 'small' });
        expect(handle).not.toHaveBeenCalled();
    });

    it('preserves only safely observed own data echoes on malformed inputs', async () => {
        const { dispatcher, handle } = setup();
        let getters = 0;
        let traps = 0;
        const hidden = { action: 'delete_message', params: { message_id: '-1' } };
        Object.defineProperty(hidden, 'echo', { value: 'hidden', enumerable: false });
        expect(await dispatcher.handle(hidden)).toEqual({ ...failed, echo: 'hidden' });

        const hiddenOverLimit = { action: 'delete_message', params: { message_id: '-1' } };
        Object.defineProperty(hiddenOverLimit, 'echo', {
            value: 'x'.repeat(limit + 1),
            enumerable: false,
        });
        assertInvalidWithoutEcho(await dispatcher.handle(hiddenOverLimit));

        const echoGetter = { action: 'delete_message', params: { message_id: '-1' } };
        Object.defineProperty(echoGetter, 'echo', {
            enumerable: true,
            get() {
                getters++;
                throw new Error('fixture-getter');
            },
        });
        assertInvalidWithoutEcho(await dispatcher.handle(echoGetter));

        const nestedParams: Record<string, unknown> = {};
        const nestedGetter = request('delete_message', 'safe', nestedParams);
        Object.defineProperty(nestedParams, 'message_id', {
            enumerable: true,
            get() {
                getters++;
                throw new Error('fixture-getter');
            },
        });
        expect(await dispatcher.handle(nestedGetter)).toEqual({ ...failed, echo: 'safe' });

        const trap = () => {
            traps++;
            throw new Error('fixture-proxy');
        };

        const trapsForInput = { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap };
        const top = new Proxy(request('delete_message', 'safe'), trapsForInput);
        assertInvalidWithoutEcho(await dispatcher.handle(top));
        const nested = request('delete_message', 'safe', new Proxy({}, trapsForInput));
        expect(await dispatcher.handle(nested)).toEqual({ ...failed, echo: 'safe' });
        const revoked = Proxy.revocable(request('delete_message', 'safe'), trapsForInput);
        revoked.revoke();
        assertInvalidWithoutEcho(await dispatcher.handle(revoked.proxy));

        const inheritedEcho = Object.assign(Object.create({ echo: 'inherited' }), {
            action: 'delete_message',
            params: { message_id: '-1' },
        });
        assertInvalidWithoutEcho(await dispatcher.handle(inheritedEcho));
        assertInvalidWithoutEcho(
            await dispatcher.handle({ action: 'delete_message', params: null }),
        );
        assertInvalidWithoutEcho(
            await dispatcher.handle({ action: 'delete_message', params: {}, echo: 1 }),
        );
        expect(getters).toBe(0);
        expect(traps).toBe(0);
        expect(handle).not.toHaveBeenCalled();
    });

    it('shares bounded failure with ordinary and explicit internal poll preflight', async () => {
        const { dispatcher, http, handle } = setup();
        const overLimitEchoes = ['x'.repeat(limit + 1), `${'😀'.repeat(limit / 2)}x`];

        for (const echo of overLimitEchoes) {
            for (const action of ['get_version', 'get_latest_events']) {
                const input = request(action, echo);
                const classified = http.classify(input);
                expect(classified.kind).toBe('error');

                if (classified.kind !== 'error') {
                    throw new Error('expected preflight error');
                }

                assertInvalidWithoutEcho(classified.response);
                expect(classified.response).toEqual(await dispatcher.handle(input));
            }
        }

        for (const echo of ['x'.repeat(limit), '😀'.repeat(limit / 2)]) {
            const poll = http.classify(request('get_latest_events', echo));
            expect(poll.kind).toBe('poll');

            if (poll.kind !== 'poll') {
                throw new Error('expected poll');
            }

            expect(poll.echo === echo).toBe(true);
            const ordinary = http.classify(request('get_version', echo));
            expect(ordinary.kind).toBe('ordinary');

            if (ordinary.kind !== 'ordinary') {
                throw new Error('expected ordinary token');
            }

            const result = await dispatcher.handlePreparedOrdinary(ordinary.token);
            expect(result.retcode).toBe(0);
            expect(result.echo === echo).toBe(true);
            assertInvalidWithoutEcho(await dispatcher.handlePreparedOrdinary(ordinary.token));
        }

        expect(handle).not.toHaveBeenCalled();
    });
});
