import { isProxy } from 'node:util/types';
import type {
    Sso12RawIdentity,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from './sso12-packet-client';

const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const lengthGetter = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const tagGetter = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;
const setBytes = Uint8Array.prototype.set;
const MAX_FRAME = 16 * 1024 * 1024;

function wipe(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            /* detached or out of bounds */
        }
    }
}

function wipeLateFrame(value: unknown): void {
    try {
        if (
            isProxy(value) ||
            !ArrayBuffer.isView(value) ||
            tagGetter.call(value) !== 'Uint8Array'
        ) {
            return;
        }

        values.call(value);
        arrayBufferLengthGetter.call(bufferGetter.call(value));
        fill.call(value, 0);
    } catch {
        /* detached, shared, out of bounds, or otherwise unavailable */
    }
}

function borrowedBytes(value: unknown): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || tagGetter.call(value) !== 'Uint8Array') {
        throw new TypeError('invalid bytes');
    }

    values.call(value);
    const size = lengthGetter.call(value) as number;

    if (size > MAX_FRAME) {
        throw new TypeError('invalid bytes');
    }

    const storage = bufferGetter.call(value) as ArrayBuffer;
    arrayBufferLengthGetter.call(storage);
    const start = offsetGetter.call(value) as number;
    const result = new Uint8Array(size);

    try {
        setBytes.call(result, new Uint8Array(storage, start, size));
        return result;
    } catch (error) {
        wipe(result);
        throw error;
    }
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid record');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid record');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid record');
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) {
            throw new TypeError('invalid record');
        }

        result[key] = descriptor.value;
    }

    return result;
}

/** Disposers are synchronous; their failures are isolated and prevent commit. */
export interface RawTransactionDisposers<C, T> {
    disposeContext?: (context: C) => void;
    disposeResult?: (result: T) => void;
}

/**
 * Binds a single transaction's callbacks. Transport must enforce exclusivity,
 * actual I/O and settlement. This guard cannot stop a never-settling transport
 * or undo callback side effects, thenable getters, or intermediate allocations.
 * A normal builder retains its original frame; the guard owns its private copy.
 * A late builder's returned frame is best-effort wiped along with its context.
 * Context and returned result must not share mutable storage: disposing context
 * precedes commit and the producer owns alias isolation. Builder field getters
 * can execute and their side effects remain outside this guard's control.
 */
export function guardBorrowedTransport<C, T>(
    transport: Sso12RawTransport,
    disposers: RawTransactionDisposers<C, T> = {},
): (options: Sso12RawOptions<C, T>) => Promise<Sso12RawResult<T>> {
    return async (options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> => {
        type Phase =
            | 'new'
            | 'building'
            | 'built'
            | 'verifying'
            | 'verified'
            | 'consuming'
            | 'consumed'
            | 'failed';
        let phase: Phase = 'new';
        const isConsumed = (): boolean => phase === 'consumed';
        let violation = false;
        let finished = false;
        let seen = false;
        let identity: Sso12RawIdentity | undefined;
        let verified: Uint8Array | undefined;
        let context!: C;
        let contextSet = false;
        let staged!: T;
        let stagedSet = false;
        const copies = new Set<Uint8Array>();
        const token = Object.freeze({});
        const contextToken = Object.freeze({});
        const started = performance.now();
        const timeout = options.timeoutMs;
        const deadline = timeout === undefined ? Infinity : started + timeout;
        let disposalFailed = false;
        const failure = (writeState: 'unknown' | 'not-written' = 'unknown'): Sso12RawResult<T> => ({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
            writeState,
        });

        const disposeContext = (): void => {
            if (contextSet) {
                contextSet = false;

                try {
                    disposers.disposeContext?.(context);
                } catch {
                    disposalFailed = true;
                }
            }
        };

        const disposeResult = (): void => {
            if (stagedSet) {
                stagedSet = false;

                try {
                    disposers.disposeResult?.(staged);
                } catch {
                    disposalFailed = true;
                }
            }
        };

        const fail = (): never => {
            violation = true;
            phase = 'failed';
            throw new Error('invalid borrowed raw transaction');
        };

        const withinDeadline = (): boolean =>
            !options.signal?.aborted && performance.now() < deadline;
        const live = (): boolean => !finished && !violation && withinDeadline();

        const enter = (expected: Phase, next: Phase): void => {
            if (!live() || phase !== expected) {
                fail();
            }

            phase = next;
        };

        const readIdentity = (value: Sso12RawIdentity): Sso12RawIdentity => {
            const data = record(value);

            if (
                typeof data.uin !== 'string' ||
                typeof data.sequence !== 'number' ||
                !Number.isInteger(data.sequence) ||
                data.sequence < 0 ||
                data.sequence > 0xffffffff
            ) {
                return fail();
            }

            return Object.freeze({ uin: data.uin, sequence: data.sequence });
        };

        const check = (value: Sso12RawIdentity): void => {
            const current = readIdentity(value);

            if (
                !identity ||
                current.uin !== identity.uin ||
                current.sequence !== identity.sequence
            ) {
                fail();
            }
        };

        const take = (value: unknown): Uint8Array => {
            const copy = borrowedBytes(value);
            copies.add(copy);
            return copy;
        };

        const release = (value: Uint8Array | undefined): void => {
            if (value) {
                wipe(value);
                copies.delete(value);
            }
        };

        let output: Sso12RawResult<T> = failure();
        let commit = false;

        try {
            if (
                timeout !== undefined &&
                (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 0x7fffffff)
            ) {
                throw new Error('invalid deadline');
            }

            if (!live()) {
                throw new Error('transaction stopped');
            }

            const result = await transport.transactRaw<object, object>({
                timeoutMs: timeout,
                signal: options.signal,
                buildRequest: async (value) => {
                    try {
                        enter('new', 'building');
                        identity = readIdentity(value);
                        const built = await options.buildRequest(identity);
                        // Probe both fields independently: one throwing getter must not
                        // hide the other known resource from late cleanup.
                        let builtFrame: unknown;
                        let frame: Uint8Array | undefined;
                        let invalid = false;

                        try {
                            builtFrame = built.frame;

                            // Preserve the original guard's order: snapshot before
                            // reading context, whose getter may mutate the frame.
                            if (!finished && !violation) {
                                frame = take(builtFrame);
                            }
                        } catch {
                            invalid = true;
                        }

                        try {
                            context = built.context;
                            contextSet = true;
                        } catch {
                            invalid = true;
                        }

                        if (!live() || phase !== 'building') {
                            wipeLateFrame(builtFrame);
                            disposeContext();
                            return fail();
                        }

                        if (invalid || !frame) {
                            return fail();
                        }

                        // The normal builder retains its original until its own cleanup.
                        enter('building', 'built');
                        return { frame, context: contextToken };
                    } catch (error) {
                        violation = true;
                        phase = 'failed';
                        throw error;
                    }
                },
                verifyCandidate: async (candidate, suppliedC, value) => {
                    let verifierCopy: Uint8Array | undefined;

                    try {
                        enter('built', 'verifying');
                        seen = true;
                        check(value);

                        if (suppliedC !== contextToken) {
                            fail();
                        }

                        verified = take(candidate);
                        verifierCopy = take(verified);
                        const accepted = await options.verifyCandidate(
                            verifierCopy,
                            context,
                            identity!,
                        );

                        if (!live() || phase !== 'verifying') {
                            return fail();
                        }

                        if (accepted !== true) {
                            phase = 'failed';
                            return false;
                        }

                        phase = 'verified';
                        return true;
                    } catch (error) {
                        violation = true;
                        phase = 'failed';
                        throw error;
                    } finally {
                        release(verifierCopy);
                    }
                },
                consumeCandidate: async (candidate, suppliedC, value) => {
                    let actual: Uint8Array | undefined;

                    try {
                        enter('verified', 'consuming');
                        check(value);

                        if (suppliedC !== contextToken) {
                            fail();
                        }

                        actual = take(candidate);

                        if (
                            !verified ||
                            actual.length !== verified.length ||
                            !actual.every((v, i) => v === verified![i])
                        ) {
                            fail();
                        }

                        staged = await options.consumeCandidate(actual, context, identity!);
                        stagedSet = true;

                        if (!live() || phase !== 'consuming') {
                            disposeResult();
                            return fail();
                        }

                        enter('consuming', 'consumed');
                        return token;
                    } catch (error) {
                        violation = true;
                        phase = 'failed';
                        throw error;
                    } finally {
                        release(actual);
                    }
                },
            });
            const stillLive = live();
            finished = true;
            const snapshot = record(result);

            if (
                !violation &&
                snapshot.kind === 'failure' &&
                typeof snapshot.code === 'string' &&
                (snapshot.writeState === 'unknown' ||
                    (snapshot.writeState === 'not-written' && !seen))
            ) {
                output = failure(snapshot.writeState);
            } else if (
                stillLive &&
                !violation &&
                snapshot.kind === 'response' &&
                isConsumed() &&
                snapshot.value === token &&
                snapshot.sequence === identity?.sequence &&
                snapshot.writeState === 'written' &&
                stagedSet
            ) {
                commit = true;
            }
        } catch {
            output = failure();
        } finally {
            finished = true;
            disposeContext();

            for (const copy of copies) {
                wipe(copy);
            }

            copies.clear();

            // A disposer can synchronously abort, consume the remaining deadline,
            // or reenter a revoked callback. Recheck just before ownership transfer.
            if (commit) {
                try {
                    if (!withinDeadline() || violation || disposalFailed) {
                        commit = false;
                    }
                } catch {
                    commit = false;
                }
            }

            if (!commit || disposalFailed || violation) {
                disposeResult();
            }
        }

        if (commit && !disposalFailed && !violation) {
            stagedSet = false;
            return {
                kind: 'response',
                sequence: identity!.sequence,
                value: staged,
                writeState: 'written',
            };
        }

        return disposalFailed ? failure() : output;
    };
}
