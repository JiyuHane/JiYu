import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownSelect } from '@/components/ui/dropdown-select';
import { useAppState } from '@/contexts/AppStateContext';
import { Input } from '@/components/ui/input';
import { actionErrorMessage, useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useApi } from '@/lib/api';
import { ApiError, type CommunityIndexResult, type LocalPluginsResult } from '@/lib/api/types';
import { filterPlugins, safePluginHomepage } from '@/lib/plugin-index';

const INDEX_REPOSITORY = 'https://github.com/HolyFoxTeam/napcat-plugin-community-index';
const ERROR_LABELS: Record<NonNullable<CommunityIndexResult['error']>, string> = {
    timeout: '请求超时',
    network: '网络请求失败',
    http: '索引服务响应失败',
    too_large: '索引数据过大',
    invalid: '索引数据格式无效',
};

export function PluginsPanel() {
    const api = useApi();
    const { startAction } = useActionFeedback();
    const [result, setResult] = useState<CommunityIndexResult | null>(null);
    const [requestError, setRequestError] = useState('');
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [requestScope] = useState(createPluginRequestScope);

    const load = useCallback(
        async (refresh: boolean) => {
            const request = requestScope.start();
            const activity = refresh ? startAction({ title: '正在刷新插件索引' }) : null;
            setRequestError('');

            await withPluginIndexLoading(setLoading, request.isCurrent, async () => {
                try {
                    const next = await api.plugins.index(refresh, request.signal);

                    if (!request.isCurrent()) {
                        if (activity) {
                            activity.fail('页面已切换，刷新结果未显示');
                        }

                        return;
                    }

                    setResult(next);

                    if (next.error || next.stale || !next.index) {
                        activity?.fail(next.error ? ERROR_LABELS[next.error] : '索引数据未更新');
                    } else {
                        activity?.succeed({ title: '插件索引已刷新' });
                    }
                } catch (error) {
                    if (!request.isCurrent()) {
                        activity?.fail('刷新已取消', { title: '插件索引刷新已取消' });
                        return;
                    }

                    const message = actionErrorMessage(error);
                    setRequestError(message);
                    activity?.fail(message, { title: '插件索引刷新失败' });
                }
            });
            request.finish();
        },
        [api, requestScope, startAction],
    );

    useEffect(() => {
        void load(false);

        return () => {
            requestScope.cancel();
        };
    }, [load, requestScope]);

    return (
        <div className="flex flex-col gap-5">
            <LocalPluginsPanel />
            <Card>
                <CardHeader>
                    <CardTitle>社区插件索引</CardTitle>
                    <CardDescription>
                        社区索引仅供浏览，不提供从索引安装；本地候选插件可在上方按账号管理。收录不代表霁羽兼容或已验证。
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" asChild>
                            <a href={INDEX_REPOSITORY} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="size-4" /> 查看社区索引
                            </a>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={loading}
                            onClick={() => void load(true)}
                        >
                            <RefreshCw className="size-4" /> {loading ? '加载中…' : '刷新索引'}
                        </Button>
                    </div>
                    {requestError && (
                        <p role="alert" className="text-sm text-destructive">
                            索引请求失败：{requestError}
                            {result?.index ? '；显示上次载入的数据。' : ''}
                        </p>
                    )}
                    <PluginIndexSwap ready={!loading || result !== null}>
                        {result && (
                            <PluginIndexContent
                                result={result}
                                query={query}
                                onQueryChange={setQuery}
                            />
                        )}
                    </PluginIndexSwap>
                </CardContent>
            </Card>
        </div>
    );
}

export function createLocalOperationTracker() {
    let states: Readonly<Record<string, 'pending' | 'unknown'>> = Object.freeze({});
    const listeners = new Set<() => void>();
    const publish = () => listeners.forEach((listener) => listener());
    return {
        snapshot: () => states,
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        begin(uin: string): boolean {
            if (states[uin]) {
                return false;
            }

            states = Object.freeze({ ...states, [uin]: 'pending' });
            publish();
            return true;
        },
        finish(uin: string, unknown: boolean) {
            if (states[uin] !== 'pending') {
                return;
            }

            const next = { ...states };

            if (unknown) {
                next[uin] = 'unknown';
            } else {
                delete next[uin];
            }

            states = Object.freeze(next);
            publish();
        },
        clearUnknown(uin: string) {
            if (states[uin] !== 'unknown') {
                return;
            }

            const next = { ...states };
            delete next[uin];
            states = Object.freeze(next);
            publish();
        },
    };
}

export function hasCurrentUnknownCheck(
    uin: string,
    current: Readonly<Record<string, 'pending' | 'unknown'>>,
    checked: Readonly<Record<string, 'pending' | 'unknown'>> | null,
): boolean {
    return current[uin] === 'unknown' && checked === current;
}

// The store outlives a settings-panel mount, but not a browser reload or another tab.
const localOperationTracker = createLocalOperationTracker();

function LocalPluginsPanel() {
    const { qqList, resources, selectedUin, setSelectedUin } = useAppState();
    const accounts = qqList.filter((account) => /^\d{5,10}$/.test(account.uin));
    const selected = accounts.some((account) => account.uin === selectedUin) ? selectedUin : null;
    const api = useApi();
    const { startAction } = useActionFeedback();
    const tracker = localOperationTracker;
    const operations = useSyncExternalStore(tracker.subscribe, tracker.snapshot, tracker.snapshot);

    const change = async (uin: string, id: string, operation: 'enable' | 'disable') => {
        if (!tracker.begin(uin)) {
            return;
        }

        const action = startAction({
            title: operation === 'enable' ? '正在启用插件' : '正在停用插件',
            detail: `账号 ${uin} · ${id}`,
        });

        try {
            const result = await api.plugins.change(uin, id, operation);
            tracker.finish(uin, false);
            action.succeed({
                title:
                    result.outcome === 'cancelled_before_execution'
                        ? '已取消执行前的启用请求'
                        : '插件操作已完成',
                detail: `账号 ${uin} · ${id}；进程资源状态未知`,
            });
        } catch (error) {
            tracker.finish(uin, true);
            action.fail(
                `账号 ${uin} · ${id}：${localPluginError(error)}；结果可能未知，请查看状态。`,
                { title: '插件操作未确认' },
            );
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>本地插件</CardTitle>
                <CardDescription>
                    手动放置在本机插件目录中的候选项，不由社区索引自动安装。插件以霁羽进程完整权限执行，与霁羽的兼容性未知。
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <p className="text-xs text-muted-foreground">
                    操作锁仅在当前页面生命周期内保留；刷新页面或使用其他标签页后，请重新核对账号状态。
                </p>
                {!resources.qqList.ready ? (
                    <p className="text-sm text-muted-foreground">正在读取账号列表…</p>
                ) : resources.qqList.error ? (
                    <p role="alert" className="text-sm text-destructive">
                        账号列表读取失败：{resources.qqList.error}
                    </p>
                ) : accounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无可选择的账号。</p>
                ) : (
                    <>
                        <DropdownSelect
                            ariaLabel="选择插件管理账号"
                            value={selected ?? ''}
                            options={[
                                { value: '', label: '请选择账号' },
                                ...accounts.map((account) => ({
                                    value: account.uin,
                                    label: `${account.nickname || account.uin} (${account.uin})`,
                                })),
                            ]}
                            onChange={(uin) => setSelectedUin(uin || null)}
                        />
                        {selected ? (
                            <LocalAccountPlugins
                                key={selected}
                                uin={selected}
                                operationState={operations[selected] ?? null}
                                operationsSnapshot={operations}
                                change={change}
                                clearUnknown={() => {
                                    if (tracker.snapshot() === operations) {
                                        tracker.clearUnknown(selected);
                                    }
                                }}
                            />
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                请选择账号后查看本地候选项。
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

const LOCAL_REASONS: Record<string, string> = {
    ACCOUNT_OFFLINE: '账号运行实例不可用',
    INSTANCE_QUIESCED: '账号实例正在停止',
    OPERATION_PENDING: '启用操作进行中',
    NOT_CANDIDATE: '本机未发现候选目录',
    ALREADY_PRESENT: '宿主已有此插件',
    OLD_INSTANCE_PENDING: '旧实例仍有待完成操作',
    CANCELLATION_PENDING: '取消正在处理中',
    NOT_LOADED: '宿主未加载此插件',
    CLEANUP_IN_PROGRESS: '清理正在进行中',
    ENABLE_BUSY: '启用操作达到并发上限',
};

function localPluginError(error: unknown): string {
    if (error instanceof ApiError && error.code) {
        const labels: Record<string, string> = {
            LOCAL_CATALOG_UNAVAILABLE: '本地目录扫描失败或不完整',
            INSTANCE_CHANGED: '账号实例已更替，结果未知',
            ACCOUNT_OFFLINE: '账号运行实例不可用',
            PLUGIN_ALREADY_PRESENT: '宿主已有此插件',
            PLUGIN_NOT_ACTIVE: '宿主当前未加载此插件',
            PLUGIN_NOT_FOUND: '本机未发现候选插件',
            PLUGIN_ENABLE_FAILED: '启用失败，结果未知',
            PLUGIN_DISABLE_FAILED: '停用失败，结果未知',
            ENABLE_CANCELLED: '启用已在执行前取消',
            INSTANCE_QUIESCED: '账号实例正在停止',
            ENABLE_BUSY: '启用操作达到并发上限',
            REQUEST_TIMEOUT: '请求超时，结果未知',
        };
        return labels[error.code] ?? `服务返回错误（${error.code}）`;
    }

    return actionErrorMessage(error);
}

type LocalOperation = 'enable' | 'disable';

function LocalAccountPlugins({
    uin,
    operationState,
    operationsSnapshot,
    change,
    clearUnknown,
}: {
    uin: string;
    operationState: 'pending' | 'unknown' | null;
    operationsSnapshot: Readonly<Record<string, 'pending' | 'unknown'>>;
    change: (uin: string, id: string, operation: LocalOperation) => Promise<void>;
    clearUnknown: () => void;
}) {
    const api = useApi();
    const [data, setData] = useState<LocalPluginsResult | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [confirm, setConfirm] = useState<{ id: string; operation: LocalOperation } | null>(null);
    const [scope] = useState(createPluginRequestScope);
    const [checkedSnapshot, setCheckedSnapshot] = useState<Readonly<
        Record<string, 'pending' | 'unknown'>
    > | null>(null);
    const mounted = useRef(false);
    const load = useCallback(
        async (manualSnapshot?: Readonly<Record<string, 'pending' | 'unknown'>>) => {
            const request = scope.start();
            setLoading(true);
            setError('');

            try {
                const value = await api.plugins.local(uin, request.signal);

                if (request.isCurrent()) {
                    setData(value);

                    if (manualSnapshot?.[uin] === 'unknown') {
                        setCheckedSnapshot(manualSnapshot);
                    }
                }
            } catch (caught) {
                if (request.isCurrent()) {
                    setError(localPluginError(caught));
                }
            } finally {
                if (request.isCurrent()) {
                    setLoading(false);
                }

                request.finish();
            }
        },
        [api, scope, uin],
    );
    useEffect(() => {
        mounted.current = true;
        void load();

        return () => {
            mounted.current = false;
            scope.cancel();
        };
    }, [load, scope]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">当前账号：{uin}</span>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => void load(operationsSnapshot)}
                >
                    <RefreshCw className="size-4" /> {loading ? '读取中…' : '刷新本地状态'}
                </Button>
            </div>
            {operationState === 'pending' && (
                <p role="status" className="text-sm text-muted-foreground">
                    此账号的操作正在进行；切换账号不会取消已提交操作。
                </p>
            )}
            {operationState === 'unknown' && (
                <div
                    role="alert"
                    className="flex flex-col items-start gap-2 text-sm text-warning-foreground"
                >
                    <p>
                        上次操作结果尚未确认。请主动刷新并核对当前账号状态；当前状态仅是读取时的快照，不会自动重新执行操作。
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={
                            loading ||
                            !!error ||
                            !data ||
                            !hasCurrentUnknownCheck(uin, operationsSnapshot, checkedSnapshot)
                        }
                        onClick={clearUnknown}
                    >
                        已核对当前状态，解除操作锁定
                    </Button>
                </div>
            )}
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    本地插件状态读取失败：{error}
                    {data ? '；下方为上次快照，操作已暂停。' : ''}
                </p>
            )}
            <PluginIndexSwap ready={!loading || data !== null}>
                {data && (
                    <LocalPluginList
                        data={data}
                        blocked={loading || !!error || operationState !== null}
                        onChoose={(id, operation) => setConfirm({ id, operation })}
                    />
                )}
            </PluginIndexSwap>
            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setConfirm(null);
                    }
                }}
                title={confirm?.operation === 'enable' ? '确认启用本地插件' : '确认停用本地插件'}
                description={confirm ? `账号 ${uin} · 插件 ${confirm.id}` : undefined}
                content={
                    confirm?.operation === 'enable' ? (
                        <p className="text-sm">
                            插件以霁羽进程完整权限执行，可访问该进程可访问的文件、网络和账号；兼容性未知。请确认启用。
                        </p>
                    ) : (
                        <p className="text-sm">
                            停用不等于卸载；进程资源和清理结果以实际状态为准。
                        </p>
                    )
                }
                confirmText={confirm?.operation === 'enable' ? '确认启用' : '确认停用'}
                onConfirm={async () => {
                    if (!confirm || operationState !== null || loading || error) {
                        return;
                    }

                    await change(uin, confirm.id, confirm.operation);

                    if (mounted.current) {
                        await load();
                    }
                }}
            />
        </div>
    );
}

export function LocalPluginList({
    data,
    blocked,
    onChoose,
}: {
    data: LocalPluginsResult;
    blocked: boolean;
    onChoose: (id: string, operation: LocalOperation) => void;
}) {
    const ids = [
        ...new Set([
            ...data.candidates,
            ...(data.runtime?.map((item) => item.id) ?? []),
            ...data.pendingOperations.map((item) => item.id),
        ]),
    ].sort();
    return (
        <div className="flex flex-col gap-3">
            {!data.accountOnline && (
                <p className="text-sm text-muted-foreground">
                    账号运行实例不可用；运行状态未知，管理操作不可用。
                </p>
            )}
            {data.runtime === null && data.accountOnline && (
                <p className="text-sm text-muted-foreground">宿主状态未知；管理操作不可用。</p>
            )}
            <p className="text-xs text-muted-foreground">
                进程资源状态未知；停用不等于卸载或释放所有资源。
            </p>
            {ids.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {data.runtime === null
                        ? '本机当前没有候选插件；宿主状态未知。'
                        : '本机当前没有候选插件，宿主也没有报告插件状态。'}
                </p>
            ) : (
                ids.map((id) => {
                    const runtime = data.runtime?.find((item) => item.id === id);
                    const action = data.actions.find((item) => item.id === id);
                    const pending = data.pendingOperations.find((item) => item.id === id);
                    const unavailable = blocked || !data.accountOnline || data.runtime === null;
                    const reason = (code: string | null | undefined) =>
                        code ? (LOCAL_REASONS[code] ?? `服务状态：${code}`) : '动作能力未知';
                    const states = {
                        initializing: '正在初始化',
                        active: '已加载',
                        stopping: '正在停用',
                        cleanup_failed: '清理失败',
                    } as const;
                    return (
                        <div key={id} className="min-w-0 rounded-lg border bg-card p-4">
                            <div className="flex flex-wrap items-center gap-2">
                                <h3 className="break-all text-sm font-semibold">{id}</h3>
                                <Badge variant="secondary">兼容性未知</Badge>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                                {data.candidates.includes(id)
                                    ? '本机候选目录已发现'
                                    : '当前目录未发现对应候选项'}{' '}
                                ·{' '}
                                {data.runtime === null
                                    ? '运行状态未知'
                                    : runtime
                                      ? states[runtime.state]
                                      : '当前宿主未加载'}
                            </p>
                            {runtime && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    初始化失败：{runtime.initializationFailed ? '是' : '否'} ·
                                    清理失败：{runtime.cleanupFailed ? '是' : '否'} · 待完成操作：
                                    {runtime.pendingActions}
                                </p>
                            )}
                            {pending && (
                                <p className="mt-1 text-xs text-warning-foreground">
                                    启用处理中：
                                    {pending.phase === 'resolving' ? '解析目录' : '宿主执行'}
                                    {pending.cancelled ? '，取消中' : ''}
                                    {pending.currentInstance ? '' : '（旧实例）'}
                                </p>
                            )}
                            <div className="mt-3 flex flex-wrap gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={unavailable || !action?.canEnable}
                                    onClick={() => onChoose(id, 'enable')}
                                >
                                    启用
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={unavailable || !action?.canDisable}
                                    onClick={() => onChoose(id, 'disable')}
                                >
                                    停用
                                </Button>
                            </div>
                            {(!action?.canEnable || !action?.canDisable) && (
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {!action?.canEnable
                                        ? `启用：${reason(action?.enableReason)}。`
                                        : ''}
                                    {!action?.canDisable
                                        ? `停用：${reason(action?.disableReason)}。`
                                        : ''}
                                </p>
                            )}
                        </div>
                    );
                })
            )}
        </div>
    );
}

/** Owns the active request across refreshes and effect cleanup. */
export function createPluginRequestScope() {
    let generation = 0;
    let active: AbortController | null = null;
    return {
        start() {
            const previous = active;
            const current = ++generation;
            const controller = new AbortController();
            active = controller;
            previous?.abort();
            return {
                signal: controller.signal,
                isCurrent: () => generation === current && !controller.signal.aborted,
                finish: () => {
                    if (generation === current) {
                        active = null;
                    }
                },
            };
        },
        cancel() {
            generation += 1;
            const previous = active;
            active = null;
            previous?.abort();
        },
    };
}

/** A completed or failed current request always releases the loading state. */
export async function withPluginIndexLoading<T>(
    setLoading: (loading: boolean) => void,
    isCurrent: () => boolean,
    action: () => Promise<T>,
): Promise<T> {
    setLoading(true);

    try {
        return await action();
    } finally {
        if (isCurrent()) {
            setLoading(false);
        }
    }
}

/** Release the reserved skeleton box when the index or its error is ready. */
export function PluginIndexSwap({ ready, children }: { ready: boolean; children: ReactNode }) {
    return (
        <SkeletonSwap
            ready={ready}
            label="插件索引"
            lines={4}
            className={ready ? 'skeleton-swap-fluid' : ''}
        >
            {children}
        </SkeletonSwap>
    );
}

/** Presentation is kept separate so each response state can be tested without a live host. */
export function PluginIndexContent({
    result,
    query,
    onQueryChange,
}: {
    result: CommunityIndexResult;
    query: string;
    onQueryChange: (query: string) => void;
}) {
    if (!result.index) {
        return (
            <p role="alert" className="text-sm text-destructive">
                索引未载入：{result.error ? ERROR_LABELS[result.error] : '暂无数据'}。请刷新重试。
            </p>
        );
    }

    const plugins = filterPlugins(result.index.plugins, query);
    const fetched = result.fetchedAt === null ? null : new Date(result.fetchedAt);
    const fetchedText =
        fetched && !Number.isNaN(fetched.getTime()) ? fetched.toLocaleString() : '未知';
    return (
        <div className="flex flex-col gap-4">
            {(result.stale || result.error) && (
                <p role="alert" className="text-sm text-warning-foreground">
                    索引可能已过期{result.error ? `：${ERROR_LABELS[result.error]}` : ''}
                    ；正在显示上次获取的数据。
                </p>
            )}
            <p className="text-xs text-muted-foreground">
                索引版本 {result.index.version} · 索引更新时间 {result.index.updateTime} · 获取时间{' '}
                {fetchedText}
            </p>
            <Input
                aria-label="搜索社区插件"
                placeholder="搜索名称、作者或标签"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
            />
            {result.index.plugins.length === 0 ? (
                <p className="text-sm text-muted-foreground">社区索引当前没有插件。</p>
            ) : plugins.length === 0 ? (
                <p className="text-sm text-muted-foreground">没有匹配的插件。</p>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                    {plugins.map((plugin) => {
                        const homepage = safePluginHomepage(plugin.homepage);
                        return (
                            <div key={plugin.id} className="min-w-0 rounded-lg border bg-card p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="min-w-0 break-words text-sm font-semibold">
                                        {plugin.name}
                                    </h3>
                                    <Badge variant="secondary">Jiyu 兼容性未知</Badge>
                                </div>
                                <p className="mt-2 break-words text-sm text-muted-foreground">
                                    {plugin.description}
                                </p>
                                <p className="mt-2 break-words text-xs text-muted-foreground">
                                    作者：{plugin.author} · 版本：{plugin.version}
                                </p>
                                <p className="mt-1 break-words text-xs text-muted-foreground">
                                    最低 NapCat 版本：{plugin.minVersion}
                                </p>
                                <p className="mt-1 break-all text-xs text-muted-foreground">
                                    主页：
                                    {homepage ? (
                                        <a
                                            className="underline"
                                            href={homepage}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            {plugin.homepage}
                                        </a>
                                    ) : (
                                        plugin.homepage
                                    )}
                                </p>
                                {plugin.tags && plugin.tags.length > 0 && (
                                    <div className="mt-3 flex flex-wrap gap-1">
                                        {plugin.tags.map((tag, index) => (
                                            <Badge key={`${tag}-${index}`} variant="outline">
                                                {tag}
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
