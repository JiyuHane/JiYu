import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectRequestScope } from '../src/direct/service-contract';
import { DirectOperationRegistry } from '../src/direct/operation-registry';

const OWNER_A = 'a'.repeat(64);
const OWNER_B = 'b'.repeat(64);
const ACCOUNT = 'fixture-account';
const REVISION = '1'.repeat(32);
const GENERATION = '2'.repeat(32);
const KEY = '123e4567-e89b-42d3-a456-426614174000';

function scope(owner = OWNER_A, valid = () => true): DirectRequestScope {
    return { owner, expiresAt: Date.now() + 10_000, isCurrent: valid };
}

function input(overrides: Partial<Parameters<DirectOperationRegistry['create']>[0]> = {}) {
    return {
        accountId: ACCOUNT,
        generation: GENERATION,
        kind: 'restore' as const,
        phase: 'restoring' as const,
        request: { expectedRevision: REVISION, operationKey: KEY },
        scope: scope(),
        ...overrides,
    };
}

describe('direct operation registry', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
    afterEach(() => vi.useRealTimers());

    it('deduplicates an exact retry without replaying the effect', () => {
        const registry = new DirectOperationRegistry();
        const first = registry.create(input());
        const second = registry.create(input());
        expect(second).toEqual(first);
        expect(registry.size).toBe(1);
    });

    it('rejects reuse of one key with changed kind or revision', () => {
        const registry = new DirectOperationRegistry();
        registry.create(input());
        expect(() => registry.find(ACCOUNT, 'stop', input().request, scope())).toThrow(
            '操作标识已用于其他请求',
        );
        expect(() =>
            registry.find(
                ACCOUNT,
                'restore',
                { ...input().request, expectedRevision: '3'.repeat(32) },
                scope(),
            ),
        ).toThrow('操作标识已用于其他请求');
    });

    it('isolates operation and visible id by management owner', () => {
        const registry = new DirectOperationRegistry();
        const operation = registry.create(input());
        expect(registry.get(operation.id, scope())).toEqual(operation);
        expect(registry.visibleId(operation.id, scope())).toBe(operation.id);
        expect(() => registry.get(operation.id, scope(OWNER_B))).toThrow('不存在');
        expect(registry.visibleId(operation.id, scope(OWNER_B))).toBeNull();
    });

    it('rejects an expired, revoked or malformed scope before effects', () => {
        const registry = new DirectOperationRegistry();
        expect(() => registry.create(input({ scope: scope(OWNER_A, () => false) }))).toThrow(
            '管理会话已失效',
        );
        expect(() => registry.create(input({ scope: scope('short') }))).toThrow('请求格式错误');
        const expired = scope();
        vi.advanceTimersByTime(20_000);
        expect(() => registry.create(input({ scope: expired }))).toThrow('管理会话已失效');
        expect(registry.size).toBe(0);
    });

    it('updates a running operation and lets only the first terminal result win', () => {
        const registry = new DirectOperationRegistry();
        const operation = registry.create(input({ kind: 'qr', phase: 'starting' }));
        registry.update(operation.id, { phase: 'qr-ready', qrAvailable: true });
        expect(registry.peek(operation.id)).toMatchObject({ phase: 'qr-ready', qrAvailable: true });
        registry.finish(operation.id, 'failed', 'failed', 'protocol-or-transport');
        const first = registry.peek(operation.id)!;
        expect(first).toMatchObject({
            status: 'failed',
            phase: 'failed',
            error: 'protocol-or-transport',
            qrAvailable: false,
        });
        expect(first.finishedAt).not.toBeNull();
        registry.finish(operation.id, 'succeeded', 'online', null);
        expect(registry.peek(operation.id)).toEqual(first);
    });

    it('evicts the oldest terminal record but never an active record', () => {
        const registry = new DirectOperationRegistry({ maxRecords: 2, retentionMs: 1000 });
        const first = registry.create(input());
        registry.finish(first.id, 'succeeded', 'online', null);
        vi.advanceTimersByTime(1);
        const second = registry.create(
            input({
                request: {
                    expectedRevision: REVISION,
                    operationKey: '223e4567-e89b-42d3-a456-426614174000',
                },
            }),
        );
        const third = registry.create(
            input({
                request: {
                    expectedRevision: REVISION,
                    operationKey: '323e4567-e89b-42d3-a456-426614174000',
                },
            }),
        );
        expect(registry.peek(first.id)).toBeUndefined();
        expect(registry.peek(second.id)).toBeDefined();
        expect(registry.peek(third.id)).toBeDefined();
    });

    it('reports capacity if every record is active', () => {
        const registry = new DirectOperationRegistry({ maxRecords: 1 });
        registry.create(input());
        expect(() =>
            registry.create(
                input({
                    request: {
                        expectedRevision: REVISION,
                        operationKey: '423e4567-e89b-42d3-a456-426614174000',
                    },
                }),
            ),
        ).toThrow('当前操作记录已满');
    });

    it('prunes terminal records only after retention and drops dedupe identity too', () => {
        const registry = new DirectOperationRegistry({ retentionMs: 100 });
        const original = registry.create(input());
        registry.finish(original.id, 'cancelled', 'stopped', null);
        vi.advanceTimersByTime(99);
        expect(registry.size).toBe(1);
        vi.advanceTimersByTime(1);
        expect(registry.size).toBe(0);
        const replacement = registry.create(input());
        expect(replacement.id).not.toBe(original.id);
    });

    it('clear drops all operation and deduplication metadata', () => {
        const registry = new DirectOperationRegistry();
        const original = registry.create(input());
        registry.clear();
        expect(registry.size).toBe(0);
        const replacement = registry.create(input());
        expect(replacement.id).not.toBe(original.id);
    });

    it.each([
        { maxRecords: 0 },
        { maxRecords: 4097 },
        { retentionMs: 0 },
        { retentionMs: 86_400_001 },
        { maxRecords: Number.NaN },
    ])('rejects invalid limits %j', (options) => {
        expect(() => new DirectOperationRegistry(options)).toThrow(TypeError);
    });
});
