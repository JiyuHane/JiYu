import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertCircle, Loader2, QrCode, RefreshCw, Square, Users } from 'lucide-react';
import type { DirectOperation } from '@snowluma/common/direct-account';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Modal } from '@/components/interior/modal';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { useAppState } from '@/contexts/AppStateContext';
import { useDirectAccounts } from '@/hooks/use-direct-accounts';
import { directControls, directKindLabel, directPhaseLabel } from '@/lib/direct-accounts';

function timeLabel(value: number | null) {
    return value === null ? '未提供' : new Date(value).toLocaleString();
}

export function DirectAccountsPage() {
    const { state, controller } = useDirectAccounts();
    const { setSelectedUin } = useAppState();
    const [confirm, setConfirm] = useState<
        | { kind: 'stop'; id: string; label: string }
        | { kind: 'cancel'; operation: DirectOperation; label: string }
        | null
    >(null);
    const selected = Object.values(state.operations).find(
        (op) => op.id === state.selectedOperation,
    );
    const selectedAccount = state.data?.accounts.find(
        (account) => account.id === selected?.accountId,
    );

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <Users className="size-5" />
                            直连账号
                        </CardTitle>
                        <CardDescription>
                            管理服务器已登记的 Linux QQ 账号；关闭页面不影响后台在线服务。
                        </CardDescription>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={state.refreshing}
                        onClick={() => void controller.refresh()}
                    >
                        <RefreshCw className="size-3.5" />
                        刷新状态
                    </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                    {state.error && (
                        <div
                            role="alert"
                            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                        >
                            {state.error}
                            {state.data && '；当前显示上次读取的状态。'}
                        </div>
                    )}
                    <SkeletonSwap
                        ready={state.ready}
                        reserve={192}
                        lines={6}
                        label="直连账号列表"
                        className={state.ready ? 'skeleton-swap-fluid' : ''}
                    >
                        {state.data && (
                            <>
                                {!state.data.supported && (
                                    <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm">
                                        当前服务器未启用可用的 Linux 直连运行环境。请在 Linux
                                        服务端配置运行环境后重启服务。
                                        {state.data.reason && (
                                            <p className="mt-2 font-mono text-xs text-muted-foreground">
                                                {state.data.reason}
                                            </p>
                                        )}
                                    </div>
                                )}
                                {(!state.data.configured || state.data.accounts.length === 0) && (
                                    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center text-muted-foreground">
                                        <Users className="size-8 opacity-50" />
                                        <p>尚未登记直连账号</p>
                                        <p className="max-w-lg px-4 text-sm">
                                            由服务器操作者使用 JIYU_DIRECT_QQ_CONFIG
                                            登记账号及私有配置，再重启服务。本页不上传登录凭据或编辑私有路径。
                                        </p>
                                    </div>
                                )}
                                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                                    {state.data.accounts.map((account) => {
                                        const controls = directControls(account);
                                        const operation = state.operations[account.id];
                                        const pending = !!state.pending[account.id];
                                        const locked =
                                            pending ||
                                            !state.data?.supported ||
                                            !!state.uncertain[account.id];
                                        const error = state.errors[account.id] || account.error;
                                        return (
                                            <section
                                                key={account.id}
                                                aria-label={account.label}
                                                className="space-y-4 rounded-xl border border-border bg-card p-4"
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <h3 className="truncate font-semibold">
                                                            {account.label}
                                                        </h3>
                                                        <p className="text-xs text-muted-foreground">
                                                            {account.uin ?? '尚未确认账号'} · Linux
                                                            QQ
                                                        </p>
                                                    </div>
                                                    <Badge
                                                        variant={
                                                            account.online
                                                                ? 'success'
                                                                : account.phase === 'failed'
                                                                  ? 'destructive'
                                                                  : 'secondary'
                                                        }
                                                    >
                                                        {directPhaseLabel[account.phase]}
                                                    </Badge>
                                                </div>
                                                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                                                    <div>
                                                        <dt className="text-muted-foreground">
                                                            OneBot
                                                        </dt>
                                                        <dd>
                                                            {account.onebotReady
                                                                ? '已就绪'
                                                                : '未就绪'}
                                                        </dd>
                                                    </div>
                                                    <div>
                                                        <dt className="text-muted-foreground">
                                                            消息接收
                                                        </dt>
                                                        <dd>
                                                            {account.receiveHealthy
                                                                ? '正常'
                                                                : '未就绪'}
                                                        </dd>
                                                    </div>
                                                    <div>
                                                        <dt className="text-muted-foreground">
                                                            自动恢复
                                                        </dt>
                                                        <dd>
                                                            {account.autoRestore
                                                                ? '已配置'
                                                                : '未配置'}
                                                            （只读）
                                                        </dd>
                                                    </div>
                                                    <div>
                                                        <dt className="text-muted-foreground">
                                                            自动续票
                                                        </dt>
                                                        <dd>
                                                            {account.autoRenew
                                                                ? '已配置'
                                                                : '未配置'}{' '}
                                                            ·{' '}
                                                            {account.canRenew
                                                                ? '实现可用'
                                                                : '实现尚未可用'}
                                                        </dd>
                                                    </div>
                                                    <div>
                                                        <dt className="text-muted-foreground">
                                                            上次续票
                                                        </dt>
                                                        <dd>{timeLabel(account.lastRenewedAt)}</dd>
                                                    </div>
                                                    <div>
                                                        <dt className="text-muted-foreground">
                                                            下次续票
                                                        </dt>
                                                        <dd>{timeLabel(account.renewAt)}</dd>
                                                    </div>
                                                    {account.retryAt !== null && (
                                                        <div className="col-span-2">
                                                            <dt className="text-muted-foreground">
                                                                计划重连
                                                            </dt>
                                                            <dd>{timeLabel(account.retryAt)}</dd>
                                                        </div>
                                                    )}
                                                </dl>
                                                <p className="text-xs text-muted-foreground">
                                                    {account.hasStoredAccount
                                                        ? '已登记存储账号；恢复时校验加密记录。'
                                                        : '尚无已登记存储账号。'}
                                                </p>
                                                <p className="break-words text-xs text-muted-foreground">
                                                    已实现能力：
                                                    {account.capabilities.join(' · ') || '未就绪'}
                                                </p>
                                                {operation && (
                                                    <p
                                                        aria-live="polite"
                                                        className="flex items-center gap-2 text-sm"
                                                    >
                                                        {operation.status === 'running' && (
                                                            <Loader2 className="size-3.5 shrink-0 animate-spin" />
                                                        )}
                                                        {directKindLabel[operation.kind]}：
                                                        {operation.status === 'running'
                                                            ? `已受理 · ${directPhaseLabel[operation.phase]}`
                                                            : operation.status === 'succeeded'
                                                              ? '已完成'
                                                              : operation.status === 'cancelled'
                                                                ? '已取消'
                                                                : '失败'}
                                                    </p>
                                                )}
                                                {error && (
                                                    <div
                                                        role="alert"
                                                        className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                                                    >
                                                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                                                        <span className="break-all">{error}</span>
                                                    </div>
                                                )}
                                                <div className="flex flex-wrap gap-2">
                                                    <Button
                                                        size="sm"
                                                        disabled={locked || !controls.qr}
                                                        onClick={() =>
                                                            void controller.run(account.id, 'qr')
                                                        }
                                                    >
                                                        <QrCode className="size-3.5" />
                                                        扫码登录
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={locked || !controls.restore}
                                                        onClick={() =>
                                                            void controller.run(
                                                                account.id,
                                                                'restore',
                                                            )
                                                        }
                                                    >
                                                        恢复登录
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={locked || !controls.renew}
                                                        onClick={() =>
                                                            void controller.run(account.id, 'renew')
                                                        }
                                                    >
                                                        <RefreshCw className="size-3.5" />
                                                        立即续票
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={locked || !controls.stop}
                                                        onClick={() =>
                                                            setConfirm({
                                                                kind: 'stop',
                                                                id: account.id,
                                                                label: account.label,
                                                            })
                                                        }
                                                    >
                                                        <Square className="size-3.5" />
                                                        停止
                                                    </Button>
                                                    {operation?.kind === 'qr' &&
                                                        operation.status === 'running' && (
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                onClick={() =>
                                                                    controller.selectQr(
                                                                        operation.id,
                                                                    )
                                                                }
                                                            >
                                                                查看扫码进度
                                                            </Button>
                                                        )}
                                                    {state.uncertain[account.id] && (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            disabled={pending}
                                                            onClick={() =>
                                                                void controller.retry(account.id)
                                                            }
                                                        >
                                                            用原请求重试
                                                        </Button>
                                                    )}
                                                </div>
                                                {account.uin && (
                                                    <div className="flex gap-4 text-sm text-primary">
                                                        <Link
                                                            to="/config"
                                                            onClick={() =>
                                                                setSelectedUin(account.uin)
                                                            }
                                                        >
                                                            节点配置
                                                        </Link>
                                                        {account.onebotReady && (
                                                            <Link
                                                                to="/debug"
                                                                onClick={() =>
                                                                    setSelectedUin(account.uin)
                                                                }
                                                            >
                                                                打开原调试工具
                                                            </Link>
                                                        )}
                                                    </div>
                                                )}
                                            </section>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                    </SkeletonSwap>
                </CardContent>
            </Card>
            <Modal
                open={!!state.selectedOperation}
                onClose={() => controller.selectQr(null)}
                title="扫码登录"
                description={selectedAccount?.label ?? '直连账号'}
                maxWidth={480}
                footer={
                    <>
                        <Button variant="outline" onClick={() => controller.selectQr(null)}>
                            关闭观察
                        </Button>
                        {selected?.status === 'running' && (
                            <Button
                                variant="destructive"
                                disabled={!!state.pending[selected.accountId]}
                                onClick={() =>
                                    setConfirm({
                                        kind: 'cancel',
                                        operation: selected,
                                        label: selectedAccount?.label ?? selected.accountId,
                                    })
                                }
                            >
                                取消本次登录
                            </Button>
                        )}
                    </>
                }
            >
                <div className="flex flex-col items-center gap-4 py-2">
                    {state.qrUrl ? (
                        <img
                            src={state.qrUrl}
                            alt="使用手机 QQ 扫描本次登录二维码"
                            className="size-64 max-w-full rounded-lg bg-white p-2 object-contain"
                        />
                    ) : (
                        <div className="flex min-h-48 items-center justify-center rounded-lg bg-muted/50 p-6 text-sm text-muted-foreground">
                            {selected ? directPhaseLabel[selected.phase] : '正在读取登录进度…'}
                        </div>
                    )}
                    <p aria-live="polite" className="text-sm">
                        {selected ? directPhaseLabel[selected.phase] : '等待服务端状态'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        二维码仅用于本次登录。关闭观察不取消后台操作。
                    </p>
                    {selected && state.errors[selected.accountId] && (
                        <>
                            <p role="alert" className="text-sm text-destructive">
                                {state.errors[selected.accountId]}
                            </p>
                            {selected.qrAvailable && (
                                <Button variant="outline" size="sm" onClick={controller.retryQr}>
                                    重新读取二维码
                                </Button>
                            )}
                        </>
                    )}
                </div>
            </Modal>
            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setConfirm(null);
                    }
                }}
                title={confirm?.kind === 'cancel' ? '取消本次登录？' : '停止直连账号？'}
                description={
                    confirm?.kind === 'cancel'
                        ? `取消 ${confirm.label} 的本次扫码尝试，已保存的登录记录保留。`
                        : `停止 ${confirm?.label ?? ''} 的后台连接；已保存的账号和消息记录保留。`
                }
                confirmText="确认"
                destructive
                onConfirm={async () => {
                    if (confirm?.kind === 'cancel') {
                        await controller.cancel(confirm.operation);
                    } else if (confirm) {
                        await controller.run(confirm.id, 'stop');
                    }
                }}
            />
        </div>
    );
}
