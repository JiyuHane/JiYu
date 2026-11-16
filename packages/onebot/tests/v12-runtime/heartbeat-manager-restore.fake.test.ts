import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';
import type { DispatchPayload } from '../../src/event-filter';
import type { HttpServerNetwork, JsonObject, OneBotConfig } from '../../src/types';
import type { AdapterStatus, NetworkAdapterContext } from '../../src/network/adapter';

interface FakeTransportRecord {
    id: number;
    instance: object;
    options: V12TransportOptions;
    rejectQuiesce: boolean;
    admissionStopped: boolean;
    released: boolean;
    closeCalls: number;
}

const fake = vi.hoisted(() => ({
    transports: [] as FakeTransportRecord[],
    trace: [] as string[],
}));

// The fixture exercises the real manager and runtime, but never creates a server,
// WebSocket or network transport. The fake deliberately leaves subscribers alive
// after partial quiesce so a stale heartbeat would remain observable.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;

    const blocked = () => {
        throw new Error('unexpected HTTP server creation in fake fixture');
    };

    return {
        ...actual,
        createServer: blocked,
        default: { ...(defaultExport ?? actual), createServer: blocked },
    };
});

vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            throw new Error('unexpected WebSocket creation in fake fixture');
        }
    },
    WebSocketServer: class {
        constructor() {
            throw new Error('unexpected WebSocketServer creation in fake fixture');
        }
    },
}));

vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        private readonly record: FakeTransportRecord;

        constructor(options: V12TransportOptions) {
            const id = fake.transports.length + 1;
            this.record = {
                id,
                instance: this,
                options,
                rejectQuiesce: false,
                admissionStopped: false,
                released: false,
                closeCalls: 0,
            };
            fake.transports.push(this.record);
            fake.trace.push(`construct:${id}`);
        }

        async open(): Promise<void> {
            fake.trace.push(`open:${this.record.id}`);
        }

        quiesce(): void {
            fake.trace.push(`quiesce:${this.record.id}`);
            this.record.admissionStopped = true;

            if (this.record.rejectQuiesce) {
                throw new Error('synthetic partial quiesce');
            }
        }

        async close(): Promise<void> {
            fake.trace.push(`close:${this.record.id}`);
            this.record.closeCalls++;
            this.record.released = true;
        }

        forceClose(): void {
            fake.trace.push(`forceClose:${this.record.id}`);
            this.record.released = true;
        }
    },
}));

import { IOneBotNetworkAdapter } from '../../src/network/adapter';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import { V12Runtime } from '../../src/v12-runtime/runtime';

const managers: OneBotNetworkManager[] = [];
type HeartbeatConfig = { enabled: boolean; interval: number };

function config(heartbeat?: HeartbeatConfig, host = '127.0.0.1'): OneBotConfig {
    return {
        networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        statusCommand: { enabled: false, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
        historySync: { enabled: false },
        notifications: { channelIds: [] },
        v12: {
            enabled: true,
            host,
            port: 3012,
            accessToken: 'E5xqVb7_9pLt2QwR4M8kZ1nY',
            allowNonLoopback: false,
            ...(heartbeat === undefined ? {} : { heartbeat }),
        },
    };
}

class FakeV11Server extends IOneBotNetworkAdapter<HttpServerNetwork> {
    constructor(config: HttpServerNetwork, ctx: NetworkAdapterContext) {
        super(config.name, config, ctx);
    }

    protected bindingSignature(config: HttpServerNetwork): string {
        return JSON.stringify([config.host, config.port, config.accessToken]);
    }

    async open(): Promise<void> {
        // Model only binding ownership; this fake never creates a listener.
        if (
            fake.transports.some(
                (record) => !record.released && record.options.port === this.config.port,
            )
        ) {
            throw new Error('fake v12 port is still retained');
        }

        fake.trace.push(`v11:open:${this.name}:${this.config.port}`);
        this.isEnabled = true;
    }

    async close(): Promise<void> {
        fake.trace.push(`v11:close:${this.name}:${this.config.port}`);
        this.isEnabled = false;
    }

    onEvent(_event: JsonObject, _payload: DispatchPayload): void {
        /* no events in this fixture */
    }

    describeStatus(): AdapterStatus {
        return {
            name: this.name,
            kind: 'httpServer',
            status: this.isActive ? 'ok' : 'down',
            detail: 'fake v11 listener',
        };
    }
}

function managerFixture() {
    const getStatus = vi.fn(() => ({ good: false, online: false }));
    const ctx: NetworkAdapterContext = {
        uin: '10001',
        api: {} as never,
        buildLifecycleEvent: () => ({}),
        buildHeartbeatEvent: () => ({}),
    };
    const manager = new OneBotNetworkManager((desired) => {
        if (desired.kind === 'httpServer') {
            return new FakeV11Server(desired.config, ctx);
        }

        if (desired.kind !== 'v12Server') {
            throw new Error('unexpected adapter in fake fixture');
        }

        return new V12Runtime(desired.config, ctx, {
            getStatus,
            getSentMessageTime: async () => null,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
        });
    });
    managers.push(manager);
    return { manager, getStatus };
}

function observe(record: FakeTransportRecord): unknown[] {
    const events: unknown[] = [];
    record.options.subscribe((event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
        type: 'meta',
        detail_type: 'status_update',
        status: { good: false, bots: [{ online: false }] },
    });
    return events;
}

function heartbeats(events: unknown[]): Array<Record<string, unknown>> {
    return events.filter((event): event is Record<string, unknown> => {
        if (typeof event !== 'object' || event === null) {
            return false;
        }

        const record = event as Record<string, unknown>;
        return record.type === 'meta' && record.detail_type === 'heartbeat';
    });
}

function expectRetainedTransport(adapter: object, old: FakeTransportRecord): void {
    expect((adapter as { transport: unknown }).transport).toBe(old.instance);
    expect(old.admissionStopped).toBe(true);
    expect(old.released).toBe(false);
    expect(old.closeCalls).toBe(0);
    expect(fake.transports).toHaveLength(1);
}

function expectCleanupBeforeReopen(old: FakeTransportRecord): FakeTransportRecord {
    expect(old.released).toBe(true);
    expect(old.closeCalls).toBe(1);
    expect(fake.transports).toHaveLength(2);
    const next = fake.transports[1];
    const quiesce = fake.trace.lastIndexOf(`quiesce:${old.id}`);
    const close = fake.trace.indexOf(`close:${old.id}`);
    const construct = fake.trace.indexOf(`construct:${next.id}`);
    const open = fake.trace.indexOf(`open:${next.id}`);
    expect(quiesce).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(quiesce);
    expect(construct).toBeGreaterThan(close);
    expect(open).toBeGreaterThan(construct);
    return next;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(async () => {
    try {
        for (const record of fake.transports) {
            record.rejectQuiesce = false;
        }

        for (const manager of managers.splice(0)) {
            await manager.shutdown();
        }
    } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        fake.transports.length = 0;
        fake.trace.length = 0;
    }
});

describe('v12 heartbeat manager restore with a partial fake quiesce', () => {
    it('retires the old timer, retains the old transport and retries cleanup before the new interval', async () => {
        const { manager, getStatus } = managerFixture();
        const original = config({ enabled: true, interval: 1000 });
        const desired = config({ enabled: true, interval: 2000 });
        expect((await manager.reconcile(original)).applied).toBe(true);
        const adapter = manager.get(V12_ADAPTER_NAME)!;
        expect(adapter).toBeInstanceOf(V12Runtime);
        const old = fake.transports[0];
        const oldEvents = observe(old);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(1000);
        expect(heartbeats(oldEvents)).toHaveLength(1);
        expect(heartbeats(oldEvents)[0]).toMatchObject({ interval: 1000 });
        expect(getStatus).toHaveBeenCalledTimes(1);

        // Model admission stopping before quiesce throws. Any immediate cleanup
        // retry in the restore path also fails until the test explicitly unblocks it.
        old.rejectQuiesce = true;
        const failed = await manager.reconcile(desired);
        expect(failed.applied).toBe(false);
        expect(failed.errors).toContainEqual(
            expect.objectContaining({ name: V12_ADAPTER_NAME, phase: 'reload', restored: false }),
        );
        expect(failed.statuses).toContainEqual(
            expect.objectContaining({ name: V12_ADAPTER_NAME, status: 'degraded' }),
        );
        expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
        expect(adapter.hasApplyFailure).toBe(true);
        expect(adapter.currentConfig).toMatchObject({
            heartbeat: { enabled: true, interval: 1000 },
        });
        expectRetainedTransport(adapter, old);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(5000);
        expect(heartbeats(oldEvents)).toHaveLength(1);
        expect(getStatus).toHaveBeenCalledTimes(1);

        old.rejectQuiesce = false;
        const retried = await manager.reconcile(desired);
        expect(retried.applied).toBe(true);
        expect(retried.errors).toEqual([]);
        expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
        expect(adapter.hasApplyFailure).toBe(false);
        const current = expectCleanupBeforeReopen(old);
        const currentEvents = observe(current);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(1999);
        expect(heartbeats(currentEvents)).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(heartbeats(currentEvents)).toHaveLength(1);
        expect(heartbeats(currentEvents)[0]).toMatchObject({ interval: 2000 });
        expect(heartbeats(oldEvents)).toHaveLength(1);
        expect(getStatus).toHaveBeenCalledTimes(2);
    });

    it.each([
        { label: 'omitted', heartbeat: undefined },
        { label: 'explicitly disabled', heartbeat: { enabled: false, interval: 1000 } },
    ])(
        'does not claim restoration for $label heartbeat when enabling fails after partial quiesce',
        async ({ heartbeat }) => {
            const { manager, getStatus } = managerFixture();
            const original = config(heartbeat);
            const desired = config({ enabled: true, interval: 1500 });
            expect((await manager.reconcile(original)).applied).toBe(true);
            const adapter = manager.get(V12_ADAPTER_NAME)!;
            const old = fake.transports[0];
            const oldEvents = observe(old);
            expect(vi.getTimerCount()).toBe(0);

            old.rejectQuiesce = true;
            const failed = await manager.reconcile(desired);
            expect(failed.applied).toBe(false);
            expect(failed.errors).toContainEqual(
                expect.objectContaining({
                    name: V12_ADAPTER_NAME,
                    phase: 'reload',
                    restored: false,
                }),
            );
            expect(failed.statuses).toContainEqual(
                expect.objectContaining({ name: V12_ADAPTER_NAME, status: 'degraded' }),
            );
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.hasApplyFailure).toBe(true);
            expectRetainedTransport(adapter, old);
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(5000);
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(1);

            old.rejectQuiesce = false;
            const retried = await manager.reconcile(desired);
            expect(retried.applied).toBe(true);
            expect(retried.errors).toEqual([]);
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.hasApplyFailure).toBe(false);
            const current = expectCleanupBeforeReopen(old);
            const currentEvents = observe(current);
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(1499);
            expect(heartbeats(currentEvents)).toHaveLength(0);
            vi.advanceTimersByTime(1);
            expect(heartbeats(currentEvents)).toHaveLength(1);
            expect(heartbeats(currentEvents)[0]).toMatchObject({ interval: 1500 });
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(2);
        },
    );

    it.each([
        { label: 'omitted', heartbeat: undefined },
        { label: 'explicitly disabled', heartbeat: { enabled: false, interval: 1000 } },
    ])(
        'fails closed in the degraded pre-close path when enabling $label heartbeat',
        async ({ heartbeat }) => {
            const { manager, getStatus } = managerFixture();
            const original = config(heartbeat);
            const desired = config({ enabled: true, interval: 1500 });
            expect((await manager.reconcile(original)).applied).toBe(true);
            const adapter = manager.get(V12_ADAPTER_NAME)!;
            const old = fake.transports[0];
            const oldEvents = observe(old);

            // A previously degraded adapter can still be active. This makes the
            // manager call closeForReload before it calls reload with desired config.
            adapter.markApplyFailure(new Error('synthetic previous apply failure'));
            expect(adapter.hasApplyFailure).toBe(true);
            expect(adapter.isActive).toBe(true);
            expect(adapter.describeManagedStatus().status).toBe('degraded');
            expect(vi.getTimerCount()).toBe(0);
            const preClose = vi.spyOn(adapter, 'closeForReload');
            const reload = vi.spyOn(adapter, 'reload');

            old.rejectQuiesce = true;
            const failed = await manager.reconcile(desired);
            expect(preClose).toHaveBeenCalledOnce();
            expect(preClose).toHaveBeenCalledWith(
                expect.objectContaining({ heartbeat: { enabled: true, interval: 1500 } }),
            );
            // The first attempted desired reload never ran: this is the manager's
            // best-effort restoration of the previously saved config.
            expect(reload).toHaveBeenCalledOnce();
            expect(reload.mock.calls[0][0]).toMatchObject({ host: '127.0.0.1' });
            expect(failed.applied).toBe(false);
            expect(failed.errors).toContainEqual(
                expect.objectContaining({
                    name: V12_ADAPTER_NAME,
                    phase: 'reload',
                    restored: false,
                }),
            );
            expect(failed.statuses).toContainEqual(
                expect.objectContaining({ name: V12_ADAPTER_NAME, status: 'degraded' }),
            );
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.hasApplyFailure).toBe(true);
            expectRetainedTransport(adapter, old);
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(5000);
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(1);

            old.rejectQuiesce = false;
            const retried = await manager.reconcile(desired);
            expect(preClose).toHaveBeenCalledTimes(2);
            expect(retried.applied).toBe(true);
            expect(retried.errors).toEqual([]);
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.hasApplyFailure).toBe(false);
            const current = expectCleanupBeforeReopen(old);
            const currentEvents = observe(current);
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(1499);
            expect(heartbeats(currentEvents)).toHaveLength(0);
            vi.advanceTimersByTime(1);
            expect(heartbeats(currentEvents)).toHaveLength(1);
            expect(heartbeats(currentEvents)[0]).toMatchObject({ interval: 1500 });
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(2);
        },
    );

    it.each([
        { label: 'omitted', heartbeat: undefined },
        { label: 'explicitly disabled', heartbeat: { enabled: false, interval: 1000 } },
    ])(
        'retains but never revives the old token when early rotation close fails with $label heartbeat',
        async ({ heartbeat }) => {
            const { manager, getStatus } = managerFixture();
            const original = config(heartbeat);
            const desired = config({ enabled: true, interval: 1500 });
            const oldToken = original.v12!.accessToken;
            const newToken = 'Wy8C6nKfQ3_rA7mP9xB5tD2z';
            desired.v12!.accessToken = newToken;
            expect(newToken).not.toBe(oldToken);
            expect((await manager.reconcile(original)).applied).toBe(true);
            const adapter = manager.get(V12_ADAPTER_NAME)!;
            const old = fake.transports[0];
            const oldEvents = observe(old);
            expect(adapter.isActive).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            const preClose = vi.spyOn(adapter, 'closeForReload');
            const reload = vi.spyOn(adapter, 'reload');

            old.rejectQuiesce = true;
            const failed = await manager.reconcile(desired);
            expect(preClose).toHaveBeenCalledOnce();
            expect(preClose).toHaveBeenCalledWith(
                expect.objectContaining({
                    accessToken: newToken,
                    heartbeat: { enabled: true, interval: 1500 },
                }),
            );
            expect(reload).not.toHaveBeenCalled();
            expect(failed.applied).toBe(false);
            const closeError = failed.errors.find(
                (error) => error.name === V12_ADAPTER_NAME && error.phase === 'close',
            );
            expect(closeError).toBeDefined();
            expect(closeError?.restored).not.toBe(true);
            expect(failed.statuses).toContainEqual(
                expect.objectContaining({ name: V12_ADAPTER_NAME, status: 'degraded' }),
            );
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.isActive).toBe(false);
            expect(adapter.hasApplyFailure).toBe(true);
            expectRetainedTransport(adapter, old);
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(5000);
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(1);

            old.rejectQuiesce = false;
            const retried = await manager.reconcile(desired);
            expect(retried.applied).toBe(true);
            expect(retried.errors).toEqual([]);
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.isActive).toBe(true);
            expect(adapter.hasApplyFailure).toBe(false);
            const current = expectCleanupBeforeReopen(old);
            // Only the original retained transport ever carried the old token.
            expect(fake.transports.map((record) => record.options.accessToken)).toEqual([
                oldToken,
                newToken,
            ]);
            expect(adapter.currentConfig.accessToken).toBe(newToken);
            const currentEvents = observe(current);
            expect(vi.getTimerCount()).toBe(1);
            old.options.onError?.(new Error('EACCES'));
            expect(adapter.isActive).toBe(true);
            expect(adapter.hasApplyFailure).toBe(false);
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(1500);
            expect(heartbeats(currentEvents)).toHaveLength(1);
            expect(heartbeats(currentEvents)[0]).toMatchObject({ interval: 1500 });
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(2);
        },
    );

    it.each([
        { label: 'omitted', heartbeat: undefined },
        { label: 'explicitly disabled', heartbeat: { enabled: false, interval: 1000 } },
    ])(
        'keeps the old port reserved after a failed v11 handoff while enabling $label heartbeat',
        async ({ heartbeat }) => {
            const { manager, getStatus } = managerFixture();
            const original = config(heartbeat);
            const desired = config({ enabled: true, interval: 1500 });
            desired.v12!.port = 3013;
            desired.networks.httpServers.push({
                name: 'fixture-v11',
                host: '127.0.0.1',
                port: 3012,
                path: '/',
                messageFormat: 'array',
                reportSelfMessage: false,
            });
            expect((await manager.reconcile(original)).applied).toBe(true);
            const adapter = manager.get(V12_ADAPTER_NAME)!;
            const old = fake.transports[0];
            const oldEvents = observe(old);
            expect(adapter.isActive).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            const preClose = vi.spyOn(adapter, 'closeForReload');

            old.rejectQuiesce = true;
            const failed = await manager.reconcile(desired);
            expect(preClose).toHaveBeenCalledOnce();
            expect(preClose).toHaveBeenCalledWith(
                expect.objectContaining({
                    port: 3013,
                    heartbeat: { enabled: true, interval: 1500 },
                }),
            );
            expect(failed.applied).toBe(false);
            const closeError = failed.errors.find(
                (error) => error.name === V12_ADAPTER_NAME && error.phase === 'close',
            );
            expect(closeError).toBeDefined();
            expect(closeError?.restored).not.toBe(true);
            expect(failed.statuses).toContainEqual(
                expect.objectContaining({ name: V12_ADAPTER_NAME, status: 'degraded' }),
            );
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.isActive).toBe(false);
            expect(adapter.hasApplyFailure).toBe(true);
            expect(manager.get('fixture-v11')).toBeNull();
            expect(fake.trace).not.toContain('v11:open:fixture-v11:3012');
            expectRetainedTransport(adapter, old);
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(5000);
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(1);

            old.rejectQuiesce = false;
            const retried = await manager.reconcile(desired);
            expect(retried.applied).toBe(true);
            expect(retried.errors).toEqual([]);
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.isActive).toBe(true);
            expect(adapter.hasApplyFailure).toBe(false);
            const current = expectCleanupBeforeReopen(old);
            expect(current.options.port).toBe(3013);
            const v11 = manager.get('fixture-v11');
            expect(v11).toBeInstanceOf(FakeV11Server);
            expect(v11?.isActive).toBe(true);
            expect(fake.trace.indexOf('v11:open:fixture-v11:3012')).toBeGreaterThan(
                fake.trace.indexOf(`close:${old.id}`),
            );
            const currentEvents = observe(current);
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(1500);
            expect(heartbeats(currentEvents)).toHaveLength(1);
            expect(heartbeats(currentEvents)[0]).toMatchObject({ interval: 1500 });
            expect(heartbeats(oldEvents)).toHaveLength(0);
            expect(getStatus).toHaveBeenCalledTimes(2);
        },
    );

    it.each([
        { label: 'omitted', heartbeat: undefined, previouslyDegraded: false },
        {
            label: 'explicitly disabled',
            heartbeat: { enabled: false, interval: 1000 },
            previouslyDegraded: false,
        },
        { label: 'omitted and degraded', heartbeat: undefined, previouslyDegraded: true },
        {
            label: 'disabled and degraded',
            heartbeat: { enabled: false, interval: 1000 },
            previouslyDegraded: true,
        },
    ])(
        'preserves the pre-existing $label heartbeat restore behavior when heartbeat remains disabled',
        async ({ heartbeat, previouslyDegraded }) => {
            const { manager } = managerFixture();
            const original = config(heartbeat);
            const desired = config(heartbeat, 'localhost');
            expect((await manager.reconcile(original)).applied).toBe(true);
            const adapter = manager.get(V12_ADAPTER_NAME)!;
            const old = fake.transports[0];
            const events = observe(old);
            expect(vi.getTimerCount()).toBe(0);

            if (previouslyDegraded) {
                adapter.markApplyFailure(new Error('synthetic previous apply failure'));
                expect(adapter.hasApplyFailure).toBe(true);
                expect(adapter.isActive).toBe(true);
            }

            old.rejectQuiesce = true;
            const failed = await manager.reconcile(desired);
            expect(failed.applied).toBe(false);
            expect(failed.errors).toContainEqual(
                expect.objectContaining({
                    name: V12_ADAPTER_NAME,
                    phase: 'reload',
                    restored: true,
                }),
            );
            expect(failed.statuses).toContainEqual(
                expect.objectContaining({ name: V12_ADAPTER_NAME, status: 'degraded' }),
            );
            expect(manager.get(V12_ADAPTER_NAME)).toBe(adapter);
            expect(adapter.isActive).toBe(true);
            expect(adapter.hasApplyFailure).toBe(true);
            expect(adapter.currentConfig).toMatchObject({ host: '127.0.0.1' });
            expectRetainedTransport(adapter, old);
            vi.advanceTimersByTime(5000);
            expect(heartbeats(events)).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );
});
