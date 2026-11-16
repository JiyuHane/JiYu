import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12GroupMemberInfo,
    OneBot12GroupMemberInfoResponse,
    OneBot12GroupMemberListResponse,
    OneBot12JsonObject,
    OneBot12JsonValue,
} from '../../src/v12/index.js';
import {
    OneBot12HttpClient,
    parseOneBot12ActionRequestJson,
    parseOneBot12ActionResponseJson,
    serializeOneBot12ActionResponse,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Fields = 'user_id' | 'user_name' | 'user_displayname';
type Shape = { user_id: string; user_name: string; user_displayname: string };
type Missing<K extends Fields> = IsAssignable<Omit<Shape, K>, OneBot12GroupMemberInfo>;
type Numeric<K extends Fields> = IsAssignable<
    Omit<Shape, K> & Record<K, number>,
    OneBot12GroupMemberInfo
>;
type InfoOk = Extract<OneBot12GroupMemberInfoResponse, { status: 'ok' }>;
type InfoFailed = Extract<OneBot12GroupMemberInfoResponse, { status: 'failed' }>;
type ListOk = Extract<OneBot12GroupMemberListResponse, { status: 'ok' }>;
type ListFailed = Extract<OneBot12GroupMemberListResponse, { status: 'failed' }>;
type Envelope = { retcode: number; message: string };
type ClientResponse = Awaited<ReturnType<OneBot12HttpClient['call']>>;

export type Checks = [
    Assert<IsAssignable<OneBot12GroupMemberInfo, OneBot12JsonObject>>,
    Assert<IsAssignable<Shape, OneBot12GroupMemberInfo>>,
    Assert<IsAssignable<OneBot12GroupMemberInfo[Fields], string>>,
    IsFalse<Missing<'user_id'>>,
    IsFalse<Missing<'user_name'>>,
    IsFalse<Missing<'user_displayname'>>,
    IsFalse<Numeric<'user_id'>>,
    IsFalse<Numeric<'user_name'>>,
    IsFalse<Numeric<'user_displayname'>>,
    Assert<IsAssignable<Shape & { 'x.extra': { nested: string[] } }, OneBot12GroupMemberInfo>>,
    IsFalse<IsAssignable<Shape & { 'x.extra': () => void }, OneBot12GroupMemberInfo>>,
    Assert<IsAssignable<InfoOk['data'], OneBot12GroupMemberInfo>>,
    Assert<IsAssignable<OneBot12GroupMemberInfo, InfoOk['data']>>,
    Assert<IsAssignable<ListOk['data'], OneBot12GroupMemberInfo[]>>,
    Assert<IsAssignable<OneBot12GroupMemberInfo[], ListOk['data']>>,
    IsFalse<IsAssignable<null, InfoOk['data']>>,
    IsFalse<IsAssignable<null, ListOk['data']>>,
    IsFalse<IsAssignable<OneBot12GroupMemberInfo[], InfoOk['data']>>,
    IsFalse<IsAssignable<OneBot12GroupMemberInfo, ListOk['data']>>,
    IsFalse<
        IsAssignable<
            Envelope & { status: 'ok'; data: Omit<Shape, 'user_id'> & { user_id: number } },
            OneBot12GroupMemberInfoResponse
        >
    >,
    IsFalse<
        IsAssignable<
            Envelope & { status: 'ok'; data: Array<Omit<Shape, 'user_id'> & { user_id: number }> },
            OneBot12GroupMemberListResponse
        >
    >,
    Assert<
        IsAssignable<
            Envelope & {
                status: 'ok';
                data: Shape & { 'x.extra': { nested: string[] } };
                'x.envelope': boolean;
            },
            OneBot12GroupMemberInfoResponse
        >
    >,
    Assert<
        IsAssignable<
            Envelope & {
                status: 'ok';
                data: Array<Shape & { 'x.extra': { nested: string[] } }>;
                'x.envelope': boolean;
            },
            OneBot12GroupMemberListResponse
        >
    >,
    Assert<IsAssignable<InfoFailed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, InfoFailed['data']>>,
    Assert<IsAssignable<ListFailed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, ListFailed['data']>>,
    Assert<
        IsAssignable<Envelope & { status: 'failed'; data: null }, OneBot12GroupMemberInfoResponse>
    >,
    Assert<
        IsAssignable<Envelope & { status: 'failed'; data: string }, OneBot12GroupMemberListResponse>
    >,
    Assert<IsAssignable<OneBot12GroupMemberInfoResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12GroupMemberListResponse, OneBot12ActionResponse>>,
    IsFalse<
        IsAssignable<Envelope & { status: 'other'; data: null }, OneBot12GroupMemberInfoResponse>
    >,
    IsFalse<
        IsAssignable<Envelope & { status: 'other'; data: null }, OneBot12GroupMemberListResponse>
    >,
    Assert<IsAssignable<ClientResponse, OneBot12ActionResponse>>,
    Assert<IsAssignable<OneBot12ActionResponse, ClientResponse>>,
    IsFalse<IsAssignable<ClientResponse, OneBot12GroupMemberInfoResponse>>,
    IsFalse<IsAssignable<ClientResponse, OneBot12GroupMemberListResponse>>,
];

const member: OneBot12GroupMemberInfo = {
    user_id: 'platform:user-01',
    user_name: 'Example',
    user_displayname: 'Example display',
    'x.extra': { nested: [true, null, 'value'] },
};
const infoSuccess: OneBot12GroupMemberInfoResponse = {
    status: 'ok',
    retcode: 0,
    data: member,
    message: '',
    echo: 'info-success',
    'x.envelope': { retained: true },
};
const listSuccess: OneBot12GroupMemberListResponse = {
    status: 'ok',
    retcode: 0,
    data: [member, { user_id: 'platform:user-02', user_name: '', user_displayname: '' }],
    message: '',
    echo: 'list-success',
    'x.envelope': { retained: true },
};
const infoFailure: OneBot12GroupMemberInfoResponse = {
    status: 'failed',
    retcode: 20002,
    data: null,
    message: 'unavailable',
    echo: 'info-failure',
};
const listFailure: OneBot12GroupMemberListResponse = {
    status: 'failed',
    retcode: 20002,
    data: { reason: 'unavailable', retry: false },
    message: 'unavailable',
    echo: 'list-failure',
};

describe('OneBot 12 group member types and generic response codec', () => {
    it('typechecks the valid and invalid member shapes', () => {
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

    it('round trips single and list success and failure envelopes with extensions', () => {
        for (const response of [infoSuccess, listSuccess, infoFailure, listFailure]) {
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });

    it('does not validate member-specific fields in the generic codec', () => {
        for (const data of [
            { user_id: 42, user_name: 'Example', user_displayname: 'Display' },
            [{ user_id: 42, user_name: 'Example', user_displayname: 'Display' }],
            { user_id: 'missing-names' },
            [{ user_id: 'missing-names' }],
        ]) {
            const response = { status: 'ok', retcode: 0, data, message: '' };
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });

    it('uses generic calls over an in-memory fetch fake and preserves both response variants', async () => {
        const replies = [infoSuccess, listSuccess, infoFailure, listFailure];
        const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
            const reply = replies.shift();

            if (!reply) {
                throw new Error('Unexpected fake fetch');
            }

            return new Response(serializeOneBot12ActionResponse(reply));
        });
        const client = new OneBot12HttpClient({
            baseUrl: 'http://fake.invalid/',
            fetch: fetchImpl,
            requestTimeoutMs: 0,
        });
        const memberParams = { group_id: 'platform:group-01', user_id: 'platform:user-01' };
        const listParams = { group_id: 'platform:group-01' };

        expect(
            await client.call('get_group_member_info', memberParams, { echo: 'info-success' }),
        ).toEqual(infoSuccess);
        expect(
            await client.request('get_group_member_list', listParams, { echo: 'list-success' }),
        ).toEqual(listSuccess);
        expect(
            await client.call('get_group_member_info', memberParams, { echo: 'info-failure' }),
        ).toEqual(infoFailure);
        expect(
            await client.request('get_group_member_list', listParams, { echo: 'list-failure' }),
        ).toEqual(listFailure);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(
            fetchImpl.mock.calls.map(([url, init]) => {
                expect(url).toBe('http://fake.invalid/');
                expect(init?.method).toBe('POST');
                return parseOneBot12ActionRequestJson(String(init?.body));
            }),
        ).toEqual([
            { action: 'get_group_member_info', params: memberParams, echo: 'info-success' },
            { action: 'get_group_member_list', params: listParams, echo: 'list-success' },
            { action: 'get_group_member_info', params: memberParams, echo: 'info-failure' },
            { action: 'get_group_member_list', params: listParams, echo: 'list-failure' },
        ]);
    });

    it('keeps generic client responses unvalidated for member fields', async () => {
        const replies = [
            { status: 'ok', retcode: 0, data: { user_id: 42 }, message: '' },
            { status: 'ok', retcode: 0, data: [{ user_id: 42 }], message: '' },
        ];
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(replies.shift())));
        const client = new OneBot12HttpClient({
            baseUrl: 'http://fake.invalid/',
            fetch: fetchImpl,
            requestTimeoutMs: 0,
        });
        expect(await client.call('get_group_member_info', { group_id: '1', user_id: '2' })).toEqual(
            {
                status: 'ok',
                retcode: 0,
                data: { user_id: 42 },
                message: '',
            },
        );
        expect(await client.call('get_group_member_list', { group_id: '1' })).toEqual({
            status: 'ok',
            retcode: 0,
            data: [{ user_id: 42 }],
            message: '',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
