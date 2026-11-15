import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ApiHandler, type ApiActionContext, type ActionRecord } from '../../src/api-handler';
import { getGroupInfo } from '../../src/modules/contact-actions';
import { V12Dispatcher } from '../../src/v12/dispatcher';

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

const marker = 'synthetic-secret-group-name-fake';
const groupId = 67291041;
const accountId = '90461023';
const defaultFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch');
});
let entries: LogEntry[];
let previousLevel: string;
let unsubscribe: () => void;

beforeEach(() => {
    previousLevel = getLogLevel();
    setLogLevel('trace');
    entries = [];
    unsubscribe = subscribeLogs((entry) => entries.push(entry));
    defaultFetch.mockClear();
    vi.stubGlobal('fetch', defaultFetch);
});
afterEach(() => {
    unsubscribe();
    setLogLevel(previousLevel);
    const calls = defaultFetch.mock.calls.length;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(calls).toBe(0);
});

function fixture(provider: ApiActionContext['getGroupInfo']) {
    const api = new ApiHandler({
        getGroupInfo: provider,
        getLoginInfo: () => ({ userId: 123, nickname: marker }),
    } as unknown as ApiActionContext);
    const subject = new V12Dispatcher({
        self: { platform: 'qq', user_id: accountId },
        api,
        version: { impl: 'fixture', version: '1' },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });
    return { api, subject, handle: vi.spyOn(api, 'handle') };
}

const request = { action: 'get_group_info', params: { group_id: String(groupId) }, echo: 'e' };
const actionLogs = () => entries.filter((entry) => entry.scope === 'Bridge.Action');

function expectActionRedacted() {
    const logs = actionLogs();
    expect(
        logs.some(
            (e) =>
                e.level === 'trace' &&
                e.message.includes('action_input') &&
                e.message.includes('params=[redacted]'),
        ),
    ).toBe(true);
    expect(
        logs.some(
            (e) =>
                e.level === 'trace' &&
                e.message.includes('action_terminal') &&
                e.message.includes('response=[redacted]'),
        ),
    ).toBe(true);
    expect(
        logs.some(
            (e) =>
                e.level === 'debug' &&
                e.message.includes('get_group_info') &&
                e.message.includes('params=[redacted]'),
        ),
    ).toBe(true);
    const text = logs.map((e) => e.line).join('\n');
    expect(text).not.toContain(marker);
    expect(text).not.toContain(String(groupId));
    expect(text).not.toContain(accountId);
}

function expectContactWarning(subject: string, uin: string, id: number) {
    const warnings = entries.filter((e) => e.scope === 'OneBot.Contacts' && e.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(subject);
    const text = warnings.map((e) => e.line).join('\n');
    expect(text).not.toContain(uin);
    expect(text).not.toContain(String(id));
    expect(text).not.toContain(marker);
    expect(text).not.toMatch(/\bat\s+.+:\d+:\d+/);
}

describe('real action diagnostics with fake providers', () => {
    it('redacts input, debug, terminal while observers keep raw values and order', async () => {
        const group = { group_id: groupId, group_name: marker };
        let reads = 0;
        Object.defineProperty(group, 'extra', {
            enumerable: true,
            get() {
                reads++;
                throw new Error(marker);
            },
        });
        const provider = vi.fn(async () => group);
        const { api, subject, handle } = fixture(provider);
        const records: ActionRecord[] = [];
        const order: string[] = [];
        api.setObserver((record) => {
            order.push('first');
            records.push(record);
            throw new Error(marker);
        });
        api.setObserver((record) => {
            order.push('second');
            records.push(record);
        });
        const result = await subject.handle(request);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'e',
            data: { group_id: String(groupId), group_name: marker },
        });
        expect(provider).toHaveBeenCalledExactlyOnceWith(groupId, false);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: groupId });
        expect(order).toEqual(['first', 'second']);
        expect(records).toHaveLength(2);
        expect(records[0]?.params).toEqual({ group_id: groupId });
        expect(records[1]?.params).toBe(records[0]?.params);
        expect(records[0]?.response.data).toBe(group);
        expect(records[1]?.response).toBe(records[0]?.response);
        expect(reads).toBe(0);
        expect(
            actionLogs()
                .filter((e) => e.level === 'warn')
                .map((e) => e.message),
        ).toEqual(['get_group_info action observer error: [redacted]']);
        expectActionRedacted();
    });

    it('uses a fixed warning and fixed v12 error while preserving the raw v11 observer response', async () => {
        const error = new Error(marker);
        const provider = vi.fn(async () => {
            throw error;
        });
        const { api, subject, handle } = fixture(provider);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await subject.handle(request);
        expect(result).toEqual({
            status: 'failed',
            retcode: 20002,
            message: 'group info unavailable',
            data: null,
            echo: 'e',
        });
        expect(records).toHaveLength(1);
        expect(records[0]?.params).toEqual({ group_id: groupId });
        expect(records[0]?.response).toMatchObject({
            status: 'failed',
            retcode: 100,
            wording: marker,
        });
        expect(provider).toHaveBeenCalledExactlyOnceWith(groupId, false);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: groupId });
        expect(
            actionLogs()
                .filter((e) => e.level === 'warn')
                .map((e) => e.message),
        ).toEqual(['get_group_info failed: [redacted]']);
        expectActionRedacted();
        expect(JSON.stringify(result)).not.toContain(marker);
    });

    it('keeps the normal verbose trace on an unrelated action', async () => {
        const provider = vi.fn(async () => ({ group_id: groupId, group_name: marker }));
        const { api } = fixture(provider);
        expect(await api.handle('get_login_info', {})).toMatchObject({
            status: 'ok',
            data: { nickname: marker },
        });
        expect(
            actionLogs().some(
                (e) =>
                    e.level === 'trace' &&
                    e.message.includes('action_terminal') &&
                    e.message.includes(marker),
            ),
        ).toBe(true);
        expect(provider).not.toHaveBeenCalled();
    });
});

describe('real getGroupInfo with synthetic bridge services', () => {
    it('after list refresh failure returns null when detail is absent', async () => {
        const uin = '90521031';
        const id = 67292031;
        const list = vi.fn(async () => {
            throw new Error(marker);
        });
        const detail = vi.fn(async () => null);
        const findGroup = vi.fn(() => null);
        const bridge = {
            identity: { uin, findGroup },
            apis: { contacts: { fetchGroupList: list, fetchGroupDetail: detail } },
        } as unknown as BridgeInterface;
        expect(await getGroupInfo(bridge, id, false)).toBeNull();
        expect(list).toHaveBeenCalledExactlyOnceWith();
        expect(detail).toHaveBeenCalledExactlyOnceWith(id);
        expect(findGroup).toHaveBeenCalledWith(id);
        expectContactWarning('group list refresh failed', uin, id);
    });

    it('falls back to level zero after joined group detail throws', async () => {
        const uin = '90521032';
        const id = 67292032;
        const list = vi.fn(async () => {});
        const detail = vi.fn(async () => {
            throw new Error(marker);
        });
        const group = { groupId: id, groupName: marker, remark: '', memberCount: 2, memberMax: 3 };
        const findGroup = vi.fn(() => group);
        const bridge = {
            identity: { uin, findGroup },
            apis: { contacts: { fetchGroupList: list, fetchGroupDetail: detail } },
        } as unknown as BridgeInterface;
        expect(await getGroupInfo(bridge, id, false)).toMatchObject({
            group_id: id,
            group_name: marker,
            group_level: 0,
        });
        expect(list).not.toHaveBeenCalled();
        expect(detail).toHaveBeenCalledExactlyOnceWith(id);
        expect(findGroup).toHaveBeenCalledWith(id);
        expectContactWarning('group detail refresh failed', uin, id);
    });

    it('returns null after a non-member detail failure', async () => {
        const uin = '90521033';
        const id = 67292033;
        const list = vi.fn(async () => {});
        const detail = vi.fn(async () => {
            throw new Error(marker);
        });
        const findGroup = vi.fn(() => null);
        const bridge = {
            identity: { uin, findGroup },
            apis: { contacts: { fetchGroupList: list, fetchGroupDetail: detail } },
        } as unknown as BridgeInterface;
        expect(await getGroupInfo(bridge, id, false)).toBeNull();
        expect(list).toHaveBeenCalledExactlyOnceWith();
        expect(detail).toHaveBeenCalledExactlyOnceWith(id);
        expect(findGroup).toHaveBeenCalledWith(id);
        expectContactWarning('non-member group lookup failed', uin, id);
    });

    it('with noCache=true propagates the original error reference without a warning', async () => {
        const id = 67292034;
        const error = new Error(marker);
        const list = vi.fn(async () => {
            throw error;
        });
        const detail = vi.fn(async () => null);
        const bridge = {
            identity: { uin: '90521034', findGroup: vi.fn(() => null) },
            apis: { contacts: { fetchGroupList: list, fetchGroupDetail: detail } },
        } as unknown as BridgeInterface;
        const outcome = await getGroupInfo(bridge, id, true).then(
            () => null,
            (reason: unknown) => reason,
        );
        expect(outcome).toBe(error);
        expect(list).toHaveBeenCalledExactlyOnceWith();
        expect(detail).not.toHaveBeenCalled();
        expect(
            entries.filter((e) => e.scope === 'OneBot.Contacts' && e.level === 'warn'),
        ).toHaveLength(0);
    });
});
