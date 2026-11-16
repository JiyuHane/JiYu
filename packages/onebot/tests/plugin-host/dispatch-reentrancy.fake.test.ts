import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginHost, PluginHostOptions } from '../../src/plugin-host';

type DispatchResult = ReturnType<PluginHost['dispatch']>;
type Entry = { id: string; dataPath: string; kind: string; value: string | null };
type Probe = { entries: Entry[] };

const roots: string[] = [];
const hosts: PluginHost[] = [];
let Host: typeof import('../../src/plugin-host').PluginHost;
let guards: Array<{ mock: { calls: unknown[] } }> = [];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected transport or native loading in synthetic plugin fixture');
}

beforeEach(async () => {
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(http2, 'createServer').mockImplementation(blocked),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(blocked),
        vi.spyOn(http2, 'connect').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
    ({ PluginHost: Host } = await import('../../src/plugin-host'));
});

afterEach(async () => {
    let hostResults: PromiseSettledResult<void>[] = [];
    let rootResults: PromiseSettledResult<void>[] = [];

    try {
        hostResults = await Promise.allSettled(hosts.splice(0).map((host) => host.shutdown()));
        rootResults = await Promise.allSettled(
            roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
        );
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        delete (globalThis as Record<string, unknown>).__dispatchReentrancyProbe;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        expect(calls).toEqual(calls.map(() => 0));
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
    }

    expect(hostResults.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(rootResults.every((result) => result.status === 'fulfilled')).toBe(true);
});

async function fixture(): Promise<{ root: string; plugin: string; probe: Probe }> {
    const root = await mkdtemp(path.join(tmpdir(), 'jiyu-dispatch-reentrancy-'));
    roots.push(root);
    const plugin = path.join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(
        path.join(plugin, 'index.mjs'),
        `
        function record(c, kind, value) {
            globalThis.__dispatchReentrancyProbe.entries.push({
                id: c.pluginName, dataPath: c.dataPath, kind, value
            });
        }
        export function plugin_init() {}
        export function plugin_onevent(c, e) { record(c, 'event', e.n); }
        export function plugin_onmessage(c, e) { record(c, 'message', e.n); }
        export function plugin_cleanup(c) { record(c, 'cleanup', null); }
        `,
    );
    const probe: Probe = { entries: [] };
    (globalThis as Record<string, unknown>).__dispatchReentrancyProbe = probe;
    return { root, plugin, probe };
}

function makeHost(
    root: string,
    accountId = '101',
    maxPendingEvents = 1,
    logger: PluginHostOptions['logger'] = () => {},
): PluginHost {
    const host = new Host({
        accountId,
        stateRoot: path.join(root, 'state'),
        managerConfig: Object.freeze({ fixture: true }),
        invokeAction: async () => {
            throw new Error('unexpected plugin action');
        },
        isStreamAction: () => false,
        logger,
        maxPendingEvents,
    });
    hosts.push(host);
    return host;
}

function sequence(probe: Probe, id: string, accountId = '101'): string[] {
    const accountPath = path.join('state', accountId, id);
    return probe.entries
        .filter((entry) => entry.id === id && entry.dataPath.endsWith(accountPath))
        .map((entry) => `${entry.kind}:${entry.value ?? ''}`);
}

describe('synchronous structuredClone getter reentrancy in PluginHost.dispatch', () => {
    it('reserves capacity before cloning and rejects nested dispatch at maxPending=1', async () => {
        const { root, plugin, probe } = await fixture();
        const reports: string[] = [];
        const host = makeHost(root, '101', 1, (_level, _id, args) => {
            reports.push(String(args[0]));
        });
        await host.enable('demo', plugin);
        let nested: DispatchResult | undefined;
        let getterCalls = 0;
        const result = host.dispatch({
            n: 'outer',
            message_type: 'private',
            get trigger() {
                getterCalls++;
                nested = host.dispatch({ n: 'nested' });
                return 'cloned';
            },
        });

        expect(getterCalls).toBe(1);
        expect(nested).toEqual({ accepted: 0, dropped: 1 });
        expect(result).toEqual({ accepted: 1, dropped: 0 });
        expect(host.dispatch({ n: 'while-pending' })).toEqual({ accepted: 0, dropped: 1 });
        expect(reports).toEqual(['Plugin host queue_full failed', 'Plugin host queue_full failed']);
        await host.shutdown();
        expect(sequence(probe, 'demo')).toEqual(['event:outer', 'message:outer', 'cleanup:']);
    });

    it.each(['disable', 'shutdown'] as const)(
        'drops the current clone when its getter starts %s before admission',
        async (operation) => {
            const { root, plugin, probe } = await fixture();
            const host = makeHost(root);
            await host.enable('demo', plugin);
            let stopping: Promise<void> | undefined;
            let getterCalls = 0;
            const result = host.dispatch({
                n: 'outer',
                get trigger() {
                    getterCalls++;
                    stopping = operation === 'disable' ? host.disable('demo') : host.shutdown();
                    return 'cloned';
                },
            });

            expect(getterCalls).toBe(1);
            expect(result).toEqual({ accepted: 0, dropped: 1 });
            expect(stopping).toBeDefined();
            await stopping;
            await Promise.resolve();
            expect(sequence(probe, 'demo')).toEqual(['cleanup:']);
        },
    );

    it.each(['disable', 'shutdown'] as const)(
        'drains already accepted work before %s cleanup and excludes the revoked clone',
        async (operation) => {
            const { root, plugin, probe } = await fixture();
            const host = makeHost(root, '101', 2);
            await host.enable('demo', plugin);
            expect(host.dispatch({ n: 'committed' })).toEqual({ accepted: 1, dropped: 0 });
            let stopping: Promise<void> | undefined;
            const result = host.dispatch({
                n: 'revoked',
                get trigger() {
                    stopping = operation === 'disable' ? host.disable('demo') : host.shutdown();
                    return true;
                },
            });

            expect(result).toEqual({ accepted: 0, dropped: 1 });
            expect(stopping).toBeDefined();
            await stopping;
            await Promise.resolve();
            expect(sequence(probe, 'demo')).toEqual(['event:committed', 'cleanup:']);
        },
    );

    it('bounds recursive own getters and retains nested commit order', async () => {
        const { root, plugin, probe } = await fixture();
        const host = makeHost(root, '101', 3);
        await host.enable('demo', plugin);
        const results: Array<{ depth: number; result: DispatchResult }> = [];
        let getters = 0;
        const dispatchDepth = (depth: number): DispatchResult =>
            host.dispatch({
                n: String(depth),
                get trigger() {
                    getters++;

                    // Keep the regression bounded even against an unpatched host.
                    if (depth >= 6) {
                        return depth;
                    }

                    const result = dispatchDepth(depth + 1);
                    results.push({ depth: depth + 1, result });
                    return depth;
                },
            });
        const result = dispatchDepth(1);

        expect(getters).toBe(3);
        expect(results).toEqual([
            { depth: 4, result: { accepted: 0, dropped: 1 } },
            { depth: 3, result: { accepted: 1, dropped: 0 } },
            { depth: 2, result: { accepted: 1, dropped: 0 } },
        ]);
        expect(result).toEqual({ accepted: 1, dropped: 0 });
        await host.shutdown();
        expect(sequence(probe, 'demo')).toEqual(['event:3', 'event:2', 'event:1', 'cleanup:']);
    });

    it('retains the reservation while queue_full reporting synchronously reenters', async () => {
        const { root, plugin, probe } = await fixture();
        let host!: PluginHost;
        let reportDispatch: DispatchResult | undefined;
        let reporting = false;
        host = makeHost(root, '101', 1, (_level, _id, args) => {
            if (args[0] === 'Plugin host queue_full failed' && !reporting) {
                reporting = true;
                reportDispatch = host.dispatch({ n: 'from-report' });
            }
        });
        await host.enable('demo', plugin);
        let nested: DispatchResult | undefined;
        const result = host.dispatch({
            n: 'outer',
            get trigger() {
                nested = host.dispatch({ n: 'nested' });
                return true;
            },
        });

        expect(nested).toEqual({ accepted: 0, dropped: 1 });
        expect(reportDispatch).toEqual({ accepted: 0, dropped: 1 });
        expect(result).toEqual({ accepted: 1, dropped: 0 });
        await host.shutdown();
        expect(sequence(probe, 'demo')).toEqual(['event:outer', 'cleanup:']);
    });

    it.each(['queue_full', 'invalid_event'] as const)(
        'suppresses recursive %s reports from a reentrant owner logger',
        async (phase) => {
            const { root, plugin, probe } = await fixture();
            let host!: PluginHost;
            let nested: DispatchResult | undefined;
            const logger = vi.fn(() => {
                nested = host.dispatch(phase === 'queue_full' ? { n: 'nested' } : { n: () => 1 });
            });
            host = makeHost(root, '101', 1, logger);
            await host.enable('demo', plugin);

            if (phase === 'queue_full') {
                expect(host.dispatch({ n: 'accepted' })).toEqual({ accepted: 1, dropped: 0 });
            }

            const result = host.dispatch(
                phase === 'queue_full' ? { n: 'over-capacity' } : { n: () => 1 },
            );
            expect(result).toEqual({ accepted: 0, dropped: 1 });
            expect(nested).toEqual({ accepted: 0, dropped: 1 });
            expect(logger).toHaveBeenCalledTimes(1);
            await host.shutdown();
            expect(sequence(probe, 'demo')).toEqual(
                phase === 'queue_full' ? ['event:accepted', 'cleanup:'] : ['cleanup:'],
            );
        },
    );

    it('releases a failed clone reservation before reporting without releasing nested work', async () => {
        const { root, plugin, probe } = await fixture();
        let host!: PluginHost;
        let fromReport: DispatchResult | undefined;
        const reports: string[] = [];
        host = makeHost(root, '101', 2, (_level, _id, args) => {
            const report = String(args[0]);
            reports.push(report);

            if (report === 'Plugin host invalid_event failed') {
                fromReport = host.dispatch({ n: 'report' });
            }
        });
        await host.enable('demo', plugin);
        let nested: DispatchResult | undefined;
        const result = host.dispatch({
            n: 'invalid',
            get trigger(): boolean {
                nested = host.dispatch({ n: 'nested' });
                throw new Error('synthetic clone failure');
            },
        });

        expect(nested).toEqual({ accepted: 1, dropped: 0 });
        expect(result).toEqual({ accepted: 0, dropped: 1 });
        expect(fromReport).toEqual({ accepted: 1, dropped: 0 });
        expect(host.dispatch({ n: 'over-capacity' })).toEqual({ accepted: 0, dropped: 1 });
        expect(reports).toEqual([
            'Plugin host invalid_event failed',
            'Plugin host queue_full failed',
        ]);
        await host.shutdown();
        expect(sequence(probe, 'demo')).toEqual(['event:nested', 'event:report', 'cleanup:']);
    });

    it('does not release another slot when a reentrant clone fails', async () => {
        const { root, plugin, probe } = await fixture();
        const host = makeHost(root);
        await host.enable('first', plugin);
        await host.enable('second', plugin);
        let nested: DispatchResult | undefined;
        const result = host.dispatch({
            n: 'invalid',
            get trigger(): boolean {
                nested = host.dispatch({ n: 'nested' });
                throw new Error('synthetic clone failure');
            },
        });

        expect(nested).toEqual({ accepted: 1, dropped: 1 });
        expect(result).toEqual({ accepted: 0, dropped: 2 });
        expect(host.dispatch({ n: 'after' })).toEqual({ accepted: 1, dropped: 1 });
        await host.shutdown();
        expect(sequence(probe, 'first')).toEqual(['event:after', 'cleanup:']);
        expect(sequence(probe, 'second')).toEqual(['event:nested', 'cleanup:']);
    });

    it('revokes only the stopped slot while another slot receives the outer event', async () => {
        const { root, plugin, probe } = await fixture();
        const host = makeHost(root);
        await host.enable('first', plugin);
        await host.enable('second', plugin);
        let stopping: Promise<void> | undefined;
        let getterCalls = 0;
        const result = host.dispatch({
            n: 'outer',
            get trigger() {
                getterCalls++;

                if (getterCalls === 1) {
                    stopping = host.disable('first');
                }

                return true;
            },
        });

        expect(getterCalls).toBe(2);
        expect(result).toEqual({ accepted: 1, dropped: 1 });
        expect(stopping).toBeDefined();
        await stopping;
        await host.shutdown();
        expect(sequence(probe, 'first')).toEqual(['cleanup:']);
        expect(sequence(probe, 'second')).toEqual(['event:outer', 'cleanup:']);
    });

    it('retains a reentrant enqueue and drops the outer event during tail inspection', async () => {
        const { root, plugin, probe } = await fixture();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (probe as Probe & { gate: Promise<void> }).gate = gate;
        await writeFile(
            path.join(plugin, 'index.mjs'),
            `
            export function plugin_init() {}
            export async function plugin_onevent(c, e) {
                globalThis.__dispatchReentrancyProbe.entries.push({
                    id: c.pluginName, dataPath: c.dataPath, kind: 'event', value: e.n
                });
                if (e.n === 'held') await globalThis.__dispatchReentrancyProbe.gate;
            }
            export function plugin_cleanup(c) {
                globalThis.__dispatchReentrancyProbe.entries.push({
                    id: c.pluginName, dataPath: c.dataPath, kind: 'cleanup', value: null
                });
            }
            `,
        );
        const host = makeHost(root, '101', 3);
        await host.enable('demo', plugin);
        const slots = (host as unknown as { slots: Map<string, { tail: Promise<void> }> }).slots;
        const previous = slots.get('demo')!.tail;
        let nested: DispatchResult | undefined;
        let reentered = false;
        Object.defineProperty(previous, 'constructor', {
            configurable: true,
            get() {
                if (!reentered) {
                    reentered = true;
                    nested = host.dispatch({ n: 'held' });
                }

                return Promise;
            },
        });
        const result = host.dispatch({ n: 'outer' });
        let stopped = false;
        const stopping = host.shutdown().then(() => {
            stopped = true;
        });

        try {
            for (let i = 0; i < 20; i++) {
                await Promise.resolve();
            }

            expect(reentered).toBe(true);
            expect(result).toEqual({ accepted: 0, dropped: 1 });
            expect(nested).toEqual({ accepted: 1, dropped: 0 });
            expect(sequence(probe, 'demo')).toEqual(['event:held']);
            expect(stopped).toBe(false);
        } finally {
            release();
            await stopping;
        }

        expect(sequence(probe, 'demo')).toEqual(['event:held', 'cleanup:']);
    });

    it('preserves a pending predecessor if tail inspection reenters and then throws', async () => {
        const { root, plugin, probe } = await fixture();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (probe as Probe & { gate: Promise<void> }).gate = gate;
        await writeFile(
            path.join(plugin, 'index.mjs'),
            `
            export function plugin_init() {}
            export async function plugin_onevent(c, e) {
                globalThis.__dispatchReentrancyProbe.entries.push({
                    id: c.pluginName, dataPath: c.dataPath, kind: 'event', value: e.n
                });
                if (e.n === 'held') await globalThis.__dispatchReentrancyProbe.gate;
            }
            export function plugin_cleanup(c) {
                globalThis.__dispatchReentrancyProbe.entries.push({
                    id: c.pluginName, dataPath: c.dataPath, kind: 'cleanup', value: null
                });
            }
            `,
        );
        const host = makeHost(root, '101', 3);
        await host.enable('demo', plugin);
        expect(host.dispatch({ n: 'held' })).toEqual({ accepted: 1, dropped: 0 });
        const slots = (host as unknown as { slots: Map<string, { tail: Promise<void> }> }).slots;
        const previous = slots.get('demo')!.tail;
        let nested: DispatchResult | undefined;
        let reentered = false;
        Object.defineProperty(previous, 'constructor', {
            configurable: true,
            get() {
                if (!reentered) {
                    reentered = true;
                    nested = host.dispatch({ n: 'nested' });
                    throw new Error('PRIVATE_SYNTHETIC_PROMISE_ERROR');
                }

                return Promise;
            },
        });
        const result = host.dispatch({ n: 'outer' });
        let stopped = false;
        const stopping = host.shutdown().then(() => {
            stopped = true;
        });

        try {
            for (let i = 0; i < 20; i++) {
                await Promise.resolve();
            }

            expect(reentered).toBe(true);
            expect(result).toEqual({ accepted: 0, dropped: 1 });
            expect(nested).toEqual({ accepted: 1, dropped: 0 });
            expect(sequence(probe, 'demo')).toEqual(['event:held']);
            expect(stopped).toBe(false);
        } finally {
            release();
            await stopping;
        }

        expect(sequence(probe, 'demo')).toEqual(['event:held', 'event:nested', 'cleanup:']);
    });

    it('runs an accepted event after a synthetic rejected predecessor without leaking it', async () => {
        const { root, plugin, probe } = await fixture();
        const logs: string[] = [];
        const host = makeHost(root, '101', 1, (_level, _id, args) => {
            logs.push(args.map(String).join(' '));
        });
        await host.enable('demo', plugin);
        const slots = (host as unknown as { slots: Map<string, { tail: Promise<void> }> }).slots;
        slots.get('demo')!.tail = Promise.reject(new Error('PRIVATE_SYNTHETIC_TAIL_ERROR'));
        expect(host.dispatch({ n: 'after-rejection' })).toEqual({ accepted: 1, dropped: 0 });
        await host.shutdown();
        expect(sequence(probe, 'demo')).toEqual(['event:after-rejection', 'cleanup:']);
        expect(logs).toContain('Plugin host event failed');
        expect(logs.join(' ')).not.toContain('PRIVATE_SYNTHETIC_TAIL_ERROR');
    });

    it('does not run an uncommitted event when a synthetic then calls back and throws', async () => {
        const { root, plugin, probe } = await fixture();
        const host = makeHost(root);
        await host.enable('demo', plugin);
        const slots = (host as unknown as { slots: Map<string, { tail: Promise<void> }> }).slots;
        const slot = slots.get('demo')!;
        slot.tail = {
            then(onFulfilled: () => Promise<void>) {
                void onFulfilled();
                throw new Error('PRIVATE_SYNTHETIC_THEN');
            },
        } as unknown as Promise<void>;
        expect(host.dispatch({ n: 'uncommitted' })).toEqual({ accepted: 0, dropped: 1 });
        await Promise.resolve();
        expect(sequence(probe, 'demo')).toEqual([]);
        slot.tail = Promise.resolve();
        await host.shutdown();
        expect(sequence(probe, 'demo')).toEqual(['cleanup:']);
    });

    it('runs an accepted event once when a synthetic then calls back twice', async () => {
        const { root, plugin, probe } = await fixture();
        const host = makeHost(root);
        await host.enable('demo', plugin);
        const slots = (host as unknown as { slots: Map<string, { tail: Promise<void> }> }).slots;
        const slot = slots.get('demo')!;
        slot.tail = {
            then(onFulfilled: () => Promise<void>) {
                return Promise.all([onFulfilled(), onFulfilled()]).then(() => undefined);
            },
        } as unknown as Promise<void>;
        expect(host.dispatch({ n: 'once' })).toEqual({ accepted: 1, dropped: 0 });
        await host.shutdown();
        expect(sequence(probe, 'demo')).toEqual(['event:once', 'cleanup:']);
    });

    it.each(['disable', 'shutdown'] as const)(
        'reports an uncertain rejected-tail drain on %s without starting cleanup',
        async (operation) => {
            const { root, plugin, probe } = await fixture();
            const logs: string[] = [];
            const host = makeHost(root, '101', 1, (_level, _id, args) => {
                logs.push(args.map(String).join(' '));
            });
            await host.enable('demo', plugin);
            const slots = (host as unknown as { slots: Map<string, { tail: Promise<void> }> })
                .slots;
            const slot = slots.get('demo')!;
            slot.tail = Promise.reject(new Error('PRIVATE_REJECTED_DRAIN'));
            const stopped = operation === 'disable' ? host.disable('demo') : host.shutdown();
            await expect(stopped).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
            expect(host.listStatuses()).toMatchObject([
                {
                    id: 'demo',
                    state: 'cleanup_failed',
                    cleanupFailed: true,
                    processResources: 'unknown',
                },
            ]);
            expect(sequence(probe, 'demo')).toEqual([]);
            expect(logs.join(' ')).toContain('Plugin host cleanup failed');
            expect(logs.join(' ')).not.toContain('PRIVATE_REJECTED_DRAIN');

            // The test injected the rejected tail; restore a settled one only to
            // let the fixture dispose its synthetic plugin after assertions.
            slot.tail = Promise.resolve();
            await host.shutdown();
            expect(sequence(probe, 'demo')).toEqual(['cleanup:']);
        },
    );

    it('rechecks admission when reading an inherited message_type reenters disable', async () => {
        const { root, plugin, probe } = await fixture();
        const host = makeHost(root);
        await host.enable('demo', plugin);
        const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'message_type');
        let stopping: Promise<void> | undefined;
        let getterCalls = 0;
        let result: DispatchResult | undefined;

        try {
            Object.defineProperty(Object.prototype, 'message_type', {
                configurable: true,
                get() {
                    getterCalls++;
                    stopping ??= host.disable('demo');
                    return 'private';
                },
            });
            result = host.dispatch({ n: 'revoked-on-message-type-read' });
        } finally {
            if (previous) {
                Object.defineProperty(Object.prototype, 'message_type', previous);
            } else {
                delete (Object.prototype as Record<string, unknown>).message_type;
            }
        }

        expect(getterCalls).toBeGreaterThan(0);
        expect(result).toEqual({ accepted: 0, dropped: 1 });
        expect(stopping).toBeDefined();
        await stopping;
        expect(sequence(probe, 'demo')).toEqual(['cleanup:']);
    });

    it('keeps reservations and shutdown independent across accounts', async () => {
        const { root, plugin, probe } = await fixture();
        const first = makeHost(root, '101');
        const second = makeHost(root, '202');
        await first.enable('demo', plugin);
        await second.enable('demo', plugin);
        let nestedFirst: DispatchResult | undefined;
        let nestedSecond: DispatchResult | undefined;
        const result = first.dispatch({
            n: 'first',
            get trigger() {
                nestedFirst = first.dispatch({ n: 'first-nested' });
                nestedSecond = second.dispatch({ n: 'second' });
                return true;
            },
        });

        expect(nestedFirst).toEqual({ accepted: 0, dropped: 1 });
        expect(nestedSecond).toEqual({ accepted: 1, dropped: 0 });
        expect(result).toEqual({ accepted: 1, dropped: 0 });
        expect(second.dispatch({ n: 'second-pending' })).toEqual({ accepted: 0, dropped: 1 });
        await first.shutdown();
        expect(second.dispatch({ n: 'second-after' })).toEqual({ accepted: 1, dropped: 0 });
        await second.shutdown();
        expect(sequence(probe, 'demo', '101')).toEqual(['event:first', 'cleanup:']);
        expect(sequence(probe, 'demo', '202')).toEqual([
            'event:second',
            'event:second-after',
            'cleanup:',
        ]);
    });
});
