import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { MessageElementValidationError } from '@snowluma/protocol/element-manifest';
import type { GroupMemberInfo, UserProfileInfo } from '@snowluma/protocol/qq-info';
import { defineStreamAction } from '../../src/action-kit';
import { ApiHandler, type ApiActionContext, type ActionRecord } from '../../src/api-handler';
import { getGroupMemberInfo, getGroupMemberList } from '../../src/modules/contact-actions';
import { okResponse, type JsonObject, type JsonValue } from '../../src/types';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import { createCompiledTestHandler } from '../helpers/compiled-action-handler';

// Keep the real action registry, group-info specs and logger subscriber, but
// use an in-memory file transport and inert unrelated actions. No socket or
// live Bridge is created by these tests.
const fileTransport = vi.hoisted(() => {
    const previousFileLevel = process.env.SNOWLUMA_LOG_FILE_LEVEL;
    process.env.SNOWLUMA_LOG_FILE_LEVEL = 'debug';
    return { writes: [] as unknown[][], previousFileLevel };
});
vi.mock('@snowluma/common/log-file-transport', () => ({
    getFileTransport: () => ({
        write: (...args: unknown[]) => {
            fileTransport.writes.push(args);
        },
        close: async () => {},
    }),
}));
vi.mock('../../src/actions/message', () => ({ actions: [] }));
vi.mock('../../src/actions/friend', () => ({ actions: [] }));
vi.mock('../../src/actions/group-admin', () => ({ actions: [] }));
vi.mock('../../src/actions/group-file', () => ({ actions: [] }));
vi.mock('../../src/actions/request', () => ({ actions: [] }));
vi.mock('../../src/actions/extended', () => ({ actions: [] }));
vi.mock('../../src/actions/group-album', () => ({ actions: [] }));
vi.mock('../../src/actions/qzone', () => ({ actions: [] }));
vi.mock('../../src/actions/qzone-public', () => ({ actions: [] }));
vi.mock('../../src/actions/stream-download', () => ({ actions: [] }));
vi.mock('../../src/actions/stream-file', () => ({ actions: [] }));
vi.mock('../../src/actions/system-face', () => ({ actions: [] }));
vi.mock('@snowluma/protocol/web/group-honor', () => ({ WebHonorType: { ALL: 'all' } }));

const accountId = 817264593;
const groupId = 723851069;
const userId = 685932417;
const nickname = 'synthetic-member-nickname-8c7e';
const card = 'synthetic-member-card-3b9f';
const errorMarker = 'synthetic-provider-error-d429';
const observerMarker = 'synthetic-observer-error-0ca7';
const extraMarker = 'synthetic-extra-input-71e2';
const secrets = [
    String(accountId),
    String(groupId),
    String(userId),
    nickname,
    card,
    errorMarker,
    observerMarker,
    extraMarker,
];
const actionNames = ['get_group_member_list', 'get_group_member_info'] as const;
type MemberAction = (typeof actionNames)[number];
let entries: LogEntry[];
let previousLevel: string;
let unsubscribe: () => void;
const defaultFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch');
});

beforeEach(() => {
    previousLevel = getLogLevel();
    setLogLevel('trace');
    entries = [];
    fileTransport.writes.length = 0;
    unsubscribe = subscribeLogs((entry) => entries.push(entry));
    defaultFetch.mockClear();
    vi.stubGlobal('fetch', defaultFetch);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    unsubscribe();
    setLogLevel(previousLevel);
    const fetchCalls = defaultFetch.mock.calls.length;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(fetchCalls).toBe(0);
});

afterAll(() => {
    if (fileTransport.previousFileLevel === undefined) {
        delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
    } else {
        process.env.SNOWLUMA_LOG_FILE_LEVEL = fileTransport.previousFileLevel;
    }
});

function apiWith(overrides: Partial<ApiActionContext> = {}): ApiHandler {
    return new ApiHandler(
        { getLoginInfo: () => ({ userId: accountId, nickname }), ...overrides } as ApiActionContext,
        accountId,
    );
}

function apiForBridge(bridge: BridgeInterface): ApiHandler {
    return apiWith({
        bridge,
        getGroupMemberList: (id, noCache) => getGroupMemberList(bridge, id, noCache),
        getGroupMemberInfo: (id, memberId, noCache) =>
            getGroupMemberInfo(bridge, id, memberId, noCache),
    });
}

function dispatcherFor(api: ApiHandler): V12Dispatcher {
    return new V12Dispatcher({
        self: { platform: 'qq', user_id: String(accountId) },
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });
}

function paramsFor(action: MemberAction, noCache = false): JsonObject {
    return {
        group_id: groupId,
        ...(action === 'get_group_member_info' ? { user_id: userId } : {}),
        no_cache: noCache,
        extra: extraMarker,
    };
}

function actionLogs() {
    return entries.filter((entry) => entry.scope === 'Bridge.Action');
}

function contactWarnings() {
    return entries
        .filter((entry) => entry.scope === 'OneBot.Contacts' && entry.level === 'warn')
        .map((entry) => entry.message);
}

function expectNoSecrets() {
    // Check full entries, including the uin metadata/line, and the fake file
    // transport arguments, not just the formatted message.
    const text = JSON.stringify({ entries, writes: fileTransport.writes });

    for (const secret of secrets) {
        expect(text).not.toContain(secret);
    }

    expect(entries.map((entry) => entry.message).join('\n')).not.toMatch(/\bat\s+.+:\d+:\d+/);
    expect(fileTransport.writes.length).toBeGreaterThan(0);
}

function expectActionDiagnostics(action: MemberAction, outcome: 'ok' | 'failed', reason: string) {
    const logs = actionLogs();
    expect(
        logs.some(
            (entry) =>
                entry.level === 'trace' &&
                entry.message === `action_input action=${action} params=[redacted]`,
        ),
    ).toBe(true);
    expect(
        logs.some(
            (entry) => entry.level === 'debug' && entry.message === `${action} params=[redacted]`,
        ),
    ).toBe(true);
    expect(
        logs.some(
            (entry) =>
                entry.level === 'trace' &&
                entry.message.includes(
                    `action_terminal action=${action} outcome=${outcome} reason=${reason}`,
                ) &&
                entry.message.endsWith('response=[redacted]'),
        ),
    ).toBe(true);
    expect(logs.every((entry) => entry.uin === undefined)).toBe(true);
    expectNoSecrets();
}

function member(overrides: Partial<GroupMemberInfo> = {}): GroupMemberInfo {
    return {
        uin: userId,
        uid: 'synthetic-uid',
        nickname,
        card,
        isRobot: false,
        role: 'admin',
        level: 7,
        title: 'synthetic-title',
        joinTime: 123,
        lastSentTime: 456,
        shutUpTime: 789,
        ...overrides,
    };
}

function formattedMember() {
    return {
        group_id: groupId,
        user_id: userId,
        nickname,
        card,
        is_robot: false,
        sex: 'unknown',
        age: 0,
        join_time: 123,
        last_sent_time: 456,
        shut_up_timestamp: 789,
        level: '7',
        role: 'admin',
        title: 'synthetic-title',
        area: '',
        unfriendly: false,
        title_expire_time: 0,
        card_changeable: true,
        qidian_master_flag: 0,
        qidian_crew_flag: 0,
        qidian_crew_flag_2: 0,
    };
}

function fakeBridge(
    options: {
        rosterError?: unknown;
        roster?: GroupMemberInfo[];
        cachedMembers?: GroupMemberInfo[];
        cachedMember?: GroupMemberInfo | null;
        cachedProfile?: UserProfileInfo | null;
        profileError?: unknown;
        profile?: UserProfileInfo;
        groupMissing?: boolean;
    } = {},
) {
    const events: string[] = [];
    const fetchGroupMemberList = vi.fn(async (_id: number, _options?: { force: boolean }) => {
        events.push('fetch-roster');

        if ('rosterError' in options) {
            throw options.rosterError;
        }

        return options.roster ?? [member()];
    });
    const fetchUserProfile = vi.fn(async (_id: number) => {
        events.push('fetch-profile');

        if ('profileError' in options) {
            throw options.profileError;
        }

        return options.profile;
    });
    const findGroup = vi.fn((_id: number) => {
        events.push('find-group');
        return options.groupMissing
            ? null
            : { members: new Map((options.cachedMembers ?? [member()]).map((m) => [m.uin, m])) };
    });
    const findGroupMember = vi.fn((_groupId: number, _userId: number) => {
        events.push('find-member');
        return options.cachedMember === undefined ? member() : options.cachedMember;
    });
    const findUserProfile = vi.fn((_id: number) => {
        events.push('find-profile');
        return options.cachedProfile ?? null;
    });
    const bridge = {
        identity: { uin: String(accountId), findGroup, findGroupMember, findUserProfile },
        apis: { contacts: { fetchGroupMemberList, fetchUserProfile } },
    } as unknown as BridgeInterface;
    return { bridge, events, fetchGroupMemberList, fetchUserProfile, findGroup, findGroupMember };
}

describe('member Action diagnostics through real ApiHandler', () => {
    it.each(actionNames)(
        '%s preserves raw response and observer ordering without traversal',
        async (action) => {
            let inputReads = 0;
            let resultReads = 0;
            const params = paramsFor(action);
            Object.defineProperty(params, 'unrelated', {
                enumerable: true,
                get() {
                    inputReads++;
                    throw new Error(extraMarker);
                },
            });
            const row: JsonObject = { group_id: groupId, user_id: userId, nickname, card };
            Object.defineProperty(row, 'unrelated', {
                enumerable: true,
                get() {
                    resultReads++;
                    throw new Error(nickname);
                },
            });
            const data = action === 'get_group_member_list' ? [row] : row;
            const list = vi.fn(async () => data as JsonObject[]);
            const info = vi.fn(async () => data as JsonObject);
            const api = apiWith({ getGroupMemberList: list, getGroupMemberInfo: info });
            const records: ActionRecord[] = [];
            const order: string[] = [];
            api.setObserver((record) => {
                order.push('first');
                records.push(record);
                throw new Error(observerMarker);
            });
            api.setObserver((record) => {
                order.push('second');
                records.push(record);
            });
            const result = await api.handle(action, params);
            expect(result.status).toBe('ok');
            expect(result.retcode).toBe(0);
            expect(result.data).toBe(data);
            expect(inputReads).toBe(0);
            expect(resultReads).toBe(0);
            expect(order).toEqual(['first', 'second']);
            expect(records).toHaveLength(2);
            expect(records[0]?.params).toBe(params);
            expect(records[1]?.params).toBe(params);
            expect(records[0]?.response).toBe(result);
            expect(records[1]?.response).toBe(result);
            expect(actionLogs().map((entry) => entry.level)).toEqual([
                'trace',
                'debug',
                'trace',
                'warn',
            ]);
            expect(actionLogs()[3]?.message).toBe(`${action} action observer error: [redacted]`);

            if (action === 'get_group_member_list') {
                expect(list).toHaveBeenCalledExactlyOnceWith(groupId, false);
                expect(info).not.toHaveBeenCalled();
            } else {
                expect(info).toHaveBeenCalledExactlyOnceWith(groupId, userId, false);
                expect(list).not.toHaveBeenCalled();
            }

            expectActionDiagnostics(action, 'ok', 'response_returned');
        },
    );

    it.each(actionNames)(
        '%s keeps the original failure wording and redacts observer errors',
        async (action) => {
            const error = new Error(`${errorMarker}:${groupId}:${userId}:${accountId}:${nickname}`);
            const provider = vi.fn(async () => {
                throw error;
            });
            const api = apiWith({ getGroupMemberList: provider, getGroupMemberInfo: provider });
            const params = paramsFor(action, true);
            const records: ActionRecord[] = [];
            api.setObserver((record) => {
                records.push(record);
                throw new Error(observerMarker);
            });
            api.setObserver((record) => records.push(record));
            const result = await api.handle(action, params);
            expect(result).toEqual({
                status: 'failed',
                retcode: 100,
                data: null,
                wording: error.message,
            });
            expect(records).toHaveLength(2);
            expect(records[0]?.params).toBe(params);
            expect(records[0]?.response).toBe(result);
            expect(records[1]?.response).toBe(result);
            expect(actionLogs().map((entry) => entry.level)).toEqual([
                'trace',
                'debug',
                'warn',
                'trace',
                'warn',
            ]);
            expect(
                actionLogs()
                    .filter((entry) => entry.level === 'warn')
                    .map((entry) => entry.message),
            ).toEqual([
                `${action} failed: [redacted]`,
                `${action} action observer error: [redacted]`,
            ]);

            if (action === 'get_group_member_list') {
                expect(provider).toHaveBeenCalledExactlyOnceWith(groupId, true);
            } else {
                expect(provider).toHaveBeenCalledExactlyOnceWith(groupId, userId, true);
            }

            expectActionDiagnostics(action, 'failed', 'handler_threw');
        },
    );

    it.each(actionNames)('%s retains a non-Error throw as v11 wording', async (action) => {
        const provider = vi.fn(async () => {
            throw errorMarker;
        });
        const api = apiWith({ getGroupMemberList: provider, getGroupMemberInfo: provider });
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(action, paramsFor(action));
        expect(result).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: errorMarker,
        });
        expect(records[0]?.response).toBe(result);
        expectActionDiagnostics(action, 'failed', 'handler_threw');
    });

    it.each(actionNames)('%s retains typed validation-error mapping', async (action) => {
        const error = new MessageElementValidationError('UNKNOWN_TYPE', errorMarker, 'fixture');
        const provider = vi.fn(async () => {
            throw error;
        });
        const api = apiWith({ getGroupMemberList: provider, getGroupMemberInfo: provider });
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(action, paramsFor(action));
        expect(result).toEqual({
            status: 'failed',
            retcode: 1400,
            data: null,
            wording: errorMarker,
        });
        expect(records[0]?.response).toBe(result);
        expectActionDiagnostics(action, 'failed', 'handler_threw');
    });

    it.each(actionNames)(
        '%s keeps absent-provider fallback and observer response',
        async (action) => {
            const api = apiWith();
            const records: ActionRecord[] = [];
            api.setObserver((record) => records.push(record));
            const params = paramsFor(action);
            const result = await api.handle(action, params);
            const data =
                action === 'get_group_member_list'
                    ? []
                    : {
                          group_id: groupId,
                          user_id: userId,
                          nickname: '',
                          card: '',
                          is_robot: false,
                          sex: 'unknown',
                          age: 0,
                          join_time: 0,
                          last_sent_time: 0,
                          shut_up_timestamp: 0,
                          level: '0',
                          role: 'member',
                          title: '',
                      };
            expect(result).toEqual({ status: 'ok', retcode: 0, data });
            expect(records).toHaveLength(1);
            expect(records[0]?.params).toBe(params);
            expect(records[0]?.response).toBe(result);
            expectActionDiagnostics(action, 'ok', 'response_returned');
        },
    );

    it('preserves the distinct null-provider info fallback including qidian fields', async () => {
        const provider = vi.fn(async () => null);
        const api = apiWith({ getGroupMemberInfo: provider });
        const result = await api.handle(
            'get_group_member_info',
            paramsFor('get_group_member_info'),
        );
        expect(result).toMatchObject({
            status: 'ok',
            data: {
                group_id: groupId,
                user_id: userId,
                nickname: '',
                qidian_master_flag: 0,
                qidian_crew_flag: 0,
                qidian_crew_flag_2: 0,
            },
        });
        expect(provider).toHaveBeenCalledExactlyOnceWith(groupId, userId, false);
        expectActionDiagnostics('get_group_member_info', 'ok', 'response_returned');
    });

    it('redacts invalid input and the returned validation error without invoking the provider', async () => {
        const provider = vi.fn(async () => []);
        const api = apiWith({ getGroupMemberList: provider });
        const params = { group_id: errorMarker, extra: extraMarker };
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle('get_group_member_list', params);
        expect(result).toMatchObject({ status: 'failed', retcode: 1400, data: null });
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(result);
        expect(provider).not.toHaveBeenCalled();
        expectActionDiagnostics('get_group_member_list', 'failed', 'response_returned');
    });

    it.each(actionNames)(
        '%s redacts unknown and quiesced dispatch including account metadata',
        async (action) => {
            const unknownApi = createCompiledTestHandler({} as ApiActionContext, [], accountId);
            const unknown = await unknownApi.handle(action, paramsFor(action));
            expect(unknown).toMatchObject({ status: 'failed', retcode: 1404 });
            expect(actionLogs().every((entry) => entry.uin === undefined)).toBe(true);
            expectNoSecrets();

            const api = apiWith();
            api.quiesce(); // This separate lifecycle record retains its existing account context.
            entries = [];
            fileTransport.writes.length = 0;
            const records: ActionRecord[] = [];
            api.setObserver((record) => records.push(record));
            const params = paramsFor(action);
            const result = await api.handle(action, params);
            expect(result).toMatchObject({ status: 'failed', retcode: 100 });
            expect(records[0]?.params).toBe(params);
            expect(records[0]?.response).toBe(result);
            expect(actionLogs().map((entry) => entry.level)).toEqual(['trace', 'warn', 'trace']);
            api.traceQuiescedAction(action, params, {
                status: 'failed',
                retcode: 100,
                data: null,
                wording: errorMarker,
            });
            api.traceQuiescedStreamRequest(JSON.stringify({ action, params }));
            expect(actionLogs().map((entry) => entry.level)).toEqual([
                'trace',
                'warn',
                'trace',
                'trace',
                'trace',
                'trace',
                'trace',
            ]);
            expect(records).toHaveLength(1);
            expect(actionLogs().every((entry) => entry.uin === undefined)).toBe(true);
            expectNoSecrets();
        },
    );

    it('redacts the file-only debug entry when the subscriber threshold is warn', async () => {
        setLogLevel('warn');
        const provider = vi.fn(async () => [
            { group_id: groupId, user_id: userId, nickname, card },
        ]);
        const api = apiWith({ getGroupMemberList: provider });
        const result = await api.handle(
            'get_group_member_list',
            paramsFor('get_group_member_list'),
        );
        expect(result).toMatchObject({ status: 'ok', data: [{ user_id: userId, nickname, card }] });
        expect(actionLogs()).toEqual([]);
        expect(fileTransport.writes).toHaveLength(1);
        expect(String(fileTransport.writes[0]?.[0])).toContain('params=[redacted]');
        expectNoSecrets();
    });

    it('keeps verbose trace and account logger for an unrelated action', async () => {
        const api = apiWith();
        const result = await api.handle('get_login_info', {});
        expect(result).toMatchObject({ status: 'ok', data: { user_id: accountId, nickname } });
        const terminal = actionLogs().find((entry) => entry.message.includes('action_terminal'));
        expect(terminal?.message).toContain(nickname);
        expect(terminal?.uin).toBe(accountId);
    });

    it('also redacts a custom member stream frame without touching its payload or sink', async () => {
        let reads = 0;
        const frame: JsonObject = { user_id: userId, nickname };
        Object.defineProperty(frame, 'extra', {
            enumerable: true,
            get() {
                reads++;
                throw new Error(errorMarker);
            },
        });
        const spec = defineStreamAction({
            name: 'get_group_member_list',
            params: {},
            run: async (_params, _context, sink) => {
                await sink.send(frame);
                return okResponse();
            },
        });
        const api = createCompiledTestHandler({} as ApiActionContext, [spec], accountId);
        const received: JsonValue[] = [];
        const result = await api.handle(
            'get_group_member_list',
            paramsFor('get_group_member_list'),
            {
                send: async (value) => {
                    received.push(value);
                },
            },
        );
        expect(result).toEqual({ status: 'ok', retcode: 0, data: null });
        expect(received).toHaveLength(1);
        expect(received[0]).toBe(frame);
        expect(reads).toBe(0);
        expect(
            actionLogs().some(
                (entry) =>
                    entry.message ===
                    'action_stream_frame action=get_group_member_list frame=[redacted]',
            ),
        ).toBe(true);
        expectActionDiagnostics('get_group_member_list', 'ok', 'response_returned');
    });
});

describe('v12 member queries over the real v11 handler and synthetic Bridge', () => {
    it.each(actionNames)(
        '%s returns the projection while observers retain the v11 list',
        async (action) => {
            const f = fakeBridge();
            const api = apiForBridge(f.bridge);
            const handle = vi.spyOn(api, 'handle');
            const records: ActionRecord[] = [];
            api.setObserver((record) => records.push(record));
            const dispatcher = dispatcherFor(api);
            const result = await dispatcher.handle({
                action,
                params: {
                    group_id: String(groupId),
                    ...(action === 'get_group_member_info' ? { user_id: String(userId) } : {}),
                },
                echo: 'fixture-echo',
            });
            const projected = {
                user_id: String(userId),
                user_name: nickname,
                user_displayname: card,
            };
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                echo: 'fixture-echo',
                data: action === 'get_group_member_list' ? [projected] : projected,
            });
            expect(handle).toHaveBeenCalledExactlyOnceWith('get_group_member_list', {
                group_id: groupId,
            });
            expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(groupId);
            expect(records).toHaveLength(1);
            expect(records[0]?.action).toBe('get_group_member_list');
            expect(records[0]?.params).toEqual({ group_id: groupId });
            expect(records[0]?.response).toBe(await handle.mock.results[0]?.value);
            expect(records[0]?.response).toEqual({
                status: 'ok',
                retcode: 0,
                data: [formattedMember()],
            });
            expectActionDiagnostics('get_group_member_list', 'ok', 'response_returned');
        },
    );

    it.each(actionNames)('%s preserves the cache fallback through v12', async (action) => {
        const f = fakeBridge({ rosterError: new Error(`${errorMarker}:${groupId}:${userId}`) });
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await dispatcherFor(api).handle({
            action,
            params: {
                group_id: String(groupId),
                ...(action === 'get_group_member_info' ? { user_id: String(userId) } : {}),
            },
        });
        const projected = { user_id: String(userId), user_name: nickname, user_displayname: card };
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: action === 'get_group_member_list' ? [projected] : projected,
        });
        expect(records[0]?.response).toEqual({
            status: 'ok',
            retcode: 0,
            data: [formattedMember()],
        });
        expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(groupId);
        expect(contactWarnings()).toEqual([
            'group member fetch failed, using classified cache: [redacted]',
        ]);
        expectActionDiagnostics('get_group_member_list', 'ok', 'response_returned');
    });

    it.each(actionNames)(
        '%s returns a fixed v12 failure while observer sees v11 wording',
        async (action) => {
            const error = new Error(`${errorMarker}:${groupId}:${userId}:${accountId}`);
            const f = fakeBridge({ rosterError: error, groupMissing: true });
            const api = apiForBridge(f.bridge);
            const records: ActionRecord[] = [];
            api.setObserver((record) => records.push(record));
            const result = await dispatcherFor(api).handle({
                action,
                params: {
                    group_id: String(groupId),
                    ...(action === 'get_group_member_info' ? { user_id: String(userId) } : {}),
                },
            });
            expect(result).toEqual({
                status: 'failed',
                retcode: 20002,
                data: null,
                message:
                    action === 'get_group_member_list'
                        ? 'group member list unavailable'
                        : 'group member info unavailable',
            });
            expect(records).toHaveLength(1);
            expect(records[0]?.response).toEqual({
                status: 'failed',
                retcode: 100,
                data: null,
                wording: error.message,
            });
            expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(groupId);
            expectActionDiagnostics('get_group_member_list', 'failed', 'handler_threw');
        },
    );

    it.each(actionNames)('%s preserves the absent v11 provider outcome', async (action) => {
        const api = apiWith();
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await dispatcherFor(api).handle({
            action,
            params: {
                group_id: String(groupId),
                ...(action === 'get_group_member_info' ? { user_id: String(userId) } : {}),
            },
        });
        expect(result).toEqual(
            action === 'get_group_member_list'
                ? { status: 'ok', retcode: 0, message: '', data: [] }
                : {
                      status: 'failed',
                      retcode: 35000,
                      message: 'group member match unavailable or ambiguous',
                      data: null,
                  },
        );
        expect(records).toHaveLength(1);
        expect(records[0]?.response).toEqual({ status: 'ok', retcode: 0, data: [] });
        expectActionDiagnostics('get_group_member_list', 'ok', 'response_returned');
    });
});

describe('member contact actions through synthetic Bridge and real ApiHandler', () => {
    it('returns the fetched roster without changing the v11 payload', async () => {
        const f = fakeBridge();
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(
            'get_group_member_list',
            paramsFor('get_group_member_list'),
        );
        expect(result).toEqual({ status: 'ok', retcode: 0, data: [formattedMember()] });
        expect(records[0]?.response).toBe(result);
        expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(groupId);
        expect(f.findGroup).not.toHaveBeenCalled();
        expect(contactWarnings()).toEqual([]);
        expectActionDiagnostics('get_group_member_list', 'ok', 'response_returned');
    });

    it('warns before consulting a classified cache and returns the cached roster', async () => {
        const error = new Error(`${errorMarker}:${groupId}:${userId}:${accountId}`);
        const f = fakeBridge({ rosterError: error });
        const stop = subscribeLogs((entry) => {
            if (entry.scope === 'OneBot.Contacts' && entry.level === 'warn') {
                f.events.push('warn');
            }
        });
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const params = paramsFor('get_group_member_list');
        const result = await api.handle('get_group_member_list', params);
        stop();
        expect(result).toEqual({ status: 'ok', retcode: 0, data: [formattedMember()] });
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(result);
        expect(f.events).toEqual(['fetch-roster', 'warn', 'find-group', 'find-profile']);
        expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(groupId);
        expect(f.findGroup).toHaveBeenCalledExactlyOnceWith(groupId);
        expect(contactWarnings()).toEqual([
            'group member fetch failed, using classified cache: [redacted]',
        ]);
        expectActionDiagnostics('get_group_member_list', 'ok', 'response_returned');
    });

    it('rethrows the same fetch error with no usable cache and retains its v11 wording', async () => {
        const error = new Error(`${errorMarker}:${groupId}:${userId}:${accountId}`);
        const f = fakeBridge({ rosterError: error, groupMissing: true });
        const direct = await getGroupMemberList(f.bridge, groupId).then(
            () => undefined,
            (reason: unknown) => reason,
        );
        expect(direct).toBe(error);
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(
            'get_group_member_list',
            paramsFor('get_group_member_list'),
        );
        expect(result).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: error.message,
        });
        expect(records[0]?.response).toBe(result);
        expect(f.fetchGroupMemberList).toHaveBeenCalledTimes(2);
        expect(f.findGroup).toHaveBeenCalledTimes(2);
        expect(contactWarnings()).toEqual([
            'group member fetch failed, using classified cache: [redacted]',
            'group member fetch failed, using classified cache: [redacted]',
        ]);
        expectActionDiagnostics('get_group_member_list', 'failed', 'handler_threw');
    });

    it.each(actionNames)('%s force refresh preserves the same thrown error', async (action) => {
        const error = new Error(`${errorMarker}:${groupId}:${userId}:${accountId}`);
        const f = fakeBridge({ rosterError: error });
        const direct = await (
            action === 'get_group_member_list'
                ? getGroupMemberList(f.bridge, groupId, true)
                : getGroupMemberInfo(f.bridge, groupId, userId, true)
        ).then(
            () => undefined,
            (reason: unknown) => reason,
        );
        expect(direct).toBe(error);
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(action, paramsFor(action, true));
        expect(result).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: error.message,
        });
        expect(records[0]?.response).toBe(result);
        expect(f.fetchGroupMemberList).toHaveBeenCalledTimes(2);
        expect(f.fetchGroupMemberList).toHaveBeenCalledWith(groupId, { force: true });
        expect(f.findGroup).not.toHaveBeenCalled();
        expect(f.fetchUserProfile).not.toHaveBeenCalled();
        expect(contactWarnings()).toEqual([
            'group member refresh failed: [redacted]',
            'group member refresh failed: [redacted]',
        ]);
        expectActionDiagnostics(action, 'failed', 'handler_threw');
    });

    it('rethrows an unforced info refresh failure when a cached member is incomplete', async () => {
        const error = new Error(`${errorMarker}:${groupId}:${userId}:${accountId}`);
        const f = fakeBridge({ rosterError: error, cachedMember: member({ card: undefined }) });
        const direct = await getGroupMemberInfo(f.bridge, groupId, userId, false).then(
            () => undefined,
            (reason: unknown) => reason,
        );
        expect(direct).toBe(error);
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(
            'get_group_member_info',
            paramsFor('get_group_member_info'),
        );
        expect(result).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: error.message,
        });
        expect(records[0]?.response).toBe(result);
        expect(f.fetchGroupMemberList).toHaveBeenCalledTimes(2);
        expect(f.fetchGroupMemberList).toHaveBeenCalledWith(groupId, { force: false });
        expect(f.fetchUserProfile).not.toHaveBeenCalled();
        expect(contactWarnings()).toEqual([
            'group member refresh failed: [redacted]',
            'group member refresh failed: [redacted]',
        ]);
        expectActionDiagnostics('get_group_member_info', 'failed', 'handler_threw');
    });

    it('keeps classification errors as v11 business failures instead of inventing members', async () => {
        const f = fakeBridge({
            rosterError: new Error(errorMarker),
            cachedMembers: [member({ isRobot: undefined })],
        });
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(
            'get_group_member_list',
            paramsFor('get_group_member_list'),
        );
        expect(result).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: `group member robot classification unavailable: group=${groupId} member=${userId}`,
        });
        expect(records[0]?.response).toBe(result);
        expect(contactWarnings()).toEqual([
            'group member fetch failed, using classified cache: [redacted]',
        ]);
        expectActionDiagnostics('get_group_member_list', 'failed', 'handler_threw');
    });

    it('keeps the cached member and zero flags after a profile failure', async () => {
        const f = fakeBridge({
            profileError: new Error(`${errorMarker}:${groupId}:${userId}:${accountId}`),
        });
        const api = apiForBridge(f.bridge);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await api.handle(
            'get_group_member_info',
            paramsFor('get_group_member_info'),
        );
        expect(result).toEqual({ status: 'ok', retcode: 0, data: formattedMember() });
        expect(records[0]?.response).toBe(result);
        expect(f.findGroupMember).toHaveBeenCalledTimes(2);
        expect(f.fetchGroupMemberList).not.toHaveBeenCalled();
        expect(f.fetchUserProfile).toHaveBeenCalledExactlyOnceWith(userId);
        expect(contactWarnings()).toEqual(['group member profile unavailable: [redacted]']);
        expectActionDiagnostics('get_group_member_info', 'ok', 'response_returned');
    });

    it('retains a cached profile after forced refresh fails', async () => {
        const profile = {
            level: 11,
            qidianMasterFlag: 1,
            qidianCrewFlag: 2,
            qidianCrewFlag2: 3,
        } as UserProfileInfo;
        const f = fakeBridge({ cachedProfile: profile, profileError: new Error(errorMarker) });
        const api = apiForBridge(f.bridge);
        const result = await api.handle(
            'get_group_member_info',
            paramsFor('get_group_member_info', true),
        );
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: {
                ...formattedMember(),
                qq_level: 11,
                qidian_master_flag: 1,
                qidian_crew_flag: 2,
                qidian_crew_flag_2: 3,
            },
        });
        expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(groupId, { force: true });
        expect(f.fetchUserProfile).toHaveBeenCalledExactlyOnceWith(userId);
        expect(contactWarnings()).toEqual(['group member profile unavailable: [redacted]']);
        expectActionDiagnostics('get_group_member_info', 'ok', 'response_returned');
    });

    it('preserves a throwing profile-warning subscriber instead of swallowing it', async () => {
        const f = fakeBridge({ profileError: new Error(errorMarker) });
        const loggerError = new Error('synthetic-logger-failure');
        const stop = subscribeLogs((entry) => {
            if (entry.scope === 'OneBot.Contacts' && entry.level === 'warn') {
                throw loggerError;
            }
        });
        const reason = await getGroupMemberInfo(f.bridge, groupId, userId).then(
            () => undefined,
            (error: unknown) => error,
        );
        stop();
        expect(reason).toBe(loggerError);
        expect(f.fetchUserProfile).toHaveBeenCalledExactlyOnceWith(userId);
        expect(contactWarnings()).toEqual(['group member profile unavailable: [redacted]']);
        expect(JSON.stringify(entries)).not.toContain(errorMarker);
        expect(JSON.stringify(entries)).not.toContain(String(userId));
        expect(JSON.stringify(entries)).not.toContain(String(groupId));
    });

    it('preserves warning-subscriber throw timing before cache fallback', async () => {
        const f = fakeBridge({ rosterError: new Error(errorMarker) });
        const loggerError = new Error('synthetic-logger-failure');
        const stop = subscribeLogs((entry) => {
            if (entry.scope === 'OneBot.Contacts' && entry.level === 'warn') {
                throw loggerError;
            }
        });
        const reason = await getGroupMemberList(f.bridge, groupId).then(
            () => undefined,
            (error: unknown) => error,
        );
        stop();
        expect(reason).toBe(loggerError);
        expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(groupId);
        expect(f.findGroup).not.toHaveBeenCalled();
        expect(contactWarnings()).toEqual([
            'group member fetch failed, using classified cache: [redacted]',
        ]);
        // emit has not reached the file transport when a subscriber throws.
        expect(JSON.stringify(entries)).not.toContain(errorMarker);
        expect(JSON.stringify(entries)).not.toContain(String(groupId));
        expect(JSON.stringify(entries)).not.toContain(String(accountId));
    });
});
