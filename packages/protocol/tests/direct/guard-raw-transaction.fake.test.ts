import { describe, expect, it, vi } from 'vitest';
import { guardBorrowedTransport } from '../../src/direct/guard-raw-transaction';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

type Context = { secret: Uint8Array };
type Result = { secret: Uint8Array };
const identity = { uin: '42', sequence: 0xffffffff };
const bytes = (...n: number[]): Uint8Array => Uint8Array.of(...n);

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

const context = (): Context => ({ secret: bytes(1, 2) });
const result = (): Result => ({ secret: bytes(3, 4) });
const options = (): Sso12RawOptions<Context, Result> => ({
    timeoutMs: 1000,
    buildRequest: () => ({ frame: bytes(5, 6), context: context() }),
    verifyCandidate: () => true,
    consumeCandidate: () => result(),
});
const failed = { kind: 'failure', code: 'borrowed-transaction-failed', writeState: 'unknown' };
const transport = (
    fn: (o: Sso12RawOptions<object, object>) => Promise<Sso12RawResult<object>>,
): Sso12RawTransport => ({
    transactRaw: fn as Sso12RawTransport['transactRaw'],
});

const normal = async (o: Sso12RawOptions<object, object>): Promise<Sso12RawResult<object>> => {
    const built = await o.buildRequest(identity);
    await o.verifyCandidate(bytes(7, 8), built.context, identity);
    const value = await o.consumeCandidate(bytes(7, 8), built.context, identity);
    return { kind: 'response', sequence: identity.sequence, value, writeState: 'written' };
};

const disposal = () => ({
    disposeContext: vi.fn((value: Context) => value.secret.fill(0)),
    disposeResult: vi.fn((value: Result) => value.secret.fill(0)),
});

describe('guard raw transaction (pure memory)', () => {
    it('commits result only after clearing context and owned frames', async () => {
        const o = options();
        const c = context();
        const r = result();
        const original = bytes(5, 6);
        o.buildRequest = () => ({ frame: original, context: c });
        o.consumeCandidate = () => r;
        let frame!: Uint8Array;
        let supplied!: Uint8Array;
        const hooks = disposal();
        const fake = transport(async (raw) => {
            const built = await raw.buildRequest(identity);
            frame = built.frame;
            supplied = bytes(7, 8);
            await raw.verifyCandidate(supplied, built.context, identity);
            const value = await raw.consumeCandidate(supplied, built.context, identity);
            return { kind: 'response', value, sequence: identity.sequence, writeState: 'written' };
        });
        expect(await guardBorrowedTransport(fake, hooks)(o)).toEqual({
            kind: 'response',
            sequence: identity.sequence,
            value: r,
            writeState: 'written',
        });
        expect(c.secret).toEqual(bytes(0, 0));
        expect(r.secret).toEqual(bytes(3, 4));
        expect(original).toEqual(bytes(5, 6));
        expect(frame).toEqual(bytes(0, 0));
        expect(supplied).toEqual(bytes(7, 8));
        expect(hooks.disposeContext).toHaveBeenCalledOnce();
        expect(hooks.disposeResult).not.toHaveBeenCalled();
    });
    it('copies frame before the builder context getter can mutate it', async () => {
        const original = bytes(5, 6);
        const o = options();
        o.buildRequest = () => ({
            frame: original,
            get context() {
                original.fill(0);
                return context();
            },
        });
        let observed!: Uint8Array;
        const fake = transport(async (raw) => {
            const built = await raw.buildRequest(identity);
            observed = Uint8Array.from(built.frame);
            await raw.verifyCandidate(bytes(7, 8), built.context, identity);
            const value = await raw.consumeCandidate(bytes(7, 8), built.context, identity);
            return { kind: 'response', sequence: identity.sequence, value, writeState: 'written' };
        });
        expect((await guardBorrowedTransport<Context, Result>(fake)(o)).kind).toBe('response');
        expect(observed).toEqual(bytes(5, 6));
        expect(original).toEqual(bytes(0, 0));
    });
    it('isolates verified snapshot from verifier mutation', async () => {
        const o = options();

        o.verifyCandidate = (candidate) => {
            candidate.fill(0);
            return true;
        };

        o.consumeCandidate = vi.fn((candidate) => {
            expect(candidate).toEqual(bytes(7, 8));
            return result();
        });
        expect((await guardBorrowedTransport<Context, Result>(transport(normal))(o)).kind).toBe(
            'response',
        );
        expect(o.consumeCandidate).toHaveBeenCalledOnce();
    });
    it.each([
        'skip',
        'repeat',
        'concurrent',
        'reentry',
        'identity',
        'uin',
        'context',
        'frame',
        'token',
        'sequence',
        'poison',
    ] as const)('fails closed for %s', async (mode) => {
        const hooks = disposal();
        const fake = transport(async (o) => {
            try {
                if (mode === 'skip') {
                    return {
                        kind: 'response',
                        sequence: identity.sequence,
                        value: {},
                        writeState: 'written',
                    };
                }

                const built = await o.buildRequest(identity);

                if (mode === 'repeat') {
                    await o.buildRequest(identity);
                }

                if (mode === 'concurrent' || mode === 'reentry') {
                    const a = Promise.resolve(
                        o.verifyCandidate(bytes(7, 8), built.context, identity),
                    );
                    const b = Promise.resolve(
                        o.verifyCandidate(bytes(7, 8), built.context, identity),
                    );
                    await Promise.allSettled([a, b]);
                    return { kind: 'failure', code: 'swallowed', writeState: 'not-written' };
                }

                const ident =
                    mode === 'identity'
                        ? { ...identity, sequence: 1 }
                        : mode === 'uin'
                          ? { ...identity, uin: '43' }
                          : identity;
                await o.verifyCandidate(
                    bytes(7, 8),
                    mode === 'context' ? {} : built.context,
                    ident,
                );
                const v = await o.consumeCandidate(
                    mode === 'frame' ? bytes(7, 9) : bytes(7, 8),
                    built.context,
                    identity,
                );

                if (mode === 'poison') {
                    return Object.defineProperty({}, 'kind', {
                        get: () => {
                            throw Error('poison');
                        },
                    }) as Sso12RawResult<object>;
                }

                return {
                    kind: 'response',
                    value: mode === 'token' ? {} : v,
                    sequence: mode === 'sequence' ? 0 : identity.sequence,
                    writeState: 'written',
                };
            } catch {
                return { kind: 'failure', code: 'swallowed', writeState: 'not-written' };
            }
        });
        expect(await guardBorrowedTransport(fake, hooks)(options())).toEqual(failed);

        if (mode === 'token' || mode === 'sequence' || mode === 'poison') {
            expect(hooks.disposeResult).toHaveBeenCalledOnce();
        }
    });
    it.each(['buildRequest', 'verifyCandidate', 'consumeCandidate'] as const)(
        'normalizes swallowed %s exceptions to unknown',
        async (which) => {
            const o = options();
            Object.assign(o, {
                [which]: () => {
                    throw Error('secret');
                },
            });
            const fake = transport(async (raw) => {
                try {
                    await normal(raw);
                } catch {
                    /* malicious transport swallows callback error */
                }

                return { kind: 'failure', code: 'secret', writeState: 'not-written' };
            });
            expect(await guardBorrowedTransport<Context, Result>(fake)(o)).toEqual(failed);
        },
    );
    it('disposes a late build context and frame after early settlement', async () => {
        const gate = deferred<{ frame: Uint8Array; context: Context }>();
        const o = options();
        o.buildRequest = () => gate.promise;
        let pending!: Promise<unknown>;
        const hooks = disposal();
        const fake = transport(async (raw) => {
            pending = Promise.resolve(raw.buildRequest(identity)).catch(() => undefined);
            return { kind: 'failure', code: 'early', writeState: 'not-written' };
        });
        expect(await guardBorrowedTransport(fake, hooks)(o)).toMatchObject({
            writeState: 'not-written',
        });
        const c = context();
        const frame = bytes(5, 6);
        gate.resolve({ context: c, frame });
        await pending;
        expect(c.secret).toEqual(bytes(0, 0));
        expect(frame).toEqual(bytes(0, 0));
        expect(hooks.disposeContext).toHaveBeenCalledOnce();
    });
    it('disposes a late result even when its disposer throws', async () => {
        const gate = deferred<Result>();
        const entered = deferred<void>();
        const o = options();

        o.consumeCandidate = () => {
            entered.resolve();
            return gate.promise;
        };

        let pending!: Promise<unknown>;
        const hooks = disposal();
        hooks.disposeResult.mockImplementation((r) => {
            r.secret.fill(0);
            throw Error('fixture');
        });
        const fake = transport(async (raw) => {
            const built = await raw.buildRequest(identity);
            await raw.verifyCandidate(bytes(7, 8), built.context, identity);
            pending = Promise.resolve(
                raw.consumeCandidate(bytes(7, 8), built.context, identity),
            ).catch(() => undefined);
            await entered.promise;
            return { kind: 'failure', code: 'early', writeState: 'unknown' };
        });
        expect(await guardBorrowedTransport(fake, hooks)(o)).toEqual(failed);
        const r = result();
        gate.resolve(r);
        await pending;
        expect(r.secret).toEqual(bytes(0, 0));
        expect(hooks.disposeResult).toHaveBeenCalledOnce();
        expect(hooks.disposeContext).toHaveBeenCalledOnce();
    });
    it('continues cleanup and rejects success when context disposer throws', async () => {
        const hooks = disposal();
        let rawFrame!: Uint8Array;
        const r = result();
        const o = options();
        o.consumeCandidate = () => r;
        hooks.disposeContext.mockImplementation((c) => {
            c.secret.fill(0);
            throw Error('fixture');
        });
        const fake = transport(async (raw) => {
            const built = await raw.buildRequest(identity);
            rawFrame = built.frame;
            await raw.verifyCandidate(bytes(7, 8), built.context, identity);
            const value = await raw.consumeCandidate(bytes(7, 8), built.context, identity);
            return { kind: 'response', sequence: identity.sequence, value, writeState: 'written' };
        });
        expect(await guardBorrowedTransport(fake, hooks)(o)).toEqual(failed);
        expect(rawFrame).toEqual(bytes(0, 0));
        expect(r.secret).toEqual(bytes(0, 0));
        expect(hooks.disposeResult).toHaveBeenCalledOnce();
    });
    it.each(['abort', 'deadline'] as const)(
        'rejects commit when context disposal causes %s',
        async (mode) => {
            const controller = new AbortController();
            let clock = 0;
            const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
            const o = options();
            o.signal = controller.signal;
            const r = result();
            o.consumeCandidate = () => r;
            const hooks = disposal();
            hooks.disposeContext.mockImplementation((c) => {
                c.secret.fill(0);

                if (mode === 'abort') {
                    controller.abort();
                } else {
                    clock = 1000;
                }
            });

            try {
                expect(await guardBorrowedTransport(transport(normal), hooks)(o)).toEqual(failed);
                expect(hooks.disposeContext).toHaveBeenCalledOnce();
                expect(hooks.disposeResult).toHaveBeenCalledOnce();
                expect(r.secret).toEqual(bytes(0, 0));
            } finally {
                spy.mockRestore();
            }
        },
    );
    it('rejects commit when context disposal reenters a raw callback', async () => {
        let raw!: Sso12RawOptions<object, object>;
        let rejected!: Promise<unknown>;
        const fake = transport(async (options) => {
            raw = options;
            return normal(options);
        });
        const hooks = disposal();
        hooks.disposeContext.mockImplementation((c) => {
            c.secret.fill(0);
            rejected = Promise.resolve(raw.buildRequest(identity)).catch(() => undefined);
        });
        const o = options();
        const r = result();
        o.consumeCandidate = () => r;
        expect(await guardBorrowedTransport(fake, hooks)(o)).toEqual(failed);
        await rejected;
        expect(hooks.disposeContext).toHaveBeenCalledOnce();
        expect(hooks.disposeResult).toHaveBeenCalledOnce();
        expect(r.secret).toEqual(bytes(0, 0));
    });
    it('leaves unreturned callback intermediate objects to the callback', async () => {
        const gate = deferred<Result>();
        const entered = deferred<void>();
        const o = options();
        const intermediate = bytes(9);
        let pending!: Promise<unknown>;

        o.consumeCandidate = () => {
            entered.resolve();
            return gate.promise;
        };

        const hooks = disposal();
        const fake = transport(async (raw) => {
            const built = await raw.buildRequest(identity);
            await raw.verifyCandidate(bytes(7, 8), built.context, identity);
            pending = Promise.resolve(
                raw.consumeCandidate(bytes(7, 8), built.context, identity),
            ).catch(() => undefined);
            await entered.promise;
            return { kind: 'failure', code: 'early', writeState: 'unknown' };
        });
        await guardBorrowedTransport(fake, hooks)(o);
        expect(intermediate).toEqual(bytes(9));
        gate.resolve(result());
        await pending;
    });
});
