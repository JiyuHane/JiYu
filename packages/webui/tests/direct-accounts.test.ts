import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectAccountStatus, DirectOperation } from '@snowluma/common/direct-account';
import {
    DirectAccountsController,
    directControls,
    createDirectOperationKey,
} from '../src/lib/direct-accounts';
import type { DirectAccountsApi } from '../src/lib/api/direct-accounts';
import { ApiError } from '../src/lib/api/types';
import { directAccount, directOperation, pngBytes } from './fixtures/direct-accounts';

let page: EventTarget & { hidden: boolean };
let controllers: DirectAccountsController[];
beforeEach(() => {
    vi.useFakeTimers();
    page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', page);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-qr');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    controllers = [];
});
afterEach(() => {
    controllers.forEach((controller) => controller.stop());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

function harness() {
    let account: DirectAccountStatus = { ...directAccount };
    let operation: DirectOperation = { ...directOperation };

    const accepted = () => {
        account = {
            ...account,
            phase: operation.phase,
            operationId: operation.id,
            generation: operation.generation,
            revision: 'd'.repeat(32),
        };
        return { account, operation };
    };

    const api = {
        list: vi.fn(async () => ({
            supported: true,
            configured: true,
            reason: null,
            accounts: [{ ...account }],
        })),
        get: vi.fn(async () => ({ account })),
        start: vi.fn<DirectAccountsApi['start']>(async () => accepted()),
        stop: vi.fn<DirectAccountsApi['stop']>(async () => accepted()),
        renew: vi.fn<DirectAccountsApi['renew']>(async () => accepted()),
        operation: vi.fn(async () => ({ operation })),
        cancel: vi.fn(async () => accepted()),
        qr: vi.fn(async () => new Blob([pngBytes], { type: 'image/png' })),
    } satisfies DirectAccountsApi;
    const activity = vi.fn();
    const after = vi.fn();
    const controller = new DirectAccountsController(api, activity, after);
    controllers.push(controller);
    return {
        api,
        activity,
        after,
        controller,
        setOperation: (value: DirectOperation) => {
            operation = value;
        },
        setAccount: (value: DirectAccountStatus) => {
            account = value;
        },
    };
}

describe('direct accounts page observer', () => {
    it('creates UUIDv4 keys without depending on secure-context randomUUID', () => {
        const fill = vi.fn((bytes: Uint8Array) => bytes.fill(0xab));
        vi.stubGlobal('crypto', { getRandomValues: fill });
        expect(createDirectOperationKey()).toBe('abababab-abab-4bab-abab-abababababab');
        expect(fill).toHaveBeenCalledOnce();
    });

    it('treats 202 as running, not completion, then observes exactly one terminal result', async () => {
        const h = harness();
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'qr');
        await settle();
        expect(h.activity.mock.calls.some(([event]) => event.status === 'succeeded')).toBe(false);
        expect(h.controller.getSnapshot().operations[directAccount.id].status).toBe('running');
        h.setOperation({
            ...directOperation,
            status: 'succeeded',
            phase: 'online',
            qrAvailable: false,
            finishedAt: directOperation.startedAt + 100,
        });
        await h.controller.refresh();
        await h.controller.refresh();
        expect(
            h.activity.mock.calls.filter(([event]) => event.status === 'succeeded'),
        ).toHaveLength(1);
        expect(h.controller.getSnapshot().qrUrl).toBeNull();
        expect(h.after).toHaveBeenCalled();
    });

    it('keeps at most one polling request and has no timer or request while hidden', async () => {
        const h = harness();
        const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.api.list>>>();
        h.api.list.mockReturnValueOnce(pending.promise);
        h.controller.start();
        void h.controller.refresh();
        void h.controller.refresh();
        await vi.advanceTimersByTimeAsync(5000);
        expect(h.api.list).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        page.hidden = true;
        page.dispatchEvent(new Event('visibilitychange'));
        pending.resolve({
            supported: true,
            configured: true,
            reason: null,
            accounts: [directAccount],
        });
        await settle();
        await vi.advanceTimersByTimeAsync(5000);
        expect(h.api.list).toHaveBeenCalledOnce();
        page.hidden = false;
        page.dispatchEvent(new Event('visibilitychange'));
        await settle();
        expect(h.api.list).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('releases QR URLs on close, terminal result, and disposal without stopping the server', async () => {
        const h = harness();
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'qr');
        await settle();
        expect(h.controller.getSnapshot().qrUrl).toBe('blob:test-qr');
        h.controller.selectQr(null);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        h.controller.selectQr(directOperation.id);
        await settle();
        expect(h.controller.getSnapshot().qrUrl).toBe('blob:test-qr');
        h.controller.stop();
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
        expect(h.api.stop).not.toHaveBeenCalled();
        expect(h.api.cancel).not.toHaveBeenCalled();
        expect(h.controller.getSnapshot().selectedOperation).toBeNull();
    });

    it('does not publish a late QR after its dialog is closed', async () => {
        const h = harness();
        const qr = Promise.withResolvers<Blob>();
        h.api.qr.mockReturnValue(qr.promise);
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'qr');
        await settle();
        h.controller.selectQr(null);
        qr.resolve(new Blob([pngBytes]));
        await settle();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('guards double clicks and retries uncertain submissions with the identical UUID and revision', async () => {
        const h = harness();
        h.controller.start();
        await settle();
        const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.api.start>>>();
        h.api.start.mockReturnValueOnce(pending.promise);
        const first = h.controller.run(directAccount.id, 'qr');
        await h.controller.run(directAccount.id, 'qr');
        expect(h.api.start).toHaveBeenCalledOnce();
        pending.reject(new ApiError(408, 'timeout'));
        await first;
        expect(h.controller.getSnapshot().uncertain[directAccount.id]).toBe(true);
        const input = h.api.start.mock.calls[0][1];
        await h.controller.retry(directAccount.id);
        expect(h.api.start.mock.calls[1][1]).toEqual(input);
        expect(input.operationKey).toMatch(/^[a-f\d-]{36}$/);
        expect(h.controller.getSnapshot().uncertain[directAccount.id]).toBe(false);
    });

    it('keeps failed operations in the card and result notice', async () => {
        const h = harness();
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'qr');
        await settle();
        h.setOperation({
            ...directOperation,
            status: 'failed',
            qrAvailable: false,
            error: 'login-expired',
            finishedAt: directOperation.startedAt + 100,
        });
        await h.controller.refresh();
        expect(h.controller.getSnapshot().errors[directAccount.id]).toBe('login-expired');
        expect(h.activity).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'failed', detail: 'login-expired' }),
        );
    });

    it('does not let stale list responses replace an accepted operation account', async () => {
        const h = harness();
        h.controller.start();
        await settle();
        const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.api.list>>>();
        h.api.list.mockReturnValueOnce(pending.promise);
        const refresh = h.controller.refresh();
        await h.controller.run(directAccount.id, 'restore');
        pending.resolve({
            supported: true,
            configured: true,
            reason: null,
            accounts: [directAccount],
        });
        await refresh;
        expect(h.controller.getSnapshot().data?.accounts[0].revision).toBe('d'.repeat(32));
    });

    it('revokes the QR and stops observation when authentication expires', async () => {
        const h = harness();
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'qr');
        await settle();
        h.api.list.mockRejectedValueOnce(new ApiError(401, 'expired'));
        await h.controller.refresh();
        expect(h.controller.getSnapshot().qrUrl).toBeNull();
        const count = h.api.list.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10000);
        expect(h.api.list).toHaveBeenCalledTimes(count);
    });

    it('keeps QR read failures visible and retries only on an explicit request', async () => {
        const h = harness();
        h.api.qr.mockRejectedValueOnce(new ApiError(410, 'QR expired'));
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'qr');
        await settle();
        await h.controller.refresh();
        await h.controller.refresh();
        expect(h.api.qr).toHaveBeenCalledOnce();
        expect(h.controller.getSnapshot().errors[directAccount.id]).toBe('QR expired');
        h.controller.retryQr();
        await settle();
        expect(h.api.qr).toHaveBeenCalledTimes(2);
    });

    it('never sends renew when the backend reports the capability unavailable', async () => {
        const h = harness();
        h.setAccount({
            ...directAccount,
            phase: 'online',
            online: true,
            autoRenew: true,
            canRenew: false,
        });
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'renew');
        expect(h.api.renew).not.toHaveBeenCalled();
        expect(h.api.start).not.toHaveBeenCalled();
    });

    it('stops retrying an expired operation even when a stale list still advertises it', async () => {
        const h = harness();
        h.setAccount({ ...directAccount, phase: 'waiting-scan', operationId: directOperation.id });
        h.api.operation.mockRejectedValue(new ApiError(410, 'operation-expired'));
        h.controller.start();
        await settle();
        await h.controller.refresh();
        await h.controller.refresh();
        expect(h.api.operation).toHaveBeenCalledOnce();
        expect(
            h.activity.mock.calls.filter(([event]) => event.title === '操作状态读取失败'),
        ).toHaveLength(1);
    });

    it('cancel acceptance retains stopping until actual cleanup completes', async () => {
        const h = harness();
        h.controller.start();
        await settle();
        await h.controller.run(directAccount.id, 'qr');
        await settle();
        h.setOperation({ ...directOperation, phase: 'stopping', qrAvailable: false });
        await h.controller.cancel(directOperation);
        expect(h.controller.getSnapshot().operations[directAccount.id]).toMatchObject({
            status: 'running',
            phase: 'stopping',
        });
        expect(h.controller.getSnapshot().data?.accounts[0].phase).toBe('stopping');
        expect(h.controller.getSnapshot().qrUrl).toBeNull();
        expect(h.activity.mock.calls.some(([event]) => event.status === 'succeeded')).toBe(false);
        h.setOperation({
            ...directOperation,
            phase: 'stopped',
            status: 'cancelled',
            qrAvailable: false,
            finishedAt: directOperation.startedAt + 100,
        });
        await h.controller.refresh();
        expect(h.controller.getSnapshot().operations[directAccount.id].status).toBe('cancelled');
        expect(h.activity).toHaveBeenCalledWith(
            expect.objectContaining({ detail: '操作已取消', status: 'failed' }),
        );
    });

    it('does not publish a response that arrives after page disposal', async () => {
        const h = harness();
        const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.api.list>>>();
        h.api.list.mockReturnValueOnce(pending.promise);
        h.controller.start();
        h.controller.stop();
        pending.resolve({
            supported: true,
            configured: true,
            reason: null,
            accounts: [directAccount],
        });
        await settle();
        expect(h.controller.getSnapshot().data).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('gates renewal on a real available implementation and preserves stop during login', () => {
        expect(directControls(directAccount)).toEqual({
            qr: true,
            restore: true,
            stop: false,
            renew: false,
        });
        expect(directControls({ ...directAccount, online: true, phase: 'online' }).renew).toBe(
            false,
        );
        expect(
            directControls({ ...directAccount, online: true, phase: 'online', canRenew: true })
                .renew,
        ).toBe(true);
        expect(
            directControls({ ...directAccount, online: true, phase: 'failed', canRenew: true })
                .renew,
        ).toBe(true);
        expect(
            directControls({ ...directAccount, online: true, phase: 'renewing', canRenew: true })
                .renew,
        ).toBe(false);
        expect(
            directControls({ ...directAccount, online: true, phase: 'stopping', canRenew: true })
                .renew,
        ).toBe(false);
        expect(directControls({ ...directAccount, phase: 'waiting-scan' }).stop).toBe(true);
    });
});
