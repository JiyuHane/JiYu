import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ApiHandler, type ApiActionContext, type ActionRecord } from '../../src/api-handler';
import { getGroupList } from '../../src/modules/contact-actions';
import { V12Dispatcher } from '../../src/v12/dispatcher';

// The registry and group-info/info actions are real; network/stream action
// modules are replaced. The web-honor dependency is irrelevant to group list.
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

const marker = 'synthetic-group-private-marker-4d3d';
const request = { action: 'get_group_list', params: {}, echo: 'fixture-echo' };
let captured: LogEntry[];
let unsubscribe: () => void;
let previousLevel: string;
const defaultFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch');
});

beforeEach(() => {
    previousLevel = getLogLevel();
    setLogLevel('trace');
    captured = [];
    unsubscribe = subscribeLogs((entry) => captured.push(entry));
    defaultFetch.mockClear();
    vi.stubGlobal('fetch', defaultFetch);
});

afterEach(() => {
    unsubscribe();
    setLogLevel(previousLevel);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(defaultFetch).not.toHaveBeenCalled();
});

function fixture(provider: ApiActionContext['getGroupList']) {
    const api = new ApiHandler({
        getGroupList: provider,
        getLoginInfo: () => ({ userId: 123, nickname: marker }),
    } as unknown as ApiActionContext);
    const handle = vi.spyOn(api, 'handle');
    const dispatcher = new V12Dispatcher({
        self: { platform: 'qq', user_id: '123' },
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });
    return { api, handle, dispatcher };
}

function actionLogs() {
    return captured.filter((entry) => entry.scope === 'Bridge.Action');
}

function assertCleanActionDiagnostics() {
    const entries = actionLogs();
    expect(
        entries.some(
            (entry) =>
                entry.level === 'trace' &&
                entry.message.includes('action_terminal') &&
                entry.message.includes('response=[redacted]'),
        ),
    ).toBe(true);
    expect(entries.map((entry) => entry.line).join('\n')).not.toContain(marker);
    expect(entries.map((entry) => entry.message).join('\n')).not.toMatch(/\bat\s+.+:\d+:\d+/);
}

describe('group-list logging with real registry and synthetic providers', () => {
    it('does not traverse extra getters in TRACE, projecting only the two v12 fields', async () => {
        let reads = 0;
        const group = { group_id: 42, group_name: marker };
        Object.defineProperty(group, 'extra', {
            enumerable: true,
            get() {
                reads++;
                throw new Error(marker);
            },
        });
        const provider = vi.fn(async () => [group]);
        const { dispatcher, handle } = fixture(provider);
        const result = await dispatcher.handle(request);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'fixture-echo',
            data: [{ group_id: '42', group_name: marker }],
        });
        expect(reads).toBe(0);
        expect(provider).toHaveBeenCalledExactlyOnceWith(false);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        assertCleanActionDiagnostics();
    });

    it('retains v11 wording while v12 maps the failure to a fixed message', async () => {
        const error = new Error(marker);
        const provider11 = vi.fn(async () => {
            throw error;
        });
        const provider12 = vi.fn(async () => {
            throw error;
        });
        const v11 = fixture(provider11);
        const v12 = fixture(provider12);
        const direct = await v11.api.handle('get_group_list', {});
        const mapped = await v12.dispatcher.handle(request);
        expect(direct).toMatchObject({ status: 'failed', retcode: 100, wording: marker });
        expect(mapped).toEqual({
            status: 'failed',
            retcode: 20002,
            message: 'group list unavailable',
            data: null,
            echo: 'fixture-echo',
        });
        expect(provider11).toHaveBeenCalledExactlyOnceWith(false);
        expect(provider12).toHaveBeenCalledExactlyOnceWith(false);
        expect(v11.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        expect(v12.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        expect(actionLogs().filter((entry) => entry.level === 'warn')).toHaveLength(2);
        assertCleanActionDiagnostics();
    });

    it('redacts observer errors while preserving the exact raw v11 response for observers', async () => {
        const group = { group_id: 42, group_name: marker };
        const provider = vi.fn(async () => [group]);
        const { api, dispatcher, handle } = fixture(provider);
        const records: ActionRecord[] = [];
        const second = vi.fn((_record: ActionRecord) => {});
        api.setObserver((record) => {
            records.push(record);
            throw new Error(marker);
        });
        api.setObserver(second);
        const result = await dispatcher.handle(request);
        expect(result).toMatchObject({
            status: 'ok',
            data: [{ group_id: '42', group_name: marker }],
        });
        expect(records).toHaveLength(1);
        expect(records[0]?.action).toBe('get_group_list');
        expect(records[0]?.response.data).toEqual([group]);
        expect((records[0]?.response.data as unknown[])[0]).toBe(group);
        expect(second).toHaveBeenCalledTimes(1);
        expect(second.mock.calls[0]?.[0].response).toBe(records[0]?.response);
        expect(provider).toHaveBeenCalledExactlyOnceWith(false);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        expect(actionLogs().filter((entry) => entry.level === 'warn')).toHaveLength(1);
        assertCleanActionDiagnostics();
    });

    it('preserves verbose trace for unrelated actions', async () => {
        const provider = vi.fn(async () => []);
        const { api } = fixture(provider);
        const result = await api.handle('get_login_info', {});
        expect(result).toMatchObject({ status: 'ok', retcode: 0, data: { nickname: marker } });
        expect(
            actionLogs().some(
                (entry) =>
                    entry.level === 'trace' &&
                    entry.message.includes('action_terminal') &&
                    entry.message.includes(marker),
            ),
        ).toBe(true);
        expect(provider).not.toHaveBeenCalled();
    });
});

describe('contact-actions group cache and fallback with fake bridge', () => {
    it('returns cached groups without requesting a refresh', async () => {
        const fetchGroupList = vi.fn(async () => {
            throw new Error('unexpected fetch');
        });
        const bridge = {
            apis: { contacts: { fetchGroupList } },
            identity: {
                uin: '123',
                groups: [
                    { groupId: 42, groupName: 'cached', remark: '', memberCount: 1, memberMax: 50 },
                ],
            },
        } as unknown as BridgeInterface;
        const result = await getGroupList(bridge, false);
        expect(result).toEqual([
            {
                group_id: 42,
                group_name: 'cached',
                group_remark: '',
                member_count: 1,
                max_member_count: 50,
                group_create_time: 0,
                group_level: 0,
                group_memo: '',
                group_description: '',
                group_all_shut: 0,
            },
        ]);
        expect(fetchGroupList).not.toHaveBeenCalled();
        expect(
            captured.filter((entry) => entry.scope === 'OneBot.Contacts' && entry.level === 'warn'),
        ).toHaveLength(0);
    });

    it('returns an empty fallback and a redacted warning after refresh failure', async () => {
        const error = new Error(marker);
        const fetchGroupList = vi.fn(async () => {
            throw error;
        });
        const bridge = {
            apis: { contacts: { fetchGroupList } },
            identity: { uin: '123', groups: [] },
        } as unknown as BridgeInterface;
        expect(await getGroupList(bridge, false)).toEqual([]);
        expect(fetchGroupList).toHaveBeenCalledExactlyOnceWith();
        const warnings = captured.filter(
            (entry) => entry.scope === 'OneBot.Contacts' && entry.level === 'warn',
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message).toContain('group list refresh failed');
        expect(warnings.map((entry) => entry.line).join('\n')).not.toContain(marker);
        expect(warnings.map((entry) => entry.message).join('\n')).not.toMatch(/\bat\s+.+:\d+:\d+/);
    });

    it('with noCache=true propagates the original error without logging it', async () => {
        const error = new Error(marker);
        const fetchGroupList = vi.fn(async () => {
            throw error;
        });
        const bridge = {
            apis: { contacts: { fetchGroupList } },
            identity: { uin: '123', groups: [{ groupId: 42, groupName: 'cached' }] },
        } as unknown as BridgeInterface;
        const result = await getGroupList(bridge, true).then(
            () => ({ resolved: true as const }),
            (reason: unknown) => ({ resolved: false as const, reason }),
        );
        expect(result).toEqual({ resolved: false, reason: error });

        if (!result.resolved) {
            expect(result.reason).toBe(error);
        }

        expect(fetchGroupList).toHaveBeenCalledExactlyOnceWith();
        const warnings = captured.filter(
            (entry) => entry.scope === 'OneBot.Contacts' && entry.level === 'warn',
        );
        expect(warnings).toHaveLength(0);
        expect(captured.map((entry) => entry.line).join('\n')).not.toContain(marker);
    });
});
