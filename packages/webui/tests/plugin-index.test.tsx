import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createLocalOperationTracker,
    createPluginRequestScope,
    hasCurrentUnknownCheck,
    LocalPluginList,
    PluginIndexContent,
    PluginIndexSwap,
    PluginsPanel,
    withPluginIndexLoading,
} from '../src/components/settings/plugins-panel';
import { createApiClient } from '../src/lib/api/client';
import type { CommunityIndexResult, LocalPluginsResult } from '../src/lib/api/types';
import {
    filterPlugins,
    parsePluginIndex,
    parseLocalPlugins,
    parseLocalPluginMutation,
    safePluginHomepage,
} from '../src/lib/plugin-index';
import { SETTINGS_TABS, settingsRoute } from '../src/router';

const indexRequest = vi.fn();
vi.mock('@/lib/api', () => ({ useApi: () => ({ plugins: { index: indexRequest } }) }));
vi.mock('@/contexts/AppStateContext', () => ({
    useAppState: () => ({
        qqList: [],
        resources: { qqList: { ready: true, error: null } },
        selectedUin: null,
        setSelectedUin: vi.fn(),
    }),
}));
vi.mock('@/contexts/ActionFeedbackContext', () => ({
    actionErrorMessage: (error: unknown) => String(error),
    useActionFeedback: () => ({ startAction: vi.fn() }),
}));
const tokenStore = { load: () => 'token', save: () => undefined };
const plugin = {
    id: 'napcat-plugin-test',
    name: '测试',
    version: '1.2.3',
    description: '说明',
    author: '<作者>',
    homepage: 'https://example.com/project',
    downloadUrl: 'https://example.com/file.zip',
    tags: ['工具'],
    minVersion: '4.14.0',
};
const result: CommunityIndexResult = {
    index: { version: '1', updateTime: '2026-01-01', plugins: [plugin] },
    fetchedAt: 1767225600000,
    stale: false,
    error: null,
    verified: false,
    minVersionTarget: 'NapCat',
};
const localFixture: LocalPluginsResult = {
    status: 'ok',
    accountOnline: true,
    candidates: ['example'],
    runtime: [],
    actions: [
        {
            id: 'example',
            canEnable: true,
            canDisable: false,
            enableReason: null,
            disableReason: 'NOT_LOADED',
        },
    ],
    pendingOperations: [],
    processResources: 'unknown',
};
const render = (value: CommunityIndexResult, query = '') =>
    renderToStaticMarkup(
        <PluginIndexContent result={value} query={query} onQueryChange={() => undefined} />,
    );

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    indexRequest.mockClear();
});

describe('community plugin index', () => {
    it('registers a deep-linkable settings tab and does not fetch at render', () => {
        expect(SETTINGS_TABS).toContain('plugins');
        const validateSearch = settingsRoute.options.validateSearch;
        expect(typeof validateSearch).toBe('function');

        if (typeof validateSearch === 'function') {
            expect(validateSearch({ tab: 'plugins' })).toEqual({ tab: 'plugins' });
            expect(validateSearch({ tab: 'unknown' })).toEqual({});
        }

        const html = renderToStaticMarkup(<PluginsPanel />);
        expect(indexRequest).not.toHaveBeenCalled();
        expect(html).toContain('暂无可选择的账号');
        expect(html).toContain('社区索引仅供浏览');
        expect(html).toContain('插件以霁羽进程完整权限执行');
        expect(html).toContain('https://github.com/HolyFoxTeam/napcat-plugin-community-index');
        expect(html).not.toContain('安装成功');
        expect(html).not.toContain('启用插件');
    });
    it('releases the skeleton box around loaded content while reserving loading space', () => {
        const content = (
            <PluginIndexContent result={result} query="" onQueryChange={() => undefined} />
        );
        const loaded = renderToStaticMarkup(<PluginIndexSwap ready>{content}</PluginIndexSwap>);
        const pending = renderToStaticMarkup(
            <PluginIndexSwap ready={false}>{null}</PluginIndexSwap>,
        );
        expect(loaded).toMatch(/aria-busy="false"[^>]*class="[^"]*skeleton-swap-fluid/);
        expect(loaded).toContain('&lt;作者&gt;');
        expect(pending).toContain('aria-busy="true"');
        expect(pending).toContain('height:84px');
        expect(pending).not.toContain('skeleton-swap-fluid');
    });
    it('retains and escapes authors while labeling compatibility and NapCat versions', () => {
        const html = render(result);
        expect(html).toContain('&lt;作者&gt;');
        expect(html).not.toContain('<作者>');
        expect(html).toContain('Jiyu 兼容性未知');
        expect(html).toContain('最低 NapCat 版本：4.14.0');
        expect(html).toContain('href="https://example.com/project"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).not.toContain('file.zip');
    });
    it('never navigates to unsafe homepages', () => {
        for (const homepage of [
            'javascript:alert(1)',
            'http://example.com',
            'https://u:p@example.com',
        ]) {
            expect(safePluginHomepage(homepage)).toBeNull();
            const html = render({
                ...result,
                index: { ...result.index!, plugins: [{ ...plugin, homepage }] },
            });
            expect(html).not.toContain(`href="${homepage}"`);
        }
    });
    it('searches locally without losing metadata', () => {
        expect(filterPlugins([plugin], '作者')).toEqual([plugin]);
        expect(filterPlugins([plugin], '工具')).toEqual([plugin]);
        expect(render(result, 'missing')).toContain('没有匹配的插件');
    });
    it('distinguishes unavailable, stale, and empty data', () => {
        expect(
            render({
                index: null,
                fetchedAt: null,
                stale: true,
                error: 'network',
                verified: false,
                minVersionTarget: 'NapCat',
            }),
        ).toContain('索引未载入：网络请求失败');
        const stale = render({ ...result, stale: true, error: 'timeout' });
        expect(stale).toContain('索引可能已过期：请求超时');
        expect(stale).toContain('&lt;作者&gt;');
        expect(render({ ...result, index: { ...result.index!, plugins: [] } })).toContain(
            '社区索引当前没有插件',
        );
    });
    it('validates object shape and preserves unavailable results', () => {
        expect(parsePluginIndex(result)).toEqual(result);
        const withoutTags = { ...plugin, tags: undefined };
        const optionalTags = { ...result, index: { ...result.index!, plugins: [withoutTags] } };
        expect(parsePluginIndex(optionalTags)).toEqual(optionalTags);
        expect(render(optionalTags, '作者')).toContain('&lt;作者&gt;');

        for (const invalid of [
            {},
            { ...result, index: {} },
            { ...result, index: { ...result.index!, plugins: [{}] } },
            { ...result, verified: true },
        ]) {
            expect(() => parsePluginIndex(invalid)).toThrow('插件索引响应格式无效');
        }
    });
    it('aborts an old body on refresh without clearing the new loading state', async () => {
        const cancelOld = vi.fn();
        const oldBody = new ReadableStream<Uint8Array>({ cancel: cancelOld });
        const nextResponse = Promise.withResolvers<Response>();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(oldBody))
            .mockReturnValueOnce(nextResponse.promise);
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        const scope = createPluginRequestScope();
        const setLoading = vi.fn();
        expect(fetchMock).not.toHaveBeenCalled();
        const first = scope.start();
        const firstResult = withPluginIndexLoading(setLoading, first.isCurrent, () =>
            client.plugins.index(false, first.signal),
        );
        const firstFailure = expect(firstResult).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(oldBody.locked).toBe(true));
        const second = scope.start();
        const secondResult = withPluginIndexLoading(setLoading, second.isCurrent, () =>
            client.plugins.index(true, second.signal),
        );
        await firstFailure;
        first.finish();
        expect(first.signal.aborted).toBe(true);
        expect(cancelOld).toHaveBeenCalledOnce();
        expect(second.isCurrent()).toBe(true);
        expect(setLoading.mock.calls).toEqual([[true], [true]]);
        nextResponse.resolve(Response.json(result));
        await expect(secondResult).resolves.toEqual(result);
        second.finish();
        expect(setLoading.mock.calls).toEqual([[true], [true], [false]]);
    });
    it('aborts the active reader on cleanup and ignores its late completion', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
        const client = createApiClient({ tokenStore });
        const scope = createPluginRequestScope();
        const setLoading = vi.fn();
        const current = scope.start();
        const request = withPluginIndexLoading(setLoading, current.isCurrent, () =>
            client.plugins.index(false, current.signal),
        );
        const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(body.locked).toBe(true));
        scope.cancel();
        await rejected;
        current.finish();
        expect(current.signal.aborted).toBe(true);
        expect(current.isCurrent()).toBe(false);
        expect(cancel).toHaveBeenCalledOnce();
        expect(setLoading.mock.calls).toEqual([[true]]);
    });
    it('times out a stalled response body, cancels the reader and releases loading for retry', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"index":'));
            },
            cancel,
        });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(body, { status: 200 }))
            .mockResolvedValueOnce(Response.json(result));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        const setLoading = vi.fn();
        const request = withPluginIndexLoading(
            setLoading,
            () => true,
            () => client.plugins.index(),
        );
        const rejection = expect(request).rejects.toMatchObject({
            status: 408,
            code: 'REQUEST_TIMEOUT',
        });
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;
        expect(cancel).toHaveBeenCalledOnce();
        expect(setLoading.mock.calls).toEqual([[true], [false]]);
        await expect(
            withPluginIndexLoading(
                setLoading,
                () => true,
                () => client.plugins.index(true),
            ),
        ).resolves.toEqual(result);
        expect(setLoading.mock.calls).toEqual([[true], [false], [true], [false]]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('preserves caller abort during a stalled body and removes its listener', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
        const client = createApiClient({ tokenStore });
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const request = client.plugins.index(false, controller.signal);
        await vi.waitFor(() => expect(body.locked).toBe(true));
        controller.abort();
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancel).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
    it('allows a slow body to complete and retains HTTP 401 handling', async () => {
        vi.useFakeTimers();
        let writer!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                writer = controller;
            },
        });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(body))
            .mockResolvedValueOnce(
                Response.json({ message: '登录失效', code: 'EXPIRED' }, { status: 401 }),
            );
        vi.stubGlobal('fetch', fetchMock);
        const onUnauthorized = vi.fn();
        const client = createApiClient({ tokenStore, onUnauthorized });
        const pending = client.plugins.index();
        await vi.advanceTimersByTimeAsync(29_000);
        writer.enqueue(new TextEncoder().encode(JSON.stringify(result)));
        writer.close();
        await expect(pending).resolves.toEqual(result);
        await expect(client.plugins.index()).rejects.toMatchObject({
            status: 401,
            code: 'EXPIRED',
            message: '登录失效',
        });
        expect(onUnauthorized).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('isolates pending and uncertain operations by account and never clears a pending write', () => {
        const tracker = createLocalOperationTracker();
        expect(tracker.begin('12345')).toBe(true);
        expect(tracker.begin('12345')).toBe(false);
        expect(tracker.begin('67890')).toBe(true);
        tracker.clearUnknown('12345');
        tracker.finish('12345', true);
        expect(tracker.snapshot()).toEqual({ '12345': 'unknown', '67890': 'pending' });
        tracker.finish('67890', false);
        expect(tracker.snapshot()).toEqual({ '12345': 'unknown' });
        expect(tracker.begin('12345')).toBe(false);
        tracker.clearUnknown('12345');
        expect(tracker.begin('12345')).toBe(true);
    });
    it('survives unsubscribe and remount while old writes settle, with stable immutable snapshots', async () => {
        const tracker = createLocalOperationTracker();
        const oldListener = vi.fn();
        const unsubscribeOld = tracker.subscribe(oldListener);
        const initial = tracker.snapshot();
        expect(tracker.snapshot()).toBe(initial);
        expect(Object.isFrozen(initial)).toBe(true);
        expect(tracker.begin('12345')).toBe(true);
        const pending = tracker.snapshot();
        expect(pending).toEqual({ '12345': 'pending' });
        expect(Object.isFrozen(pending)).toBe(true);
        unsubscribeOld();
        const remounted = vi.fn();
        const unsubscribeNew = tracker.subscribe(remounted);
        const late = Promise.withResolvers<void>();
        const finished = late.promise.then(() => tracker.finish('12345', true));
        expect(tracker.begin('12345')).toBe(false);
        late.resolve();
        await finished;
        expect(oldListener).toHaveBeenCalledTimes(1);
        expect(remounted).toHaveBeenCalledTimes(1);
        expect(tracker.snapshot()).toEqual({ '12345': 'unknown' });
        expect(hasCurrentUnknownCheck('12345', tracker.snapshot(), null)).toBe(false);
        const manuallyChecked = tracker.snapshot();
        expect(hasCurrentUnknownCheck('12345', tracker.snapshot(), manuallyChecked)).toBe(true);
        tracker.begin('67890');
        expect(hasCurrentUnknownCheck('12345', tracker.snapshot(), manuallyChecked)).toBe(false);
        tracker.clearUnknown('12345');
        unsubscribeNew();
        const callCount = remounted.mock.calls.length;
        tracker.finish('67890', false);
        expect(remounted).toHaveBeenCalledTimes(callCount);
        expect(tracker.snapshot()).toEqual({});
    });
    it('shows candidates, runtime failures, pending operations and unknown resource status separately', () => {
        const fixture: LocalPluginsResult = {
            ...localFixture,
            runtime: [
                {
                    id: 'other',
                    state: 'cleanup_failed',
                    cleanupFailed: true,
                    initializationFailed: true,
                    pendingActions: 2,
                    processResources: 'unknown',
                },
            ],
            pendingOperations: [
                {
                    id: 'example',
                    operation: 'enable',
                    phase: 'resolving',
                    cancelled: true,
                    currentInstance: false,
                },
            ],
        };
        const html = renderToStaticMarkup(
            <LocalPluginList data={fixture} blocked={false} onChoose={() => undefined} />,
        );
        expect(html).toContain('当前宿主未加载');
        expect(html).toContain('当前目录未发现对应候选项');
        expect(html).toContain('清理失败');
        expect(html).toContain('初始化失败：是');
        expect(html).toContain('旧实例');
        expect(html).toContain('进程资源状态未知');
        expect(html).not.toContain('卸载成功');
    });
    it('uses backend capabilities and keeps offline and missing capabilities disabled', () => {
        const offline = { ...localFixture, accountOnline: false, runtime: null };
        const html = renderToStaticMarkup(
            <LocalPluginList data={offline} blocked={false} onChoose={() => undefined} />,
        );
        expect(html).toContain('账号运行实例不可用');
        expect(html).toMatch(/disabled=""[^>]*>启用/);
        expect(html).toMatch(/disabled=""[^>]*>停用/);
        const noActions = renderToStaticMarkup(
            <LocalPluginList
                data={{ ...localFixture, actions: [] }}
                blocked={false}
                onChoose={() => undefined}
            />,
        );
        expect(noActions).toContain('动作能力未知');
        expect(noActions).toMatch(/disabled=""[^>]*>启用/);
    });
    it('validates local API data and explicit operation results without interpreting extensions', () => {
        expect(parseLocalPlugins(localFixture)).toEqual(localFixture);
        expect(() => parseLocalPlugins({ ...localFixture, pendingOperations: 'bad' })).toThrow(
            '本地插件响应格式无效',
        );
        expect(() =>
            parseLocalPlugins({
                ...localFixture,
                actions: [{ ...localFixture.actions[0], canEnable: 'true' }],
            }),
        ).toThrow('本地插件响应格式无效');
        expect(() => parseLocalPlugins({ ...localFixture, candidates: ['../x'] })).toThrow(
            '本地插件响应格式无效',
        );
        const cancelled = {
            status: 'ok',
            operation: 'disable',
            runtime: null,
            processResources: 'unknown',
            outcome: 'cancelled_before_execution',
            extension: 7,
        };
        expect(parseLocalPluginMutation(cancelled, 'disable')).toEqual(cancelled);
        expect(() => parseLocalPluginMutation(cancelled, 'enable')).toThrow('本地插件响应格式无效');
    });
    it('requests local state and posts explicit account and plugin without a body', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json(localFixture))
            .mockResolvedValueOnce(
                Response.json({
                    status: 'ok',
                    operation: 'enable',
                    runtime: null,
                    processResources: 'unknown',
                }),
            );
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        await expect(client.plugins.local('12345')).resolves.toEqual(localFixture);
        await expect(client.plugins.change('12345', 'example', 'enable')).resolves.toMatchObject({
            status: 'ok',
        });
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            '/api/plugins/local/12345',
            expect.objectContaining({ headers: new Headers({ 'X-SnowLuma-Token': 'token' }) }),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            '/api/plugins/local/12345/example/enable',
            expect.objectContaining({
                method: 'POST',
                headers: new Headers({ 'X-SnowLuma-Token': 'token' }),
            }),
        );
        expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('does not turn local catalog errors or failed writes into success', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json(
                    { status: 'failed', code: 'LOCAL_CATALOG_UNAVAILABLE' },
                    { status: 503 },
                ),
            )
            .mockResolvedValueOnce(
                Response.json(
                    {
                        status: 'failed',
                        code: 'PLUGIN_ENABLE_FAILED',
                        outcome: 'unknown',
                        runtime: null,
                        processResources: 'unknown',
                    },
                    { status: 409 },
                ),
            );
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        await expect(client.plugins.local('12345')).rejects.toMatchObject({
            status: 503,
            code: 'LOCAL_CATALOG_UNAVAILABLE',
        });
        await expect(client.plugins.change('12345', 'example', 'enable')).rejects.toMatchObject({
            status: 409,
            code: 'PLUGIN_ENABLE_FAILED',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('times out a stalled mutation without replaying the POST', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        const request = client.plugins.change('12345', 'example', 'enable');
        const rejected = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(30_000);
        await rejected;
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    });
    it.each([0, 1])(
        'bounds a fragmented body with %i-byte chunks and releases its reader',
        async (size) => {
            const read = vi.fn(async () => ({ done: false, value: new Uint8Array(size) }));
            const cancel = vi.fn(() => new Promise<void>(() => {}));
            const releaseLock = vi.fn();
            const response = {
                ok: true,
                status: 200,
                body: { getReader: () => ({ read, cancel, releaseLock }) },
            } as unknown as Response;
            const fetchMock = vi.fn().mockResolvedValue(response);
            vi.stubGlobal('fetch', fetchMock);
            const client = createApiClient({ tokenStore });
            await expect(client.plugins.index()).rejects.toMatchObject({
                code: 'INVALID_RESPONSE',
            });
            expect(read).toHaveBeenCalledTimes(8193);
            expect(cancel).toHaveBeenCalledOnce();
            expect(releaseLock).toHaveBeenCalledOnce();
            expect(fetchMock).toHaveBeenCalledOnce();
        },
    );
    it.each(['throws', 'rejects'])(
        'releases the reader when overflow cancellation %s',
        async (mode) => {
            const read = vi.fn(async () => ({ done: false, value: new Uint8Array(0) }));
            const cancel = vi.fn(() => {
                if (mode === 'throws') {
                    throw new Error('cancel failed');
                }

                return Promise.reject(new Error('cancel rejected'));
            });
            const releaseLock = vi.fn();
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    status: 200,
                    body: { getReader: () => ({ read, cancel, releaseLock }) },
                }),
            );
            await expect(createApiClient({ tokenStore }).plugins.index()).rejects.toMatchObject({
                code: 'INVALID_RESPONSE',
            });
            expect(cancel).toHaveBeenCalledOnce();
            expect(releaseLock).toHaveBeenCalledOnce();
        },
    );
    it('accepts a valid response split across exactly 8192 chunks', async () => {
        const text = JSON.stringify(result).padEnd(8192, ' ');
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (index === text.length) {
                    controller.close();
                    return;
                }

                controller.enqueue(new TextEncoder().encode(text[index++]));
            },
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
        await expect(createApiClient({ tokenStore }).plugins.index()).resolves.toEqual(result);
    });
    it.each(['throws', 'rejects', 'never'])(
        'cancels a late response even when cancel %s',
        async (mode) => {
            vi.useFakeTimers();
            const deferred = Promise.withResolvers<Response>();
            vi.stubGlobal('fetch', vi.fn().mockReturnValue(deferred.promise));
            const unauthorized = vi.fn();
            const client = createApiClient({ tokenStore, onUnauthorized: unauthorized });
            const request = client.plugins.index();
            const rejected = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
            await vi.advanceTimersByTimeAsync(30_000);
            await rejected;
            const cancel = vi.fn(() => {
                if (mode === 'throws') {
                    throw new Error('cancel failed');
                }

                if (mode === 'rejects') {
                    return Promise.reject(new Error('cancel rejected'));
                }

                return new Promise<void>(() => {});
            });
            deferred.resolve({ status: 401, body: { cancel } } as unknown as Response);
            await Promise.resolve();
            await Promise.resolve();
            expect(cancel).toHaveBeenCalledOnce();
            expect(unauthorized).not.toHaveBeenCalled();
        },
    );
    it('releases a non-cooperative pending reader at deadline without awaiting cancellation', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const releaseLock = vi.fn();
        const reader = { read: () => new Promise<never>(() => {}), cancel, releaseLock };
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ status: 200, ok: true, body: { getReader: () => reader } }),
        );
        const pending = createApiClient({ tokenStore }).plugins.index();
        const rejected = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(30_000);
        await rejected;
        expect(cancel).toHaveBeenCalledOnce();
        expect(releaseLock).toHaveBeenCalledOnce();
    });
    it('uses the session header and explicit refresh query', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        await expect(client.plugins.index()).resolves.toEqual(result);
        await client.plugins.index(true);
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            '/api/plugins/index',
            expect.objectContaining({ headers: new Headers({ 'X-SnowLuma-Token': 'token' }) }),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            '/api/plugins/index?refresh=1',
            expect.anything(),
        );
    });
});
