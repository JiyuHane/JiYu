import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ApiHandler, type ApiActionContext, type ActionRecord } from '../../src/api-handler';
import { getFriendList } from '../../src/modules/contact-actions';
import { V12Dispatcher } from '../../src/v12/dispatcher';

// Restrict the real registry to the real friend and info ActionSpecs. Avoid
// importing unrelated actions (including network/download and file streaming).
vi.mock('../../src/actions/message', () => ({ actions: [] }));
vi.mock('../../src/actions/group-info', () => ({ actions: [] }));
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

const marker = 'synthetic-friend-unique-marker-4d3d';
const request = { action: 'get_friend_list', params: {}, echo: 'fixture-echo' };
let captured: LogEntry[];
let unsubscribe: () => void;
let previousLevel: string;

beforeEach(() => {
    previousLevel = getLogLevel();
    setLogLevel('trace');
    captured = [];
    unsubscribe = subscribeLogs((entry) => captured.push(entry));
});

afterEach(() => {
    unsubscribe();
    setLogLevel(previousLevel);
});

function fixture(provider: ApiActionContext['getFriendList']) {
    const api = new ApiHandler({
        getFriendList: provider,
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

describe('friend-list logging with real dispatch and synthetic providers', () => {
    it('does not traverse a row for TRACE and maps only four v12 fields', async () => {
        let getterReads = 0;
        const row = { user_id: 42, nickname: marker, remark: 'fixture-remark' };
        Object.defineProperty(row, 'extra', {
            enumerable: true,
            get() {
                getterReads += 1;
                throw new Error(marker);
            },
        });
        const provider = vi.fn(async () => [row]);
        const { dispatcher, handle } = fixture(provider);
        const result = await dispatcher.handle(request);

        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'fixture-echo',
            data: [
                {
                    user_id: '42',
                    user_name: marker,
                    user_displayname: '',
                    user_remark: 'fixture-remark',
                },
            ],
        });
        expect(getterReads).toBe(0);
        expect(provider).toHaveBeenCalledExactlyOnceWith(false);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        expect(
            actionLogs().some(
                (entry) => entry.level === 'trace' && entry.message.includes('action_terminal'),
            ),
        ).toBe(true);
        assertCleanActionDiagnostics();
    });

    it('preserves v11 error wording while v12 returns its fixed unavailable response', async () => {
        const error = new Error(marker);
        const provider11 = vi.fn(async () => {
            throw error;
        });
        const provider12 = vi.fn(async () => {
            throw error;
        });
        const v11 = fixture(provider11);
        const v12 = fixture(provider12);
        const directResult = await v11.api.handle('get_friend_list', {});
        const mappedResult = await v12.dispatcher.handle(request);

        expect(directResult).toMatchObject({ status: 'failed', retcode: 100, wording: marker });
        expect(mappedResult).toEqual({
            status: 'failed',
            retcode: 20002,
            message: 'friend list unavailable',
            data: null,
            echo: 'fixture-echo',
        });
        expect(provider11).toHaveBeenCalledExactlyOnceWith(false);
        expect(provider12).toHaveBeenCalledExactlyOnceWith(false);
        expect(v11.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        expect(v12.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        expect(actionLogs().filter((entry) => entry.level === 'warn')).toHaveLength(2);
        assertCleanActionDiagnostics();
    });

    it('limits observer-error logging but observers still receive the raw v11 response', async () => {
        const row = { user_id: 42, nickname: marker, remark: 'fixture-remark' };
        const provider = vi.fn(async () => [row]);
        const { api, dispatcher, handle } = fixture(provider);
        const records: ActionRecord[] = [];
        const second = vi.fn((_record: ActionRecord) => {});
        api.setObserver((record) => {
            records.push(record);
            throw new Error(marker);
        });
        api.setObserver(second);
        const result = await dispatcher.handle(request);

        expect(result.status).toBe('ok');
        expect(records).toHaveLength(1);
        expect(records[0]?.action).toBe('get_friend_list');
        expect(records[0]?.response.data).toEqual([row]);
        expect((records[0]?.response.data as unknown[])[0]).toBe(row);
        expect(second).toHaveBeenCalledTimes(1);
        expect(second.mock.calls[0]?.[0].response).toBe(records[0]?.response);
        expect(provider).toHaveBeenCalledExactlyOnceWith(false);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        expect(actionLogs().filter((entry) => entry.level === 'warn')).toHaveLength(1);
        assertCleanActionDiagnostics();
    });

    it('retains verbose TRACE for an unrelated action', async () => {
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

describe('contact-actions synthetic bridge fallback logging', () => {
    it('keeps the cached roster and device entries; withProfile rethrows the same error', async () => {
        const error = new Error(marker);
        const fetchFriendList = vi.fn(async () => {
            throw error;
        });
        const bridge = {
            apis: { contacts: { fetchFriendList } },
            identity: { friends: [{ uin: 42, nickname: 'cached-name', remark: 'cached-remark' }] },
        } as unknown as BridgeInterface;
        const fallback = await getFriendList(bridge, false);
        const profileFailure = await getFriendList(bridge, true).then(
            () => ({ resolved: true as const }),
            (reason: unknown) => ({ resolved: false as const, reason }),
        );

        expect(fallback).toEqual([
            { user_id: 42, nickname: 'cached-name', remark: 'cached-remark' },
            { user_id: 0x7e000001, nickname: '我的电脑', remark: '我的电脑' },
            { user_id: 0x7e000002, nickname: '我的手机', remark: '我的手机' },
            { user_id: 0x7e000003, nickname: '我的Pad', remark: '我的Pad' },
        ]);
        expect(profileFailure).toEqual({ resolved: false, reason: error });

        if (!profileFailure.resolved) {
            expect(profileFailure.reason).toBe(error);
        }

        expect(fetchFriendList).toHaveBeenCalledTimes(2);
        expect(fetchFriendList).toHaveBeenNthCalledWith(1, { withProfile: false });
        expect(fetchFriendList).toHaveBeenNthCalledWith(2, { withProfile: true });
        const warnings = captured.filter(
            (entry) => entry.scope === 'OneBot.Contacts' && entry.level === 'warn',
        );
        expect(warnings).toHaveLength(2);
        expect(warnings[0]?.message).toContain('friend list refresh failed');
        expect(warnings[1]?.message).toContain('friend list refresh failed');
        expect(warnings.map((entry) => entry.line).join('\n')).not.toContain(marker);
        expect(warnings.map((entry) => entry.message).join('\n')).not.toMatch(/\bat\s+.+:\d+:\d+/);
    });
});
