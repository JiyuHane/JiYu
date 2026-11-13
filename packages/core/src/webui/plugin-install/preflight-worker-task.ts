import { createHash } from 'node:crypto';
import { addAbortListener, EventEmitter, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { readManifestWorkerResult } from './manifest-worker-result.ts';
import type {
    ZipEntryMetadata,
    ZipManifestResult,
    ZipPreflightError,
    ZipPreflightResult,
} from './zip-preflight';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const copy = Uint8Array.prototype.set;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const signalAdd = EventTarget.prototype.addEventListener;
const signalRemove = EventTarget.prototype.removeEventListener;

// addAbortListener/getEventListeners perform ordinary property lookup. Reject
// shadowed lookup points without evaluating accessors; removeEventListener is
// deliberately bypassed with the captured EventTarget intrinsic.
function inspectableSignal(value: unknown): value is AbortSignal {
    if (typeof value !== 'object' || value === null || types.isProxy(value)) {
        return false;
    }

    if (
        Object.getPrototypeOf(value) !== AbortSignal.prototype ||
        Object.getPrototypeOf(AbortSignal.prototype) !== EventTarget.prototype ||
        Object.getPrototypeOf(EventTarget.prototype) !== Object.prototype
    ) {
        return false;
    }

    if (
        Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get !== signalAborted ||
        Object.hasOwn(AbortSignal.prototype, 'addEventListener') ||
        Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener')?.value !==
            signalAdd
    ) {
        return false;
    }

    return (
        !Object.hasOwn(value, 'aborted') &&
        !Object.hasOwn(value, 'addEventListener') &&
        ![value, AbortSignal.prototype, EventTarget.prototype, Object.prototype].some((part) =>
            Object.hasOwn(part, 'listeners'),
        )
    );
}

const errors: readonly ZipPreflightError[] = [
    'malformed',
    'unsupported',
    'unsafe_path',
    'collision',
    'integrity',
    'limit',
    'invalid_input',
    'internal',
];

export interface PreflightWorker extends EventEmitter {
    terminate(): Promise<unknown>;
}

export type WorkerTaskOutcome =
    | Readonly<{ kind: 'result'; result: ZipPreflightResult }>
    | Readonly<{
          kind: 'failure';
          code:
              | 'busy'
              | 'invalid_input'
              | 'limit'
              | 'invalid_signal'
              | 'invalid_timeout'
              | 'invalid_options'
              | 'factory'
              | 'invalid_worker'
              | 'worker_error'
              | 'message_error'
              | 'invalid_result'
              | 'exit'
              | 'abort'
              | 'timeout'
              | 'internal';
      }>;
export interface WorkerTaskHandle {
    readonly outcome: Promise<WorkerTaskOutcome>;
    readonly cleanup: Promise<'released' | 'unknown'>;
}

/**
 * Internal adapter contract: factory owns startup and must emit only asynchronously;
 * the returned handle is exclusive and registration/removal hooks must not throw,
 * reenter, or emit early. If startup/registration or listener cleanup is uncertain,
 * cleanup stays unknown and the slot remains occupied. A returned worker must be
 * an EventEmitter whose exit event means the worker has actually exited. The
 * factory and its event mapping must be trusted: a forged exit is not proof of
 * thread termination. A matching hash
 * binds the report to the snapshot but does not prove its metadata is truthful.
 * No default factory, worker entry, files or network are used. Workers share the
 * process permissions; resource limits are not process RSS or CPU isolation.
 * Snapshot, hash and factory run synchronously on the parent event loop; timers
 * cannot preempt them. The eventual worker parser normally makes a second copy.
 * An injected clock must be monotonic; observed nonfinite values, regressions and
 * throws select internal failure. Options accept only plain own data properties.
 * A native, unproxied AbortSignal with standard lookup points is required. Its
 * abort callback is checked with getEventListeners at install and after intrinsic
 * EventTarget removal; unavailable evidence keeps cleanup unknown and the slot busy.
 * Reentrant callbacks cannot replace a terminal decision already in progress;
 * message processing before any terminal decision is not generally serialized.
 */
export class PreflightWorkerTask {
    private busy = false;

    constructor(
        private readonly workerFactory: (owned: ArrayBuffer) => PreflightWorker,
        private readonly cleanupTimeoutMs = 1000,
        private readonly clock: () => number = () => performance.now(),
    ) {
        if (
            !Number.isInteger(cleanupTimeoutMs) ||
            cleanupTimeoutMs < 10 ||
            cleanupTimeoutMs > 10000
        ) {
            throw new RangeError('Invalid cleanup timeout');
        }
    }

    start(input: unknown, options: { timeoutMs: number; signal?: AbortSignal }): WorkerTaskHandle {
        const self = this;
        type Bridge = {
            busy: typeof self.busy;
            workerFactory: typeof self.workerFactory;
            cleanupTimeoutMs: typeof self.cleanupTimeoutMs;
            clock: typeof self.clock;
        };
        return startWorkerTask(self as unknown as Bridge, input, options, readResult);
    }
}

export type ManifestWorkerTaskOutcome =
    | Readonly<{ kind: 'result'; result: ZipManifestResult }>
    | Extract<WorkerTaskOutcome, { kind: 'failure' }>;
export interface ManifestWorkerTaskHandle {
    readonly outcome: Promise<ManifestWorkerTaskOutcome>;
    readonly cleanup: Promise<'released' | 'unknown'>;
}

/** Same offline lifecycle and trusted-factory contract as PreflightWorkerTask. */
export class ManifestPreflightWorkerTask {
    private busy = false;

    constructor(
        private readonly workerFactory: (owned: ArrayBuffer) => PreflightWorker,
        private readonly cleanupTimeoutMs = 1000,
        private readonly clock: () => number = () => performance.now(),
    ) {
        if (
            !Number.isInteger(cleanupTimeoutMs) ||
            cleanupTimeoutMs < 10 ||
            cleanupTimeoutMs > 10000
        ) {
            throw new RangeError('Invalid cleanup timeout');
        }
    }

    start(
        input: unknown,
        options: { timeoutMs: number; signal?: AbortSignal },
    ): ManifestWorkerTaskHandle {
        const self = this;
        type Bridge = {
            busy: typeof self.busy;
            workerFactory: typeof self.workerFactory;
            cleanupTimeoutMs: typeof self.cleanupTimeoutMs;
            clock: typeof self.clock;
        };
        return startWorkerTask(self as unknown as Bridge, input, options, readManifestResult);
    }
}

// Both facades declare these same private fields. The bridge is internal; calls
// remain property calls on the original facade so factory and clock retain this.
interface TaskOwner {
    busy: boolean;
    readonly workerFactory: (owned: ArrayBuffer) => PreflightWorker;
    readonly cleanupTimeoutMs: number;
    readonly clock: () => number;
}

type TaskFailure = Extract<WorkerTaskOutcome, { kind: 'failure' }>;
type TaskOutcome<Result> = Readonly<{ kind: 'result'; result: Result }> | TaskFailure;
type TaskHandle<Result> = {
    readonly outcome: Promise<TaskOutcome<Result>>;
    readonly cleanup: Promise<'released' | 'unknown'>;
};

function readManifestResult(message: unknown, hash: string): ZipManifestResult | undefined {
    const validated = readManifestWorkerResult(message, hash);
    return validated === null ? undefined : validated.result;
}

function startWorkerTask<Result>(
    owner: TaskOwner,
    input: unknown,
    options: { timeoutMs: number; signal?: AbortSignal },
    readCandidate: (message: unknown, hash: string, archiveLength: number) => Result | undefined,
): TaskHandle<Result> {
    const immediate = (
        code: Extract<WorkerTaskOutcome, { kind: 'failure' }>['code'],
    ): TaskHandle<Result> => ({
        outcome: Promise.resolve(Object.freeze({ kind: 'failure', code })),
        cleanup: Promise.resolve('released'),
    });

    if (owner.busy) {
        return immediate('busy');
    }

    // Reserve before reading any caller-owned value or invoking the injected clock.
    owner.busy = true;

    const reject = (
        code: Extract<WorkerTaskOutcome, { kind: 'failure' }>['code'],
    ): TaskHandle<Result> => {
        owner.busy = false;
        return immediate(code);
    };

    let started: number;

    try {
        started = owner.clock();

        if (typeof started !== 'number' || !Number.isFinite(started)) {
            return reject('internal');
        }
    } catch {
        return reject('internal');
    }

    let config: Record<string, unknown> | null;

    try {
        if (typeof options !== 'object' || options === null || types.isProxy(options)) {
            return reject('invalid_options');
        }

        const keys = Object.hasOwn(options, 'signal') ? ['timeoutMs', 'signal'] : ['timeoutMs'];
        config = dataObject(options, keys);
    } catch {
        return reject('invalid_options');
    }

    if (!config) {
        return reject('invalid_options');
    }

    const timeout = config.timeoutMs;

    if (
        typeof timeout !== 'number' ||
        !Number.isInteger(timeout) ||
        timeout < 1 ||
        timeout > 60000
    ) {
        return reject('invalid_timeout');
    }

    const signal = config.signal as AbortSignal | undefined;

    try {
        if (signal !== undefined) {
            if (!inspectableSignal(signal)) {
                return reject('invalid_signal');
            }

            if (signalAborted.call(signal)) {
                return reject('abort');
            }
        }
    } catch {
        return reject('invalid_signal');
    }

    let resolveOutcome!: (value: TaskOutcome<Result>) => void;
    let resolveCleanup!: (value: 'released' | 'unknown') => void;
    const outcome = new Promise<TaskOutcome<Result>>((resolve) => {
        resolveOutcome = resolve;
    });
    const cleanup = new Promise<'released' | 'unknown'>((resolve) => {
        resolveCleanup = resolve;
    });
    const handle = { outcome, cleanup };
    let settled = false;
    let cleanupDone = false;
    let exited = false;
    let terminalDecision: 'failure' | 'exit' | undefined;
    let deferredExit = false;
    let constructing = true;
    let worker: PreflightWorker | undefined;
    let terminationStarted = false;
    let candidate: Result | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let abortInstalled = false;
    let cleanupUncertain = false;
    let hash = '';
    let archiveLength = 0;
    let constructionFailure: 'invalid_input' | 'internal' = 'internal';
    let lastTime = started;
    let clockFault = false;

    const readClock = (): number | undefined => {
        if (clockFault) {
            return undefined;
        }

        try {
            const now = owner.clock();

            if (typeof now !== 'number' || !Number.isFinite(now) || now < lastTime) {
                clockFault = true;
                return undefined;
            }

            lastTime = now;
            return now;
        } catch {
            clockFault = true;
            return undefined;
        }
    };

    const expired = (): boolean => {
        const now = readClock();
        return now === undefined || now - started >= timeout;
    };

    const reportCleanup = (value: 'released' | 'unknown'): void => {
        if (!cleanupDone) {
            cleanupDone = true;
            resolveCleanup(value);
        }
    };

    const clearAbort = (): void => {
        if (!signal || !abortInstalled) {
            return;
        }

        abortInstalled = false;

        try {
            signalRemove.call(signal, 'abort', onAbort);

            if (
                !inspectableSignal(signal) ||
                getEventListeners(signal, 'abort').includes(onAbort)
            ) {
                cleanupUncertain = true;
            }
        } catch {
            cleanupUncertain = true;
        }
    };

    const detach = (): void => {
        if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
        }

        if (cleanupTimer !== undefined) {
            clearTimeout(cleanupTimer);
        }

        clearAbort();

        if (worker) {
            for (const [event, listener] of [
                ['message', onMessage],
                ['messageerror', onMessageError],
                ['exit', onExit],
                ['error', onError],
            ] as const) {
                try {
                    EventEmitter.prototype.removeListener.call(worker, event, listener);

                    if (EventEmitter.prototype.listeners.call(worker, event).includes(listener)) {
                        cleanupUncertain = true;
                    }
                } catch {
                    cleanupUncertain = true;
                }
            }
        }
    };

    const release = (): void => {
        detach();

        if (cleanupUncertain) {
            reportCleanup('unknown');
        } else {
            owner.busy = false;
            reportCleanup('released');
        }
    };

    const stop = (): void => {
        if (constructing || exited) {
            return;
        }

        if (!worker) {
            release();
            return;
        }

        if (!terminationStarted) {
            terminationStarted = true;

            try {
                Promise.resolve(worker.terminate()).catch(() => {});
            } catch {
                /* exit remains the only release evidence */
            }
        }

        if (cleanupTimer === undefined && !exited) {
            cleanupTimer = setTimeout(() => reportCleanup('unknown'), owner.cleanupTimeoutMs);
        }
    };

    const finish = (value: TaskOutcome<Result>): void => {
        if (settled) {
            return;
        }

        settled = true;

        if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
        }

        clearAbort();

        resolveOutcome(Object.freeze(value));
        stop();
    };

    const chooseFailure = (code: Extract<WorkerTaskOutcome, { kind: 'failure' }>['code']): void => {
        const overdue = expired();
        finish({ kind: 'failure', code: clockFault ? 'internal' : overdue ? 'timeout' : code });
    };

    const fail = (code: Extract<WorkerTaskOutcome, { kind: 'failure' }>['code']): void => {
        if (settled || terminalDecision) {
            return;
        }

        // Reserve the first terminal decision before the injectable clock can reenter.
        terminalDecision = 'failure';

        try {
            chooseFailure(code);
        } finally {
            terminalDecision = undefined;

            if (deferredExit) {
                deferredExit = false;
                release();
            }
        }
    };

    const onAbort = (): void => {
        fail('abort');
    };

    const onError = (): void => {
        fail('worker_error');
    };

    const onMessageError = (): void => {
        fail('message_error');
    };

    const onMessage = (message: unknown): void => {
        if (settled || exited || terminalDecision) {
            return;
        }

        if (expired()) {
            fail('timeout');
            return;
        }

        if (candidate !== undefined) {
            fail('invalid_result');
            return;
        }

        try {
            const validated = readCandidate(message, hash, archiveLength);

            if (expired()) {
                fail('timeout');
            } else if (settled) {
                return;
            } else if (!validated || candidate !== undefined) {
                fail('invalid_result');
            } else {
                candidate = validated;
            }
        } catch {
            fail('invalid_result');
        }
    };

    const onExit = (code: unknown): void => {
        if (exited) {
            return;
        }

        exited = true;
        const exitCandidate = candidate;

        // A first failure owns the decision; retain this exit until it finishes.
        if (terminalDecision) {
            deferredExit = true;
            return;
        }

        terminalDecision = 'exit';

        try {
            if (!settled) {
                if (expired()) {
                    chooseFailure('timeout');
                } else if (code === 0 && exitCandidate !== undefined) {
                    finish({ kind: 'result', result: exitCandidate });
                } else {
                    chooseFailure('exit');
                }
            }
        } finally {
            terminalDecision = undefined;
            release();
        }
    };

    try {
        if (signal) {
            // The returned disposable dynamically reads signal.removeEventListener.
            // Verify the actual registered identity before using the intrinsic removal.
            abortInstalled = true;

            try {
                addAbortListener(signal, onAbort);

                if (
                    !inspectableSignal(signal) ||
                    !getEventListeners(signal, 'abort').includes(onAbort)
                ) {
                    cleanupUncertain = true;
                    fail('invalid_signal');
                }
            } catch {
                cleanupUncertain = true;
                fail('invalid_signal');
            }

            if (!settled && signalAborted.call(signal)) {
                fail('abort');
            }
        }

        if (!settled && expired()) {
            fail('timeout');
        }

        if (!settled) {
            const now = readClock();

            if (now === undefined) {
                fail('internal');
            } else if (now - started >= timeout) {
                fail('timeout');
            } else if (!settled) {
                deadlineTimer = setTimeout(
                    () => fail('timeout'),
                    Math.max(1, Math.ceil(timeout - (now - started))),
                );
            }
        }

        if (!settled) {
            constructionFailure = 'invalid_input';

            if (types.isProxy(input) || !types.isUint8Array(input)) {
                fail('invalid_input');
            } else {
                const buffer: unknown = getBuffer.call(input);
                const offset: number = getOffset.call(input);
                const length: number = getLength.call(input);

                if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) {
                    fail('invalid_input');
                } else if (length > MAX_ARCHIVE) {
                    fail('limit');
                } else {
                    const owned = new Uint8Array(length);
                    copy.call(owned, new Uint8Array(buffer as ArrayBuffer, offset, length));
                    constructionFailure = 'internal';
                    archiveLength = length;
                    hash = createHash('sha256').update(owned).digest('hex');

                    if (expired()) {
                        fail('timeout');
                    }

                    if (!settled) {
                        let result: unknown;

                        try {
                            result = owner.workerFactory(owned.buffer);
                        } catch {
                            fail('factory');
                            reportCleanup('unknown');
                            return handle;
                        }

                        try {
                            if (types.isProxy(result) || !(result instanceof EventEmitter)) {
                                fail('invalid_worker');
                                reportCleanup('unknown');
                                return handle;
                            }

                            worker = result as PreflightWorker;

                            if (typeof worker.terminate !== 'function') {
                                throw new TypeError('Invalid worker');
                            }

                            EventEmitter.prototype.on.call(worker, 'error', onError);
                            EventEmitter.prototype.on.call(worker, 'messageerror', onMessageError);
                            EventEmitter.prototype.on.call(worker, 'message', onMessage);
                            EventEmitter.prototype.on.call(worker, 'exit', onExit);

                            if (!settled && expired()) {
                                fail('timeout');
                            }
                        } catch {
                            // Broken EventEmitter hooks may have left a live worker.
                            // Retain any error listener, try to observe exit, and make
                            // one best-effort termination only with error handling.
                            cleanupUncertain = true;

                            if (worker) {
                                try {
                                    if (
                                        !EventEmitter.prototype.listeners
                                            .call(worker, 'error')
                                            .includes(onError)
                                    ) {
                                        EventEmitter.prototype.on.call(worker, 'error', onError);
                                    }
                                } catch {
                                    /* retained as unknown */
                                }

                                try {
                                    if (
                                        !EventEmitter.prototype.listeners
                                            .call(worker, 'exit')
                                            .includes(onExit)
                                    ) {
                                        EventEmitter.prototype.on.call(worker, 'exit', onExit);
                                    }
                                } catch {
                                    /* retained as unknown */
                                }

                                try {
                                    if (
                                        EventEmitter.prototype.listeners
                                            .call(worker, 'error')
                                            .includes(onError)
                                    ) {
                                        constructing = false;
                                    }
                                } catch {
                                    /* retained as unknown */
                                }
                            }

                            if (!settled) {
                                fail('invalid_worker');
                            } else {
                                stop();
                            }

                            reportCleanup('unknown');
                            return handle;
                        }
                    }
                }
            }
        }
    } catch {
        if (!settled) {
            fail(constructionFailure);
        }
    }

    constructing = false;

    if (settled) {
        stop();
    }

    return handle;
}

function dataObject(
    value: unknown,
    keys: readonly string[],
    array = false,
): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || types.isProxy(value)) {
        return null;
    }

    if (
        array
            ? !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
            : Array.isArray(value) ||
              (Object.getPrototypeOf(value) !== Object.prototype &&
                  Object.getPrototypeOf(value) !== null)
    ) {
        return null;
    }

    const actual = Reflect.ownKeys(value);

    if (
        actual.length !== keys.length ||
        actual.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) {
        return null;
    }

    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            return null;
        }

        out[key] = descriptor.value;
    }

    return out;
}

function uint(value: unknown, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function readResult(
    message: unknown,
    hash: string,
    archiveLength: number,
): ZipPreflightResult | undefined {
    const envelope = dataObject(message, ['kind', 'result']);

    if (!envelope || envelope.kind !== 'result') {
        return;
    }

    const raw = envelope.result;

    if (typeof raw !== 'object' || raw === null || types.isProxy(raw)) {
        return;
    }

    const okDescriptor = Object.getOwnPropertyDescriptor(raw, 'ok');

    if (!okDescriptor || !('value' in okDescriptor)) {
        return;
    }

    if (okDescriptor.value === false) {
        const failure = dataObject(raw, ['ok', 'code']);

        if (!failure || !errors.includes(failure.code as ZipPreflightError)) {
            return;
        }

        return Object.freeze({ ok: false, code: failure.code as ZipPreflightError });
    }

    const success = dataObject(raw, ['ok', 'entries', 'totalSize', 'sha256']);

    if (
        !success ||
        success.ok !== true ||
        success.sha256 !== hash ||
        !uint(success.totalSize, MAX_ARCHIVE)
    ) {
        return;
    }

    const entriesRaw = success.entries;

    if (
        !Array.isArray(entriesRaw) ||
        types.isProxy(entriesRaw) ||
        Object.getPrototypeOf(entriesRaw) !== Array.prototype
    ) {
        return;
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(entriesRaw, 'length');
    const count: unknown = lengthDescriptor?.value;

    if (!uint(count, MAX_ENTRIES) || count === 0) {
        return;
    }

    const keys = Array.from({ length: count }, (_, i) => String(i));
    const entries = dataObject(entriesRaw, [...keys, 'length'], true);

    if (!entries) {
        return;
    }

    const output: ZipEntryMetadata[] = [];
    let total = 0;
    let compressedTotal = 0;
    let hasFile = false;
    const paths = new Map<string, { spelling: string; explicit: boolean; file: boolean }>();

    for (const key of keys) {
        const entry = dataObject(entries[key], [
            'path',
            'kind',
            'compressedSize',
            'actualSize',
            'crc32',
        ]);

        if (
            !entry ||
            typeof entry.path !== 'string' ||
            entry.path.length === 0 ||
            entry.path.length > 512 ||
            !/^[A-Za-z0-9._/-]+$/.test(entry.path) ||
            (entry.kind !== 'file' && entry.kind !== 'directory') ||
            !uint(entry.compressedSize, MAX_FILE) ||
            !uint(entry.actualSize, MAX_FILE) ||
            !uint(entry.crc32, 0xffffffff)
        ) {
            return;
        }

        const path = entry.path;
        const directory = entry.kind === 'directory';

        if (directory !== path.endsWith('/')) {
            return;
        }

        const parts = (directory ? path.slice(0, -1) : path).split('/');

        if (
            parts.length > 16 ||
            parts.some(
                (part) =>
                    !part ||
                    part.length > 100 ||
                    part === '.' ||
                    part === '..' ||
                    part.endsWith('.') ||
                    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
            )
        ) {
            return;
        }

        let prefix = '';

        for (let i = 0; i < parts.length; i++) {
            prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
            const key = prefix.toLowerCase();
            const previous = paths.get(key);
            const leaf = i === parts.length - 1;

            if (
                previous &&
                (previous.spelling !== prefix || previous.file || (leaf && previous.explicit))
            ) {
                return;
            }

            if (leaf && !directory && previous) {
                return;
            }

            if (!previous) {
                paths.set(key, { spelling: prefix, explicit: leaf, file: leaf && !directory });
            } else if (leaf) {
                previous.explicit = true;
            }
        }

        if (
            directory &&
            (entry.actualSize !== 0 || entry.compressedSize !== 0 || entry.crc32 !== 0)
        ) {
            return;
        }

        if (!directory) {
            hasFile = true;
        }

        total += entry.actualSize;
        compressedTotal += entry.compressedSize;

        if (total > MAX_ARCHIVE || compressedTotal > archiveLength) {
            return;
        }

        output.push(
            Object.freeze({
                path,
                kind: entry.kind,
                compressedSize: entry.compressedSize,
                actualSize: entry.actualSize,
                crc32: entry.crc32,
            }),
        );
    }

    if (!hasFile || total !== success.totalSize) {
        return;
    }

    return Object.freeze({
        ok: true,
        entries: Object.freeze(output),
        totalSize: total,
        sha256: hash,
    });
}
