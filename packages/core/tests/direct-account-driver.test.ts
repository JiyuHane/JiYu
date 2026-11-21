import type { PacketSender } from '@snowluma/common/packet-sender';
import type { OneBotInstance } from '@snowluma/onebot/instance';
import type { DirectPushIngress } from '@snowluma/protocol/direct/direct-push-ingress';
import type { WtReferencePacketInput } from '@snowluma/protocol/direct/wt-reference-packet-flow';
import { WtTicketRefreshError } from '@snowluma/protocol/direct/wt-reference-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectSessionHandle } from '../src/bridge/manager';
import {
    createDirectAccountDriver,
    type DirectAccountDriverOverrides,
    type DirectManagedController,
    type DirectRenewSession,
} from '../src/direct/direct-account-driver';
import type { ManagedAccountConfig } from '../src/direct/managed-config';
import {
    ManagedDirectAccountDriverError,
    ManagedDirectAccountService,
    type ManagedDirectAccountDriverCallbacks,
    type ManagedDirectAccountUpdate,
} from '../src/direct/managed-service';
import { DirectServiceError, type DirectRequestScope } from '../src/direct/service-contract';
import type {
    DirectLoginController,
    DirectRestoredLoginController,
    ManagedDirectLoginOptions,
    ManagedDirectRestoreOptions,
} from '../src/direct/runner';

// All fixtures are local in-memory objects. No QQ process, account, socket, vault,
// selector file, private ticket, or external network is opened by this suite.
const UIN = '2000000001';
const GENERATION = '11'.repeat(16);
const MSG_PUSH = 'trpc.msg.olpush.OlPushService.MsgPush';
const PACKET_COMMAND = 'MessageSvc.PbSendMsg' as const;
const SERVICE_OWNER = 'a'.repeat(64);

function serviceScope(): DirectRequestScope {
    return { owner: SERVICE_OWNER, expiresAt: Date.now() + 60_000, isCurrent: () => true };
}

function operationKey(index: number): string {
    return `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`;
}

function serviceErrorCode(effect: () => unknown): string | undefined {
    try {
        effect();
        return undefined;
    } catch (error) {
        return error instanceof DirectServiceError ? error.code : undefined;
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function turns(count = 3): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

class ManualScheduler {
    now = 1_700_000_000_000;
    private nextId = 1;
    private readonly timers = new Map<number, { at: number; callback: () => void }>();
    private readonly immediates = new Map<number, () => void>();

    readonly setTimeout = (
        callback: () => void,
        milliseconds: number,
    ): ReturnType<typeof setTimeout> => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + milliseconds, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
    };

    readonly clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
        this.timers.delete(handle as unknown as number);
    };

    readonly setImmediate = (callback: () => void): ReturnType<typeof setImmediate> => {
        const id = this.nextId++;
        this.immediates.set(id, callback);
        return id as unknown as ReturnType<typeof setImmediate>;
    };

    readonly clearImmediate = (handle: ReturnType<typeof setImmediate>): void => {
        this.immediates.delete(handle as unknown as number);
    };

    async flushImmediates(): Promise<void> {
        while (this.immediates.size > 0) {
            const callbacks = [...this.immediates.values()];
            this.immediates.clear();

            for (const callback of callbacks) {
                callback();
            }

            await turns();
        }
    }

    async advance(milliseconds: number): Promise<void> {
        this.now += milliseconds;

        while (true) {
            const due = [...this.timers.entries()]
                .filter(([, timer]) => timer.at <= this.now)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);

            if (due.length === 0) {
                break;
            }

            for (const [id, timer] of due) {
                if (this.timers.delete(id)) {
                    timer.callback();
                }
            }

            await turns();
        }

        await this.flushImmediates();
    }

    nextDelay(): number | null {
        const next = [...this.timers.values()].sort((a, b) => a.at - b.at)[0];
        return next ? next.at - this.now : null;
    }
}

interface FakeOwner {
    requestPacket: ReturnType<typeof vi.fn>;
    alive: ReturnType<typeof vi.fn>;
    heartbeat: ReturnType<typeof vi.fn>;
    refreshTickets: ReturnType<typeof vi.fn>;
}

interface FakeController {
    readonly value: DirectManagedController;
    readonly owner: FakeOwner;
    readonly close: ReturnType<typeof vi.fn>;
    readonly getRenewalMetadata: ReturnType<typeof vi.fn>;
    closeUnexpectedly(): void;
    failUnexpectedly(error: unknown): void;
}

function fakeController(
    renewalMetadata: { nextRefreshAtSeconds: bigint; expiresAtSeconds: bigint } | null = null,
): FakeController {
    const closed = deferred<void>();
    let closedOnce = false;
    const owner: FakeOwner = {
        requestPacket: vi.fn(async (input: WtReferencePacketInput) => ({
            status: 'response' as const,
            command: input.command,
            sequence: 7,
            retCode: 0 as const,
            body: Uint8Array.from([9, 8, 7]),
            writeState: 'written' as const,
        })),
        alive: vi.fn(async () => ({ status: 'success' as const })),
        heartbeat: vi.fn(async () => ({ status: 'success' as const, interval: 270n })),
        refreshTickets: vi.fn(async () => ({
            status: 'refreshed' as const,
            nextRefreshAtSeconds: 0n,
            expiresAtSeconds: 0n,
        })),
    };
    const close = vi.fn(async () => {
        if (!closedOnce) {
            closedOnce = true;
            closed.resolve();
        }
    });
    const getRenewalMetadata = vi.fn(() => renewalMetadata);
    const value = {
        owner,
        confirmedUin: UIN,
        qrImage: '/fixture/qr/qr-121212121212121212121212.png',
        whenClosed: closed.promise,
        close,
        getRenewalMetadata,
    } as unknown as DirectManagedController;
    return {
        value,
        owner,
        close,
        getRenewalMetadata,
        closeUnexpectedly() {
            if (!closedOnce) {
                closedOnce = true;
                closed.resolve();
            }
        },
        failUnexpectedly(error: unknown) {
            if (!closedOnce) {
                closedOnce = true;
                closed.reject(error);
            }
        },
    };
}

interface FakeIngress {
    readonly value: DirectPushIngress;
    readonly activate: ReturnType<typeof vi.fn>;
    readonly submit: ReturnType<typeof vi.fn>;
    readonly stop: ReturnType<typeof vi.fn>;
    readonly drain: ReturnType<typeof vi.fn>;
}

function fakeIngress(): FakeIngress {
    const activate = vi.fn(() => true);
    const submit = vi.fn(async () => ({ kind: 'settled' as const, events: 1 }));
    const stop = vi.fn();
    const drain = vi.fn(async () => undefined);
    return {
        value: { activate, submit, stop, drain },
        activate,
        submit,
        stop,
        drain,
    };
}

interface FakeSession {
    readonly handle: DirectSessionHandle;
    readonly bridge: { openDirectPushIngress: ReturnType<typeof vi.fn> };
    readonly ingress: FakeIngress;
    readonly activate: ReturnType<typeof vi.fn>;
    readonly setReceiveHealthy: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
    sender: PacketSender | undefined;
}

function fakeSession(order: string[]): FakeSession {
    const ingress = fakeIngress();
    const bridge = {
        openDirectPushIngress: vi.fn(() => {
            order.push('ingress-open');
            return ingress.value;
        }),
    };
    const fixture = {} as FakeSession;
    const activate = vi.fn((sender: PacketSender) => {
        order.push('bridge-activate');
        fixture.sender = sender;
    });
    const setReceiveHealthy = vi.fn();
    const close = vi.fn(async () => {
        order.push('bridge-close');
    });
    Object.assign(fixture, {
        handle: { bridge, activate, setReceiveHealthy, close } as unknown as DirectSessionHandle,
        bridge,
        ingress,
        activate,
        setReceiveHealthy,
        close,
        sender: undefined,
    });
    return fixture;
}

function account(
    options: { autoRestore?: boolean; autoRenew?: boolean } = {},
): ManagedAccountConfig {
    return {
        id: 'fixture-account',
        label: 'Fixture account',
        configFile: '/fixture/config.json',
        selectorFile: '/fixture/selector.json',
        persistence: {
            vaultRoot: '/fixture/vault',
            keyRoot: '/fixture/key',
            slotId: 'ab'.repeat(16),
        },
        autoRestore: options.autoRestore ?? false,
        autoRenew: options.autoRenew ?? false,
        config: {
            outDir: '/fixture/qr',
            reserve: { signCommands: [] },
        } as unknown as ManagedAccountConfig['config'],
    };
}

function callbacks() {
    const updates: ManagedDirectAccountUpdate[] = [];
    const controller = new AbortController();
    const update = vi.fn((value: ManagedDirectAccountUpdate) => updates.push(value));
    return {
        value: { signal: controller.signal, update } satisfies ManagedDirectAccountDriverCallbacks,
        controller,
        update,
        updates,
    };
}

interface FixtureOptions {
    storedUin?: string | null;
    account?: ManagedAccountConfig;
    start?: (options: ManagedDirectLoginOptions) => Promise<DirectLoginController>;
    restore?: (options: ManagedDirectRestoreOptions) => Promise<DirectRestoredLoginController>;
    renewSession?: DirectRenewSession | null;
    readRenewalMetadata?: DirectAccountDriverOverrides['readRenewalMetadata'];
}

async function fixture(options: FixtureOptions = {}) {
    const order: string[] = [];
    const scheduler = new ManualScheduler();
    const sessions: FakeSession[] = [];
    const controllers: FakeController[] = [];
    let currentController = fakeController();
    controllers.push(currentController);
    const openDirectSession = vi.fn(() => {
        order.push('bridge-open');
        const session = fakeSession(order);
        sessions.push(session);
        return session.handle;
    });
    const getInstanceForSession = vi.fn((_uin: string, bridge: unknown) => {
        order.push('onebot-get');
        const current = sessions.at(-1);
        return current?.sender && bridge === current.bridge
            ? ({ fixture: true } as unknown as OneBotInstance)
            : null;
    });
    const waitForSessionRetirement = vi.fn(async (_uin: string, bridge: unknown) => {
        order.push('onebot-retire');
        expect(bridge).toBe(sessions.find((session) => session.bridge === bridge)?.bridge);
    });
    let lastStartOptions: ManagedDirectLoginOptions | undefined;
    let lastRestoreOptions: ManagedDirectRestoreOptions | undefined;
    const startManagedDirectLogin = vi.fn(async (_config, runnerOptions) => {
        lastStartOptions = runnerOptions;

        if (options.start) {
            return options.start(runnerOptions);
        }

        runnerOptions.onEvent?.({
            state: 'qr-ready',
            qrImage: '/fixture/qr/qr-121212121212121212121212.png',
        });
        runnerOptions.onEvent?.({ state: 'waiting-scan' });
        runnerOptions.beforeRegister?.(UIN);
        runnerOptions.onEvent?.({ state: 'registering' });
        runnerOptions.onEvent?.({ state: 'online' });
        return currentController.value as DirectLoginController;
    });
    const restoreManagedDirectLogin = vi.fn(async (_config, runnerOptions) => {
        lastRestoreOptions = runnerOptions;

        if (options.restore) {
            return options.restore(runnerOptions);
        }

        currentController = fakeController();
        controllers.push(currentController);
        runnerOptions.onEvent?.({ state: 'restoring' });
        runnerOptions.beforeRegister?.(UIN);
        runnerOptions.onEvent?.({ state: 'online' });
        return currentController.value as DirectRestoredLoginController;
    });
    const readManagedSelector = vi.fn(async () => options.storedUin ?? null);
    const saveManagedSelector = vi.fn(async (_file, _uin, guard: () => boolean) => {
        order.push('selector-save');
        expect(guard()).toBe(true);
    });
    const readManagedQr = vi.fn(async (_dir, _file, guard: () => boolean) => {
        expect(guard()).toBe(true);
        return { bytes: Uint8Array.from([1, 2, 3]), contentType: 'image/png' as const };
    });
    const overrides: DirectAccountDriverOverrides = {
        startManagedDirectLogin,
        restoreManagedDirectLogin,
        readManagedSelector,
        saveManagedSelector,
        readManagedQr,
        renewSession: options.renewSession,
        readRenewalMetadata: options.readRenewalMetadata,
        now: () => scheduler.now,
        monotonicNow: () => scheduler.now,
        setTimeout: scheduler.setTimeout,
        clearTimeout: scheduler.clearTimeout,
        setImmediate: scheduler.setImmediate,
        clearImmediate: scheduler.clearImmediate,
        oneBotReadyTimeoutMs: 10_000,
    };
    const driver = await createDirectAccountDriver(
        options.account ?? account(),
        {
            bridgeManager: { openDirectSession },
            oneBotManager: { getInstanceForSession, waitForSessionRetirement },
        },
        overrides,
    );
    return {
        driver,
        order,
        scheduler,
        sessions,
        controllers,
        openDirectSession,
        getInstanceForSession,
        waitForSessionRetirement,
        startManagedDirectLogin,
        restoreManagedDirectLogin,
        readManagedSelector,
        saveManagedSelector,
        readManagedQr,
        get startOptions() {
            return lastStartOptions;
        },
        get restoreOptions() {
            return lastRestoreOptions;
        },
        get controller() {
            return currentController;
        },
    };
}

const drivers: Array<{ dispose(): Promise<void> }> = [];
const services: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
    await Promise.allSettled(drivers.splice(0).map((driver) => driver.dispose()));
    vi.restoreAllMocks();
});

describe('managed direct account driver (synthetic dependencies only)', () => {
    it('reads the selector before publishing its snapshot and permits explicit renewal disablement', async () => {
        const enabled = await fixture({
            storedUin: UIN,
            account: account({ autoRenew: true }),
        });
        drivers.push(enabled.driver);
        expect(enabled.readManagedSelector).toHaveBeenCalledOnce();
        expect(enabled.driver.snapshot()).toMatchObject({
            phase: 'stopped',
            generation: null,
            uin: UIN,
            hasStoredAccount: true,
            canRenew: true,
        });
        expect(enabled.driver.snapshot().capabilities).toContain('renew');

        const disabled = await fixture({
            storedUin: UIN,
            account: account({ autoRenew: true }),
            renewSession: null,
        });
        drivers.push(disabled.driver);
        expect(disabled.driver.snapshot().canRenew).toBe(false);
        expect(disabled.driver.snapshot().capabilities).not.toContain('renew');
    });

    it('opens Bridge and ingress in beforeRegister, persists QR selection, then activates exact OneBot generation', async () => {
        const f = await fixture();
        drivers.push(f.driver);
        const cb = callbacks();
        await f.driver.begin('qr', GENERATION, cb.value);
        const session = f.sessions[0];

        expect(f.startOptions?.leaseTimeoutMs).toBe(0x7fffffff);
        expect(f.startOptions?.push?.maxPushBodyBytes).toBe(2 * 1024 * 1024);
        expect(f.order).toEqual([
            'bridge-open',
            'ingress-open',
            'selector-save',
            'bridge-activate',
            'onebot-get',
        ]);
        expect(session.ingress.activate).toHaveBeenCalledBefore(session.activate);
        expect(f.saveManagedSelector).toHaveBeenCalledBefore(session.activate);
        expect(f.getInstanceForSession).toHaveBeenCalledWith(UIN, session.bridge);
        expect(f.driver.snapshot()).toMatchObject({
            generation: GENERATION,
            uin: UIN,
            phase: 'online',
            online: true,
            onebotReady: true,
            receiveHealthy: true,
            hasStoredAccount: true,
        });
        expect(cb.updates.at(-1)).toEqual({ phase: 'online', qrAvailable: false, error: null });
    });

    it('keeps QR reads generation-guarded without deleting the artifact', async () => {
        const gate = deferred<void>();
        let runnerOptions: ManagedDirectLoginOptions | undefined;
        const f = await fixture({
            start: async (options) => {
                runnerOptions = options;
                options.onEvent?.({
                    state: 'qr-ready',
                    qrImage: '/fixture/qr/qr-121212121212121212121212.png',
                });
                options.onEvent?.({ state: 'waiting-scan' });
                await gate.promise;
                options.beforeRegister?.(UIN);
                throw new Error('synthetic stop after QR read');
            },
        });
        drivers.push(f.driver);
        const cb = callbacks();
        const beginning = f.driver.begin('qr', GENERATION, cb.value);
        await turns();
        await expect(f.driver.qr(GENERATION)).resolves.toEqual({
            bytes: Uint8Array.from([1, 2, 3]),
            contentType: 'image/png',
        });
        expect(f.readManagedQr).toHaveBeenCalledWith(
            '/fixture/qr',
            '/fixture/qr/qr-121212121212121212121212.png',
            expect.any(Function),
        );
        expect(runnerOptions).toBeDefined();
        gate.resolve();
        await expect(beginning).rejects.toMatchObject({ code: 'protocol-or-transport' });
    });

    it('closes a controller that resolves after initial-generation cancellation', async () => {
        const gate = deferred<void>();
        const late = fakeController();
        const f = await fixture({
            start: async () => {
                await gate.promise;
                return late.value as DirectLoginController;
            },
        });
        drivers.push(f.driver);
        const beginning = f.driver.begin('qr', GENERATION, callbacks().value);
        await turns();
        f.driver.cancel(GENERATION);
        gate.resolve();
        await expect(beginning).rejects.toBeDefined();
        expect(late.close).toHaveBeenCalledOnce();
    });

    it('maps only the fixed six packet commands through one bounded queue and never replays a write', async () => {
        const f = await fixture();
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        const sender = f.sessions[0].sender!;
        const unsupported = await sender.sendPacket('Fixture.Unknown', Buffer.from([1]));
        expect(unsupported).toMatchObject({ success: false, gotResponse: false, errorCode: -1 });
        expect(f.controller.owner.requestPacket).not.toHaveBeenCalled();

        const response = await sender.sendPacket(PACKET_COMMAND, Buffer.from([4, 5]), 1234);
        expect(response).toEqual({
            success: true,
            gotResponse: true,
            errorCode: 0,
            errorMessage: '',
            responseData: Buffer.from([9, 8, 7]),
        });
        expect(f.controller.owner.requestPacket).toHaveBeenCalledOnce();
        expect(f.controller.owner.requestPacket).toHaveBeenCalledWith({
            command: PACKET_COMMAND,
            body: Uint8Array.from([0, 0]),
            timeoutMs: expect.any(Number),
            maxResponseBodyBytes: 2 * 1024 * 1024,
        });

        f.controller.owner.requestPacket.mockRejectedValueOnce(
            new Error('synthetic write unknown'),
        );
        const failed = await sender.sendPacket(PACKET_COMMAND, Buffer.from([6]));
        expect(failed).toMatchObject({ success: false, gotResponse: false });
        expect(f.controller.owner.requestPacket).toHaveBeenCalledTimes(2);
        await turns();
        expect(f.controller.owner.requestPacket).toHaveBeenCalledTimes(2);
    });

    it('submits only MsgPush and marks receive health false on rejected or exceptional async ingress results', async () => {
        const f = await fixture();
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        const push = f.startOptions?.push?.onPushBody;
        const session = f.sessions[0];
        expect(push).toBeTypeOf('function');

        await push!(Uint8Array.from([1]), {
            uin: UIN,
            sequence: 1,
            command: 'ConfigPushSvc.PushReq',
            retCode: 0,
        });
        expect(session.ingress.submit).not.toHaveBeenCalled();
        await push!(Uint8Array.from([1]), {
            uin: '2000000002',
            sequence: 2,
            command: MSG_PUSH,
            retCode: 0,
        });
        expect(session.ingress.submit).not.toHaveBeenCalled();

        session.ingress.submit.mockResolvedValueOnce({ kind: 'rejected', reason: 'capacity' });
        await push!(Uint8Array.from([2]), {
            uin: UIN,
            sequence: 2,
            command: MSG_PUSH,
            retCode: 0,
        });
        expect(session.ingress.submit).toHaveBeenCalledOnce();
        expect(session.setReceiveHealthy).toHaveBeenLastCalledWith(false);
        expect(f.driver.snapshot().receiveHealthy).toBe(false);

        session.ingress.submit.mockRejectedValueOnce(new Error('synthetic pipeline failure'));
        await push!(Uint8Array.from([3]), {
            uin: UIN,
            sequence: 3,
            command: MSG_PUSH,
            retCode: 0,
        });
        expect(session.ingress.submit).toHaveBeenCalledTimes(2);
        expect(f.driver.snapshot().receiveHealthy).toBe(false);
    });

    it('runs Alive at 2s and heartbeat at 270s only as serialized liveness checks', async () => {
        const f = await fixture();
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.advance(270_000);
        expect(f.controller.owner.alive).toHaveBeenCalledOnce();
        expect(f.controller.owner.heartbeat).toHaveBeenCalledOnce();
        expect(f.controller.owner.refreshTickets).not.toHaveBeenCalled();
        expect(f.driver.snapshot().renewAt).toBeNull();
    });

    it('closes after three consecutive liveness failures without treating heartbeat as renewal', async () => {
        const f = await fixture();
        drivers.push(f.driver);
        f.controller.owner.alive.mockResolvedValue({ status: 'sso-error', retCode: 1 });
        await f.driver.begin('qr', GENERATION, callbacks().value);

        for (let count = 0; count < 3; count += 1) {
            await f.scheduler.advance(2_000);
        }

        expect(f.controller.owner.alive).toHaveBeenCalledTimes(3);
        expect(f.controller.close).toHaveBeenCalledOnce();
        expect(f.driver.snapshot()).toMatchObject({
            online: false,
            onebotReady: false,
            receiveHealthy: false,
            phase: 'failed',
            error: 'protocol-or-transport',
        });
        expect(f.controller.owner.refreshTickets).not.toHaveBeenCalled();
    });

    it('auto-restores an unexpected close after bounded exponential backoff', async () => {
        const f = await fixture({
            storedUin: UIN,
            account: account({ autoRestore: true }),
        });
        drivers.push(f.driver);
        const cb = callbacks();
        await f.driver.begin('restore', GENERATION, cb.value);
        f.controller.closeUnexpectedly();
        await turns(5);
        expect(f.restoreManagedDirectLogin).toHaveBeenCalledOnce();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'backoff',
            retryAt: f.scheduler.now + 5_000,
        });

        await f.scheduler.advance(4_999);
        expect(f.restoreManagedDirectLogin).toHaveBeenCalledOnce();
        await f.scheduler.advance(1);
        expect(f.restoreManagedDirectLogin).toHaveBeenCalledTimes(2);
        expect(f.driver.snapshot()).toMatchObject({
            online: true,
            onebotReady: true,
            phase: 'online',
            retryAt: null,
        });
        expect(cb.updates.some((update) => update.phase === 'backoff')).toBe(true);
    });

    it('caps failed automatic restore at ten attempts and five-minute delays', async () => {
        const restore = vi.fn(async (options: ManagedDirectRestoreOptions) => {
            options.onEvent?.({ state: 'restoring' });
            throw new Error('synthetic restore failure');
        });
        const f = await fixture({
            storedUin: UIN,
            account: account({ autoRestore: true }),
        });
        drivers.push(f.driver);
        await f.driver.begin('restore', GENERATION, callbacks().value);
        f.controller.closeUnexpectedly();
        await turns(5);
        f.restoreManagedDirectLogin.mockImplementation(restore);

        const delays: number[] = [];

        for (let attempt = 0; attempt < 10; attempt += 1) {
            const delay = f.scheduler.nextDelay();
            expect(delay).not.toBeNull();
            delays.push(delay!);
            await f.scheduler.advance(delay!);
        }

        expect(restore).toHaveBeenCalledTimes(10);
        expect(delays).toEqual([
            5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000,
        ]);
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'failed',
            retryAt: null,
            online: false,
        });

        const replacement = fakeController();
        f.startManagedDirectLogin.mockImplementation(async (_config, runnerOptions) => {
            runnerOptions.beforeRegister?.(UIN);
            runnerOptions.onEvent?.({ state: 'online' });
            return replacement.value as DirectLoginController;
        });
        await expect(
            f.driver.begin('qr', '22'.repeat(16), callbacks().value),
        ).resolves.toBeUndefined();
        expect(f.driver.snapshot()).toMatchObject({ phase: 'online', online: true });
    });

    it('blocks new ingress and egress synchronously, then drains in exact retirement order', async () => {
        const f = await fixture();
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        const session = f.sessions[0];
        const sender = session.sender!;
        const stopCallbacks = callbacks();
        const stopping = f.driver.begin('stop', GENERATION, stopCallbacks.value);
        expect(session.ingress.stop).toHaveBeenCalledOnce();
        await f.startOptions?.push?.onPushBody(Uint8Array.from([1]), {
            uin: UIN,
            sequence: 99,
            command: MSG_PUSH,
            retCode: 0,
        });
        expect(session.ingress.submit).not.toHaveBeenCalled();
        await expect(sender.sendPacket(PACKET_COMMAND, Buffer.from([1]))).resolves.toMatchObject({
            success: false,
        });
        await stopping;
        expect(f.order.slice(-2)).toEqual(['bridge-close', 'onebot-retire']);
        expect(session.ingress.drain).toHaveBeenCalledBefore(session.close);
        expect(f.waitForSessionRetirement).toHaveBeenCalledWith(UIN, session.bridge);
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'stopped',
            generation: null,
            online: false,
            onebotReady: false,
        });
    });

    it('preserves independent owner, ingress, bridge, and OneBot retirement failures on stop', async () => {
        const f = await fixture();
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        const session = f.sessions[0];
        f.controller.close.mockRejectedValueOnce(new Error('owner-close'));
        session.ingress.drain.mockRejectedValueOnce(new Error('ingress-drain'));
        session.close.mockRejectedValueOnce(new Error('bridge-close'));
        f.waitForSessionRetirement.mockRejectedValueOnce(new Error('onebot-retire'));
        const cb = callbacks();
        const error = await f.driver.begin('stop', GENERATION, cb.value).then(
            () => undefined,
            (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toHaveLength(4);
        expect(session.ingress.drain).toHaveBeenCalled();
        expect(session.close).toHaveBeenCalled();
        expect(f.waitForSessionRetirement).toHaveBeenCalledWith(UIN, session.bridge);
        expect(cb.updates.at(-1)).toEqual({
            phase: 'failed',
            qrAvailable: false,
            error: 'cleanup-failed',
        });
    });

    it('ignores both persistence checkpoint event pairs throughout manual renewal', async () => {
        const gate = deferred<{ renewAt: null; lastRenewedAt: number }>();
        const observed: Array<{ phase: string; error: string | null }> = [];
        let f!: Awaited<ReturnType<typeof fixture>>;
        const renewSession = vi.fn<DirectRenewSession>(async () => {
            const emit = f.startOptions?.onEvent;

            for (let checkpoint = 0; checkpoint < 2; checkpoint += 1) {
                emit?.({ state: 'saving-account' });
                observed.push({
                    phase: f.driver.snapshot().phase,
                    error: f.driver.snapshot().error,
                });
                emit?.({ state: 'account-saved' });
                observed.push({
                    phase: f.driver.snapshot().phase,
                    error: f.driver.snapshot().error,
                });
            }

            return gate.promise;
        });
        f = await fixture({ account: account({ autoRenew: false }), renewSession });
        drivers.push(f.driver);
        const sessionCallbacks = callbacks();
        await f.driver.begin('qr', GENERATION, sessionCallbacks.value);
        const sessionUpdateCount = sessionCallbacks.updates.length;
        const renewal = f.driver.begin('renew', GENERATION, callbacks().value);
        await turns();

        try {
            expect(observed).toHaveLength(4);
            expect(observed).toEqual(
                Array.from({ length: 4 }, () => ({ phase: 'renewing', error: null })),
            );
            expect(f.driver.snapshot()).toMatchObject({ phase: 'renewing', error: null });
            expect(sessionCallbacks.updates.slice(sessionUpdateCount)).toEqual([]);
        } finally {
            gate.resolve({ renewAt: null, lastRenewedAt: f.scheduler.now });
        }

        await renewal;
        expect(f.driver.snapshot()).toMatchObject({ phase: 'online', error: null });
    });

    it('keeps automatic checkpoint events renewing so service preflight rejects concurrent renewal', async () => {
        const gate = deferred<{ renewAt: null; lastRenewedAt: number }>();
        const observed: string[] = [];
        let f!: Awaited<ReturnType<typeof fixture>>;
        const renewSession = vi.fn<DirectRenewSession>(async () => {
            const emit = f.startOptions?.onEvent;

            for (let checkpoint = 0; checkpoint < 2; checkpoint += 1) {
                emit?.({ state: 'saving-account' });
                observed.push(f.driver.snapshot().phase);
                emit?.({ state: 'account-saved' });
                observed.push(f.driver.snapshot().phase);
            }

            return gate.promise;
        });
        f = await fixture({
            account: account({ autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        const managed = new ManagedDirectAccountService([f.driver], { autoStart: false });
        services.push(managed);
        const initial = managed.get('fixture-account', serviceScope()).account;
        managed.start(
            'fixture-account',
            {
                mode: 'qr',
                expectedRevision: initial.revision,
                operationKey: operationKey(91),
            },
            serviceScope(),
        );
        await turns(8);
        expect(managed.get('fixture-account', serviceScope()).account.phase).toBe('online');
        await f.scheduler.flushImmediates();

        try {
            expect(renewSession).toHaveBeenCalledOnce();
            expect(observed).toEqual(['renewing', 'renewing', 'renewing', 'renewing']);
            expect(f.driver.snapshot()).toMatchObject({ phase: 'renewing', error: null });
            const renewingAccount = managed.get('fixture-account', serviceScope()).account;
            expect(renewingAccount.phase).toBe('renewing');
            expect(
                serviceErrorCode(() =>
                    managed.renew(
                        'fixture-account',
                        {
                            expectedRevision: renewingAccount.revision,
                            operationKey: operationKey(92),
                        },
                        serviceScope(),
                    ),
                ),
            ).toBe('account-busy');
        } finally {
            gate.resolve({ renewAt: null, lastRenewedAt: f.scheduler.now });
        }

        await turns(8);
        expect(managed.get('fixture-account', serviceScope()).account.phase).toBe('online');
    });

    it('bootstraps renewal once, then schedules only the returned absolute server time', async () => {
        const schedulerNow = 1_700_000_000_000;
        const renewSession = vi
            .fn<DirectRenewSession>()
            .mockResolvedValueOnce({ renewAt: schedulerNow + 10_000, lastRenewedAt: schedulerNow })
            .mockResolvedValueOnce({ renewAt: null, lastRenewedAt: schedulerNow + 10_000 });
        const f = await fixture({
            account: account({ autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'online',
            renewAt: schedulerNow + 10_000,
            lastRenewedAt: schedulerNow,
        });

        await f.scheduler.advance(9_999);
        expect(renewSession).toHaveBeenCalledOnce();
        await f.scheduler.advance(1);
        expect(renewSession).toHaveBeenCalledTimes(2);
        expect(f.driver.snapshot().renewAt).toBeNull();
        await f.scheduler.advance(1_000_000);
        expect(renewSession).toHaveBeenCalledTimes(2);
    });

    it('replaces an existing auto-renew timer after manual renewal instead of double refreshing', async () => {
        const now = 1_700_000_000_000;
        const renewSession = vi
            .fn<DirectRenewSession>()
            .mockResolvedValueOnce({ renewAt: now + 10_000, lastRenewedAt: now })
            .mockResolvedValueOnce({ renewAt: now + 20_000, lastRenewedAt: now })
            .mockResolvedValueOnce({ renewAt: null, lastRenewedAt: now + 20_000 });
        const f = await fixture({
            account: account({ autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(renewSession).toHaveBeenCalledOnce();

        await f.driver.begin('renew', GENERATION, callbacks().value);
        expect(renewSession).toHaveBeenCalledTimes(2);
        expect(f.driver.snapshot().renewAt).toBe(now + 20_000);
        await f.scheduler.advance(10_000);
        expect(renewSession).toHaveBeenCalledTimes(2);
        await f.scheduler.advance(10_000);
        expect(renewSession).toHaveBeenCalledTimes(3);
    });

    it('treats non-null zero renewal metadata as known and never bootstraps it again', async () => {
        const renewSession = vi.fn<DirectRenewSession>(async () => ({
            renewAt: null,
            lastRenewedAt: 1_700_000_000_000,
        }));
        const f = await fixture({
            account: account({ autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => ({
                nextRefreshAtSeconds: 0n,
                expiresAtSeconds: 0n,
            }),
        });
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        await f.scheduler.advance(1_000_000);
        expect(renewSession).not.toHaveBeenCalled();
        expect(f.driver.snapshot().renewAt).toBeNull();
    });

    it('preserves an automatic renewal error across transport recovery without replaying refresh', async () => {
        const renewSession = vi.fn<DirectRenewSession>(async (controller) => {
            await controller.close();
            throw new ManagedDirectAccountDriverError('renewal-not-sent');
        });
        const f = await fixture({
            storedUin: UIN,
            account: account({ autoRestore: true, autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        await f.driver.begin('restore', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'backoff',
            error: 'renewal-not-sent',
        });

        await f.scheduler.advance(5_000);
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'online',
            online: true,
            error: 'renewal-not-sent',
        });
        await f.scheduler.advance(1_000_000);
        expect(renewSession).toHaveBeenCalledOnce();
    });

    it.each(['renewal-write-unknown', 'renewal-not-sent'] as const)(
        'does not replay %s from the same overdue persisted renewal receipt after recovery',
        async (errorCode) => {
            const base = 1_700_000_000_000;
            const readRenewalMetadata = vi.fn(() => ({
                nextRefreshAtSeconds: BigInt((base - 1_000) / 1000),
                expiresAtSeconds: BigInt((base + 120_000) / 1000),
            }));
            const renewSession = vi.fn<DirectRenewSession>(async (controller) => {
                await controller.close();
                throw new ManagedDirectAccountDriverError(errorCode);
            });
            const f = await fixture({
                storedUin: UIN,
                account: account({ autoRestore: true, autoRenew: true }),
                renewSession,
                readRenewalMetadata,
            });
            drivers.push(f.driver);
            await f.driver.begin('restore', GENERATION, callbacks().value);
            await f.scheduler.advance(0);
            expect(renewSession).toHaveBeenCalledOnce();
            expect(f.driver.snapshot()).toMatchObject({ phase: 'backoff', error: errorCode });

            await f.scheduler.advance(5_000);
            expect(readRenewalMetadata).toHaveBeenCalledTimes(2);
            expect(f.driver.snapshot()).toMatchObject({
                phase: 'online',
                online: true,
                error: errorCode,
            });
            await f.scheduler.advance(1_000_000);
            expect(renewSession).toHaveBeenCalledOnce();
        },
    );

    it('does not auto-replay an early explicit renewal failure from the same future metadata', async () => {
        const base = 1_700_000_000_000;
        const readRenewalMetadata = vi.fn(() => ({
            nextRefreshAtSeconds: BigInt((base + 20_000) / 1000),
            expiresAtSeconds: BigInt((base + 120_000) / 1000),
        }));
        const renewSession = vi.fn<DirectRenewSession>(async (controller) => {
            await controller.close();
            throw new ManagedDirectAccountDriverError('renewal-write-unknown');
        });
        const f = await fixture({
            storedUin: UIN,
            account: account({ autoRestore: true, autoRenew: true }),
            renewSession,
            readRenewalMetadata,
        });
        drivers.push(f.driver);
        await f.driver.begin('restore', GENERATION, callbacks().value);
        expect(f.driver.snapshot().renewAt).toBe(base + 20_000);
        expect(renewSession).not.toHaveBeenCalled();

        await expect(f.driver.begin('renew', GENERATION, callbacks().value)).rejects.toMatchObject({
            code: 'renewal-write-unknown',
        });
        await turns(5);
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'backoff',
            error: 'renewal-write-unknown',
        });

        await f.scheduler.advance(5_000);
        expect(readRenewalMetadata).toHaveBeenCalledTimes(2);
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'online',
            error: 'renewal-write-unknown',
            renewAt: base + 20_000,
        });
        await f.scheduler.advance(1_000_000);
        expect(renewSession).toHaveBeenCalledOnce();
    });

    it('projects future metadata but keeps automatic renewal fail-closed after a failed receipt', async () => {
        const base = 1_700_000_000_000;
        const readRenewalMetadata = vi
            .fn<NonNullable<DirectAccountDriverOverrides['readRenewalMetadata']>>()
            .mockReturnValueOnce({
                nextRefreshAtSeconds: BigInt((base - 1_000) / 1000),
                expiresAtSeconds: BigInt((base + 120_000) / 1000),
            })
            .mockReturnValueOnce({
                nextRefreshAtSeconds: BigInt((base + 20_000) / 1000),
                expiresAtSeconds: BigInt((base + 120_000) / 1000),
            });
        const renewSession = vi.fn<DirectRenewSession>(async (controller) => {
            await controller.close();
            throw new ManagedDirectAccountDriverError('renewal-write-unknown');
        });
        const f = await fixture({
            storedUin: UIN,
            account: account({ autoRestore: true, autoRenew: true }),
            renewSession,
            readRenewalMetadata,
        });
        drivers.push(f.driver);
        await f.driver.begin('restore', GENERATION, callbacks().value);
        await f.scheduler.advance(0);
        expect(renewSession).toHaveBeenCalledOnce();

        await f.scheduler.advance(5_000);
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'online',
            error: 'renewal-write-unknown',
            renewAt: base + 20_000,
        });
        await f.scheduler.advance(15_000);
        await f.scheduler.advance(1_000_000);
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'online',
            error: 'renewal-write-unknown',
            renewAt: base + 20_000,
        });
    });

    it('reloads persisted renewal metadata from each restored session without replaying legacy bootstrap', async () => {
        const base = 1_700_000_000_000;
        const readRenewalMetadata = vi
            .fn<NonNullable<DirectAccountDriverOverrides['readRenewalMetadata']>>()
            .mockReturnValueOnce(null)
            .mockReturnValueOnce({
                nextRefreshAtSeconds: BigInt((base + 20_000) / 1000),
                expiresAtSeconds: BigInt((base + 120_000) / 1000),
            });
        const renewSession = vi.fn<DirectRenewSession>(async () => ({
            renewAt: null,
            lastRenewedAt: base,
        }));
        const f = await fixture({
            storedUin: UIN,
            account: account({ autoRestore: true, autoRenew: true }),
            renewSession,
            readRenewalMetadata,
        });
        drivers.push(f.driver);
        await f.driver.begin('restore', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(renewSession).toHaveBeenCalledOnce();
        expect(readRenewalMetadata).toHaveBeenCalledOnce();

        f.controller.closeUnexpectedly();
        await turns(5);
        await f.scheduler.advance(5_000);
        expect(readRenewalMetadata).toHaveBeenCalledTimes(2);
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot().renewAt).toBe(base + 20_000);
        await f.scheduler.advance(15_000);
        expect(renewSession).toHaveBeenCalledTimes(2);
    });

    it('schedules valid persisted renewal metadata at its absolute time, including an overdue time', async () => {
        const renewSession = vi.fn<DirectRenewSession>(async () => ({
            renewAt: null,
            lastRenewedAt: 1_700_000_000_000,
        }));
        const f = await fixture({
            account: account({ autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => ({
                nextRefreshAtSeconds: 1_699_999_999n,
                expiresAtSeconds: 1_700_000_100n,
            }),
        });
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.advance(0);
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot().renewAt).toBeNull();
    });

    it('uses the production refreshTickets adapter with fixed result and error projection', async () => {
        const f = await fixture({
            account: account({ autoRenew: true }),
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        f.controller.owner.refreshTickets.mockResolvedValueOnce({
            status: 'refreshed',
            nextRefreshAtSeconds: BigInt(Math.floor((f.scheduler.now + 60_000) / 1000)),
            expiresAtSeconds: BigInt(Math.floor((f.scheduler.now + 120_000) / 1000)),
        });
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(f.controller.owner.refreshTickets).toHaveBeenCalledWith({
            signal: expect.any(AbortSignal),
            timeoutMs: 120_000,
        });
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'online',
            lastRenewedAt: f.scheduler.now,
            renewAt: f.scheduler.now + 60_000,
        });
    });

    it('maps default refresh failures without exposing native details or replaying', async () => {
        const f = await fixture({
            account: account({ autoRenew: true }),
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        f.controller.owner.refreshTickets.mockRejectedValueOnce({
            writeState: 'unknown',
            message: 'synthetic private native detail',
        });
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'failed',
            error: 'renewal-write-unknown',
        });
        expect(f.controller.owner.refreshTickets).toHaveBeenCalledOnce();
        await f.scheduler.advance(1_000_000);
        expect(f.controller.owner.refreshTickets).toHaveBeenCalledOnce();
    });

    it('invalidates the stored-account claim on native needs-login without restore retries', async () => {
        const f = await fixture({
            storedUin: UIN,
            account: account({ autoRestore: true, autoRenew: true }),
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        f.controller.owner.refreshTickets.mockResolvedValueOnce({
            status: 'needs-login',
            code: 8n,
        });
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(f.controller.owner.refreshTickets).toHaveBeenCalledOnce();
        expect(f.controller.close).toHaveBeenCalledOnce();
        expect(f.restoreManagedDirectLogin).not.toHaveBeenCalled();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'needs-login',
            online: false,
            hasStoredAccount: false,
            uin: UIN,
            error: 'needs-login',
        });
        await f.scheduler.advance(10_000_000);
        expect(f.restoreManagedDirectLogin).not.toHaveBeenCalled();
        await expect(
            f.driver.begin('restore', '33'.repeat(16), callbacks().value),
        ).rejects.toMatchObject({ code: 'needs-login' });
    });

    it.each([
        ['not-sent', 'not-written', 'renewal-not-sent'],
        ['write-unknown', 'unknown', 'renewal-write-unknown'],
        ['invalid-response', 'written', 'renewal-invalid-receipt'],
        ['checkpoint-failed', 'written', 'renewal-checkpoint-failed'],
        ['invalidation-failed', 'written', 'renewal-invalidation-failed'],
        ['activation-failed', 'written', 'renewal-activation-failed'],
        ['stopped', 'not-written', 'renewal-closed'],
    ] as const)(
        'maps WtTicketRefreshError %s (%s) to a fixed projection',
        async (code, writeState, expected) => {
            const f = await fixture({
                account: account({ autoRenew: true }),
                readRenewalMetadata: () => null,
            });
            drivers.push(f.driver);
            f.controller.owner.refreshTickets.mockRejectedValueOnce(
                new WtTicketRefreshError(code, writeState),
            );
            await f.driver.begin('qr', GENERATION, callbacks().value);
            await f.scheduler.flushImmediates();
            expect(f.driver.snapshot()).toMatchObject({ phase: 'failed', error: expected });
        },
    );

    it('does not retry a renewal failure with uncertain write state', async () => {
        const renewSession = vi.fn<DirectRenewSession>(async () => {
            throw new ManagedDirectAccountDriverError('renewal-write-unknown');
        });
        const f = await fixture({
            account: account({ autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot()).toMatchObject({
            phase: 'failed',
            error: 'renewal-write-unknown',
            renewAt: null,
        });
        await f.scheduler.advance(10_000_000);
        expect(renewSession).toHaveBeenCalledOnce();
    });

    it('rejects a manual renewal that races an automatic flight instead of attaching to it', async () => {
        const gate = deferred<{ renewAt: null; lastRenewedAt: number }>();
        const renewSession = vi.fn<DirectRenewSession>(() => gate.promise);
        const f = await fixture({
            account: account({ autoRenew: true }),
            renewSession,
            readRenewalMetadata: () => null,
        });
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        await f.scheduler.flushImmediates();
        expect(renewSession).toHaveBeenCalledOnce();
        await expect(f.driver.begin('renew', GENERATION, callbacks().value)).rejects.toMatchObject({
            code: 'renewal-backoff',
        });
        expect(renewSession).toHaveBeenCalledOnce();
        gate.resolve({ renewAt: null, lastRenewedAt: f.scheduler.now });
        await turns();
    });

    it('serializes manual renewal behind a business packet and cancels without rotating owner generation', async () => {
        const packet = deferred<{
            status: 'response';
            command: typeof PACKET_COMMAND;
            sequence: number;
            retCode: 0;
            body: Uint8Array;
            writeState: 'written';
        }>();
        const renewSession = vi.fn<DirectRenewSession>(async () => ({
            renewAt: null,
            lastRenewedAt: 1_700_000_000_000,
        }));
        const f = await fixture({ account: account(), renewSession });
        drivers.push(f.driver);
        await f.driver.begin('qr', GENERATION, callbacks().value);
        f.controller.owner.requestPacket.mockImplementationOnce(() => packet.promise);
        const sending = f.sessions[0].sender!.sendPacket(PACKET_COMMAND, Buffer.from([1]));
        await turns();
        const renewCallbacks = callbacks();
        const renewing = f.driver.begin('renew', GENERATION, renewCallbacks.value);
        await turns();
        expect(renewSession).not.toHaveBeenCalled();
        packet.resolve({
            status: 'response',
            command: PACKET_COMMAND,
            sequence: 1,
            retCode: 0,
            body: Uint8Array.from([1]),
            writeState: 'written',
        });
        await sending;
        await renewing;
        expect(renewSession).toHaveBeenCalledOnce();
        expect(f.driver.snapshot().generation).toBe(GENERATION);
    });
});
