import childProcess, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LocalQqSignWorkerError,
    startLocalQqSignWorker,
    type LocalQqSignWorker,
    type LocalQqSignWorkerOptions,
} from '../../src/direct/local-qq-sign-worker';
import type { SsoSigningRequest } from '../../src/direct/sso-reserve';

// Real Node child processes and OS pipes, synthetic signing only. No native QQ,
// accounts, network endpoints, desktop client or Hook is used in these tests.
const BUILD = '3.2.35-54395';
const SHA256 = 'dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328';
const READY = { type: 'ready', protocol: 1, build: BUILD, sha256: SHA256 };
const SEND = "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');";
const RESULT = "send({id: req.id, result: {sign: '0102', token: '', extra: 'ab'}});";
const handles: LocalQqSignWorker[] = [];
const children: ChildProcess[] = [];
const closed = new WeakSet<ChildProcess>();
let onSpawn: ((child: ChildProcess) => void) | undefined;

function script(body = RESULT, setup = ''): string {
    return `
        const readline = require('node:readline');
        ${SEND}
        ${setup}
        const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
        lines.on('line', line => { const req = JSON.parse(line); ${body} });
        send(${JSON.stringify(READY)});
    `;
}

function options(
    code: string,
    override: Partial<LocalQqSignWorkerOptions> = {},
): LocalQqSignWorkerOptions {
    return {
        executable: process.execPath,
        args: ['-e', code],
        initialUin: '0',
        expectedBuild: BUILD,
        expectedSha256: SHA256,
        startupTimeoutMs: 5000,
        requestTimeoutMs: 3000,
        maxPending: 4,
        ...override,
    };
}

async function open(code = script(), override: Partial<LocalQqSignWorkerOptions> = {}) {
    const handle = await startLocalQqSignWorker(options(code, override));
    handles.push(handle);
    return handle;
}

function request(overrides: Partial<SsoSigningRequest> = {}): SsoSigningRequest {
    return {
        uin: '0',
        command: 'Test.Sign',
        sequence: 0xffffffff,
        body: Uint8Array.of(1, 2),
        ...overrides,
    };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('test child cleanup timed out')), 8000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

beforeEach(() => {
    onSpawn = undefined;
    const original = childProcess.spawn;
    const observed = ((...args: Parameters<typeof original>) => {
        const child = Reflect.apply(original, childProcess, args) as ChildProcess;
        children.push(child);
        child.once('close', () => closed.add(child));
        onSpawn?.(child);
        return child;
    }) as typeof original;
    vi.spyOn(childProcess, 'spawn').mockImplementation(observed);
    syncBuiltinESMExports();
});

afterEach(async () => {
    try {
        await bounded(Promise.all(handles.splice(0).map((handle) => handle.close())));

        for (const child of children.splice(0)) {
            if (!closed.has(child)) {
                const closure = once(child, 'close').catch(() => undefined);
                child.kill('SIGKILL');
                await bounded(closure);
            }
        }
    } finally {
        onSpawn = undefined;
        vi.restoreAllMocks();
        syncBuiltinESMExports();
    }
});

describe('local QQ signer subprocess with synthetic Node worker', () => {
    it('has no import-time launch and validates configuration before spawning', async () => {
        vi.resetModules();
        await import('../../src/direct/local-qq-sign-worker');
        expect(children).toHaveLength(0);
        const bad = [
            { executable: '' },
            { args: ['bad\0arg'] },
            { initialUin: '00' },
            { initialUin: '4294967296' },
            { expectedBuild: '' },
            { expectedSha256: 'bad' },
            { startupTimeoutMs: 0 },
            { requestTimeoutMs: NaN },
            { maxPending: 0 },
            { maxPending: 1025 },
            { cwd: 'bad\0path' },
            { unknown: true },
        ];

        for (const override of bad) {
            await expect(startLocalQqSignWorker(options(script(), override))).rejects.toMatchObject(
                { code: 'configuration' },
            );
        }

        expect(children).toHaveLength(0);
    });

    it('uses shell:false, real pipes, literal args and exact request fields with no UIN', async () => {
        const literal = 'literal;$(not-a-command)& value';
        const received: unknown[] = [];

        onSpawn = (child) => {
            const stdin = child.stdin!;
            const write = stdin.write;
            vi.spyOn(stdin, 'write').mockImplementation(function (
                this: typeof stdin,
                ...args: Parameters<typeof write>
            ) {
                received.push(JSON.parse(Buffer.from(args[0] as Uint8Array).toString()));
                return Reflect.apply(write, this, args) as boolean;
            } as typeof write);
        };

        const code = script(
            "send({id:req.id,result:{sign:Buffer.from(process.argv[1]).toString('hex'),token:'',extra:''}});",
        );
        const handle = await open(code, { args: ['-e', code, '--', literal], cwd: process.cwd() });
        const result = await handle.sign(request());
        expect(Buffer.from(result.sign).toString()).toBe(literal);
        expect(received).toEqual([
            { id: 1, command: 'Test.Sign', sequence: 0xffffffff, body: '0102' },
        ]);
        expect(childProcess.spawn).toHaveBeenCalledWith(
            process.execPath,
            ['-e', code, '--', literal],
            expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
        );
        expect(children).toHaveLength(1);
        await handle.close();
        expect(closed.has(children[0])).toBe(true);
        expect((await handle.whenClosed).reason).toBe('closed');
    });

    it('snapshots body bytes synchronously without using byte-view getters or iterators', async () => {
        const handle = await open(
            script(
                "setTimeout(() => send({id:req.id,result:{sign:req.body,token:'',extra:''}}), 30);",
            ),
        );
        const buffer = Uint8Array.from([99, 10, 11, 88]);
        const body = buffer.subarray(1, 3);
        const trap = vi.fn(() => {
            throw new Error('byte accessor called');
        });

        for (const key of ['buffer', 'byteOffset', 'byteLength', Symbol.iterator]) {
            Object.defineProperty(body, key, { get: trap });
        }

        const first = handle.sign(request());
        const pending = handle.sign(request({ body }));
        buffer.fill(0);
        expect(Buffer.from((await pending).sign).toString('hex')).toBe('0a0b');
        await first;
        expect(trap).not.toHaveBeenCalled();
    });

    it('keeps one in-flight request and bounds the total admitted FIFO', async () => {
        const code = script(
            `
            if (working) throw new Error('overlapped worker requests');
            working = true;
            setTimeout(() => {
                working = false;
                send({id:req.id,result:{sign:req.id.toString(16).padStart(2,'0'),token:'',extra:''}});
            }, 50);
        `,
            'let working = false;',
        );
        const handle = await open(code, { maxPending: 2 });
        const first = handle.sign(request());
        const second = handle.sign(request());
        await expect(handle.sign(request())).rejects.toMatchObject({ code: 'capacity' });
        expect((await first).sign).toEqual(Buffer.from('01', 'hex'));
        expect((await second).sign).toEqual(Buffer.from('02', 'hex'));
        expect((await handle.sign(request())).sign).toEqual(Buffer.from('03', 'hex'));
    });

    it('binds 0 to one confirmed account only while idle, without putting UIN on the wire', async () => {
        const handle = await open(script(`setTimeout(() => { ${RESULT} }, 40);`));
        handle.bindUin('0');
        const pending = handle.sign(request());
        expect(() => handle.bindUin('123')).toThrowError(expect.objectContaining({ code: 'busy' }));
        expect(() => handle.bindUin('0')).toThrowError(expect.objectContaining({ code: 'busy' }));
        await pending;
        handle.bindUin('123');
        handle.bindUin('123');
        await expect(handle.sign(request())).rejects.toMatchObject({ code: 'account' });
        await expect(handle.sign(request({ uin: '456' }))).rejects.toMatchObject({
            code: 'account',
        });
        await expect(handle.sign(request({ uin: '123' }))).resolves.toMatchObject({
            sign: Buffer.from('0102', 'hex'),
        });

        for (const uin of ['0', '456', '0123', '4294967296']) {
            expect(() => handle.bindUin(uin)).toThrowError(
                expect.objectContaining({ code: 'account' }),
            );
        }

        const bound = await open(script(), { initialUin: '4294967295' });
        bound.bindUin('4294967295');
        expect(() => bound.bindUin('123')).toThrowError(
            expect.objectContaining({ code: 'account' }),
        );
        await bound.sign(request({ uin: '4294967295' }));
    });

    it('rejects malformed requests without effects and keeps the worker usable', async () => {
        const handle = await open();
        const detached = new Uint8Array(2);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const trap = vi.fn(() => {
            throw new Error('request accessor called');
        });
        const accessor = {
            ...request(),
            get command() {
                return trap();
            },
        };
        const malformed = [
            request({ command: '' }),
            request({ command: 'a'.repeat(257) }),
            request({ command: 'bad\0command' }),
            request({ command: '非ASCII' }),
            request({ sequence: -1 }),
            request({ sequence: -0 }),
            request({ sequence: 0x100000000 }),
            request({ sequence: 1.5 }),
            request({ sequence: Infinity }),
            request({ body: new Uint8Array(1024 * 1024 + 1) }),
            request({ body: new Uint8Array(new SharedArrayBuffer(1)) }),
            request({
                body: new Uint8Array(
                    Reflect.construct(ArrayBuffer, [2, { maxByteLength: 4 }]) as ArrayBuffer,
                ),
            }),
            request({ body: detached }),
            accessor,
            new Proxy(request(), { get: trap }),
            { ...request(), extra: true },
        ];

        for (const value of malformed) {
            await expect(handle.sign(value)).rejects.toBeInstanceOf(LocalQqSignWorkerError);
        }

        expect(trap).not.toHaveBeenCalled();
        await expect(
            handle.sign(request({ command: 'A'.repeat(256), sequence: 0, body: new Uint8Array() })),
        ).resolves.toHaveProperty('sign');
    });

    it('accepts fragmented ready/replies and all 255-byte hex-field boundaries', async () => {
        const code = `
            const readline = require('node:readline');
            const ready = Buffer.from(${JSON.stringify(JSON.stringify(READY) + '\n')});
            process.stdout.write(ready.subarray(0, 12));
            setTimeout(() => process.stdout.write(ready.subarray(12)), 10);
            readline.createInterface({input:process.stdin}).on('line', line => {
                const req = JSON.parse(line);
                const reply = Buffer.from(JSON.stringify({id:req.id,result:{sign:'aB'.repeat(255),token:'CD'.repeat(255),extra:'ef'.repeat(255)}})+'\\n');
                process.stdout.write(reply.subarray(0, 7));
                setTimeout(() => process.stdout.write(reply.subarray(7)), 10);
            });
        `;
        const handle = await open(code);
        const result = await handle.sign(request());
        expect(result.sign).toEqual(Buffer.alloc(255, 0xab));
        expect(result.token).toEqual(Buffer.alloc(255, 0xcd));
        expect(result.extra).toEqual(Buffer.alloc(255, 0xef));
    });

    it('drains real pipe backpressure before dispatching the next request', async () => {
        const returns: boolean[] = [];

        onSpawn = (child) => {
            const stdin = child.stdin!;
            const write = stdin.write;
            vi.spyOn(stdin, 'write').mockImplementation(function (
                this: typeof stdin,
                ...args: Parameters<typeof write>
            ) {
                const result = Reflect.apply(write, this, args) as boolean;
                returns.push(result);
                return result;
            } as typeof write);
        };

        const code = `
            ${SEND}
            send(${JSON.stringify(READY)});
            setTimeout(() => {
                require('node:readline').createInterface({input:process.stdin}).on('line', line => {
                    const req = JSON.parse(line);
                    if (req.body.length !== (req.id === 1 ? 2 * 1024 * 1024 : 4)) throw new Error('bad write');
                    ${RESULT}
                });
            }, 200);
        `;
        const handle = await open(code);
        const first = handle.sign(request({ body: new Uint8Array(1024 * 1024).fill(7) }));
        const second = handle.sign(request());
        await Promise.all([first, second]);
        expect(returns).toHaveLength(2);
        expect(returns[0]).toBe(false);
    });

    it('counts queue time in the deadline and kills all pending work without retries', async () => {
        const code = script(`setTimeout(() => { ${RESULT} }, req.id === 1 ? 150 : 250);`);
        const handle = await open(code, { requestTimeoutMs: 300 });
        const outcomes = await Promise.allSettled([
            handle.sign(request()),
            handle.sign(request()),
            handle.sign(request()),
        ]);
        expect(outcomes[0].status).toBe('fulfilled');

        for (const result of outcomes.slice(1)) {
            expect(result).toMatchObject({
                status: 'rejected',
                reason: { code: 'request-timeout' },
            });
        }

        expect((await handle.whenClosed).reason).toBe('request-timeout');
        expect(children).toHaveLength(1);
        expect(closed.has(children[0])).toBe(true);
        await expect(handle.sign(request())).rejects.toMatchObject({ code: 'closed' });
    });

    it('settles writes and queued work when timed out under real pipe backpressure', async () => {
        const code = `${SEND} send(${JSON.stringify(READY)}); setInterval(() => {}, 1000);`;
        const handle = await open(code, { requestTimeoutMs: 150 });
        const outcomes = await Promise.allSettled([
            handle.sign(request({ body: new Uint8Array(1024 * 1024) })),
            handle.sign(request()),
        ]);
        expect(outcomes).toEqual([
            expect.objectContaining({
                status: 'rejected',
                reason: expect.objectContaining({ code: 'request-timeout' }),
            }),
            expect.objectContaining({
                status: 'rejected',
                reason: expect.objectContaining({ code: 'request-timeout' }),
            }),
        ]);
        await handle.whenClosed;
        expect(closed.has(children[0])).toBe(true);
    });

    it('preserves a fixed empty-sign worker code and may continue the session', async () => {
        const code = script(`
            if (req.id === 1) send({id:req.id,error:{code:'empty-sign'}});
            else { ${RESULT} }
        `);
        const handle = await open(code);
        const outcome = await handle.sign(request()).then(
            () => undefined,
            (error) => error as Error,
        );
        expect(outcome).toMatchObject({ code: 'worker-error', workerCode: 'empty-sign' });
        expect(String(outcome)).not.toContain('empty-sign');
        expect(outcome).not.toHaveProperty('cause');
        await expect(handle.sign(request())).resolves.toHaveProperty('sign');
    });

    it.each([
        ['missing field', "send({id:req.id,result:{sign:'01',token:''}});"],
        ['empty sign', "send({id:req.id,result:{sign:'',token:'',extra:''}});"],
        ['oversize sign', "send({id:req.id,result:{sign:'01'.repeat(256),token:'',extra:''}});"],
        ['oversize token', "send({id:req.id,result:{sign:'01',token:'02'.repeat(256),extra:''}});"],
        ['odd hex', "send({id:req.id,result:{sign:'0',token:'',extra:''}});"],
        ['nonhex', "send({id:req.id,result:{sign:'zz',token:'',extra:''}});"],
        ['unknown root', "send({id:req.id,result:{sign:'01',token:'',extra:''},other:1});"],
        ['unknown nested', "send({id:req.id,result:{sign:'01',token:'',extra:'',other:''}});"],
        [
            'result and error',
            "send({id:req.id,result:{sign:'01',token:'',extra:''},error:{code:'oops'}});",
        ],
        ['wrong id', "send({id:req.id+1,result:{sign:'01',token:'',extra:''}});"],
        ['string id', "send({id:String(req.id),result:{sign:'01',token:'',extra:''}});"],
        ['zero id', "send({id:0,result:{sign:'01',token:'',extra:''}});"],
        ['unknown error field', "send({id:req.id,error:{code:'oops',detail:'secret'}});"],
        ['bad error code', "send({id:req.id,error:{code:'/secret/path'}});"],
        ['unknown error code', "send({id:req.id,error:{code:'sensitive-worker-detail'}});"],
        ['null id after ready', "send({id:null,error:{code:'preload-failed'}});"],
        [
            'duplicate root',
            `process.stdout.write('{"id":'+req.id+',"id":'+req.id+',"result":{"sign":"01","token":"","extra":""}}\\n');`,
        ],
        [
            'escaped duplicate',
            `process.stdout.write('{"id":'+req.id+',"\\\\u0069d":'+req.id+',"result":{"sign":"01","token":"","extra":""}}\\n');`,
        ],
        [
            'duplicate nested',
            `process.stdout.write('{"id":'+req.id+',"result":{"sign":"01","sign":"02","token":"","extra":""}}\\n');`,
        ],
        [
            'duplicate reply same chunk',
            `const out=JSON.stringify({id:req.id,result:{sign:'01',token:'',extra:''}})+'\\n'; process.stdout.write(out+out);`,
        ],
        ['invalid UTF8', 'process.stdout.write(Buffer.from([0xc3,0x28,0x0a]));'],
        ['oversize line', "process.stdout.write('x'.repeat(4097));"],
        ['truncated EOF', "process.stdout.write('{', () => process.exit(0));"],
    ])('fails closed and settles every request on %s', async (_name, body) => {
        const handle = await open(script(body));
        const outcomes = await Promise.allSettled([handle.sign(request()), handle.sign(request())]);

        for (const result of outcomes) {
            expect(result).toMatchObject({ status: 'rejected', reason: { code: 'protocol' } });
        }

        expect((await handle.whenClosed).reason).toBe('protocol');
        expect(closed.has(children[0])).toBe(true);
    });

    it.each([
        { ...READY, protocol: 2 },
        { ...READY, build: 'other' },
        { ...READY, sha256: '0'.repeat(64) },
        { ...READY, unknown: true },
    ])('validates the exact ready statement %#', async (ready) => {
        const code = `${SEND} send(${JSON.stringify(ready)}); setInterval(() => {}, 1000);`;
        await expect(startLocalQqSignWorker(options(code))).rejects.toMatchObject({
            code: 'protocol',
        });
        expect(closed.has(children[0])).toBe(true);
    });

    it('rejects duplicate ready keys and unsolicited replies before returning a handle', async () => {
        const duplicate = JSON.stringify(READY).replace(
            '"protocol":1',
            '"protocol":1,"protocol":1',
        );
        await expect(
            startLocalQqSignWorker(
                options(
                    `process.stdout.write(${JSON.stringify(duplicate + '\n')}); setInterval(()=>{},1000);`,
                ),
            ),
        ).rejects.toMatchObject({ code: 'protocol' });
        const lines =
            JSON.stringify(READY) +
            '\n' +
            JSON.stringify({ id: 1, result: { sign: '01', token: '', extra: '' } }) +
            '\n';
        await expect(
            startLocalQqSignWorker(
                options(
                    `process.stdout.write(${JSON.stringify(lines)}); setInterval(()=>{},1000);`,
                ),
            ),
        ).rejects.toMatchObject({ code: 'protocol' });
        expect(children.every((child) => closed.has(child))).toBe(true);
    });

    it('preserves startup preload-failed and rejects only after actual child closure', async () => {
        const code = `${SEND}
            send({id:null,error:{code:'preload-failed'}});
            setInterval(() => {}, 1000);
        `;
        const error = await startLocalQqSignWorker(options(code)).then(
            () => undefined,
            (reason) => reason as LocalQqSignWorkerError,
        );
        expect(error).toMatchObject({ code: 'worker-error', workerCode: 'preload-failed' });
        expect(String(error)).toBe('LocalQqSignWorkerError: Local QQ sign worker worker-error');
        expect(closed.has(children[0])).toBe(true);
        expect(children[0].listenerCount('error')).toBe(0);
    });

    it.each([
        { id: null, error: { code: 'sensitive-unknown-code' } },
        { id: 1, error: { code: 'preload-failed' } },
        { id: null, error: { code: 'preload-failed', path: '/secret/path' } },
        { id: null, error: { code: 'preload-failed' }, unexpected: 1 },
    ])('rejects malformed or unknown startup errors %#', async (message) => {
        const code = `${SEND} send(${JSON.stringify(message)}); setInterval(() => {}, 1000);`;
        const error = await startLocalQqSignWorker(options(code)).then(
            () => undefined,
            (reason) => reason as LocalQqSignWorkerError,
        );
        expect(error).toMatchObject({ code: 'protocol', workerCode: undefined });
        expect(closed.has(children[0])).toBe(true);
    });

    it('bounds startup and reports missing executables without leaking paths', async () => {
        await expect(
            startLocalQqSignWorker(options('setInterval(()=>{},1000);', { startupTimeoutMs: 150 })),
        ).rejects.toMatchObject({ code: 'startup-timeout' });
        const sentinel = path.resolve('sensitive-missing-executable-793acb');
        const error = await startLocalQqSignWorker(options('', { executable: sentinel })).then(
            () => undefined,
            (reason) => reason as Error,
        );
        expect(error).toMatchObject({ code: 'spawn' });
        expect(String(error)).not.toContain(sentinel);
        expect(error).not.toHaveProperty('cause');
        expect(children.every((child) => closed.has(child))).toBe(true);
    });

    it('drains stderr without retaining it and handles stdout end and child exit', async () => {
        const handle = await open(
            script(`
            process.stderr.write('sensitive-native-diagnostic'.repeat(100000), () => process.exit(7));
        `),
        );
        const outcome = await handle.sign(request()).then(
            () => undefined,
            (error) => error as Error,
        );
        expect(outcome).toBeInstanceOf(LocalQqSignWorkerError);
        expect(String(outcome)).not.toContain('sensitive-native-diagnostic');
        await handle.whenClosed;
        const exited = await open(script('process.exit(7);'));
        await expect(exited.sign(request())).rejects.toBeInstanceOf(LocalQqSignWorkerError);
        await exited.whenClosed;
        expect(children.every((child) => closed.has(child))).toBe(true);
    });

    it('accepts an exact 4096-byte line but rejects unsolicited output while idle', async () => {
        const handle = await open(
            script(`
            const reply = JSON.stringify({id:req.id,result:{sign:'01',token:'',extra:''}});
            process.stdout.write(reply + ' '.repeat(4096 - Buffer.byteLength(reply)) + '\\n');
            setTimeout(() => send({id:req.id,result:{sign:'01',token:'',extra:''}}), 50);
        `),
        );
        expect((await handle.sign(request())).sign).toEqual(Buffer.from('01', 'hex'));
        expect((await handle.whenClosed).reason).toBe('protocol');
        expect(closed.has(children[0])).toBe(true);
    });

    it('settles active and queued requests when the real stdin pipe errors', async () => {
        const code = `${SEND}
            send(${JSON.stringify(READY)});
            setInterval(() => {}, 1000);
        `;
        const handle = await open(code);
        const outcomesPromise = Promise.allSettled([
            handle.sign(request({ body: new Uint8Array(1024 * 1024) })),
            handle.sign(request()),
        ]);
        children[0].stdin!.destroy(new Error('sensitive-write-failure'));
        const outcomes = await outcomesPromise;
        expect(outcomes.every((result) => result.status === 'rejected')).toBe(true);
        expect(
            outcomes
                .map((result) => (result.status === 'rejected' ? String(result.reason) : ''))
                .join(),
        ).not.toContain('sensitive-write-failure');
        expect((await handle.whenClosed).reason).toBe('stream');
        expect(closed.has(children[0])).toBe(true);
    });

    it('close settles all work, is idempotent, waits for close and releases its listeners', async () => {
        const handle = await open(script('/* keep the request pending */'));
        const promises = [handle.sign(request()), handle.sign(request())];
        const outcomes = Promise.allSettled(promises);
        await Promise.all([handle.close(), handle.close()]);
        expect(await outcomes).toEqual([
            expect.objectContaining({
                status: 'rejected',
                reason: expect.objectContaining({ code: 'closed' }),
            }),
            expect.objectContaining({
                status: 'rejected',
                reason: expect.objectContaining({ code: 'closed' }),
            }),
        ]);
        expect(closed.has(children[0])).toBe(true);
        expect(() => handle.bindUin('123')).toThrowError(
            expect.objectContaining({ code: 'closed' }),
        );
        await expect(handle.sign(request())).rejects.toMatchObject({ code: 'closed' });
        expect(children[0].listenerCount('error')).toBe(0);
        expect(children[0].listenerCount('exit')).toBe(0);
        expect(children[0].stdout!.listenerCount('data')).toBe(0);
        expect(children[0].stderr!.listenerCount('data')).toBe(0);
        expect(children[0].stdin!.listenerCount('drain')).toBe(0);
    });
});
