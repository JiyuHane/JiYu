import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { NodePollResponseSink } from '../../src/v12-network/poll-response-sink';

/** Models response state and synchronous EventEmitter delivery, without sockets. */
class MemoryResponse extends EventEmitter {
    headersSent = false;
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    finished = false;
    headArgs: unknown[][] = [];
    bodies: string[] = [];
    headAction?: () => void;
    endAction?: () => void;

    writeHead(status: number, headers: Record<string, string>): this {
        this.headArgs.push([status, headers]);
        this.headAction?.();
        this.headersSent = true;
        return this;
    }

    end(body: string): this {
        this.bodies.push(body);
        this.writableEnded = true;
        this.endAction?.();
        return this;
    }

    finish(): void {
        this.writableFinished = true;
        this.finished = true;
        this.emit('finish');
    }
}

function responseWithHost() {
    const response = new MemoryResponse();
    const hostError = vi.fn();
    response.on('error', hostError);
    return { response, hostError };
}

function setup() {
    const { response, hostError } = responseWithHost();
    const report = vi.fn();
    const sink = new NodePollResponseSink(response as unknown as ServerResponse, report);
    return { response, sink, report, hostError };
}

describe('NodePollResponseSink (in-memory response)', () => {
    it('publishes the exact JSON header and continues to be open until end', () => {
        const { response, sink } = setup();
        expect(sink.isOpen()).toBe(true);
        sink.writeHead();
        expect(response.headArgs).toEqual([
            [200, { 'content-type': 'application/json; charset=utf-8', connection: 'close' }],
        ]);
        expect(response.headersSent).toBe(true);
        expect(sink.isOpen()).toBe(true);
        sink.end('{"data":[]}');
        expect(response.bodies).toEqual(['{"data":[]}']);
        expect(sink.isOpen()).toBe(false);
        sink.dispose();
    });

    it.each(['destroyed', 'writableEnded', 'writableFinished', 'finished'] as const)(
        'rejects the %s response state before and after the header',
        (flag) => {
            const a = setup();
            a.response[flag] = true;
            expect(a.sink.isOpen()).toBe(false);
            expect(() => a.sink.writeHead()).toThrow('not writable');
            expect(a.response.headArgs).toHaveLength(0);
            a.sink.dispose();

            const b = setup();
            b.sink.writeHead();
            b.response[flag] = true;
            expect(b.sink.isOpen()).toBe(false);
            expect(() => b.sink.end('x')).toThrow('not writable');
            expect(b.response.bodies).toHaveLength(0);
            b.sink.dispose();
        },
    );

    it('rejects an externally published header and a damaged owned header state', () => {
        const a = setup();
        a.response.headersSent = true;
        expect(a.sink.isOpen()).toBe(false);
        expect(() => a.sink.writeHead()).toThrow('not writable');
        expect(a.response.headArgs).toHaveLength(0);
        a.sink.dispose();

        const b = setup();
        b.sink.writeHead();
        b.response.headersSent = false;
        expect(b.sink.isOpen()).toBe(false);
        expect(() => b.sink.end('x')).toThrow('not writable');
        b.sink.dispose();
    });

    it('owns the entering phase before synchronous reentry, before and after headersSent', () => {
        const { response, sink } = setup();

        response.headAction = () => {
            expect(sink.isOpen()).toBe(true);
            expect(() => sink.writeHead()).toThrow('not writable');
            expect(() => sink.end('nested')).toThrow('not writable');
            response.headersSent = true;
            expect(sink.isOpen()).toBe(true);
        };

        sink.writeHead();
        expect(sink.isOpen()).toBe(true);
        sink.end('outer');
        expect(response.headArgs).toHaveLength(1);
        expect(response.bodies).toEqual(['outer']);
        sink.dispose();
    });

    it.each(['error', 'close'] as const)(
        'forwards synchronous %s in writeHead and becomes closed',
        (event) => {
            const { response, sink, report } = setup();
            const listener = vi.fn();
            sink.on(event, listener);

            response.headAction = () => {
                response.headersSent = true;
                response.emit(event, new Error('private detail'));
                expect(sink.isOpen()).toBe(false);
            };

            sink.writeHead();
            expect(listener).toHaveBeenCalledTimes(1);
            expect(sink.isOpen()).toBe(false);
            expect(() => sink.end('x')).toThrow('not writable');
            expect(response.bodies).toHaveLength(0);
            expect(report).toHaveBeenCalledTimes(event === 'error' ? 1 : 0);
            sink.off(event, listener);
            sink.dispose();
        },
    );

    it.each([false, true])(
        'poisons a thrown header with partial=%s and never retries',
        (partial) => {
            const { response, sink } = setup();
            const failure = new Error('original');

            response.headAction = () => {
                response.headersSent = partial;
                throw failure;
            };

            expect(() => sink.writeHead()).toThrow(failure);
            expect(sink.isOpen()).toBe(false);
            expect(() => sink.writeHead()).toThrow('not writable');
            expect(() => sink.end('x')).toThrow('not writable');
            expect(response.headArgs).toHaveLength(1);
            expect(response.bodies).toHaveLength(0);
            sink.dispose();
        },
    );

    it('rejects writeHead that returns without actually publishing headers', () => {
        const { response, sink } = setup();
        vi.spyOn(response, 'writeHead').mockReturnValue(response);
        expect(() => sink.writeHead()).toThrow('header state invalid');
        expect(sink.isOpen()).toBe(false);
        expect(() => sink.writeHead()).toThrow('not writable');
        sink.dispose();
    });

    it.each(['finish', 'close', 'error'] as const)(
        'preserves synchronous %s delivery inside end',
        (event) => {
            const { response, sink } = setup();
            const listener = vi.fn(() => expect(sink.isOpen()).toBe(false));
            sink.on(event, listener);

            response.endAction = () => {
                if (event === 'finish') {
                    response.finish();
                } else {
                    response.emit(event, new Error('detail'));
                }
            };

            sink.writeHead();
            sink.end('body');
            expect(listener).toHaveBeenCalledTimes(1);
            expect(response.bodies).toEqual(['body']);
            expect(sink.isOpen()).toBe(false);
            sink.off(event, listener);
            sink.dispose();
        },
    );

    it.each([false, true])('propagates end throw even after finish=%s', (finishFirst) => {
        const { response, sink } = setup();
        const finish = vi.fn();
        const failure = new Error('write failure');
        sink.on('finish', finish);

        response.endAction = () => {
            if (finishFirst) {
                response.finish();
            }

            throw failure;
        };

        sink.writeHead();
        expect(() => sink.end('body')).toThrow(failure);
        expect(finish).toHaveBeenCalledTimes(finishFirst ? 1 : 0);
        expect(() => sink.end('again')).toThrow('not writable');
        expect(response.bodies).toEqual(['body']);
        sink.off('finish', finish);
        sink.dispose();
    });

    it('retains a persistent sanitized error handler after transaction off', async () => {
        const { response, sink, report, hostError } = setup();
        const transactionError = vi.fn();
        sink.on('error', transactionError);
        sink.off('error', transactionError);
        expect(response.listenerCount('error')).toBe(2);
        await Promise.resolve();
        expect(() => response.emit('error', new Error('secret'))).not.toThrow();
        expect(transactionError).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledTimes(1);
        expect(report.mock.calls[0][0].message).toBe('poll response error');
        expect(sink.isOpen()).toBe(false);
        expect(hostError).toHaveBeenCalledTimes(1);
        sink.dispose();
        response.emit('error', new Error('late'));
        expect(hostError).toHaveBeenCalledTimes(2);
        expect(report).toHaveBeenCalledTimes(1);
    });

    it('preserves finish-then-close order during end without creating a second response', () => {
        const { response, sink } = setup();
        const events: string[] = [];
        const finish = () => events.push('finish');
        const close = () => events.push('close');
        sink.on('finish', finish);
        sink.on('close', close);

        response.endAction = () => {
            response.finish();
            response.emit('close');
        };

        sink.writeHead();
        sink.end('body');
        expect(events).toEqual(['finish', 'close']);
        expect(response.headArgs).toHaveLength(1);
        expect(response.bodies).toEqual(['body']);
        sink.off('finish', finish);
        sink.off('close', close);
        sink.dispose();
    });

    it('isolates a throwing diagnostic callback and still forwards the error', () => {
        const { response } = responseWithHost();
        const report = vi.fn(() => {
            throw new Error('private diagnostic');
        });
        const sink = new NodePollResponseSink(response as unknown as ServerResponse, report);
        const transactionError = vi.fn();
        sink.on('error', transactionError);
        response.emit('error', new Error('private source'));
        expect(transactionError).toHaveBeenCalledTimes(1);
        expect(sink.isOpen()).toBe(false);
        expect(sink.diagnosticUncertain).toBe(true);
        sink.off('error', transactionError);
        sink.dispose();
    });

    it('keeps ordinary EventEmitter duplicate-listener and off behavior', () => {
        const { response, sink } = setup();
        const listener = vi.fn();
        sink.on('close', listener);
        sink.on('close', listener);
        sink.off('close', listener);
        response.emit('close');
        expect(listener).toHaveBeenCalledTimes(1);
        sink.off('close', listener);
        sink.dispose();
        sink.dispose();
        expect(response.listenerCount('close')).toBe(0);
    });

    it("detects external removal and does not remove another owner's listeners", () => {
        const { response, sink, hostError } = setup();
        const external = vi.fn();
        response.on('close', external);

        for (const listener of response.listeners('error')) {
            if (listener !== hostError) {
                response.off('error', listener as (...args: unknown[]) => void);
            }
        }

        expect(sink.isOpen()).toBe(false);
        sink.dispose();
        expect(response.listeners('close')).toEqual([external]);
        response.off('close', external);
    });

    it('keeps exclusive ownership when cleanup throws, attempts all, then allows retry', () => {
        const { response, sink } = setup();
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('already owned');
        const off = response.off.bind(response);
        const seen: string[] = [];
        let fail = true;
        const spy = vi.spyOn(response, 'off').mockImplementation((event, listener) => {
            seen.push(String(event));

            if (event === 'error' && fail) {
                throw new Error('private');
            }

            return off(event, listener);
        });
        expect(() => sink.dispose()).toThrow('cleanup uncertain');
        expect(seen).toEqual(['error', 'close', 'finish']);
        expect(sink.isOpen()).toBe(false);
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('already owned');
        fail = false;
        sink.dispose();
        sink.dispose();
        spy.mockRestore();
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('already owned');
    });

    it.each(['error', 'close', 'finish'] as const)(
        'cleans a partial constructor on(%s) failure, even after registration',
        (event) => {
            const { response, hostError } = responseWithHost();
            const on = response.on.bind(response);
            vi.spyOn(response, 'on').mockImplementation((name, listener) => {
                const result = on(name, listener);

                if (name === event) {
                    throw new Error('private install');
                }

                return result;
            });
            expect(
                () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
            ).toThrow('listener installation failed');
            expect(response.listeners('error')).toEqual([hostError]);
            expect(response.listenerCount('close')).toBe(0);
            expect(response.listenerCount('finish')).toBe(0);
            expect(
                () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
            ).toThrow('already owned');
        },
    );

    it.each(['head', 'end'] as const)(
        'preserves ownership and listeners if dispose reenters %s',
        (where) => {
            const { response, sink, hostError } = setup();
            const before = ['error', 'close', 'finish'].map((event) =>
                response.listenerCount(event),
            );

            const action = () => {
                expect(() => sink.dispose()).toThrow('cleanup in flight');
                expect(
                    ['error', 'close', 'finish'].map((event) => response.listenerCount(event)),
                ).toEqual(before);
                expect(
                    () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
                ).toThrow('already owned');
            };

            if (where === 'head') {
                response.headAction = action;
            } else {
                response.endAction = action;
            }

            sink.writeHead();

            if (where === 'end') {
                sink.end('body');
            }

            sink.dispose();
            expect(response.listeners('error')).toEqual([hostError]);
            expect(
                () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
            ).toThrow('already owned');
        },
    );

    it.each(['head', 'end'] as const)(
        'propagates uncaught reentrant dispose in %s and permits cleanup afterward',
        (where) => {
            const { response, sink } = setup();

            if (where === 'head') {
                response.headAction = () => sink.dispose();
                expect(() => sink.writeHead()).toThrow('cleanup in flight');
            } else {
                sink.writeHead();
                response.endAction = () => sink.dispose();
                expect(() => sink.end('body')).toThrow('cleanup in flight');
            }

            expect(sink.isOpen()).toBe(false);
            sink.dispose();
            expect(
                () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
            ).toThrow('already owned');
        },
    );

    it.each([
        ['head', 'getter'],
        ['head', 'listeners'],
        ['end', 'getter'],
        ['end', 'listeners'],
    ] as const)('guards %s preflight against %s reentry', (where, source) => {
        const { response, sink, hostError } = setup();

        if (where === 'end') {
            sink.writeHead();
        }

        let calls = 0;

        const reenter = () => {
            calls++;
            expect(() => sink.dispose()).toThrow('cleanup in flight');
            expect(
                () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
            ).toThrow('already owned');
            expect(() => sink.writeHead()).toThrow('not writable');
            expect(() => sink.end('nested')).toThrow('not writable');
        };

        if (source === 'getter') {
            Object.defineProperty(response, 'destroyed', {
                configurable: true,
                get() {
                    reenter();
                    return false;
                },
            });
        } else {
            const listeners = response.listeners.bind(response);
            vi.spyOn(response, 'listeners').mockImplementation((event) => {
                reenter();
                return listeners(event);
            });
        }

        if (where === 'head') {
            sink.writeHead();
            expect(response.headArgs).toHaveLength(1);
            expect(response.bodies).toHaveLength(0);
        } else {
            sink.end('body');
            expect(response.bodies).toEqual(['body']);
        }

        expect(calls).toBeGreaterThan(0);
        vi.restoreAllMocks();
        sink.dispose();
        expect(response.listeners('error')).toEqual([hostError]);
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('already owned');
    });

    it.each(['head', 'end'] as const)(
        'releases the in-flight guard after %s preflight getter throws',
        (where) => {
            const { response, sink } = setup();

            if (where === 'end') {
                sink.writeHead();
            }

            const failure = new Error('private state error');
            Object.defineProperty(response, 'destroyed', {
                configurable: true,
                get() {
                    throw failure;
                },
            });
            expect(() => (where === 'head' ? sink.writeHead() : sink.end('body'))).toThrow(failure);
            expect(response.bodies).toHaveLength(0);
            expect(response.headArgs).toHaveLength(where === 'head' ? 0 : 1);
            sink.dispose();
            expect(
                () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
            ).toThrow('already owned');
        },
    );

    it('rechecks sink state when externally invoked isOpen reenters disposal', () => {
        const { response, sink } = setup();
        Object.defineProperty(response, 'headersSent', {
            configurable: true,
            get() {
                sink.dispose();
                return false;
            },
        });
        expect(sink.isOpen()).toBe(false);
        expect(() => sink.writeHead()).toThrow('not writable');
        expect(response.headArgs).toHaveLength(0);
    });

    it('tombstones even a clean response after explicit disposal', () => {
        const { response, sink, hostError } = setup();
        sink.dispose();
        expect(response.listeners('error')).toEqual([hostError]);
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('already owned');
    });

    it('tombstones when an error callback synchronously disposes and tries to replace the sink', () => {
        const { response, hostError } = responseWithHost();
        let sink!: NodePollResponseSink;
        const transactionError = vi.fn();
        const report = vi.fn(() => {
            sink.dispose();
            expect(
                () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
            ).toThrow('already owned');
        });
        sink = new NodePollResponseSink(response as unknown as ServerResponse, report);
        sink.on('error', transactionError);
        response.emit('error', new Error('private'));
        expect(hostError).toHaveBeenCalledTimes(1);
        expect(transactionError).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledTimes(1);
        expect(sink.diagnosticUncertain).toBe(false);
        sink.off('error', transactionError);
    });

    it('observes a diagnostic Promise rejection after settlement without interrupting error listeners', async () => {
        const { response, hostError } = responseWithHost();
        let reject!: (reason: Error) => void;
        const pending = new Promise<void>((_, fail) => {
            reject = fail;
        });
        const report = vi.fn(() => pending);
        const sink = new NodePollResponseSink(response as unknown as ServerResponse, report);
        const transactionError = vi.fn();
        sink.on('error', transactionError);
        response.emit('error', new Error('private source'));
        expect(sink.diagnosticUncertain).toBe(false);
        expect(hostError).toHaveBeenCalledTimes(1);
        expect(transactionError).toHaveBeenCalledTimes(1);
        reject(new Error('private rejection'));
        await Promise.resolve();
        expect(sink.diagnosticUncertain).toBe(true);
        sink.off('error', transactionError);
        sink.dispose();
    });

    it('observes a throwing thenable getter without an unhandled rejection', async () => {
        const { response } = responseWithHost();
        const thenable = Object.defineProperty({}, 'then', {
            get() {
                throw new Error('private getter');
            },
        });
        const sink = new NodePollResponseSink(
            response as unknown as ServerResponse,
            () => thenable,
        );
        const transactionError = vi.fn();
        sink.on('error', transactionError);
        response.emit('error', new Error('private source'));
        expect(transactionError).toHaveBeenCalledTimes(1);
        expect(sink.diagnosticUncertain).toBe(false);
        await Promise.resolve();
        expect(sink.diagnosticUncertain).toBe(true);
        sink.off('error', transactionError);
        sink.dispose();
    });

    it('uses intrinsic promise observation when a returned Promise overrides then', async () => {
        const { response } = responseWithHost();
        const pending = Promise.reject(new Error('private'));
        Object.defineProperty(pending, 'then', {
            get() {
                throw new Error('overridden then');
            },
        });
        const sink = new NodePollResponseSink(response as unknown as ServerResponse, () => pending);
        response.emit('error', new Error('private source'));
        await Promise.resolve();
        expect(sink.diagnosticUncertain).toBe(true);
        sink.dispose();
    });

    it('keeps the preinstalled host error owner when constructor rollback partly fails', async () => {
        const { response, hostError } = responseWithHost();
        const on = response.on.bind(response);
        vi.spyOn(response, 'on').mockImplementation((name, listener) => {
            const result = on(name, listener);

            if (name === 'finish') {
                throw new Error('private install');
            }

            return result;
        });
        const off = response.off.bind(response);
        const attempted: string[] = [];
        vi.spyOn(response, 'off').mockImplementation((name, listener) => {
            attempted.push(String(name));

            if (name === 'close' || name === 'finish') {
                throw new Error('private cleanup');
            }

            return off(name, listener);
        });
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('listener installation cleanup uncertain');
        expect(attempted).toEqual(['error', 'close', 'finish']);
        expect(response.listeners('error')).toEqual([hostError]);
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('already owned');
        await Promise.resolve();
        response.emit('error', new Error('late'));
        expect(hostError).toHaveBeenCalledTimes(1);
    });

    it('keeps ownership when constructor rollback itself is uncertain', () => {
        const { response } = responseWithHost();
        const on = response.on.bind(response);
        vi.spyOn(response, 'on').mockImplementation((name, listener) => {
            const result = on(name, listener);

            if (name === 'close') {
                throw new Error('private install');
            }

            return result;
        });
        const off = response.off.bind(response);
        const tried: string[] = [];
        vi.spyOn(response, 'off').mockImplementation((name, listener) => {
            tried.push(String(name));

            if (name === 'error') {
                throw new Error('private cleanup');
            }

            return off(name, listener);
        });
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('listener installation cleanup uncertain');
        expect(tried).toEqual(['error', 'close', 'finish']);
        expect(
            () => new NodePollResponseSink(response as unknown as ServerResponse, vi.fn()),
        ).toThrow('already owned');
        expect(response.listenerCount('error')).toBe(2);
    });
});
