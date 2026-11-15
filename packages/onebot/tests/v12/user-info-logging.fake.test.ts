import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ApiHandler, type ApiActionContext, type ActionRecord } from '../../src/api-handler';
import { getStrangerInfo } from '../../src/modules/contact-actions';
import { V12Dispatcher } from '../../src/v12/dispatcher';

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

const marker = 'synthetic-private-user-name-or-error';
const userId = 67291041;
const accountId = '90461023';
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

function fixture(provider: ApiActionContext['getStrangerInfo']) {
    const api = new ApiHandler({
        getStrangerInfo: provider,
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

const request = { action: 'get_user_info', params: { user_id: String(userId) }, echo: 'e' };
const actionLogs = () => entries.filter((entry) => entry.scope === 'Bridge.Action');

function expectActionRedacted(outcome: 'ok' | 'failed', reason: string) {
    const logs = actionLogs();
    expect(
        logs.some(
            (e) =>
                e.level === 'trace' &&
                e.message.includes('action_input action=get_stranger_info') &&
                e.message.includes('params=[redacted]'),
        ),
    ).toBe(true);
    expect(
        logs.some(
            (e) =>
                e.level === 'trace' &&
                e.message.includes('action_terminal action=get_stranger_info') &&
                e.message.includes(`outcome=${outcome}`) &&
                e.message.includes(`reason=${reason}`) &&
                e.message.includes('response=[redacted]'),
        ),
    ).toBe(true);
    expect(
        logs.some(
            (e) =>
                e.level === 'debug' &&
                e.message.includes('get_stranger_info') &&
                e.message.includes('params=[redacted]'),
        ),
    ).toBe(true);
    const text = logs.map((e) => e.line).join('\n');
    expect(text).not.toContain(marker);
    expect(text).not.toContain(String(userId));
}

function expectContactWarning(id: number) {
    const warnings = entries.filter((e) => e.scope === 'OneBot.Contacts' && e.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('user profile refresh failed');
    const text = warnings.map((e) => e.line).join('\n');
    expect(text).not.toContain(String(id));
    expect(text).not.toContain(marker);
    expect(text).not.toMatch(/\bat\s+.+:\d+:\d+/);
}

describe('real action diagnostics for fake user providers', () => {
    it('redacts action diagnostics while observers retain raw records and later observers run', async () => {
        const user = { user_id: userId, nickname: marker, remark: marker };
        let reads = 0;
        Object.defineProperty(user, 'extra', {
            enumerable: true,
            get() {
                reads++;
                throw new Error(marker);
            },
        });
        const provider = vi.fn(async () => user);
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
            data: {
                user_id: String(userId),
                user_name: marker,
                user_displayname: '',
                user_remark: marker,
            },
        });
        expect(provider).toHaveBeenCalledExactlyOnceWith(userId);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: userId });
        expect(order).toEqual(['first', 'second']);
        expect(records).toHaveLength(2);
        expect(records[0]?.params).toEqual({ user_id: userId });
        expect(records[1]?.params).toBe(records[0]?.params);
        expect(records[0]?.response.data).toBe(user);
        expect(records[1]?.response).toBe(records[0]?.response);
        expect(reads).toBe(0);
        expect(
            actionLogs()
                .filter((e) => e.level === 'warn')
                .map((e) => e.message),
        ).toEqual(['get_stranger_info action observer error: [redacted]']);
        expectActionRedacted('ok', 'response_returned');
    });

    it('redacts handler errors while preserving the raw v11 observer response', async () => {
        const provider = vi.fn(async () => {
            throw new Error(marker);
        });
        const { api, subject, handle } = fixture(provider);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const result = await subject.handle(request);
        expect(result).toEqual({
            status: 'failed',
            retcode: 20002,
            message: 'user info unavailable',
            data: null,
            echo: 'e',
        });
        expect(records).toHaveLength(1);
        expect(records[0]?.params).toEqual({ user_id: userId });
        expect(records[0]?.response).toMatchObject({
            status: 'failed',
            retcode: 100,
            wording: marker,
        });
        expect(provider).toHaveBeenCalledExactlyOnceWith(userId);
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: userId });
        expect(
            actionLogs()
                .filter((e) => e.level === 'warn')
                .map((e) => e.message),
        ).toEqual(['get_stranger_info failed: [redacted]']);
        expectActionRedacted('failed', 'handler_threw');
        expect(JSON.stringify(result)).not.toContain(marker);
    });

    it('keeps the ordinary verbose trace on a different action', async () => {
        const provider = vi.fn(async () => ({ user_id: userId, nickname: marker, remark: '' }));
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

const profile = (id: number) => ({
    uin: id,
    uid: `u_${id}`,
    nickname: 'cached',
    remark: '',
    qid: '',
    sex: 'unknown',
    age: 0,
    sign: '',
    avatar: '',
    level: 0,
    qidianMasterFlag: 0,
    qidianCrewFlag: 0,
    qidianCrewFlag2: 0,
});

describe('real getStrangerInfo and synthetic bridge', () => {
    it('returns the device pseudo-contact without fetching a profile', async () => {
        const fetchUserProfile = vi.fn(async () => {
            throw new Error(marker);
        });
        const bridge = { apis: { contacts: { fetchUserProfile } } } as unknown as BridgeInterface;
        const result = await getStrangerInfo(bridge, 0x7e000001);
        expect(result).toEqual({
            user_id: 0x7e000001,
            nickname: '我的电脑',
            remark: '我的电脑',
            sex: 'unknown',
            age: 0,
            long_nick: '',
        });
        expect(fetchUserProfile).not.toHaveBeenCalled();
        expect(
            entries.filter((e) => e.scope === 'OneBot.Contacts' && e.level === 'warn'),
        ).toHaveLength(0);
    });

    it.each(['profile', 'friend', 'none'] as const)(
        'uses %s fallback after rejection without logging identifiers or errors',
        async (mode) => {
            const id = 67292031;
            const fetchUserProfile = vi.fn(async () => {
                throw new Error(`${marker}:${id}`);
            });
            const findUserProfile = vi.fn(() => (mode === 'profile' ? profile(id) : null));
            const findFriend = vi.fn(() =>
                mode === 'none' ? null : { uin: id, nickname: 'friend', remark: 'friend remark' },
            );
            const bridge = {
                identity: { findUserProfile, findFriend },
                apis: { contacts: { fetchUserProfile } },
            } as unknown as BridgeInterface;
            const result = await getStrangerInfo(bridge, id);

            if (mode === 'profile') {
                expect(result).toMatchObject({
                    user_id: id,
                    nickname: 'cached',
                    remark: 'friend remark',
                });
            } else if (mode === 'friend') {
                expect(result).toEqual({
                    user_id: id,
                    nickname: 'friend',
                    remark: 'friend remark',
                    sex: 'unknown',
                    age: 0,
                    long_nick: '',
                });
            } else {
                expect(result).toBeNull();
            }

            expect(fetchUserProfile).toHaveBeenCalledExactlyOnceWith(id);
            expect(findUserProfile).toHaveBeenCalledExactlyOnceWith(id);
            expect(findFriend).toHaveBeenCalledExactlyOnceWith(id);
            expectContactWarning(id);
        },
    );

    it('keeps enterprise lookup best-effort when its fake callback rejects', async () => {
        const id = 67292032;
        const fetchUserProfile = vi.fn(async () => ({ ...profile(id), qidianCrewFlag: 1 }));
        const fetchQidianCorpInfo = vi.fn(async () => {
            throw new Error(marker);
        });
        const bridge = {
            apis: { contacts: { fetchUserProfile, fetchQidianCorpInfo } },
        } as unknown as BridgeInterface;
        const result = await getStrangerInfo(bridge, id);
        expect(result).toMatchObject({
            user_id: id,
            nickname: 'cached',
            qidian_crew_flag: 1,
            qidian_enterprise_name: '',
        });
        expect(fetchUserProfile).toHaveBeenCalledExactlyOnceWith(id);
        expect(fetchQidianCorpInfo).toHaveBeenCalledExactlyOnceWith(id);
        expect(
            entries.filter((e) => e.scope === 'OneBot.Contacts' && e.level === 'warn'),
        ).toHaveLength(0);
    });
});
