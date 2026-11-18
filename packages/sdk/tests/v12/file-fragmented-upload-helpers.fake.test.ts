import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12HttpRequestOptions,
    OneBot12JsonObject,
    OneBot12JsonValue,
    OneBot12UploadFileFragmentedFinishParams,
    OneBot12UploadFileFragmentedPrepareParams,
    OneBot12UploadFileFragmentedTransferParams,
} from '../../src/v12/index.js';

// As in the download helper fixtures, load the public entry with I/O sentinels
// in place. The only requester exercised below is a plain in-memory object.
const forbidden = vi.hoisted(() =>
    vi.fn(function unexpectedEffect(): never {
        throw new Error('unexpected external effect in fragmented upload helper fixture');
    }),
);
vi.mock('ws', () => ({ default: forbidden, WebSocket: forbidden, WebSocketServer: forbidden }));

let sdk: typeof import('../../src/v12/index.js');

beforeEach(async () => {
    forbidden.mockClear();
    vi.stubGlobal('fetch', forbidden);
    vi.stubGlobal('WebSocket', forbidden);
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(forbidden);
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden);
    vi.spyOn(dgram, 'createSocket').mockImplementation(forbidden);
    vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden);
    vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden);
    vi.spyOn(childProcess, 'exec').mockImplementation(forbidden);
    vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden);
    vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden);
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden);
    vi.spyOn(childProcess, 'fork').mockImplementation(forbidden);
    vi.spyOn(process, 'dlopen').mockImplementation(forbidden);
    sdk = await import('../../src/v12/index.js');
});

afterEach(() => {
    const attempts = forbidden.mock.calls.length;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(attempts).toBe(0);
});

const stages = ['prepare', 'transfer', 'finish'] as const;
type Stage = (typeof stages)[number];
const sha256 = '0123456789abcdef'.repeat(4);
const paramsByStage = {
    prepare: { stage: 'prepare', name: '', total_size: 0 },
    transfer: { stage: 'transfer', file_id: ' upload:/临时?opaque#id ', offset: 0, data: '' },
    finish: { stage: 'finish', file_id: ' ', sha256 },
} satisfies {
    prepare: OneBot12UploadFileFragmentedPrepareParams;
    transfer: OneBot12UploadFileFragmentedTransferParams;
    finish: OneBot12UploadFileFragmentedFinishParams;
};

function ok(data: OneBot12JsonValue): OneBot12ActionResponse {
    return { status: 'ok', retcode: 0, data, message: '', echo: 'fixture-echo' };
}

function fakeTransport(respond: () => unknown) {
    return {
        request: vi.fn(
            (
                _action: string,
                _params?: OneBot12JsonObject,
                _options?: OneBot12HttpRequestOptions,
            ) => Promise.resolve(respond()) as Promise<OneBot12ActionResponse>,
        ),
    };
}

function invoke(
    stage: Stage,
    transport: ReturnType<typeof fakeTransport>,
    params: unknown = paramsByStage[stage],
    options?: OneBot12HttpRequestOptions,
): Promise<OneBot12ActionResponse> {
    // Deliberately admit malformed values here to test the runtime boundary.
    switch (stage) {
        case 'prepare':
            return sdk.prepareOneBot12FragmentedUpload(
                transport,
                params as OneBot12UploadFileFragmentedPrepareParams,
                options,
            );
        case 'transfer':
            return sdk.transferOneBot12FragmentedUpload(
                transport,
                params as OneBot12UploadFileFragmentedTransferParams,
                options,
            );
        case 'finish':
            return sdk.finishOneBot12FragmentedUpload(
                transport,
                params as OneBot12UploadFileFragmentedFinishParams,
                options,
            );
    }
}

async function expectClientError(
    pending: Promise<unknown>,
    code: 'invalid_options' | 'invalid_response',
): Promise<void> {
    const message =
        code === 'invalid_options'
            ? 'Invalid upload_file_fragmented parameters'
            : 'Invalid upload_file_fragmented response';
    await expect(pending).rejects.toBeInstanceOf(sdk.OneBot12ClientError);
    await expect(pending).rejects.toMatchObject({ code, message });
}

describe('OneBot 12 fragmented upload helpers with an in-memory requester', () => {
    it('sends each stage once with a snapshot, the original receiver and opaque options', async () => {
        const options: OneBot12HttpRequestOptions = {
            echo: 'request-echo',
            self: { platform: 'fixture', user_id: 'account' },
            signal: AbortSignal.abort(),
            timeoutMs: 0,
        };

        for (const stage of stages) {
            const params = { ...paramsByStage[stage], 'vendor.params': { nested: ['client'] } };
            const data =
                stage === 'transfer' ? null : { file_id: ' ', 'vendor.result': ['server'] };
            const response = { ...ok(data), 'vendor.envelope': { nested: ['envelope'] } };
            const { request } = fakeTransport(() => response);
            const transport = {
                get request() {
                    params['vendor.params'].nested[0] = 'changed during method lookup';
                    return request;
                },
            };
            const pending = invoke(stage, transport, params, options);
            const callsBeforeAwait = request.mock.calls.length;
            const result = await pending;

            expect(callsBeforeAwait).toBe(1);
            expect(request).toHaveBeenCalledTimes(1);
            const [action, snapshot, forwardedOptions] = request.mock.calls[0]!;
            expect(request.mock.contexts[0]).toBe(transport);
            expect(action).toBe('upload_file_fragmented');
            expect(snapshot).not.toBe(params);
            expect(snapshot).toEqual({
                ...paramsByStage[stage],
                'vendor.params': { nested: ['client'] },
            });
            expect(forwardedOptions).toBe(options);
            expect(result).toEqual(response);
            expect(result).not.toBe(response);

            response['vendor.envelope'].nested[0] = 'changed after response';
            expect(result['vendor.envelope']).toEqual({ nested: ['envelope'] });

            if (data !== null) {
                data['vendor.result'][0] = 'changed after response';
                expect(result.data).toEqual({ file_id: ' ', 'vendor.result': ['server'] });
            } else {
                expect(result.data).toBeNull();
            }
        }
    });

    it('accepts safe-integer endpoints without applying host chunk or encoding rules', async () => {
        const cases: [Stage, OneBot12JsonObject, OneBot12JsonValue][] = [
            [
                'prepare',
                { ...paramsByStage.prepare, total_size: Number.MAX_SAFE_INTEGER },
                { file_id: 'id' },
            ],
            ['transfer', { ...paramsByStage.transfer, offset: -0, data: ' not Base64!\n' }, null],
            // Each four-character block encodes three bytes: this is just over 256 KiB.
            [
                'transfer',
                {
                    ...paramsByStage.transfer,
                    offset: Number.MAX_SAFE_INTEGER,
                    data: 'YWFh'.repeat(87_382),
                },
                null,
            ],
        ];

        for (const [stage, params, data] of cases) {
            const fake = fakeTransport(() => ok(data));
            expect((await invoke(stage, fake, params)).status).toBe('ok');
            expect(fake.request.mock.calls).toEqual([
                ['upload_file_fragmented', params, undefined],
            ]);
        }
    });

    it('rejects mismatched stages, bad fields, numbers and digests before dispatch', async () => {
        const { prepare, transfer, finish } = paramsByStage;
        const cases: [Stage, unknown][] = [
            ['prepare', null],
            ['prepare', { ...prepare, stage: 'transfer' }],
            ['prepare', { ...prepare, name: null }],
            ['prepare', { stage: 'prepare', name: 'file' }],
            ['transfer', { ...transfer, stage: 'finish' }],
            ['transfer', { ...transfer, file_id: '' }],
            ['transfer', { ...transfer, file_id: 42 }],
            ['transfer', { ...transfer, data: [] }],
            ['finish', { ...finish, stage: 'prepare' }],
            ['finish', { ...finish, file_id: '' }],
            ['finish', { ...finish, file_id: false }],
            ['finish', { stage: 'finish', file_id: 'id' }],
        ];

        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0']) {
            cases.push(
                ['prepare', { ...prepare, total_size: value }],
                ['transfer', { ...transfer, offset: value }],
            );
        }

        for (const value of [
            42,
            sha256.slice(1),
            `${sha256}0`,
            sha256.toUpperCase(),
            `g${sha256.slice(1)}`,
            `${sha256}\n`,
        ]) {
            cases.push(['finish', { ...finish, sha256: value }]);
        }

        const fake = fakeTransport(() => ok(null));

        for (const [stage, params] of cases) {
            await expectClientError(invoke(stage, fake, params), 'invalid_options');
            expect(fake.request).not.toHaveBeenCalled();
        }
    });

    it('retains valid business failures and propagates transport errors by identity', async () => {
        const failure = {
            ...ok(['not stage-shaped', { detail: 1 }]),
            status: 'failed',
            retcode: -7,
        };
        const original = new sdk.OneBot12ClientError('timeout', 'fixture transport timeout');

        for (const stage of stages) {
            const fake = fakeTransport(() => failure);
            const result = await invoke(stage, fake);
            expect(result).toEqual(failure);
            expect(result.data).not.toBe(failure.data);
            expect(fake.request).toHaveBeenCalledTimes(1);

            for (const respond of [
                () => Promise.reject(original),
                () => {
                    throw original;
                },
            ]) {
                const throwing = fakeTransport(respond);
                await expect(invoke(stage, throwing)).rejects.toBe(original);
                expect(throwing.request).toHaveBeenCalledTimes(1);
            }
        }
    });

    it('rejects malformed envelopes and incorrect successful data after one request', async () => {
        for (const stage of stages) {
            const validData = stage === 'transfer' ? null : { file_id: 'opaque' };
            const envelope = ok(validData);
            const badData: OneBot12JsonValue[] =
                stage === 'transfer'
                    ? [{ file_id: 'opaque' }, false, []]
                    : [null, [], {}, { file_id: '' }, { file_id: 42 }];
            const cases = [
                ...badData.map((data) => ok(data)),
                { ...envelope, retcode: 1 },
                { status: 'failed', retcode: 7, message: '' },
            ];

            for (const response of cases) {
                const fake = fakeTransport(() => response);
                await expectClientError(invoke(stage, fake), 'invalid_response');
                expect(fake.request).toHaveBeenCalledTimes(1);
            }
        }
    });

    it('does not read JSON accessors or Proxy values, and maps throwing metadata traps', async () => {
        const get = vi.fn(() => {
            throw new Error('fixture property read');
        });
        const accessor = Object.defineProperty({}, 'nested', { enumerable: true, get });
        const getPrototypeOf = vi.fn(() => {
            throw new Error('fixture metadata trap');
        });
        const trap = new Proxy({}, { getPrototypeOf });

        for (const extension of [accessor, trap]) {
            const params = { ...paramsByStage.prepare, 'vendor.invalid': extension };
            const fake = fakeTransport(() => ok({ file_id: 'id' }));
            await expectClientError(invoke('prepare', fake, params), 'invalid_options');
            expect(fake.request).not.toHaveBeenCalled();

            const response = fakeTransport(() =>
                ok({ file_id: 'id', 'vendor.invalid': extension }),
            );
            await expectClientError(invoke('finish', response), 'invalid_response');
            expect(response.request).toHaveBeenCalledTimes(1);
        }

        const fake = fakeTransport(() => ok(new Proxy({ file_id: 'id' }, { get })));
        const params = new Proxy(paramsByStage.finish, { get });
        expect(await invoke('finish', fake, params)).toEqual(ok({ file_id: 'id' }));
        expect(fake.request).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalled();
        expect(getPrototypeOf).toHaveBeenCalledTimes(2);
    });
});
