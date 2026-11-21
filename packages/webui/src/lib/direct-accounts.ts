import type {
    DirectAccountPhase,
    DirectAccountsResponse,
    DirectAccountStatus,
    DirectOperation,
    DirectOperationKind,
    DirectControlRequest,
} from '@snowluma/common/direct-account';
import type { DirectAccountsApi } from './api/direct-accounts';
import { ApiError } from './api/types';
import { startPolling } from './polling';

export const directPhaseLabel: Record<DirectAccountPhase, string> = {
    stopped: '已停止',
    starting: '启动中',
    'qr-ready': '等待扫码',
    'waiting-scan': '等待扫码',
    'waiting-confirmation': '等待手机确认',
    registering: '注册中',
    restoring: '恢复登录中',
    online: '在线',
    renewing: '续票中',
    backoff: '等待重连',
    'needs-login': '需要重新登录',
    stopping: '停止中',
    failed: '失败',
};
export const directKindLabel: Record<DirectOperationKind, string> = {
    qr: '扫码登录',
    restore: '恢复登录',
    stop: '停止账号',
    renew: '更新票据',
};

/** getRandomValues also works on HTTP management deployments where randomUUID is absent. */
export function createDirectOperationKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function directControls(account: DirectAccountStatus) {
    const idle = ['stopped', 'failed', 'needs-login'].includes(account.phase) && !account.online;
    return {
        qr: idle,
        restore: idle && account.hasStoredAccount,
        stop: account.phase !== 'stopped' && account.phase !== 'stopping',
        // Renewal errors do not tear down a healthy Bridge/OneBot generation. Permit an
        // explicit retry from `failed`, but never expose it during teardown or recovery.
        renew:
            account.online &&
            account.canRenew &&
            (account.phase === 'online' || account.phase === 'failed'),
    };
}

export interface DirectAccountsState {
    data: DirectAccountsResponse | null;
    ready: boolean;
    refreshing: boolean;
    error: string | null;
    errors: Readonly<Record<string, string>>;
    pending: Readonly<Record<string, boolean>>;
    uncertain: Readonly<Record<string, boolean>>;
    operations: Readonly<Record<string, DirectOperation>>;
    selectedOperation: string | null;
    qrUrl: string | null;
}
export interface DirectActivity {
    id: string;
    title: string;
    status: 'running' | 'accepted' | 'succeeded' | 'failed' | 'detached';
    detail: string;
    nextId?: string;
}
interface Intent {
    kind: DirectOperationKind;
    input: DirectControlRequest;
}
const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : '读取直连账号失败';

/** Page-local observer. Disposing it never stops the server's account or replays a mutation. */
export class DirectAccountsController {
    private state: DirectAccountsState = {
        data: null,
        ready: false,
        refreshing: false,
        error: null,
        errors: {},
        pending: {},
        uncertain: {},
        operations: {},
        selectedOperation: null,
        qrUrl: null,
    };
    private listeners = new Set<() => void>();
    private abort = new AbortController();
    private stopPolling: (() => void) | null = null;
    private active = false;
    private epoch = 0;
    private dataVersion = 0;
    private flight: Promise<void> | null = null;
    private tracked = new Map<string, DirectOperation>();
    private notices = new Set<string>();
    private intents = new Map<string, Intent>();
    private qrVersion = 0;
    private qrFailed = false;
    private lastPollError: string | null = null;
    private operationErrors = new Map<string, string>();
    private unavailableOperations = new Set<string>();

    private readonly api: DirectAccountsApi;
    private readonly activity: (event: DirectActivity) => void;
    private readonly afterOperation: () => void;

    constructor(
        api: DirectAccountsApi,
        activity: (event: DirectActivity) => void,
        afterOperation: () => void,
    ) {
        this.api = api;
        this.activity = activity;
        this.afterOperation = afterOperation;
    }

    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    };
    private patch(patch: Partial<DirectAccountsState>) {
        this.state = { ...this.state, ...patch };

        for (const listener of this.listeners) {
            listener();
        }
    }
    private revokeQr() {
        this.qrVersion += 1;

        if (this.state.qrUrl) {
            URL.revokeObjectURL(this.state.qrUrl);
        }

        this.patch({ qrUrl: null });
    }
    start = () => {
        if (this.active) {
            return;
        }

        this.active = true;
        this.epoch += 1;
        this.abort = new AbortController();
        this.stopPolling = startPolling(this.refresh, 2000);
    };
    stop = () => {
        this.active = false;
        this.epoch += 1;
        this.stopPolling?.();
        this.stopPolling = null;
        this.abort.abort();
        this.revokeQr();
        this.patch({ selectedOperation: null, refreshing: false, pending: {} });

        for (const id of this.notices) {
            this.activity({
                id,
                title: '已停止观察直连操作',
                status: 'detached',
                detail: '后台操作继续运行；返回账号页查看最终状态。',
            });
        }

        this.notices.clear();
    };
    selectQr = (id: string | null) => {
        this.revokeQr();
        this.qrFailed = false;
        this.patch({ selectedOperation: id });

        if (id) {
            void this.refresh();
        }
    };
    retryQr = () => {
        this.qrFailed = false;
        void this.refresh();
    };

    refresh = (): Promise<void> => {
        if (!this.active || document.hidden) {
            return Promise.resolve();
        }

        if (this.flight) {
            return this.flight;
        }

        const epoch = this.epoch;
        const version = this.dataVersion;
        const current = () => this.active && this.epoch === epoch;
        this.patch({ refreshing: true });

        const work = async () => {
            try {
                const data = await this.api.list(this.abort.signal);

                if (!current()) {
                    return;
                }

                if (this.dataVersion === version) {
                    this.patch({ data, ready: true, error: null });
                }

                this.lastPollError = null;
                const ids = new Set([
                    ...[...this.tracked.values()]
                        .filter((op) => op.status === 'running')
                        .map((op) => op.id),
                    ...data.accounts.flatMap((account) =>
                        account.operationId ? [account.operationId] : [],
                    ),
                ]);

                for (const id of this.unavailableOperations) {
                    if (!ids.has(id)) {
                        this.unavailableOperations.delete(id);
                        this.operationErrors.delete(id);
                    }
                }

                for (const id of ids) {
                    if (this.unavailableOperations.has(id)) {
                        continue;
                    }

                    if (!current() || document.hidden) {
                        return;
                    }

                    if (
                        this.tracked.get(id)?.status !== undefined &&
                        this.tracked.get(id)?.status !== 'running'
                    ) {
                        continue;
                    }

                    try {
                        const { operation } = await this.api.operation(id, this.abort.signal);

                        if (current()) {
                            this.operationErrors.delete(id);
                            this.accept(operation);
                        }
                    } catch (error) {
                        if (!current()) {
                            return;
                        }

                        const old = this.tracked.get(id);

                        if (this.state.selectedOperation === id) {
                            this.revokeQr();
                            this.qrFailed = true;
                        }

                        if (old) {
                            this.setError(old.accountId, errorMessage(error));
                        }

                        if (this.operationErrors.get(id) !== errorMessage(error)) {
                            this.operationErrors.set(id, errorMessage(error));
                            this.activity({
                                id: `observe-${id}`,
                                title: '操作状态读取失败',
                                status: 'failed',
                                detail: errorMessage(error),
                            });
                        }

                        if (
                            error instanceof ApiError &&
                            [401, 403, 404, 410].includes(error.status)
                        ) {
                            this.tracked.delete(id);
                            this.unavailableOperations.add(id);

                            if (this.state.selectedOperation === id) {
                                this.selectQr(null);
                            }

                            this.finishNotice(id, 'failed', '操作观察已失效，请刷新账号状态');
                        }

                        if (error instanceof ApiError && error.status === 401) {
                            this.stop();
                            return;
                        }
                    }
                }

                const selected = this.state.selectedOperation;
                const op = selected ? this.tracked.get(selected) : undefined;

                if (op && (!op.qrAvailable || op.status !== 'running')) {
                    this.revokeQr();
                }

                if (
                    current() &&
                    !document.hidden &&
                    op?.qrAvailable &&
                    op.status === 'running' &&
                    !this.state.qrUrl &&
                    !this.qrFailed
                ) {
                    const qrVersion = this.qrVersion;

                    try {
                        const blob = await this.api.qr(op.id, this.abort.signal);

                        if (
                            current() &&
                            qrVersion === this.qrVersion &&
                            this.state.selectedOperation === op.id
                        ) {
                            this.patch({ qrUrl: URL.createObjectURL(blob) });
                            this.setError(op.accountId, '');
                        }
                    } catch (error) {
                        if (current() && qrVersion === this.qrVersion) {
                            this.qrFailed = true;
                            this.revokeQr();
                            this.setError(op.accountId, errorMessage(error));
                            this.activity({
                                id: `qr-${op.id}`,
                                title: '二维码读取失败',
                                status: 'failed',
                                detail: errorMessage(error),
                            });
                        }
                    }
                }
            } catch (error) {
                if (!current()) {
                    return;
                }

                const message = errorMessage(error);
                this.patch({ ready: true, error: message });
                this.revokeQr();

                if (message !== this.lastPollError) {
                    this.activity({
                        id: 'direct-list',
                        title: '账号状态读取失败',
                        status: 'failed',
                        detail: message,
                    });
                    this.lastPollError = message;
                }

                if (error instanceof ApiError && error.status === 401) {
                    this.stop();
                }
            } finally {
                if (current()) {
                    this.patch({ refreshing: false });
                }
            }
        };

        this.flight = work().finally(() => {
            this.flight = null;
        });
        return this.flight;
    };

    private setError(id: string, message: string) {
        this.patch({ errors: { ...this.state.errors, [id]: message } });
    }
    private finishNotice(id: string, status: 'succeeded' | 'failed', detail: string) {
        if (this.notices.delete(id)) {
            this.activity({ id, title: '直连账号操作', status, detail });
        }
    }
    private accept(operation: DirectOperation) {
        const previous = this.tracked.get(operation.id);

        if (
            previous &&
            (previous.accountId !== operation.accountId ||
                previous.generation !== operation.generation ||
                previous.status !== 'running')
        ) {
            return;
        }

        this.tracked.set(operation.id, operation);
        // Old terminal results are observed, but never replace a newer account operation.
        const visible = this.state.operations[operation.accountId];
        const advertised = this.state.data?.accounts.find(
            (account) => account.id === operation.accountId,
        )?.operationId;
        const isCurrent =
            !visible ||
            visible.id === operation.id ||
            advertised === operation.id ||
            visible.startedAt < operation.startedAt;

        if (isCurrent) {
            this.patch({
                operations: { ...this.state.operations, [operation.accountId]: operation },
            });
        }

        if (operation.status === 'running') {
            if (!this.notices.has(operation.id)) {
                this.notices.add(operation.id);
                this.activity({
                    id: operation.id,
                    title: directKindLabel[operation.kind],
                    status: 'running',
                    detail: '已受理，等待服务端完成',
                });
            }
        } else {
            const detail =
                operation.status === 'succeeded'
                    ? `${directKindLabel[operation.kind]}已完成`
                    : (operation.error ??
                      (operation.status === 'cancelled' ? '操作已取消' : '操作失败'));

            if (isCurrent) {
                this.setError(operation.accountId, operation.status === 'succeeded' ? '' : detail);
            }

            this.finishNotice(
                operation.id,
                operation.status === 'succeeded' ? 'succeeded' : 'failed',
                detail,
            );
            this.afterOperation();
        }

        if (
            this.state.selectedOperation === operation.id &&
            (!operation.qrAvailable || operation.status !== 'running')
        ) {
            this.revokeQr();
        }

        // Retain current per-account results only; keep running predecessors until terminal.
        for (const [id, op] of this.tracked) {
            if (op.status !== 'running' && this.state.operations[op.accountId]?.id !== id) {
                this.tracked.delete(id);
            }
        }
    }

    run = async (id: string, kind: DirectOperationKind, retry = false): Promise<void> => {
        if (!this.active || this.state.pending[id]) {
            return;
        }

        const account = this.state.data?.accounts.find((item) => item.id === id);

        if (!account || (kind === 'renew' && !account.canRenew)) {
            return;
        }

        let intent = retry ? this.intents.get(id) : undefined;

        if (!intent) {
            if (
                !this.state.data?.supported ||
                !directControls(account)[kind] ||
                this.state.uncertain[id]
            ) {
                return;
            }

            intent = {
                kind,
                input: {
                    expectedRevision: account.revision,
                    operationKey: createDirectOperationKey(),
                },
            };
        }

        this.intents.set(id, intent);
        const epoch = this.epoch;
        this.dataVersion += 1;
        this.patch({
            pending: { ...this.state.pending, [id]: true },
            errors: { ...this.state.errors, [id]: '' },
        });
        const noticeId = `request-${intent.input.operationKey}`;
        this.notices.add(noticeId);
        this.activity({
            id: noticeId,
            title: directKindLabel[intent.kind],
            status: 'running',
            detail: '正在提交请求',
        });

        try {
            const { kind: action, input } = intent;
            const result = await (action === 'qr' || action === 'restore'
                ? this.api.start(id, { ...input, mode: action }, this.abort.signal)
                : this.api[action](id, input, this.abort.signal));

            if (!this.active || this.epoch !== epoch) {
                return;
            }

            this.dataVersion += 1;
            this.intents.delete(id);
            this.patch({
                data: this.state.data && {
                    ...this.state.data,
                    accounts: this.state.data.accounts.map((item) =>
                        item.id === id ? result.account : item,
                    ),
                },
                uncertain: { ...this.state.uncertain, [id]: false },
            });
            // Transfer the same running notice; 202 does not generate a success result.
            this.notices.delete(noticeId);
            this.activity({
                id: noticeId,
                nextId: result.operation.id,
                title: directKindLabel[action],
                status: 'accepted',
                detail: '已受理，等待服务端完成',
            });
            this.notices.add(result.operation.id);
            this.accept(result.operation);

            if (action === 'qr' && result.operation.status === 'running') {
                this.selectQr(result.operation.id);
            }

            this.afterOperation();
        } catch (error) {
            if (!this.active || this.epoch !== epoch) {
                return;
            }

            const uncertain =
                !(error instanceof ApiError) || error.status === 408 || error.status >= 500;

            if (!uncertain) {
                this.intents.delete(id);
            }

            const detail =
                errorMessage(error) + (uncertain ? '；受理状态待确认，可使用原请求重试。' : '');
            this.setError(id, detail);
            this.patch({ uncertain: { ...this.state.uncertain, [id]: uncertain } });
            this.finishNotice(noticeId, 'failed', detail);
        } finally {
            if (this.active && this.epoch === epoch) {
                this.patch({ pending: { ...this.state.pending, [id]: false } });
            }
        }
    };
    retry = (id: string) => this.run(id, this.intents.get(id)?.kind ?? 'restore', true);

    cancel = async (operation: DirectOperation): Promise<void> => {
        if (!this.active || this.state.pending[operation.accountId]) {
            return;
        }

        const epoch = this.epoch;
        const id = operation.accountId;
        this.dataVersion += 1;
        this.patch({ pending: { ...this.state.pending, [id]: true } });

        try {
            const result = await this.api.cancel(operation.id, this.abort.signal);

            if (this.active && this.epoch === epoch) {
                this.dataVersion += 1;
                this.patch({
                    data: this.state.data && {
                        ...this.state.data,
                        accounts: this.state.data.accounts.map((account) =>
                            account.id === id ? result.account : account,
                        ),
                    },
                });
                this.accept(result.operation);
                this.afterOperation();
            }
        } catch (error) {
            if (this.active && this.epoch === epoch) {
                this.setError(id, errorMessage(error));
                this.activity({
                    id: `cancel-${operation.id}`,
                    title: '取消请求失败',
                    status: 'failed',
                    detail: errorMessage(error),
                });
            }
        } finally {
            if (this.active && this.epoch === epoch) {
                this.patch({ pending: { ...this.state.pending, [id]: false } });
            }
        }
    };
}
