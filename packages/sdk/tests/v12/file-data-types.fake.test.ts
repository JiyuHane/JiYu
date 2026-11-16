import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12GetFileDataParams,
    OneBot12GetFileDataResponse,
    OneBot12GetFileDataResult,
    OneBot12GetFileUrlParams,
    OneBot12HttpClient,
    OneBot12JsonObject,
    OneBot12JsonValue,
    OneBot12UploadFileDataParams,
    OneBot12UploadFileDataResponse,
    OneBot12UploadFileDataResult,
    OneBot12WebSocketClient,
} from '../../src/v12/index.js';
import {
    parseOneBot12ActionRequestJson,
    parseOneBot12ActionResponseJson,
    serializeOneBot12ActionRequest,
    serializeOneBot12ActionResponse,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type UploadParams = { type: 'data'; name: string; data: string };
type UploadResult = { file_id: string };
type GetParams = { file_id: string; type: 'data' };
type GetResult = { name: string; data: string };
type UploadOk = Extract<OneBot12UploadFileDataResponse, { status: 'ok' }>;
type UploadFailed = Extract<OneBot12UploadFileDataResponse, { status: 'failed' }>;
type GetOk = Extract<OneBot12GetFileDataResponse, { status: 'ok' }>;
type GetFailed = Extract<OneBot12GetFileDataResponse, { status: 'failed' }>;
type Envelope = { retcode: number; message: string };
type HttpRequestResponse = Awaited<ReturnType<OneBot12HttpClient['request']>>;
type HttpCallResponse = Awaited<ReturnType<OneBot12HttpClient['call']>>;
type WsRequestResponse = Awaited<ReturnType<OneBot12WebSocketClient['request']>>;
type WsCallResponse = Awaited<ReturnType<OneBot12WebSocketClient['call']>>;

export type Checks = [
    Assert<IsAssignable<UploadParams, OneBot12UploadFileDataParams>>,
    Assert<IsAssignable<OneBot12UploadFileDataParams, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12UploadFileDataParams['type'], 'data'>>,
    Assert<IsAssignable<'data', OneBot12UploadFileDataParams['type']>>,
    IsFalse<IsAssignable<Omit<UploadParams, 'type'>, OneBot12UploadFileDataParams>>,
    IsFalse<IsAssignable<Omit<UploadParams, 'name'>, OneBot12UploadFileDataParams>>,
    IsFalse<IsAssignable<Omit<UploadParams, 'data'>, OneBot12UploadFileDataParams>>,
    IsFalse<
        IsAssignable<{ type: 'url'; name: string; data: string }, OneBot12UploadFileDataParams>
    >,
    IsFalse<
        IsAssignable<{ type: string; name: string; data: string }, OneBot12UploadFileDataParams>
    >,
    IsFalse<
        IsAssignable<{ type: 'data'; name: number; data: string }, OneBot12UploadFileDataParams>
    >,
    IsFalse<
        IsAssignable<{ type: 'data'; name: string; data: number }, OneBot12UploadFileDataParams>
    >,
    IsFalse<
        IsAssignable<{ type: 'data'; name: string; data: Uint8Array }, OneBot12UploadFileDataParams>
    >,
    Assert<IsAssignable<undefined, OneBot12UploadFileDataParams['sha256']>>,
    Assert<IsAssignable<string, NonNullable<OneBot12UploadFileDataParams['sha256']>>>,
    IsFalse<IsAssignable<UploadParams & { sha256: number }, OneBot12UploadFileDataParams>>,
    Assert<
        IsAssignable<
            UploadParams & { 'x.extra': { nested: string[] } },
            OneBot12UploadFileDataParams
        >
    >,
    IsFalse<IsAssignable<UploadParams & { 'x.invalid': () => void }, OneBot12UploadFileDataParams>>,
    Assert<IsAssignable<UploadResult, OneBot12UploadFileDataResult>>,
    Assert<IsAssignable<OneBot12UploadFileDataResult, OneBot12JsonObject>>,
    IsFalse<IsAssignable<{}, OneBot12UploadFileDataResult>>,
    IsFalse<IsAssignable<{ file_id: number }, OneBot12UploadFileDataResult>>,
    Assert<IsAssignable<UploadResult & { 'x.extra': boolean }, OneBot12UploadFileDataResult>>,
    IsFalse<IsAssignable<UploadResult & { 'x.invalid': () => void }, OneBot12UploadFileDataResult>>,
    Assert<IsAssignable<GetParams, OneBot12GetFileDataParams>>,
    Assert<IsAssignable<OneBot12GetFileDataParams, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12GetFileDataParams['type'], 'data'>>,
    Assert<IsAssignable<'data', OneBot12GetFileDataParams['type']>>,
    IsFalse<IsAssignable<{ type: 'data' }, OneBot12GetFileDataParams>>,
    IsFalse<IsAssignable<{ file_id: string }, OneBot12GetFileDataParams>>,
    IsFalse<IsAssignable<{ file_id: number; type: 'data' }, OneBot12GetFileDataParams>>,
    IsFalse<IsAssignable<{ file_id: string; type: string }, OneBot12GetFileDataParams>>,
    IsFalse<IsAssignable<{ file_id: string; type: 'url' }, OneBot12GetFileDataParams>>,
    IsFalse<IsAssignable<GetParams, OneBot12GetFileUrlParams>>,
    Assert<IsAssignable<{ file_id: string; type: 'url' }, OneBot12GetFileUrlParams>>,
    Assert<IsAssignable<GetParams & { 'x.extra': null[] }, OneBot12GetFileDataParams>>,
    IsFalse<IsAssignable<GetParams & { 'x.invalid': () => void }, OneBot12GetFileDataParams>>,
    Assert<IsAssignable<GetResult, OneBot12GetFileDataResult>>,
    Assert<IsAssignable<OneBot12GetFileDataResult, OneBot12JsonObject>>,
    IsFalse<IsAssignable<{ data: string }, OneBot12GetFileDataResult>>,
    IsFalse<IsAssignable<{ name: string }, OneBot12GetFileDataResult>>,
    IsFalse<IsAssignable<{ name: number; data: string }, OneBot12GetFileDataResult>>,
    IsFalse<IsAssignable<{ name: string; data: Uint8Array }, OneBot12GetFileDataResult>>,
    Assert<IsAssignable<undefined, OneBot12GetFileDataResult['sha256']>>,
    Assert<IsAssignable<string, NonNullable<OneBot12GetFileDataResult['sha256']>>>,
    IsFalse<IsAssignable<GetResult & { sha256: number }, OneBot12GetFileDataResult>>,
    Assert<
        IsAssignable<GetResult & { 'x.extra': { nested: boolean[] } }, OneBot12GetFileDataResult>
    >,
    IsFalse<IsAssignable<GetResult & { 'x.invalid': () => void }, OneBot12GetFileDataResult>>,
    Assert<IsAssignable<UploadOk['data'], OneBot12UploadFileDataResult>>,
    Assert<IsAssignable<OneBot12UploadFileDataResult, UploadOk['data']>>,
    Assert<IsAssignable<GetOk['data'], OneBot12GetFileDataResult>>,
    Assert<IsAssignable<OneBot12GetFileDataResult, GetOk['data']>>,
    IsFalse<IsAssignable<null, UploadOk['data']>>,
    IsFalse<IsAssignable<null, GetOk['data']>>,
    Assert<IsAssignable<UploadFailed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, UploadFailed['data']>>,
    Assert<IsAssignable<GetFailed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, GetFailed['data']>>,
    Assert<
        IsAssignable<Envelope & { status: 'failed'; data: null }, OneBot12UploadFileDataResponse>
    >,
    Assert<
        IsAssignable<
            Envelope & { status: 'failed'; data: [string, number, null] },
            OneBot12GetFileDataResponse
        >
    >,
    IsFalse<IsAssignable<Envelope & { status: 'ok'; data: null }, OneBot12UploadFileDataResponse>>,
    IsFalse<
        IsAssignable<
            Envelope & { status: 'ok'; data: { name: string } },
            OneBot12GetFileDataResponse
        >
    >,
    IsFalse<IsAssignable<Envelope & { status: 'other'; data: null }, OneBot12GetFileDataResponse>>,
    Assert<IsAssignable<OneBot12UploadFileDataResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12GetFileDataResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<HttpRequestResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, HttpRequestResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, HttpCallResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, WsRequestResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, WsCallResponse>>,
    IsFalse<IsAssignable<HttpRequestResponse, OneBot12UploadFileDataResponse>>,
    IsFalse<IsAssignable<HttpCallResponse, OneBot12GetFileDataResponse>>,
    IsFalse<IsAssignable<WsRequestResponse, OneBot12UploadFileDataResponse>>,
    IsFalse<IsAssignable<WsCallResponse, OneBot12GetFileDataResponse>>,
];

// This example is typechecked but never called; no client connection is opened.
export function ordinaryFileRequests(
    http: OneBot12HttpClient,
    ws: OneBot12WebSocketClient,
    upload: OneBot12UploadFileDataParams,
    get: OneBot12GetFileDataParams,
): Array<Promise<OneBot12ActionResponse>> {
    const self = { platform: 'qq', user_id: '10001' };
    return [
        http.request('upload_file', upload, { self }),
        http.call('get_file', get, { self }),
        ws.request('upload_file', upload, { self }),
        ws.call('get_file', get, { self }),
    ];
}

const uploadParams: OneBot12UploadFileDataParams = {
    type: 'data',
    name: 'fixture.txt',
    data: 'aGVsbG8=',
    'x.extra': { nested: ['value'] },
};
const getParams: OneBot12GetFileDataParams = {
    file_id: 'fixture-file-id',
    type: 'data',
};
const uploadSuccess: OneBot12UploadFileDataResponse = {
    status: 'ok',
    retcode: 0,
    data: { file_id: 'fixture-file-id', 'x.extra': true },
    message: '',
    echo: 'upload-echo',
};
const getSuccess: OneBot12GetFileDataResponse = {
    status: 'ok',
    retcode: 0,
    data: {
        name: 'fixture.txt',
        data: 'aGVsbG8=',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        'x.extra': [true, null],
    },
    message: '',
};
const uploadFailure: OneBot12UploadFileDataResponse = {
    status: 'failed',
    retcode: 10004,
    data: { reason: 'unsupported' },
    message: 'unsupported',
};
const getFailure: OneBot12GetFileDataResponse = {
    status: 'failed',
    retcode: 20002,
    data: null,
    message: 'unavailable',
};

describe('OneBot 12 file data types and generic JSON codec', () => {
    it('typechecks valid and invalid data subset shapes and generic clients', () => {
        // The SDK tsconfig includes only src; explicitly check this test fixture too.
        const testFile = fileURLToPath(import.meta.url);
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
        const program = ts.createProgram([testFile], {
            ...parsed.options,
            rootDir: undefined,
            noEmit: true,
        });
        const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
        const host: ts.FormatDiagnosticsHost = {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: ts.sys.getCurrentDirectory,
            getNewLine: () => ts.sys.newLine,
        };
        expect(ts.formatDiagnostics(diagnostics, host)).toBe('');
    }, 30_000);

    it('round trips JSON data requests and success or failure envelopes', () => {
        for (const request of [
            { action: 'upload_file', params: uploadParams },
            { action: 'get_file', params: getParams },
        ]) {
            expect(parseOneBot12ActionRequestJson(serializeOneBot12ActionRequest(request))).toEqual(
                request,
            );
        }

        for (const response of [uploadSuccess, getSuccess, uploadFailure, getFailure]) {
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });

    it('does not validate file parameters, Base64 or hashes in the generic codec', () => {
        for (const params of [
            { type: 'data', name: 'fixture', data: 'not base64!' },
            { type: 'data', name: 'fixture', data: 'Zg' },
            { type: 'data', name: 'fixture', data: 'AB==' },
            { type: 'data', name: 'fixture', data: 'Zg==', sha256: 'not-a-hash' },
            { type: 'data', name: 42, data: [1, 2] },
            { type: 'data', name: 'fixture' },
        ]) {
            const request = { action: 'upload_file', params };
            expect(parseOneBot12ActionRequestJson(serializeOneBot12ActionRequest(request))).toEqual(
                request,
            );
        }

        for (const data of [
            { name: 'fixture', data: 'not base64!' },
            { name: 'fixture', data: 'Zg' },
            { name: 'fixture', data: 'AB==' },
            { name: 'fixture', data: 'Zg==', sha256: false },
            { name: 'fixture', data: [1, 2] },
            { name: 'fixture' },
            null,
        ]) {
            const response = { status: 'ok', retcode: 0, data, message: '' };
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });
});
