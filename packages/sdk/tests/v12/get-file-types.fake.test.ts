import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12GetFileUrlData,
    OneBot12GetFileUrlParams,
    OneBot12GetFileUrlResponse,
    OneBot12HttpClient,
    OneBot12JsonObject,
    OneBot12JsonValue,
} from '../../src/v12/index.js';
import {
    parseOneBot12ActionResponseJson,
    serializeOneBot12ActionResponse,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Params = { file_id: string; type: 'url' };
type Data = { name: string; url: string };
type Ok = Extract<OneBot12GetFileUrlResponse, { status: 'ok' }>;
type Failed = Extract<OneBot12GetFileUrlResponse, { status: 'failed' }>;
type Envelope = { retcode: number; message: string };
type ClientResponse = Awaited<ReturnType<OneBot12HttpClient['request']>>;

export type Checks = [
    Assert<IsAssignable<Params, OneBot12GetFileUrlParams>>,
    Assert<IsAssignable<OneBot12GetFileUrlParams, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12GetFileUrlParams['type'], 'url'>>,
    Assert<IsAssignable<'url', OneBot12GetFileUrlParams['type']>>,
    IsFalse<IsAssignable<{ type: 'url' }, OneBot12GetFileUrlParams>>,
    IsFalse<IsAssignable<{ file_id: string }, OneBot12GetFileUrlParams>>,
    IsFalse<IsAssignable<{ file_id: number; type: 'url' }, OneBot12GetFileUrlParams>>,
    IsFalse<IsAssignable<{ file_id: string; type: string }, OneBot12GetFileUrlParams>>,
    IsFalse<IsAssignable<{ file_id: string; type: 'bytes' }, OneBot12GetFileUrlParams>>,
    IsFalse<IsAssignable<{ file_id: string; type: 'path' }, OneBot12GetFileUrlParams>>,
    Assert<IsAssignable<Params & { 'x.params': { nested: string[] } }, OneBot12GetFileUrlParams>>,
    IsFalse<IsAssignable<Params & { 'x.invalid': () => void }, OneBot12GetFileUrlParams>>,
    Assert<IsAssignable<Data, OneBot12GetFileUrlData>>,
    Assert<IsAssignable<OneBot12GetFileUrlData, OneBot12JsonObject>>,
    IsFalse<IsAssignable<{ url: string }, OneBot12GetFileUrlData>>,
    IsFalse<IsAssignable<{ name: string }, OneBot12GetFileUrlData>>,
    IsFalse<IsAssignable<{ name: number; url: string }, OneBot12GetFileUrlData>>,
    IsFalse<IsAssignable<{ name: string; url: number }, OneBot12GetFileUrlData>>,
    Assert<IsAssignable<undefined, OneBot12GetFileUrlData['headers']>>,
    Assert<IsAssignable<undefined, OneBot12GetFileUrlData['sha256']>>,
    Assert<IsAssignable<NonNullable<OneBot12GetFileUrlData['headers']>, Record<string, string>>>,
    Assert<IsAssignable<Record<string, string>, NonNullable<OneBot12GetFileUrlData['headers']>>>,
    Assert<IsAssignable<NonNullable<OneBot12GetFileUrlData['sha256']>, string>>,
    Assert<IsAssignable<string, NonNullable<OneBot12GetFileUrlData['sha256']>>>,
    Assert<
        IsAssignable<
            Data & { headers: Record<string, string>; sha256: string },
            OneBot12GetFileUrlData
        >
    >,
    IsFalse<IsAssignable<Data & { headers: Record<string, number> }, OneBot12GetFileUrlData>>,
    IsFalse<IsAssignable<Data & { headers: string }, OneBot12GetFileUrlData>>,
    IsFalse<IsAssignable<Data & { sha256: number }, OneBot12GetFileUrlData>>,
    Assert<IsAssignable<Data & { 'x.file': { nested: string[] } }, OneBot12GetFileUrlData>>,
    IsFalse<IsAssignable<Data & { 'x.invalid': () => void }, OneBot12GetFileUrlData>>,
    Assert<IsAssignable<Ok['data'], OneBot12GetFileUrlData>>,
    Assert<IsAssignable<OneBot12GetFileUrlData, Ok['data']>>,
    IsFalse<IsAssignable<null, Ok['data']>>,
    Assert<IsAssignable<Failed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, Failed['data']>>,
    Assert<IsAssignable<Envelope & { status: 'failed'; data: null }, OneBot12GetFileUrlResponse>>,
    Assert<
        IsAssignable<
            Envelope & { status: 'failed'; data: [string, number, null] },
            OneBot12GetFileUrlResponse
        >
    >,
    Assert<
        IsAssignable<
            Envelope & {
                status: 'ok';
                data: Data & { 'x.file': { nested: string[] } };
                'x.envelope': boolean;
            },
            OneBot12GetFileUrlResponse
        >
    >,
    IsFalse<IsAssignable<Envelope & { status: 'ok'; data: null }, OneBot12GetFileUrlResponse>>,
    IsFalse<
        IsAssignable<
            Envelope & { status: 'ok'; data: { name: string } },
            OneBot12GetFileUrlResponse
        >
    >,
    IsFalse<IsAssignable<Envelope & { status: 'other'; data: null }, OneBot12GetFileUrlResponse>>,
    Assert<IsAssignable<OneBot12GetFileUrlResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<ClientResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, ClientResponse>>,
    IsFalse<IsAssignable<ClientResponse, OneBot12GetFileUrlResponse>>,
];

const success: OneBot12GetFileUrlResponse = {
    status: 'ok',
    retcode: 0,
    data: { name: 'image.png', url: 'https://example.invalid/image.png' },
    message: '',
};
const extendedSuccess: OneBot12GetFileUrlResponse = {
    status: 'ok',
    retcode: 0,
    data: {
        name: 'voice.wav',
        url: 'https://example.invalid/voice.wav',
        headers: { 'X-Fixture': 'value' },
        sha256: '0'.repeat(64),
        'x.file': { nested: [true, null, 'value'] },
    },
    message: '',
    echo: 'test-echo',
    'x.envelope': { retained: true },
};
const failure: OneBot12GetFileUrlResponse = {
    status: 'failed',
    retcode: 20002,
    data: { reason: 'unavailable', retry: false },
    message: 'unavailable',
};
const nullFailure: OneBot12GetFileUrlResponse = {
    status: 'failed',
    retcode: 10003,
    data: null,
    message: 'invalid parameters',
};

describe('OneBot 12 get_file URL types and generic response codec', () => {
    it('typechecks the valid and invalid URL subset shapes', () => {
        // The SDK's normal tsconfig includes src only, so check this fixture explicitly.
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

    it('round trips success and failure envelopes with JSON extensions', () => {
        for (const response of [success, extendedSuccess, failure, nullFailure]) {
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });

    it('does not validate get_file fields or URL syntax in the generic codec', () => {
        for (const data of [
            { name: 'image', url: 42 },
            { name: 42, url: 'https://example.invalid/image' },
            { name: 'image' },
            { name: 'image', url: 'not a URL' },
            { name: 'image', url: 'not a URL', headers: { 'X-Fixture': 42 }, sha256: false },
            null,
        ]) {
            const response = { status: 'ok', retcode: 0, data, message: '' };
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });
});
