import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    BridgeInterface,
    BridgeSessionListener,
    BridgeSessionSource,
} from '@snowluma/core/bridge-interface';
import type { GlobalSettings } from '../../src/global-config';
import type { OneBotInstance } from '../../src/instance';
import type { DatabaseMigrationCallbacks, OneBotManagerOptions } from '../../src/manager';
import type { OneBotConfig } from '../../src/types';
import type { PollGate } from '../../src/v12-runtime/poll-owner';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12Source } from '../../src/v12-runtime/source-generation';

// The manager and the in-memory poll primitives are real. Configuration,
// migration, Bridge and instance lifecycle are all synthetic objects.
const inputs = vi.hoisted(() => ({
    config: Object.freeze({ fixture: 'config' }),
    settings: Object.freeze({ fixture: 'settings', videoUploadConcurrency: 1 }),
}));

vi.mock('@snowluma/common/logger', () => ({
    createLogger: () => ({ info() {}, warn() {}, error() {} }),
    runWithoutRequestContext: (operation: () => unknown) => operation(),
}));
vi.mock('@snowluma/protocol/highway/upload-settings', () => ({
    setVideoUploadConcurrency: vi.fn(),
}));
vi.mock('../../src/config', () => ({
    loadOneBotConfig: () => inputs.config,
    OneBotConfigValidationError: class extends Error {},
}));
vi.mock('../../src/global-config', () => ({
    loadGlobalSettings: () => inputs.settings,
}));
vi.mock('../../src/message-store-migration-task', () => ({
    createMessageStoreMigrationTask: () => {
        throw new Error('unexpected real migration task');
    },
    estimateRemainingSeconds: () => null,
}));
vi.mock('../../src/instance', () => ({
    OneBotInstance: class {
        constructor(...args: unknown[]) {
            const instance = makeFakeInstance(args[0] as string);
            constructions.push({ args, instance });
            return instance;
        }
    },
}));

interface FakeInstance {
    uin: string;
    nickname: string;
    addPid: ReturnType<typeof vi.fn>;
    waitUntilNetworkReady: ReturnType<typeof vi.fn>;
    emitBotStatus: ReturnType<typeof vi.fn>;
    startLoginHistorySync: ReturnType<typeof vi.fn>;
    getConnectionStatuses: ReturnType<typeof vi.fn>;
    quiesce: ReturnType<typeof vi.fn>;
    forceRelease: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    holdDisposal(): void;
    releaseDisposal(): void;
}

type Construction = { args: unknown[]; instance: FakeInstance };
const constructions: Construction[] = [];
const managers: Array<import('../../src/manager').OneBotManager> = [];
const pollHosts: object[] = [];
const releases: Array<() => void> = [];

let OneBotManager: typeof import('../../src/manager').OneBotManager;
let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let poll: typeof import('../../src/v12-runtime/poll-owner');
let SourceGeneration: typeof import('../../src/v12-runtime/source-generation').SourceGeneration;
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    releases.push(resolve);
    return { promise, resolve };
}

function makeFakeInstance(uin: string): FakeInstance {
    let held: ReturnType<typeof deferred> | undefined;
    let disposePromise: Promise<{ closed: boolean; errors: never[] }> | undefined;
    const quiesce = vi.fn();
    const instance: FakeInstance = {
        uin,
        nickname: 'synthetic',
        addPid: vi.fn(),
        waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
        emitBotStatus: vi.fn(async (_status: 'online' | 'offline') => undefined),
        startLoginHistorySync: vi.fn(),
        getConnectionStatuses: vi.fn(() => []),
        quiesce,
        forceRelease: vi.fn(),
        dispose: vi.fn(() => {
            if (!disposePromise) {
                quiesce();
                disposePromise = (held?.promise ?? Promise.resolve()).then(() => ({
                    closed: true,
                    errors: [],
                }));
            }

            return disposePromise;
        }),
        holdDisposal: () => {
            if (disposePromise || held) {
                throw new Error('disposal already started or held');
            }

            held = deferred();
        },
        releaseDisposal: () => held?.resolve(),
    };
    return instance;
}

class FakeSource implements BridgeSessionSource {
    listener: BridgeSessionListener | undefined;
    readonly unsubscribe = vi.fn();

    subscribeSessions(listener: BridgeSessionListener): () => void {
        this.listener = listener;
        return this.unsubscribe;
    }

    start(uin: string, bridge: BridgeInterface): void {
        if (!this.listener?.started) {
            throw new Error('source is not bound');
        }

        this.listener.started(uin, bridge);
    }

    close(uin: string, bridge: BridgeInterface): void {
        if (!this.listener?.closed) {
            throw new Error('source is not bound');
        }

        this.listener.closed(uin, bridge, 1);
    }
}

function fakeBridge(): BridgeInterface {
    return {
        activePid: null,
        identity: { nickname: 'synthetic' },
        whenRosterWarmupSettled: async () => ({ friendsLoaded: false, groupsLoaded: false }),
    } as unknown as BridgeInterface;
}

function harness(options: Pick<OneBotManagerOptions, 'createInstance'> = {}) {
    const source = new FakeSource();
    const manager = new OneBotManager({
        sessionReleaseDeadlineMs: 25,
        createDatabaseMigrationTask: () => ({
            start: (callbacks: DatabaseMigrationCallbacks) => callbacks.onReady(),
            beginMigration: vi.fn(),
            cancel: vi.fn(),
        }),
        ...options,
    });
    managers.push(manager);
    manager.bind(source);
    return { manager, source };
}

function currentConstruction(
    manager: import('../../src/manager').OneBotManager,
    uin: string,
): Construction {
    const instance = manager.getInstance(uin);
    const construction = constructions.find((entry) => (entry.instance as unknown) === instance);

    if (!instance || !construction) {
        throw new Error(`missing synthetic instance for ${JSON.stringify(uin)}`);
    }

    expect(construction.args).toHaveLength(5);
    expect(construction.args[0]).toBe(uin);
    return construction;
}

function gateOf(construction: Construction): PollGate {
    const gate = construction.args[4];

    if (typeof gate !== 'object' || gate === null) {
        throw new Error('expected a real poll gate');
    }

    return gate as PollGate;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
    }
}

function forbidden(): never {
    throw new Error('unexpected network or native operation in manager poll gate fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubEnv('SNOWLUMA_SESSION_RELEASE_DEADLINE_MS', '');
    fetchGuard = vi.fn(forbidden);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(forbidden),
        vi.spyOn(net, 'createConnection').mockImplementation(forbidden),
        vi.spyOn(net, 'connect').mockImplementation(forbidden),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(forbidden),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(http, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http, 'request').mockImplementation(forbidden),
        vi.spyOn(http, 'get').mockImplementation(forbidden),
        vi.spyOn(https, 'createServer').mockImplementation(forbidden),
        vi.spyOn(https, 'request').mockImplementation(forbidden),
        vi.spyOn(https, 'get').mockImplementation(forbidden),
        vi.spyOn(http2, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'connect').mockImplementation(forbidden),
        vi.spyOn(tls, 'createServer').mockImplementation(forbidden),
        vi.spyOn(tls, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram, 'createSocket').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];
    // Import after the guards are armed; the real instance module is mocked.
    ({ OneBotManager } = await import('../../src/manager'));
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
    poll = await import('../../src/v12-runtime/poll-owner');
    ({ SourceGeneration } = await import('../../src/v12-runtime/source-generation'));
});

afterEach(async () => {
    try {
        // Also unblock operations whose test stopped at an earlier assertion.
        for (const release of releases.splice(0)) {
            release();
        }

        for (const host of pollHosts.splice(0)) {
            poll.invalidatePollOwner(host);
        }

        await vi.advanceTimersByTimeAsync(0);
        const cleanup = await Promise.allSettled(
            managers.splice(0).map((manager) => manager.dispose()),
        );
        await settle();
        expect.soft(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
        expect.soft(fetchGuard).not.toHaveBeenCalled();
        expect.soft(webSocketGuard).not.toHaveBeenCalled();

        for (const guard of guards) {
            expect.soft(guard.mock.calls).toHaveLength(0);
        }

        expect.soft(vi.getTimerCount()).toBe(0);
    } finally {
        constructions.length = 0;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    }
});

describe('OneBotManager poll gate binding (synthetic in-process fixtures)', () => {
    it('reuses one exact gate after retirement, isolates UINs and isolates managers', async () => {
        const first = harness();
        const second = harness();
        const oldBridge = fakeBridge();
        const newBridge = fakeBridge();
        first.source.start('12345', oldBridge);
        const old = currentConstruction(first.manager, '12345');
        expect(old.args[1]).toBe(oldBridge);
        expect(old.args[2]).toBe(inputs.config);
        expect(old.args[3]).toBe(inputs.settings);
        const gate = gateOf(old);
        first.source.start('23456', fakeBridge());
        const otherGate = gateOf(currentConstruction(first.manager, '23456'));
        second.source.start('12345', fakeBridge());
        const independentGate = gateOf(currentConstruction(second.manager, '12345'));
        expect(otherGate).not.toBe(gate);
        expect(independentGate).not.toBe(gate);
        expect(independentGate).not.toBe(otherGate);
        // Preserve a synthetic outstanding claim and uncertainty, not just gate shape.
        const claim = {};
        gate.claim = claim;
        gate.uncertain = true;
        expect(otherGate).toEqual({ claim: null, uncertain: false });
        expect(independentGate).toEqual({ claim: null, uncertain: false });

        old.instance.holdDisposal();
        first.source.close('12345', oldBridge);
        first.source.start('12345', newBridge);
        await settle();
        expect(first.manager.getInstance('12345')).toBeNull();
        expect(constructions).toHaveLength(3);
        old.instance.releaseDisposal();
        await vi.advanceTimersByTimeAsync(0);
        const replacement = currentConstruction(first.manager, '12345');
        expect(replacement.instance).not.toBe(old.instance);
        expect(replacement.args[1]).toBe(newBridge);
        expect(gateOf(replacement)).toBe(gate);
        expect(gateOf(replacement)).toEqual({ claim, uncertain: true });
        first.source.close('12345', oldBridge);
        expect(first.manager.getInstance('12345')).toBe(replacement.instance);
        expect(gateOf(currentConstruction(first.manager, '23456'))).toBe(otherGate);
        expect(gateOf(currentConstruction(second.manager, '12345'))).toBe(independentGate);
    });

    it('keeps a delayed old poll claim across a forced session handoff', async () => {
        const f = harness();
        const oldBridge = fakeBridge();
        const newBridge = fakeBridge();
        f.source.start('12345', oldBridge);
        const old = currentConstruction(f.manager, '12345');
        const gate = gateOf(old);
        const generation = new SourceGeneration();
        generation.setOnline(true);
        const binding = {};
        const host = {
            captureBinding: () => binding,
            captureSource: () => generation.capture(binding),
            verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
        };
        const oldRuntime = {};
        const newRuntime = {};
        pollHosts.push(oldRuntime, newRuntime);
        poll.registerPollHost(oldRuntime, host, gate);
        const activated = poll.activatePollOwner(oldRuntime);
        expect(activated.status).toBe('ready');

        if (activated.status !== 'ready') {
            throw new Error('synthetic old poll owner was not ready');
        }

        poll.enqueuePollEvent(
            oldRuntime,
            { type: 'message', id: 'one', time: 1 },
            host.captureSource(),
        );
        expect(poll.pollOwnerStats(oldRuntime)?.accepted).toBe(1);
        const delay = deferred();
        let selected = false;
        const reserve = EventPollBuffer.prototype.reserve;
        vi.spyOn(EventPollBuffer.prototype, 'reserve').mockImplementation(function (
            this: InstanceType<typeof EventPollBuffer>,
            options,
        ) {
            return reserve.call(this, options).then(async (result) => {
                if (result.status === 'reserved') {
                    selected = true;
                    await delay.promise;
                }

                return result;
            });
        });
        const sink: PollSink = Object.assign(new EventEmitter(), {
            isOpen: () => true,
            writeHead: vi.fn(),
            end: vi.fn(),
        });
        const pending = activated.owner.start(
            {
                limit: 1,
                timeoutMs: 0,
                maxOutputBytes: 1024,
                responseDeadline: performance.now() + 10_000,
            },
            sink,
        );
        await settle();
        expect(selected).toBe(true);
        // The fake runtime is revoked, but its selected in-memory reservation is still pending.
        poll.invalidatePollOwner(oldRuntime);
        old.instance.holdDisposal();
        f.source.close('12345', oldBridge);
        f.source.start('12345', newBridge);
        await vi.advanceTimersByTimeAsync(24);
        expect(f.manager.getInstance('12345')).toBeNull();
        expect(old.instance.forceRelease).not.toHaveBeenCalled();
        expect(gate.claim).not.toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        const replacement = currentConstruction(f.manager, '12345');
        expect(old.instance.forceRelease).toHaveBeenCalledOnce();
        expect(gateOf(replacement)).toBe(gate);
        poll.registerPollHost(newRuntime, host, gateOf(replacement));
        expect(poll.activatePollOwner(newRuntime)).toEqual({ status: 'cleanup_pending' });
        expect(poll.pollOwnerStats(newRuntime)).toMatchObject({
            cleanup_pending: true,
            cleanup_uncertain: false,
        });
        expect(sink.writeHead).not.toHaveBeenCalled();
        expect(sink.end).not.toHaveBeenCalled();

        delay.resolve();
        await expect(pending.result).resolves.toMatchObject({ kind: 'closed' });
        await settle();
        expect(poll.activatePollOwner(newRuntime).status).toBe('ready');
        poll.invalidatePollOwner(newRuntime);
        old.instance.releaseDisposal();
    });

    it('passes explicit null for invalid IDs and for the 1025th distinct valid ID, without eviction', async () => {
        const f = harness();

        for (const uin of ['', '0', '01', '-1', ' 1', '1 ', '1e3', '9007199254740992']) {
            f.source.start(uin, fakeBridge());
            expect(currentConstruction(f.manager, uin).args[4]).toBeNull();
        }

        const gates = new Set<PollGate>();
        let firstBridge: BridgeInterface | undefined;
        let firstGate: PollGate | undefined;

        for (let index = 1; index <= 1024; index += 1) {
            const uin = String(index);
            const bridge = fakeBridge();
            f.source.start(uin, bridge);
            const gate = gateOf(currentConstruction(f.manager, uin));
            gates.add(gate);

            if (index === 1) {
                firstBridge = bridge;
                firstGate = gate;
            }
        }

        expect(gates.size).toBe(1024);
        f.source.start('1025', fakeBridge());
        expect(currentConstruction(f.manager, '1025').args[4]).toBeNull();

        if (!firstBridge || !firstGate) {
            throw new Error('missing first capacity fixture');
        }

        f.source.close('1', firstBridge);
        f.source.start('1', fakeBridge());
        await vi.advanceTimersByTimeAsync(0);
        expect(gateOf(currentConstruction(f.manager, '1'))).toBe(firstGate);
        f.source.start('1026', fakeBridge());
        expect(currentConstruction(f.manager, '1026').args[4]).toBeNull();
    });

    it('keeps custom factories at exactly four arguments without pollGate leakage', () => {
        const createInstance = vi.fn(
            (
                uin: string,
                _bridge: BridgeInterface,
                _config: OneBotConfig,
                _settings: GlobalSettings,
            ) => makeFakeInstance(uin) as unknown as OneBotInstance,
        );
        const f = harness({ createInstance });
        const bridge = fakeBridge();
        f.source.start('12345', bridge);
        expect(createInstance).toHaveBeenCalledOnce();
        const args = createInstance.mock.calls[0];
        expect(args).toHaveLength(4);
        expect(args[0]).toBe('12345');
        expect(args[1]).toBe(bridge);
        expect(args[2]).toBe(inputs.config);
        expect(args[3]).toBe(inputs.settings);
        expect(Object.hasOwn(args[2], 'pollGate')).toBe(false);
        expect(Object.hasOwn(args[3], 'pollGate')).toBe(false);
        expect(f.manager.getInstance('12345')).not.toBeNull();

        // An ID rejected by the default registry still reaches a custom factory unchanged.
        const invalidBridge = fakeBridge();
        f.source.start('01', invalidBridge);
        expect(createInstance).toHaveBeenCalledTimes(2);
        expect(createInstance.mock.calls[1]).toEqual([
            '01',
            invalidBridge,
            inputs.config,
            inputs.settings,
        ]);
        expect(createInstance.mock.calls[1]).toHaveLength(4);
        expect(f.manager.getInstance('01')).not.toBeNull();
        expect(constructions).toHaveLength(0);
    });
});
