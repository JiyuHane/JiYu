import { spawn } from 'node:child_process';
import { isProxy, isUint8Array } from 'node:util/types';
import type { SsoSignature, SsoSigningRequest } from './sso-reserve';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 4096;
const MAX_TIMER = 0x7fffffff;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
const backingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')!.get!;
const values = Uint8Array.prototype.values;

export interface LocalQqSignWorkerOptions {
    executable: string;
    args: readonly string[];
    cwd?: string;
    initialUin: string;
    expectedBuild: string;
    expectedSha256: string;
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    /** Total admitted requests, including the single in-flight request; 1..1024. */
    maxPending: number;
}

export type LocalQqSignWorkerErrorCode =
    | 'configuration'
    | 'request'
    | 'account'
    | 'busy'
    | 'capacity'
    | 'closed'
    | 'spawn'
    | 'startup-timeout'
    | 'request-timeout'
    | 'protocol'
    | 'worker-error'
    | 'worker-exit'
    | 'stream';

// Protocol-1 vocabulary, kept in sync with tools/local-qq-sign/worker.py ERROR_CODES.
const WORKER_ERROR_CODES = [
    'invalid-arguments',
    'unsupported-platform',
    'image-io',
    'image-changed',
    'hash-mismatch',
    'invalid-elf',
    'abi-mismatch',
    'core-limit-failed',
    'preload-failed',
    'dlopen-failed',
    'link-map-failed',
    'native-bind-failed',
    'startup-failed',
    'invalid-json',
    'duplicate-key',
    'invalid-request',
    'invalid-id',
    'invalid-command',
    'invalid-sequence',
    'invalid-body',
    'line-too-long',
    'native-call-failed',
    'output-guard',
    'invalid-output',
    'empty-sign',
    'backend-close-failed',
    'io-failed',
    'stopped',
    'internal-error',
] as const;

export type LocalQqSignWorkerCode = (typeof WORKER_ERROR_CODES)[number];

/** Never includes raw worker output, executable paths, request content or native errors.
 * workerCode, when present, belongs to the fixed protocol vocabulary, not arbitrary text. */
export class LocalQqSignWorkerError extends Error {
    constructor(
        readonly code: LocalQqSignWorkerErrorCode,
        readonly workerCode?: LocalQqSignWorkerCode,
    ) {
        super(`Local QQ sign worker ${code}`);
        this.name = 'LocalQqSignWorkerError';
    }
}

export interface LocalQqSignWorkerClosed {
    reason: LocalQqSignWorkerErrorCode;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

export interface LocalQqSignWorker {
    sign(request: SsoSigningRequest): Promise<SsoSignature>;
    /** Only idle workers may bind. Zero can transition once to a positive uint32 UIN. */
    bindUin(uin: string): void;
    /** Kills this direct child and waits for its actual close event, including stdio closure. */
    close(): Promise<void>;
    readonly whenClosed: Promise<LocalQqSignWorkerClosed>;
}

function record(input: unknown, required: readonly string[], optional: readonly string[] = []) {
    if (!input || typeof input !== 'object' || isProxy(input)) {
        throw new Error();
    }

    const prototype = Object.getPrototypeOf(input) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error();
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (
            typeof key !== 'string' ||
            (!required.includes(key) && !optional.includes(key)) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new Error();
        }

        result[key] = descriptor.value;
    }

    if (required.some((key) => !Object.hasOwn(result, key))) {
        throw new Error();
    }

    return result;
}

function isUin(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^(0|[1-9][0-9]{0,9})$/.test(value) &&
        BigInt(value) <= 0xffffffffn
    );
}

function text(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function timer(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TIMER;
}

function optionsSnapshot(input: LocalQqSignWorkerOptions): LocalQqSignWorkerOptions {
    try {
        const fields = record(
            input,
            [
                'executable',
                'args',
                'initialUin',
                'expectedBuild',
                'expectedSha256',
                'startupTimeoutMs',
                'requestTimeoutMs',
                'maxPending',
            ],
            ['cwd'],
        );
        const args = fields.args;

        if (!Array.isArray(args) || isProxy(args) || args.length > 1024) {
            throw new Error();
        }

        const copiedArgs: string[] = [];

        for (let index = 0; index < args.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(args, String(index));

            if (
                !descriptor ||
                !('value' in descriptor) ||
                typeof descriptor.value !== 'string' ||
                descriptor.value.includes('\0')
            ) {
                throw new Error();
            }

            copiedArgs.push(descriptor.value);
        }

        if (
            !text(fields.executable) ||
            (fields.cwd !== undefined && !text(fields.cwd)) ||
            !isUin(fields.initialUin) ||
            typeof fields.expectedBuild !== 'string' ||
            !/^[\x21-\x7e]{1,128}$/.test(fields.expectedBuild) ||
            typeof fields.expectedSha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(fields.expectedSha256) ||
            !timer(fields.startupTimeoutMs) ||
            !timer(fields.requestTimeoutMs) ||
            typeof fields.maxPending !== 'number' ||
            !Number.isInteger(fields.maxPending) ||
            fields.maxPending < 1 ||
            fields.maxPending > 1024
        ) {
            throw new Error();
        }

        return {
            executable: fields.executable,
            args: copiedArgs,
            cwd: fields.cwd,
            initialUin: fields.initialUin,
            expectedBuild: fields.expectedBuild,
            expectedSha256: fields.expectedSha256,
            startupTimeoutMs: fields.startupTimeoutMs,
            requestTimeoutMs: fields.requestTimeoutMs,
            maxPending: fields.maxPending,
        };
    } catch {
        throw new LocalQqSignWorkerError('configuration');
    }
}

/** This protocol only contains objects, strings, numbers and null. Detect duplicate decoded keys
 * before JSON.parse could overwrite them, including escaped spellings such as "\u0069d". */
function parseLine(line: string): unknown {
    let position = 0;

    const space = () => {
        while (position < line.length && /[ \t\r\n]/.test(line[position])) {
            position++;
        }
    };

    const string = (): string => {
        const start = position++;

        while (position < line.length) {
            const character = line[position++];

            if (character === '\\') {
                position++;
            } else if (character === '"') {
                return JSON.parse(line.slice(start, position)) as string;
            }
        }

        throw new Error();
    };

    const value = (depth: number): unknown => {
        space();

        if (line[position] === '"') {
            return string();
        }

        if (line.startsWith('null', position)) {
            position += 4;
            return null;
        }

        if (line[position] !== '{') {
            const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
                line.slice(position),
            );

            if (!match) {
                throw new Error();
            }

            position += match[0].length;
            return Number(match[0]);
        }

        if (depth > 2) {
            throw new Error();
        }

        position++;
        space();
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

        if (line[position] === '}') {
            position++;
            return result;
        }

        for (;;) {
            space();

            if (line[position] !== '"') {
                throw new Error();
            }

            const key = string();
            space();

            if (Object.hasOwn(result, key) || line[position++] !== ':') {
                throw new Error();
            }

            result[key] = value(depth + 1);
            space();
            const delimiter = line[position++];

            if (delimiter === '}') {
                return result;
            }

            if (delimiter !== ',') {
                throw new Error();
            }
        }
    };

    const result = value(0);
    space();

    if (position !== line.length) {
        throw new Error();
    }

    return result;
}

function signature(input: unknown): SsoSignature {
    const fields = record(input, ['sign', 'token', 'extra']);

    const field = (value: unknown, required: boolean): Uint8Array => {
        if (
            typeof value !== 'string' ||
            value.length > 510 ||
            value.length % 2 !== 0 ||
            (required && value.length === 0) ||
            !/^[0-9a-fA-F]*$/.test(value)
        ) {
            throw new Error();
        }

        return Buffer.from(value, 'hex');
    };

    const sign = field(fields.sign, true);
    let token: Uint8Array | undefined;

    try {
        token = field(fields.token, false);
        return { sign, token, extra: field(fields.extra, false) };
    } catch (error) {
        sign.fill(0);
        token?.fill(0);
        throw error;
    }
}

function workerErrorCode(input: unknown): LocalQqSignWorkerCode {
    const fields = record(input, ['code']);
    const code = WORKER_ERROR_CODES.find((candidate) => candidate === fields.code);

    if (!code) {
        throw new Error();
    }

    return code;
}

type Reply = { result: SsoSignature } | { error: LocalQqSignWorkerCode };
type Pending = {
    id: number;
    frame: Buffer;
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: SsoSignature) => void;
    reject: (error: LocalQqSignWorkerError) => void;
    writing: boolean;
    reply?: Reply;
};

function wipeReply(reply: Reply | undefined): void {
    if (reply && 'result' in reply) {
        reply.result.sign.fill(0);
        reply.result.token.fill(0);
        reply.result.extra.fill(0);
    }
}

/** Explicit process launch, not a QQ client or a signature implementation. The trusted
 * executable must verify its native input before declaring ready; its declaration alone
 * is not attestation. Only this direct child is killed, never an alleged process tree.
 * Built-ins and the local executable are trusted. Immutable JSON/hex strings and OS pipe
 * copies are not securely erased. A failed startup waits for actual child/stdio closure. */
export async function startLocalQqSignWorker(
    input: LocalQqSignWorkerOptions,
): Promise<LocalQqSignWorker> {
    const started = performance.now();
    const options = optionsSnapshot(input);
    let child: ReturnType<typeof spawn>;

    try {
        child = spawn(options.executable, [...options.args], {
            cwd: options.cwd,
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        throw new LocalQqSignWorkerError('spawn');
    }

    const stdin = child.stdin!;
    const stdout = child.stdout!;
    const stderr = child.stderr!;
    let uin = options.initialUin;
    let nextId = 1;
    let ready = false;
    let readyReceived = false;
    let reading = false;
    let writeCall = false;
    let needDrain = false;
    let exited = false;
    let physicallyClosed = false;
    let terminal: LocalQqSignWorkerErrorCode | undefined;
    let active: Pending | undefined;
    const queue: Pending[] = [];
    const writes = new Set<Pending>();
    const lineBuffer = Buffer.alloc(MAX_LINE_BYTES);
    let lineLength = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let readyResolve!: () => void;
    let readyReject!: (error: LocalQqSignWorkerError) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    let closedResolve!: (result: LocalQqSignWorkerClosed) => void;
    const whenClosed = new Promise<LocalQqSignWorkerClosed>((resolve) => {
        closedResolve = resolve;
    });
    const startupTimer = setTimeout(
        () => terminate('startup-timeout'),
        Math.max(1, Math.ceil(started + options.startupTimeoutMs - performance.now())),
    );

    function terminate(
        reason: LocalQqSignWorkerErrorCode,
        workerCode?: LocalQqSignWorkerCode,
    ): void {
        if (terminal) {
            return;
        }

        terminal = reason;
        clearTimeout(startupTimer);
        readyReject(new LocalQqSignWorkerError(reason, workerCode));
        const pending = active ? [active, ...queue] : queue.slice();
        active = undefined;
        queue.length = 0;

        for (const job of pending) {
            clearTimeout(job.timer);
            wipeReply(job.reply);

            if (!job.writing) {
                job.frame.fill(0);
            }

            job.reject(new LocalQqSignWorkerError(reason, workerCode));
        }

        lineBuffer.fill(0);
        lineLength = 0;
        stdin.destroy();

        if (!physicallyClosed && !exited) {
            try {
                child.kill('SIGKILL');
            } catch {
                // Do not claim closure when the OS has not delivered the close event.
            }
        }
    }

    function flush(): void {
        if (terminal || reading || writeCall) {
            return;
        }

        if (readyReceived && !ready) {
            ready = true;
            clearTimeout(startupTimer);
            readyResolve();
        }

        if (active?.reply && !active.writing && !needDrain) {
            const job = active;

            if (performance.now() >= job.deadline) {
                terminate('request-timeout');
                return;
            }

            const reply = job.reply!;
            active = undefined;
            clearTimeout(job.timer);
            job.frame.fill(0);

            if ('result' in reply) {
                job.resolve(reply.result);
            } else {
                job.reject(new LocalQqSignWorkerError('worker-error', reply.error));
            }
        }

        if (!ready || active || needDrain || queue.length === 0) {
            return;
        }

        const job = queue.shift()!;
        active = job;

        if (performance.now() >= job.deadline) {
            terminate('request-timeout');
            return;
        }

        job.writing = true;
        writes.add(job);
        writeCall = true;

        try {
            needDrain = !stdin.write(job.frame, (error) => {
                job.writing = false;
                writes.delete(job);
                job.frame.fill(0);

                if (error) {
                    terminate('stream');
                } else {
                    flush();
                }
            });
        } catch {
            terminate('stream');
        } finally {
            writeCall = false;
        }

        flush();
    }

    function onLine(line: string): void {
        const message = parseLine(line);

        if (!readyReceived) {
            if (performance.now() >= started + options.startupTimeoutMs) {
                terminate('startup-timeout');
                return;
            }

            if (message && typeof message === 'object' && Object.hasOwn(message, 'error')) {
                const fields = record(message, ['id', 'error']);

                if (fields.id !== null) {
                    throw new Error();
                }

                terminate('worker-error', workerErrorCode(fields.error));
                return;
            }

            const fields = record(message, ['type', 'protocol', 'build', 'sha256']);

            if (
                fields.type !== 'ready' ||
                fields.protocol !== 1 ||
                fields.build !== options.expectedBuild ||
                fields.sha256 !== options.expectedSha256
            ) {
                throw new Error();
            }

            readyReceived = true;
            return;
        }

        const fields = record(message, ['id'], ['result', 'error']);

        if (
            !active ||
            active.reply ||
            !Number.isSafeInteger(fields.id) ||
            fields.id !== active.id ||
            Object.hasOwn(fields, 'result') === Object.hasOwn(fields, 'error')
        ) {
            throw new Error();
        }

        if (Object.hasOwn(fields, 'result')) {
            active.reply = { result: signature(fields.result) };
        } else {
            active.reply = { error: workerErrorCode(fields.error) };
        }
    }

    function onData(chunk: Buffer): void {
        if (terminal) {
            return;
        }

        reading = true;

        try {
            let offset = 0;

            while (offset < chunk.length) {
                const newline = chunk.indexOf(10, offset);
                const end = newline < 0 ? chunk.length : newline;
                const size = end - offset;

                if (lineLength + size > MAX_LINE_BYTES) {
                    throw new Error();
                }

                chunk.copy(lineBuffer, lineLength, offset, end);
                lineLength += size;
                offset = end + 1;

                if (newline >= 0) {
                    const line = decoder.decode(lineBuffer.subarray(0, lineLength));
                    lineBuffer.fill(0, 0, lineLength);
                    lineLength = 0;
                    onLine(line);

                    if (terminal) {
                        return;
                    }
                }
            }

            // Extra partial output after a complete ready/reply is unsolicited, too.
            if (lineLength > 0 && ((!ready && readyReceived) || active?.reply)) {
                throw new Error();
            }
        } catch {
            terminate('protocol');
        } finally {
            reading = false;
        }

        flush();
    }

    const onStreamError = () => terminate('stream');
    const onStdoutEnd = () => terminate(lineLength ? 'protocol' : 'stream');
    const onStdinClose = () => terminate('stream');

    const onDrain = () => {
        needDrain = false;
        flush();
    };

    const onSpawnError = () => terminate('spawn');

    const onExit = () => {
        exited = true;
        terminate(lineLength ? 'protocol' : 'worker-exit');
    };

    const discardStderr = (_chunk: Buffer) => {
        // Drain without recording or forwarding potentially sensitive native diagnostics.
    };

    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        physicallyClosed = true;
        terminate('worker-exit');

        for (const job of writes) {
            job.writing = false;
            job.frame.fill(0);
        }

        writes.clear();
        stdin.removeListener('error', onStreamError);
        stdin.removeListener('close', onStdinClose);
        stdin.removeListener('drain', onDrain);
        stdout.removeListener('data', onData);
        stdout.removeListener('error', onStreamError);
        stdout.removeListener('end', onStdoutEnd);
        stderr.removeListener('data', discardStderr);
        stderr.removeListener('error', onStreamError);
        child.removeListener('error', onSpawnError);
        child.removeListener('exit', onExit);
        child.removeListener('close', onClose);
        closedResolve(Object.freeze({ reason: terminal!, exitCode, signal }));
    };

    stdin.on('error', onStreamError);
    stdin.on('close', onStdinClose);
    stdin.on('drain', onDrain);
    stdout.on('data', onData);
    stdout.on('error', onStreamError);
    stdout.on('end', onStdoutEnd);
    stderr.on('data', discardStderr);
    stderr.on('error', onStreamError);
    child.on('error', onSpawnError);
    child.on('exit', onExit);
    child.on('close', onClose);

    try {
        await readyPromise;
    } catch (error) {
        await whenClosed;
        throw error;
    }

    return Object.freeze({
        whenClosed,
        sign(request: SsoSigningRequest): Promise<SsoSignature> {
            const deadline = performance.now() + options.requestTimeoutMs;
            let frame: Buffer;

            try {
                if (terminal) {
                    throw new LocalQqSignWorkerError('closed');
                }

                const fields = record(request, ['uin', 'command', 'sequence', 'body']);

                if (!isUin(fields.uin) || fields.uin !== uin) {
                    throw new LocalQqSignWorkerError('account');
                }

                if (
                    typeof fields.command !== 'string' ||
                    // eslint-disable-next-line no-control-regex -- The wire contract permits ASCII except NUL.
                    !/^[\x01-\x7f]{1,256}$/.test(fields.command) ||
                    typeof fields.sequence !== 'number' ||
                    !Number.isInteger(fields.sequence) ||
                    fields.sequence < 0 ||
                    fields.sequence > 0xffffffff ||
                    Object.is(fields.sequence, -0) ||
                    isProxy(fields.body) ||
                    !isUint8Array(fields.body)
                ) {
                    throw new Error();
                }

                values.call(fields.body);
                const backing = buffer.call(fields.body) as ArrayBuffer;
                backingLength.call(backing);
                const size = byteLength.call(fields.body) as number;

                if (resizable.call(backing) || size > MAX_BODY_BYTES) {
                    throw new Error();
                }

                if (queue.length + (active ? 1 : 0) >= options.maxPending) {
                    throw new LocalQqSignWorkerError('capacity');
                }

                if (!Number.isSafeInteger(nextId)) {
                    terminate('protocol');
                    throw new LocalQqSignWorkerError('closed');
                }

                const copy = Buffer.alloc(size);
                copy.set(new Uint8Array(backing, byteOffset.call(fields.body) as number, size));

                try {
                    frame = Buffer.from(
                        JSON.stringify({
                            id: nextId,
                            command: fields.command,
                            sequence: fields.sequence,
                            body: copy.toString('hex'),
                        }) + '\n',
                    );
                } finally {
                    copy.fill(0);
                }
            } catch (error) {
                return Promise.reject(
                    error instanceof LocalQqSignWorkerError
                        ? error
                        : new LocalQqSignWorkerError('request'),
                );
            }

            return new Promise<SsoSignature>((resolve, reject) => {
                const job: Pending = {
                    id: nextId++,
                    frame,
                    deadline,
                    resolve,
                    reject,
                    writing: false,
                    timer: setTimeout(
                        () => terminate('request-timeout'),
                        Math.max(1, Math.ceil(deadline - performance.now())),
                    ),
                };
                queue.push(job);
                flush();
            });
        },
        bindUin(next: string): void {
            if (terminal) {
                throw new LocalQqSignWorkerError('closed');
            }

            if (!isUin(next) || (next !== uin && (uin !== '0' || next === '0'))) {
                throw new LocalQqSignWorkerError('account');
            }

            if (active || queue.length) {
                throw new LocalQqSignWorkerError('busy');
            }

            uin = next;
        },
        async close(): Promise<void> {
            terminate('closed');
            await whenClosed;
        },
    });
}
