import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface, BridgeSessionListener } from '@snowluma/core/bridge-interface';
import type { OneBotInstance } from '../src/instance';
import { OneBotManager, type DatabaseMigrationCallbacks } from '../src/manager';

function fakeBridge() {
    return {
        activePid: null,
        identity: { nickname: 'test' },
        whenRosterWarmupSettled: () =>
            Promise.resolve({ friendsLoaded: false, groupsLoaded: false }),
    } as unknown as BridgeInterface;
}

function bindClosed(manager: OneBotManager) {
    let listener!: BridgeSessionListener;
    manager.bind({
        subscribeSessions: (next) => {
            listener = next;

            return () => {};
        },
    });
    return (uin: string, bridge: BridgeInterface) => listener.closed!(uin, bridge, 0);
}

describe('OneBotManager bot_status', () => {
    async function withTempCwd(run: () => Promise<void>): Promise<void> {
        const originalCwd = process.cwd();
        const root = mkdtempSync(path.join(tmpdir(), 'snowluma-manager-bot-status-'));
        process.chdir(root);

        try {
            await run();
        } finally {
            process.chdir(originalCwd);
            rmSync(root, { recursive: true, force: true });
        }
    }

    function preparingManager(instance: OneBotInstance) {
        let callbacks!: DatabaseMigrationCallbacks;
        const manager = new OneBotManager({
            createDatabaseMigrationTask: () => ({
                beginMigration: vi.fn(),
                cancel: vi.fn(),
                start: (next) => {
                    callbacks = next;
                },
            }),
            createInstance: () => instance,
        });
        return {
            manager,
            ready: () => callbacks.onReady(),
        };
    }

    it('emits online after the instance network is ready', async () => {
        await withTempCwd(async () => {
            let releaseNetwork!: (value: { applied: boolean; statuses: []; errors: [] }) => void;
            const networkReady = new Promise<{ applied: boolean; statuses: []; errors: [] }>(
                (resolve) => {
                    releaseNetwork = resolve;
                },
            );
            const emitBotStatus = vi.fn(async () => undefined);
            const instance = {
                uin: '10001',
                nickname: 'test',
                quiesce: vi.fn(),
                dispose: vi.fn(async () => ({ closed: true, errors: [] })),
                emitBotStatus,
                waitUntilNetworkReady: vi.fn(() => networkReady),
                startLoginHistorySync: vi.fn(),
                getConnectionStatuses: () => [],
            } as unknown as OneBotInstance;
            const { manager, ready } = preparingManager(instance);

            try {
                (
                    manager as unknown as { onSessionStarted(uin: string, bridge: never): void }
                ).onSessionStarted('10001', fakeBridge() as never);
                ready();
                await Promise.resolve();
                expect(emitBotStatus).not.toHaveBeenCalled();
                releaseNetwork({ applied: true, statuses: [], errors: [] });
                await vi.waitFor(() => {
                    expect(emitBotStatus).toHaveBeenCalledOnce();
                });
                expect(emitBotStatus).toHaveBeenCalledWith('online');
            } finally {
                await manager.dispose();
            }
        });
    });

    it('emits offline and awaits it before dispose', async () => {
        let finishOffline!: () => void;
        const offlineGate = new Promise<void>((resolve) => {
            finishOffline = resolve;
        });
        const order: string[] = [];
        const emitBotStatus = vi.fn(async (subType: 'online' | 'offline') => {
            if (subType === 'offline') {
                order.push('offline-start');
                await offlineGate;
                order.push('offline-done');
            }
        });
        const dispose = vi.fn(async () => {
            order.push('dispose');
            return { closed: true, errors: [] };
        });
        const instance = {
            uin: '10001',
            nickname: 'test',
            quiesce: vi.fn(),
            dispose,
            emitBotStatus,
            getConnectionStatuses: () => [],
        } as unknown as OneBotInstance;
        const manager = new OneBotManager();
        const internals = manager as unknown as {
            instances: Map<string, OneBotInstance>;
            instanceBindings: Map<string, { bridge: BridgeInterface; instance: OneBotInstance }>;
        };
        const closed = bindClosed(manager);
        const bridge = fakeBridge();
        internals.instances.set('10001', instance);
        internals.instanceBindings.set('10001', { bridge, instance });

        closed('10001', bridge);
        await Promise.resolve();
        expect(order).toEqual(['offline-start']);
        expect(dispose).not.toHaveBeenCalled();

        finishOffline();
        await vi.waitFor(() => {
            expect(order).toEqual(['offline-start', 'offline-done', 'dispose']);
        });
        expect(emitBotStatus).toHaveBeenCalledWith('offline');
        await manager.dispose();
    });

    it('does not emit offline when the process is disposing', async () => {
        const emitBotStatus = vi.fn(async () => undefined);
        const dispose = vi.fn(async () => ({ closed: true, errors: [] }));
        const instance = {
            uin: '10001',
            nickname: 'test',
            quiesce: vi.fn(),
            dispose,
            emitBotStatus,
            getConnectionStatuses: () => [],
        } as unknown as OneBotInstance;
        const manager = new OneBotManager();
        const internals = manager as unknown as {
            instances: Map<string, OneBotInstance>;
            instanceBindings: Map<string, { bridge: BridgeInterface; instance: OneBotInstance }>;
            onSessionClosed(uin: string, bridge: BridgeInterface): void;
        };
        const closed = bindClosed(manager);
        const bridge = fakeBridge();
        internals.instances.set('10001', instance);
        internals.instanceBindings.set('10001', { bridge, instance });

        await manager.dispose();
        expect(emitBotStatus).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();

        closed('10001', bridge);
        internals.onSessionClosed('10001', bridge);
        expect(emitBotStatus).not.toHaveBeenCalled();
    });
});
