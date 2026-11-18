import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Virtual consumer source is compiled, never executed. It does not create a
// client, connection, listener or socket. Package paths resolve to public source
// entry points; published declarations need a separate packaging check.
const consumerSource = `
import {
    finishOneBot12FragmentedUpload,
    prepareOneBot12FileFragment,
    prepareOneBot12FragmentedUpload,
    transferOneBot12FileFragment,
    transferOneBot12FragmentedUpload,
} from '@harehane/sdk/v12';
import type {
    OneBot12ActionResponse,
    OneBot12GetFileFragmentedPrepareParams,
    OneBot12GetFileFragmentedPrepareResponse,
    OneBot12GetFileFragmentedPrepareResult,
    OneBot12GetFileFragmentedTransferParams,
    OneBot12GetFileFragmentedTransferResponse,
    OneBot12GetFileFragmentedTransferResult,
    OneBot12HttpClient,
    OneBot12HttpRequestOptions,
    OneBot12JsonObject,
    OneBot12JsonValue,
    OneBot12RequestOptions,
    OneBot12UploadFileFragmentedFinishParams,
    OneBot12UploadFileFragmentedFinishResponse,
    OneBot12UploadFileFragmentedPrepareParams,
    OneBot12UploadFileFragmentedPrepareResponse,
    OneBot12UploadFileFragmentedTransferParams,
    OneBot12UploadFileFragmentedTransferResponse,
    OneBot12WebSocketClient,
} from '@harehane/sdk/v12';
import type { OneBot12ReverseWebSocketSession } from '@harehane/sdk/v12/node';

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Equal<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;

type SyntheticRequester = {
    readonly marker: 'synthetic';
    request(
        this: SyntheticRequester,
        action: string,
        params?: OneBot12JsonObject,
        options?: OneBot12RequestOptions & { fixture?: 'in-memory' },
    ): Promise<OneBot12ActionResponse>;
};

declare const http: OneBot12HttpClient;
declare const ws: OneBot12WebSocketClient;
declare const reverse: OneBot12ReverseWebSocketSession;
declare const synthetic: SyntheticRequester;
declare const signal: AbortSignal;

const prepare: OneBot12GetFileFragmentedPrepareParams = {
    stage: 'prepare',
    file_id: 'opaque-id',
    'vendor.options': { nested: [1, true, null] },
};
const transfer: OneBot12GetFileFragmentedTransferParams = {
    stage: 'transfer',
    file_id: 'opaque-id',
    offset: 0,
    size: 0,
    'vendor.options': { nested: ['fixture'] },
};
const httpOptions: OneBot12HttpRequestOptions = {
    self: { platform: 'example', user_id: 'account', 'vendor.self': true },
    echo: 'synthetic-echo',
    timeoutMs: 0,
    signal,
};
const baseOptions: OneBot12RequestOptions = {
    self: { platform: 'example', user_id: 'account' },
    timeoutMs: 5000,
    signal,
};

// No code below executes: calls exist solely to check the public type contracts.
async function publicConsumer() {
    const prepareHttp = prepareOneBot12FileFragment(http, prepare, httpOptions);
    const transferHttp = transferOneBot12FileFragment(http, transfer, {
        echo: '',
        self: { platform: 'qq', user_id: '10001' },
        timeoutMs: 1,
        signal,
    });
    const prepareWs = prepareOneBot12FileFragment(ws, prepare, baseOptions);
    const transferWs = transferOneBot12FileFragment(ws, transfer, {
        self: { platform: 'qq', user_id: '10001' },
        timeoutMs: 1,
        signal,
    });
    const prepareReverse = prepareOneBot12FileFragment(reverse, prepare, baseOptions);
    const transferReverse = transferOneBot12FileFragment(reverse, transfer, baseOptions);
    const prepareSynthetic = prepareOneBot12FileFragment(synthetic, prepare, baseOptions);
    const transferSynthetic = transferOneBot12FileFragment(synthetic, transfer);

    type ReturnChecks = [
        Assert<Equal<Awaited<typeof prepareHttp>, OneBot12GetFileFragmentedPrepareResponse>>,
        Assert<Equal<Awaited<typeof prepareWs>, OneBot12GetFileFragmentedPrepareResponse>>,
        Assert<Equal<Awaited<typeof prepareReverse>, OneBot12GetFileFragmentedPrepareResponse>>,
        Assert<Equal<Awaited<typeof prepareSynthetic>, OneBot12GetFileFragmentedPrepareResponse>>,
        Assert<Equal<Awaited<typeof transferHttp>, OneBot12GetFileFragmentedTransferResponse>>,
        Assert<Equal<Awaited<typeof transferWs>, OneBot12GetFileFragmentedTransferResponse>>,
        Assert<Equal<Awaited<typeof transferReverse>, OneBot12GetFileFragmentedTransferResponse>>,
        Assert<Equal<Awaited<typeof transferSynthetic>, OneBot12GetFileFragmentedTransferResponse>>
    ];
    const checkReturns: ReturnChecks = [true, true, true, true, true, true, true, true];
    void checkReturns;

    const p = await prepareHttp;
    if (p.status === 'ok') {
        const data: OneBot12GetFileFragmentedPrepareResult = p.data;
        const name: string = data.name;
        const total: number = data.total_size;
        const digest: string = data.sha256;
        const extension: OneBot12JsonValue | undefined = data['vendor.output'];
        void [name, total, digest, extension];
    } else {
        const data: OneBot12JsonValue = p.data;
        void data;
    }

    const t = await transferHttp;
    if (t.status === 'ok') {
        const data: OneBot12GetFileFragmentedTransferResult = t.data;
        const encoded: string = data.data;
        const extension: OneBot12JsonValue | undefined = data['vendor.output'];
        void [encoded, extension];
    } else {
        const data: OneBot12JsonValue = t.data;
        void data;
    }

    // TypeScript number itself does not express integer/range validation.
    for (const offset of [0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
        const params: OneBot12GetFileFragmentedTransferParams = {
            stage: 'transfer', file_id: 'opaque-id', offset, size: -1,
            'vendor.range': { reason: 'fixture' },
        };
        void transferOneBot12FileFragment(http, params);
    }

    // Generic requests stay generic and must not imply stage-specific data.
    const genericPrepare = http.request('get_file_fragmented', prepare);
    const genericTransfer = ws.call('get_file_fragmented', transfer);
    type GenericPrepare = Awaited<typeof genericPrepare>;
    type GenericTransfer = Awaited<typeof genericTransfer>;
    type GenericChecks = [
        Assert<Equal<GenericPrepare, OneBot12ActionResponse>>,
        Assert<Equal<GenericTransfer, OneBot12ActionResponse>>,
        AssertFalse<Assignable<GenericPrepare, OneBot12GetFileFragmentedPrepareResponse>>,
        AssertFalse<Assignable<GenericTransfer, OneBot12GetFileFragmentedTransferResponse>>
    ];
    const checkGeneric: GenericChecks = [true, true, false, false];
    void checkGeneric;

    // WebSocket transports generate their own echo; object literals should not
    // present HTTP's echo as a supported option on these concrete instances.
    // @ts-expect-error forward WebSocket options do not accept echo
    void prepareOneBot12FileFragment(ws, prepare, { echo: 'not-an-http-option' });
    // @ts-expect-error reverse WebSocket options do not accept echo
    void transferOneBot12FileFragment(reverse, transfer, { echo: 'not-an-http-option' });
    // @ts-expect-error prepare requires the full prepare-stage parameters
    void prepareOneBot12FileFragment(http, { file_id: 'opaque-id' });
    // @ts-expect-error a transfer-stage request is not a prepare-stage request
    void prepareOneBot12FileFragment(http, transfer);
    // @ts-expect-error transfer requires offset and size
    void transferOneBot12FileFragment(http, { stage: 'transfer', file_id: 'opaque-id' });
    // @ts-expect-error byte offset is a number, not a string
    void transferOneBot12FileFragment(http, { stage: 'transfer', file_id: 'id', offset: '0', size: 1 });
    // @ts-expect-error arbitrary functions are not JSON extension values
    void prepareOneBot12FileFragment(http, { stage: 'prepare', file_id: 'id', 'vendor.invalid': () => 1 });
}
void publicConsumer;

async function uploadConsumer() {
    const prepareUpload: OneBot12UploadFileFragmentedPrepareParams = {
        stage: 'prepare',
        name: 'fixture.bin',
        total_size: 0,
        'vendor.options': { nested: [true, null] },
    };
    const transferUpload: OneBot12UploadFileFragmentedTransferParams = {
        stage: 'transfer', file_id: 'draft-id', offset: 0, data: '',
    };
    const finishUpload: OneBot12UploadFileFragmentedFinishParams = {
        stage: 'finish', file_id: 'draft-id', sha256: 'a'.repeat(64),
    };
    const prepared = prepareOneBot12FragmentedUpload(http, prepareUpload, {
        ...httpOptions,
        echo: 'upload-echo',
    });
    const transferred = transferOneBot12FragmentedUpload(ws, transferUpload, baseOptions);
    const finished = finishOneBot12FragmentedUpload(reverse, finishUpload, baseOptions);
    void prepareOneBot12FragmentedUpload(ws, prepareUpload, baseOptions);
    // @ts-expect-error forward WebSocket options do not accept echo
    void prepareOneBot12FragmentedUpload(ws, prepareUpload, { ...baseOptions, echo: 'http-only' });
    void transferOneBot12FragmentedUpload(http, transferUpload, { echo: 'upload-echo' });
    void finishOneBot12FragmentedUpload(http, finishUpload, { echo: 'upload-echo' });
    void prepareOneBot12FragmentedUpload(synthetic, prepareUpload);
    void finishOneBot12FragmentedUpload(synthetic, finishUpload, { fixture: 'in-memory' });

    type ReturnChecks = [
        Assert<Equal<Awaited<typeof prepared>, OneBot12UploadFileFragmentedPrepareResponse>>,
        Assert<Equal<Awaited<typeof transferred>, OneBot12UploadFileFragmentedTransferResponse>>,
        Assert<Equal<Awaited<typeof finished>, OneBot12UploadFileFragmentedFinishResponse>>
    ];
    const checkReturns: ReturnChecks = [true, true, true];
    void checkReturns;

    const p = await prepared;
    const t = await transferred;
    const f = await finished;
    if (p.status === 'ok' && t.status === 'ok' && f.status === 'ok') {
        void (p.data.file_id satisfies string);
        void (t.data satisfies null);
        void (f.data.file_id satisfies string);
    }

    // @ts-expect-error forward WebSocket options do not accept echo
    void transferOneBot12FragmentedUpload(ws, transferUpload, { ...baseOptions, echo: 'http-only' });
    // @ts-expect-error reverse WebSocket options do not accept echo
    void finishOneBot12FragmentedUpload(reverse, finishUpload, { ...baseOptions, echo: 'http-only' });
    // @ts-expect-error stages are not interchangeable
    void prepareOneBot12FragmentedUpload(http, transferUpload);
    // @ts-expect-error transfer requires a data string
    void transferOneBot12FragmentedUpload(http, { stage: 'transfer', file_id: 'draft-id', offset: 0 });
    // @ts-expect-error finish requires a digest
    void finishOneBot12FragmentedUpload(http, { stage: 'finish', file_id: 'draft-id' });
}
void uploadConsumer;
`;

function typecheckPublicConsumer(): void {
    const virtualFile = fileURLToPath(
        new URL('./__virtual_file_fragmented_helper_consumer__.mts', import.meta.url),
    );
    const publicIndex = fileURLToPath(new URL('../../src/v12/index.ts', import.meta.url));
    const nodeIndex = fileURLToPath(new URL('../../src/v12/node/index.ts', import.meta.url));
    const configFile = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
    const config = ts.readConfigFile(configFile, ts.sys.readFile);

    if (config.error) {
        throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }

    const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(configFile),
        undefined,
        configFile,
    );
    const options: ts.CompilerOptions = {
        ...parsed.options,
        rootDir: undefined,
        noEmit: true,
        paths: {
            ...parsed.options.paths,
            '@harehane/sdk/v12': [publicIndex],
            '@harehane/sdk/v12/node': [nodeIndex],
        },
    };
    const host = ts.createCompilerHost(options);
    const originalRead = host.readFile.bind(host);
    const originalExists = host.fileExists.bind(host);
    const originalSource = host.getSourceFile.bind(host);
    const normal = (path: string) => path.replace(/\\/g, '/').toLowerCase();
    const isVirtual = (path: string) => normal(path) === normal(virtualFile);
    host.fileExists = (path) => isVirtual(path) || originalExists(path);
    host.readFile = (path) => (isVirtual(path) ? consumerSource : originalRead(path));
    host.getSourceFile = (path, version, onError, shouldCreateNewSourceFile) =>
        isVirtual(path)
            ? ts.createSourceFile(path, consumerSource, version, true, ts.ScriptKind.TS)
            : originalSource(path, version, onError, shouldCreateNewSourceFile);

    host.writeFile = () => {
        throw new Error('typecheck must not emit files');
    };

    const program = ts.createProgram([virtualFile], options, host);
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
    const formatHost: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => ts.sys.newLine,
    };
    expect(program.getSourceFile(publicIndex)).toBeDefined();
    expect(program.getSourceFile(nodeIndex)).toBeDefined();
    expect(ts.formatDiagnostics(diagnostics, formatHost)).toBe('');
}

describe('OneBot 12 fragmented file helpers public types', () => {
    it('typechecks concrete transports and a structural requester without emitting files', () => {
        typecheckPublicConsumer();
    }, 30_000);
});
