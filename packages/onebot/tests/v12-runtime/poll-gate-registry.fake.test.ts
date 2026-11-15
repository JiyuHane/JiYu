import { describe, expect, it, vi } from 'vitest';
import {
    activateOrderedPollOwner,
    createPollGateRegistry,
    invalidatePollOwner,
    pollOwnerStats,
    recordPreparedScopeLoss,
    registerPollHost,
    type PollGateRegistry,
} from '../../src/v12-runtime/poll-owner';
import { SourceGeneration, type V12Source } from '../../src/v12-runtime/source-generation';

type PollHost = Parameters<typeof registerPollHost>[1];

function fakeHost(): PollHost {
    const binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    return {
        self: { platform: 'qq', user_id: '12345' },
        captureBinding: () => binding,
        captureSource: () => generation.capture(binding),
        verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
    };
}

function readyGate(registry: PollGateRegistry, uin: unknown) {
    const result = registry.getOrCreate(uin);

    if (result.kind !== 'ready') {
        throw new Error(`expected ready, got ${result.kind}`);
    }

    return result.gate;
}

async function settle() {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
}

describe('poll gate registry (synthetic in-process fixtures)', () => {
    it('validates capacity without an implicit default or an additional ceiling', () => {
        for (const capacity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => createPollGateRegistry(capacity)).toThrow(RangeError);
        }

        for (const capacity of [undefined, null, '1', 1n, {}, new Number(1)]) {
            expect(() => createPollGateRegistry(capacity as number)).toThrow(RangeError);
        }

        expect(createPollGateRegistry(Number.MAX_SAFE_INTEGER).getOrCreate('1').kind).toBe('ready');
    });

    it('accepts only bounded canonical positive safe-integer strings without invoking object traps', () => {
        const registry = createPollGateRegistry(4);
        const getter = vi.fn(() => '1');
        const trap = vi.fn(() => {
            throw new Error('unexpected proxy access');
        });
        const object = {
            get value() {
                return getter();
            },
        };
        const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
        const invalid: unknown[] = [
            '',
            '0',
            '00',
            '01',
            '-1',
            '+1',
            ' 1',
            '1 ',
            '1.0',
            '1e3',
            '9007199254740992',
            '99999999999999999',
            1,
            1n,
            null,
            undefined,
            object,
            proxy,
            new String('1'),
        ];

        for (const value of invalid) {
            expect(registry.getOrCreate(value)).toEqual({ kind: 'invalid_uin' });
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(registry.getOrCreate('1').kind).toBe('ready');
        expect(registry.getOrCreate('9007199254740991').kind).toBe('ready');
    });

    it('keeps exact gates when full, makes independent registries, and exposes no removal interface', () => {
        const first = createPollGateRegistry(1);
        const other = createPollGateRegistry(1);
        const gate = readyGate(first, '1');
        const claim = {};
        gate.claim = claim;
        gate.uncertain = true;
        expect(first.getOrCreate('2')).toEqual({ kind: 'capacity_exhausted' });
        expect(readyGate(first, '1')).toBe(gate);
        expect(gate).toEqual({ claim, uncertain: true });
        expect(readyGate(other, '1')).not.toBe(gate);
        expect(Object.keys(first)).toEqual(['getOrCreate']);
        expect('delete' in first).toBe(false);
        expect('clear' in first).toBe(false);
    });

    it('keeps different keys independent within a registry', () => {
        const registry = createPollGateRegistry(2);
        const first = readyGate(registry, '12345');
        const second = readyGate(registry, '23456');
        expect(second).not.toBe(first);
        first.claim = {};
        first.uncertain = true;
        expect(second).toEqual({ claim: null, uncertain: false });
        expect(readyGate(registry, '12345')).toBe(first);
        expect(readyGate(registry, '23456')).toBe(second);
    });

    it('requires a ready result before a fake caller registers anything', () => {
        const registry = createPollGateRegistry(1);
        const register = vi.fn();

        const enable = (uin: unknown) => {
            const result = registry.getOrCreate(uin);

            if (result.kind !== 'ready') {
                return 'disabled';
            }

            register(result.gate);
            return 'enabled';
        };

        expect(enable('1')).toBe('enabled');
        expect(enable('2')).toBe('disabled');
        expect(enable('01')).toBe('disabled');
        expect(register).toHaveBeenCalledTimes(1);
        expect(register.mock.calls[0][0]).toBe(readyGate(registry, '1'));
    });

    // The caller supplies the matching key; the registry does not authenticate the host.
    it('shares the real claim between fake hosts and keeps the same gate after release', async () => {
        const registry = createPollGateRegistry(1);
        const host = fakeHost();
        const a = {};
        const b = {};
        const gate = readyGate(registry, '12345');
        registerPollHost(a, host, gate);
        registerPollHost(b, host, readyGate(registry, '12345'));
        expect(activateOrderedPollOwner(a).status).toBe('ready');
        expect(activateOrderedPollOwner(b)).toEqual({ status: 'cleanup_pending' });
        expect(gate.claim).not.toBeNull();
        invalidatePollOwner(a);
        expect(readyGate(registry, '12345')).toBe(gate);
        await settle();
        expect(gate.claim).toBeNull();
        expect(readyGate(registry, '12345')).toBe(gate);
        expect(activateOrderedPollOwner(b).status).toBe('ready');
        invalidatePollOwner(b);
        await settle();
    });

    it('retains WeakMap gap and uncertainty rather than replacing the gate', async () => {
        const registry = createPollGateRegistry(1);
        const host = fakeHost();
        const a = {};
        const b = {};
        const gate = readyGate(registry, '12345');
        registerPollHost(a, host, gate);
        registerPollHost(b, host, readyGate(registry, '12345'));
        const active = activateOrderedPollOwner(a);
        expect(active.status).toBe('ready');

        if (active.status !== 'ready') {
            throw new Error('owner not ready');
        }

        active.owner.failIngress();
        await settle();
        expect(gate.claim).toBeNull();
        expect(readyGate(registry, '12345')).toBe(gate);
        expect(pollOwnerStats(b)?.ordering_gap).toBe(true);
        expect(activateOrderedPollOwner(b)).toEqual({ status: 'degraded' });
        recordPreparedScopeLoss(b, undefined);
        expect(gate.uncertain).toBe(true);
        expect(readyGate(registry, '12345')).toBe(gate);
        expect(activateOrderedPollOwner(b)).toEqual({ status: 'cleanup_pending' });
    });
});
