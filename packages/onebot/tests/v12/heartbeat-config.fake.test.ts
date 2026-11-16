import { describe, expect, it } from 'vitest';
import {
    assertValidOneBotConfig,
    OneBotConfigValidationError,
    prepareOneBotConfigForRestore,
} from '../../src/config';
import type { OneBotConfig } from '../../src/types';

const TIMER_MAX_MS = 2_147_483_647;
const legacyV12 = {
    enabled: true,
    host: '127.0.0.1',
    port: 3012,
    accessToken: 'E5xqVb7_9pLt2QwR4M8kZ1nY',
    allowNonLoopback: false,
};

// This public restore seam parses and normalizes in memory; it never loads or saves a file.
function normalize(value: unknown, inheritedGlobal?: unknown): OneBotConfig {
    const result = prepareOneBotConfigForRestore(value, 'per-uin', inheritedGlobal).value;
    assertValidOneBotConfig(result);
    return result;
}

function captureError(action: () => unknown): unknown {
    try {
        action();
        return undefined;
    } catch (error) {
        return error;
    }
}

function expectCapturedConfigError(error: unknown, message: string): void {
    expect(error).toBeInstanceOf(OneBotConfigValidationError);
    expect(error).toHaveProperty('message', message);
}

function expectConfigError(action: () => unknown, message: string): void {
    expectCapturedConfigError(captureError(action), message);
}

function expectHeartbeatRejected(heartbeat: unknown, message: string): void {
    const v12 = { ...legacyV12, heartbeat };
    const normalized = normalize({ v12: legacyV12 });

    // Exercise both the restore parser and the validator used by config consumers.
    expectConfigError(() => prepareOneBotConfigForRestore({ v12 }, 'per-uin'), message);
    expectConfigError(() => assertValidOneBotConfig({ ...normalized, v12 }), message);
}

describe('synthetic OneBot v12 heartbeat configuration', () => {
    it('leaves the heartbeat absent by default and preserves legacy v12 configuration', () => {
        const empty = normalize({});
        expect(Object.prototype.hasOwnProperty.call(empty, 'v12')).toBe(false);

        for (const enabled of [true, false]) {
            const legacy = { ...legacyV12, enabled };
            const result = normalize({ v12: legacy });
            expect(result.v12).toEqual(legacy);
            expect(Object.prototype.hasOwnProperty.call(result.v12, 'heartbeat')).toBe(false);
            expect(() => assertValidOneBotConfig(result)).not.toThrow();
        }
    });

    it.each([
        { enabled: true, interval: 1 },
        { enabled: true, interval: 1000 },
        { enabled: true, interval: TIMER_MAX_MS },
        { enabled: false, interval: 1 },
        { enabled: false, interval: 1000 },
        { enabled: false, interval: TIMER_MAX_MS },
    ])('preserves the explicit heartbeat $enabled at $interval ms', (heartbeat) => {
        const input = { v12: { ...legacyV12, heartbeat } };
        const result = normalize(input);

        expect(result.v12).toEqual({ ...legacyV12, heartbeat });
        expect(result.v12?.heartbeat).not.toBe(heartbeat);
        expect(() => assertValidOneBotConfig(result)).not.toThrow();
    });

    it.each([
        { name: 'zero', value: 0 },
        { name: 'negative', value: -1 },
        { name: 'fraction', value: 1.5 },
        { name: 'NaN', value: NaN },
        { name: 'positive infinity', value: Infinity },
        { name: 'negative infinity', value: -Infinity },
        { name: 'above Node timer limit', value: TIMER_MAX_MS + 1 },
        { name: 'numeric string', value: '1000' },
        { name: 'text', value: 'private-interval-value' },
        { name: 'null', value: null },
        { name: 'array', value: [1000] },
        { name: 'undefined', value: undefined },
    ])('rejects $name interval even when disabled, with an exact generic error', ({ value }) => {
        for (const enabled of [true, false]) {
            expectHeartbeatRejected(
                { enabled, interval: value },
                'v12.heartbeat.interval must be an integer between 1 and 2147483647',
            );
        }
    });

    it.each([
        { name: 'string', value: 'false' },
        { name: 'number', value: 0 },
        { name: 'null', value: null },
        { name: 'array', value: [] },
        { name: 'undefined', value: undefined },
    ])('rejects a non-boolean enabled field: $name', ({ value }) => {
        expectHeartbeatRejected(
            { enabled: value, interval: 1000 },
            'v12.heartbeat.enabled must be a boolean',
        );
    });

    it('requires both fields, including an interval when the heartbeat is disabled', () => {
        expectHeartbeatRejected({}, 'v12.heartbeat.enabled must be a boolean');
        expectHeartbeatRejected({ interval: 1 }, 'v12.heartbeat.enabled must be a boolean');

        for (const enabled of [true, false]) {
            expectHeartbeatRejected(
                { enabled },
                'v12.heartbeat.interval must be an integer between 1 and 2147483647',
            );
        }
    });

    it.each([
        { name: 'null', value: null },
        { name: 'array', value: [] },
        { name: 'string', value: 'heartbeat' },
        { name: 'number', value: 1000 },
        { name: 'boolean', value: false },
    ])('rejects a non-object heartbeat: $name', ({ value }) => {
        expectHeartbeatRejected(value, 'v12.heartbeat must be an object');
    });

    it('rejects inherited required fields, including Object.prototype getters, without reading them', () => {
        for (const field of ['enabled', 'interval'] as const) {
            const heartbeat = field === 'enabled' ? { interval: 1000 } : { enabled: false };
            const v12 = { ...legacyV12, heartbeat };
            const normalized = normalize({ v12: legacyV12 });
            const original = Object.getOwnPropertyDescriptor(Object.prototype, field);
            const failures: unknown[] = [];
            let reads = 0;

            try {
                Object.defineProperty(Object.prototype, field, {
                    configurable: true,
                    get() {
                        reads += 1;
                        return field === 'enabled' ? true : 1000;
                    },
                });
                failures.push(
                    captureError(() => prepareOneBotConfigForRestore({ v12 }, 'per-uin')),
                );
                failures.push(captureError(() => assertValidOneBotConfig({ ...normalized, v12 })));
            } finally {
                if (original) {
                    Object.defineProperty(Object.prototype, field, original);
                } else {
                    Reflect.deleteProperty(Object.prototype, field);
                }
            }

            const message =
                field === 'enabled'
                    ? 'v12.heartbeat.enabled must be a boolean'
                    : 'v12.heartbeat.interval must be an integer between 1 and 2147483647';
            expect(failures).toHaveLength(2);

            for (const error of failures) {
                expectCapturedConfigError(error, message);
            }

            expect(reads).toBe(0);
        }
    });

    it('rejects non-enumerable and accessor heartbeat fields without invoking getters', () => {
        for (const field of ['enabled', 'interval'] as const) {
            for (const enabled of [true, false]) {
                const message =
                    field === 'enabled'
                        ? 'v12.heartbeat.enabled must be a boolean'
                        : 'v12.heartbeat.interval must be an integer between 1 and 2147483647';
                const hidden = { enabled, interval: 1000 };
                Object.defineProperty(hidden, field, {
                    value: field === 'enabled' ? enabled : 1000,
                    enumerable: false,
                });
                expectHeartbeatRejected(hidden, message);

                const accessor = { enabled, interval: 1000 };
                let reads = 0;
                Object.defineProperty(accessor, field, {
                    enumerable: true,
                    get() {
                        reads += 1;
                        return field === 'enabled' ? enabled : 1000;
                    },
                });
                expectHeartbeatRejected(accessor, message);
                expect(reads).toBe(0);
            }
        }
    });

    it('rejects a non-enumerable or accessor v12 heartbeat without invoking its getter', () => {
        const normalized = normalize({ v12: legacyV12 });
        const hidden = Object.defineProperty({ ...legacyV12 }, 'heartbeat', {
            value: { enabled: true, interval: 1000 },
            enumerable: false,
        });
        let reads = 0;
        const accessor = Object.defineProperty({ ...legacyV12 }, 'heartbeat', {
            enumerable: true,
            get() {
                reads += 1;
                return { enabled: true, interval: 1000 };
            },
        });

        for (const v12 of [hidden, accessor]) {
            expectConfigError(
                () => prepareOneBotConfigForRestore({ v12 }, 'per-uin'),
                'v12.heartbeat must be an own data property',
            );
            expectConfigError(
                () => assertValidOneBotConfig({ ...normalized, v12 }),
                'v12.heartbeat must be an own data property',
            );
        }

        expect(reads).toBe(0);
    });

    it('treats an inherited v12 heartbeat as absent without invoking its getter', () => {
        let reads = 0;
        const prototype = Object.defineProperty({}, 'heartbeat', {
            get() {
                reads += 1;
                return { enabled: true, interval: 1000 };
            },
        });
        const v12 = Object.assign(Object.create(prototype) as object, legacyV12);
        const result = normalize({ v12 });

        expect(result.v12).toEqual(legacyV12);
        expect(Object.prototype.hasOwnProperty.call(result.v12, 'heartbeat')).toBe(false);
        expect(reads).toBe(0);
    });

    it('rejects unknown keys without exposing their names or values in the error', () => {
        for (const enabled of [true, false]) {
            const unknownKey = {
                enabled,
                interval: 1,
                private_fixture_key: 'private-fixture-value',
            };
            const nonEnumerableKey = Object.defineProperty(
                { enabled, interval: 1 },
                'private_fixture_key',
                { value: 'private-fixture-value' },
            );
            const symbolKey = { enabled, interval: 1, [Symbol('private-fixture')]: true };

            for (const heartbeat of [unknownKey, nonEnumerableKey, symbolKey]) {
                expectHeartbeatRejected(heartbeat, 'v12.heartbeat contains unsupported fields');
            }
        }
    });

    it('copies heartbeat across merged and re-normalized configs without changing other settings', () => {
        const global = {
            messageFormat: 'string',
            reportSelfMessage: true,
            networks: {
                httpServers: [
                    { name: 'fixture-http', host: '127.0.0.1', port: 4301, path: '/v11' },
                ],
                httpClients: [],
                wsServers: [],
                wsClients: [],
            },
            statusCommand: {
                enabled: true,
                swallow: true,
                cooldownSeconds: 7,
                trigger: '#fixture',
            },
            historySync: { enabled: true },
            notifications: { channelIds: ['global-fixture'] },
        };
        const heartbeat = { enabled: true, interval: 1000 };
        const account = {
            mode: 'overlay',
            networks: {
                httpClients: [{ name: 'fixture-client', enabled: false, url: '', timeoutMs: 1000 }],
            },
            statusCommand: { swallow: false },
            notifications: { channelIds: ['account-fixture'] },
            v12: { ...legacyV12, heartbeat },
        };
        const originalGlobal = structuredClone(global);
        const originalAccount = structuredClone(account);
        const withoutHeartbeat = normalize({ ...account, v12: { ...legacyV12 } }, global);
        const first = normalize(account, global);
        const second = normalize(account, global);
        const copied = normalize(first);
        const { v12: oldV12, ...oldSettings } = withoutHeartbeat;
        const { v12: newV12, ...newSettings } = first;

        expect(global).toEqual(originalGlobal);
        expect(account).toEqual(originalAccount);
        expect(newSettings).toEqual(oldSettings);
        expect(newV12).toEqual({ ...oldV12, heartbeat });
        expect(first.networks.httpServers[0]).toMatchObject({
            name: 'fixture-http',
            host: '127.0.0.1',
            port: 4301,
            path: '/v11',
            messageFormat: 'string',
            reportSelfMessage: true,
        });
        expect(first.networks.httpClients[0]).toMatchObject({
            name: 'fixture-client',
            enabled: false,
            url: '',
            timeoutMs: 1000,
            messageFormat: 'string',
            reportSelfMessage: true,
        });
        expect(first.statusCommand).toEqual({
            enabled: true,
            swallow: false,
            cooldownSeconds: 7,
            trigger: '#fixture',
        });
        expect(first.historySync).toEqual({ enabled: true });
        expect(first.notifications).toEqual({ channelIds: ['account-fixture'] });
        expect(first.v12?.heartbeat).not.toBe(heartbeat);
        expect(second.v12?.heartbeat).not.toBe(first.v12?.heartbeat);
        expect(copied.v12?.heartbeat).not.toBe(first.v12?.heartbeat);
        expect(copied).toEqual(first);

        heartbeat.enabled = false;
        heartbeat.interval = 2000;
        account.v12.host = 'localhost';
        account.notifications.channelIds.push('mutated-input');
        global.statusCommand.trigger = '#mutated';
        expect(first.v12).toEqual({
            ...legacyV12,
            heartbeat: { enabled: true, interval: 1000 },
        });
        expect(first.notifications).toEqual({ channelIds: ['account-fixture'] });
        expect(first.statusCommand.trigger).toBe('#fixture');
        expect(second.v12?.heartbeat).toEqual({ enabled: true, interval: 1000 });
        expect(copied.v12?.heartbeat).toEqual({ enabled: true, interval: 1000 });

        first.v12!.heartbeat!.interval = 7;
        expect(second.v12?.heartbeat).toEqual({ enabled: true, interval: 1000 });
        expect(copied.v12?.heartbeat).toEqual({ enabled: true, interval: 1000 });
        expect(heartbeat).toEqual({ enabled: false, interval: 2000 });
    });
});
