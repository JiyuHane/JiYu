import { downloadOneBot12FragmentedFile } from '@harehane/sdk/v12';
import type {
    OneBot12ActionResponse,
    OneBot12FragmentedDownloadOptions,
    OneBot12FragmentedDownloadResult,
    OneBot12GetFileFragmentedPrepareParams,
    OneBot12GetFileFragmentedPrepareResponse,
    OneBot12GetFileFragmentedPrepareResult,
    OneBot12GetFileFragmentedTransferParams,
    OneBot12GetFileFragmentedTransferResponse,
    OneBot12GetFileFragmentedTransferResult,
    OneBot12HttpClient,
    OneBot12JsonObject,
    OneBot12JsonValue,
    OneBot12WebSocketClient,
} from '@harehane/sdk/v12';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type PrepareParams = { stage: 'prepare'; file_id: string };
type TransferParams = { stage: 'transfer'; file_id: string; offset: number; size: number };
type PrepareResult = { name: string; total_size: number; sha256: string };
type TransferResult = { data: string };
type PrepareOk = Extract<OneBot12GetFileFragmentedPrepareResponse, { status: 'ok' }>;
type PrepareFailed = Extract<OneBot12GetFileFragmentedPrepareResponse, { status: 'failed' }>;
type TransferOk = Extract<OneBot12GetFileFragmentedTransferResponse, { status: 'ok' }>;
type TransferFailed = Extract<OneBot12GetFileFragmentedTransferResponse, { status: 'failed' }>;
type HttpCall = Awaited<ReturnType<OneBot12HttpClient['call']>>;
type WsCall = Awaited<ReturnType<OneBot12WebSocketClient['call']>>;
type Envelope = { retcode: number; message: string };

export type FragmentedChecks = [
    Assert<IsAssignable<PrepareParams, OneBot12GetFileFragmentedPrepareParams>>,
    Assert<IsAssignable<TransferParams, OneBot12GetFileFragmentedTransferParams>>,
    // A number annotation does not enforce safe-integer values; this makes no request.
    Assert<
        IsAssignable<
            { stage: 'transfer'; file_id: string; offset: 1.5; size: 9007199254740992 },
            OneBot12GetFileFragmentedTransferParams
        >
    >,
    Assert<IsAssignable<OneBot12GetFileFragmentedPrepareParams, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12GetFileFragmentedTransferParams, OneBot12JsonObject>>,
    IsFalse<IsAssignable<Omit<PrepareParams, 'stage'>, OneBot12GetFileFragmentedPrepareParams>>,
    IsFalse<IsAssignable<Omit<PrepareParams, 'file_id'>, OneBot12GetFileFragmentedPrepareParams>>,
    IsFalse<IsAssignable<{ stage: 'transfer'; file_id: string }, OneBot12GetFileFragmentedPrepareParams>>,
    IsFalse<IsAssignable<{ stage: 'prepare'; file_id: number }, OneBot12GetFileFragmentedPrepareParams>>,
    IsFalse<IsAssignable<Omit<TransferParams, 'stage'>, OneBot12GetFileFragmentedTransferParams>>,
    IsFalse<IsAssignable<Omit<TransferParams, 'file_id'>, OneBot12GetFileFragmentedTransferParams>>,
    IsFalse<IsAssignable<Omit<TransferParams, 'offset'>, OneBot12GetFileFragmentedTransferParams>>,
    IsFalse<IsAssignable<Omit<TransferParams, 'size'>, OneBot12GetFileFragmentedTransferParams>>,
    IsFalse<IsAssignable<PrepareParams, OneBot12GetFileFragmentedTransferParams>>,
    IsFalse<IsAssignable<TransferParams, OneBot12GetFileFragmentedPrepareParams>>,
    IsFalse<IsAssignable<{ stage: 'transfer'; file_id: string; offset: string; size: number }, OneBot12GetFileFragmentedTransferParams>>,
    IsFalse<IsAssignable<{ stage: 'transfer'; file_id: string; offset: number; size: bigint }, OneBot12GetFileFragmentedTransferParams>>,
    Assert<IsAssignable<PrepareParams & { 'x.extra': { nested: boolean[] } }, OneBot12GetFileFragmentedPrepareParams>>,
    IsFalse<IsAssignable<TransferParams & { 'x.invalid': () => void }, OneBot12GetFileFragmentedTransferParams>>,
    Assert<IsAssignable<PrepareResult, OneBot12GetFileFragmentedPrepareResult>>,
    Assert<IsAssignable<TransferResult, OneBot12GetFileFragmentedTransferResult>>,
    Assert<IsAssignable<OneBot12GetFileFragmentedPrepareResult, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12GetFileFragmentedTransferResult, OneBot12JsonObject>>,
    IsFalse<IsAssignable<Omit<PrepareResult, 'name'>, OneBot12GetFileFragmentedPrepareResult>>,
    IsFalse<IsAssignable<Omit<PrepareResult, 'total_size'>, OneBot12GetFileFragmentedPrepareResult>>,
    IsFalse<IsAssignable<Omit<PrepareResult, 'sha256'>, OneBot12GetFileFragmentedPrepareResult>>,
    IsFalse<IsAssignable<{ name: string; total_size: string; sha256: string }, OneBot12GetFileFragmentedPrepareResult>>,
    IsFalse<IsAssignable<{ name: string; total_size: number; sha256: number }, OneBot12GetFileFragmentedPrepareResult>>,
    IsFalse<IsAssignable<{}, OneBot12GetFileFragmentedTransferResult>>,
    IsFalse<IsAssignable<{ data: Uint8Array }, OneBot12GetFileFragmentedTransferResult>>,
    Assert<IsAssignable<TransferResult & { 'x.extra': null[] }, OneBot12GetFileFragmentedTransferResult>>,
    Assert<IsAssignable<PrepareOk['data'], OneBot12GetFileFragmentedPrepareResult>>,
    Assert<IsAssignable<OneBot12GetFileFragmentedPrepareResult, PrepareOk['data']>>,
    Assert<IsAssignable<TransferOk['data'], OneBot12GetFileFragmentedTransferResult>>,
    Assert<IsAssignable<OneBot12GetFileFragmentedTransferResult, TransferOk['data']>>,
    Assert<IsAssignable<PrepareFailed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, PrepareFailed['data']>>,
    Assert<IsAssignable<TransferFailed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, TransferFailed['data']>>,
    Assert<IsAssignable<Envelope & { status: 'failed'; data: null }, OneBot12GetFileFragmentedPrepareResponse>>,
    Assert<IsAssignable<Envelope & { status: 'failed'; data: [string, number, null] }, OneBot12GetFileFragmentedTransferResponse>>,
    IsFalse<IsAssignable<Envelope & { status: 'ok'; data: null }, OneBot12GetFileFragmentedPrepareResponse>>,
    IsFalse<IsAssignable<Envelope & { status: 'ok'; data: { name: string } }, OneBot12GetFileFragmentedPrepareResponse>>,
    IsFalse<IsAssignable<Envelope & { status: 'ok'; data: null }, OneBot12GetFileFragmentedTransferResponse>>,
    IsFalse<IsAssignable<Envelope & { status: 'other'; data: null }, OneBot12GetFileFragmentedTransferResponse>>,
    Assert<IsAssignable<OneBot12GetFileFragmentedPrepareResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12GetFileFragmentedTransferResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<HttpCall, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, HttpCall>>,
    Assert<IsAssignable<WsCall, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, WsCall>>,
    IsFalse<IsAssignable<HttpCall, OneBot12GetFileFragmentedPrepareResponse>>,
    IsFalse<IsAssignable<WsCall, OneBot12GetFileFragmentedTransferResponse>>,
];

// Typechecking only: this function is never called by the package consumer tests.
export function genericFragmentedCalls(
    http: OneBot12HttpClient,
    ws: OneBot12WebSocketClient,
    prepare: OneBot12GetFileFragmentedPrepareParams,
    transfer: OneBot12GetFileFragmentedTransferParams,
): Array<Promise<OneBot12ActionResponse>> {
    return [
        http.call('get_file_fragmented', prepare),
        http.call('get_file_fragmented', transfer),
        ws.call('get_file_fragmented', prepare),
        ws.call('get_file_fragmented', transfer),
    ];
}

// The helper returns decoded bytes only on verified success; it is not a JSON envelope.
export async function readFragmentedFromPublishedSdk(http: OneBot12HttpClient): Promise<void> {
    const fileId = 'fixture-file-id';
    const options: OneBot12FragmentedDownloadOptions = { maxBytes: 4096, chunkSize: 512 };
    const result: OneBot12FragmentedDownloadResult = await downloadOneBot12FragmentedFile(
        http,
        fileId,
        options,
    );

    if (result.status === 'ok') {
        const bytes: Uint8Array = result.bytes;
        void bytes;
        // @ts-expect-error A successful download is not the transport's JSON envelope.
        void result.retcode;
    } else {
        const stage: 'prepare' | 'transfer' = result.stage;
        const status: 'failed' = result.response.status;
        void [stage, status];
        // @ts-expect-error A failed stage never exposes partially assembled bytes.
        void result.bytes;
    }

    // @ts-expect-error Applications must select an explicit allocation limit.
    void downloadOneBot12FragmentedFile(http, fileId, { chunkSize: 512 });
}

export const prepareParams: OneBot12GetFileFragmentedPrepareParams = {
    stage: 'prepare',
    file_id: 'fixture-file-id',
};
export const transferParams: OneBot12GetFileFragmentedTransferParams = {
    stage: 'transfer',
    file_id: 'fixture-file-id',
    offset: 0,
    size: 1,
};
export const prepareSuccess: OneBot12GetFileFragmentedPrepareResponse = {
    status: 'ok',
    retcode: 0,
    data: { name: 'fixture.bin', total_size: 1, sha256: 'server-reported-hash' },
    message: '',
};
export const transferSuccess: OneBot12GetFileFragmentedTransferResponse = {
    status: 'ok',
    retcode: 0,
    data: { data: 'AA==' },
    message: '',
};
export const transferFailure: OneBot12GetFileFragmentedTransferResponse = {
    status: 'failed',
    retcode: 1,
    data: { detail: ['fixture', null] },
    message: '',
};

export function readSuccessFields(
    prepare: OneBot12GetFileFragmentedPrepareResponse,
    transfer: OneBot12GetFileFragmentedTransferResponse,
): void {
    if (prepare.status === 'ok') {
        const name: string = prepare.data.name;
        const totalSize: number = prepare.data.total_size;
        const digest: string = prepare.data.sha256;
        void [name, totalSize, digest];
    } else {
        const failureData: OneBot12JsonValue = prepare.data;
        void failureData;
    }

    if (transfer.status === 'ok') {
        const encodedBytes: string = transfer.data.data;
        void encodedBytes;
    } else {
        const failureData: OneBot12JsonValue = transfer.data;
        void failureData;
    }
}
