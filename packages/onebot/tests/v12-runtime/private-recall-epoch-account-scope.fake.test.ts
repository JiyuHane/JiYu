import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import type { SourceGeneration, V12Source } from '../../src/v12-runtime/source-ticket';

// Preserve real conversion/provenance, but give independent events the same ID.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomUUID: () => '11111111-1111-4111-8111-111111111111' };
});

// source-generation's unrelated ordered-owner code is outside this fixture.
vi.mock('../../src/v12-runtime/poll-owner', () => ({
    isCurrentOrderedFacade: () => false,
}));
vi.mock('@snowluma/sqlite', () => {
    throw new Error('SQLite import is outside this in-memory fixture');
});
vi.mock('@snowluma/websocket', () => {
    throw new Error('WebSocket module import is outside this in-memory fixture');
});

let ticketApi: typeof import('../../src/v12-runtime/source-ticket');
let generationApi: typeof import('../../src/v12-runtime/source-generation');
let recall: typeof import('../../src/v12-runtime/private-recall-source');
let guards: Array<{ mock: { calls: unknown[] } }> = [];

function forbidden(): never {
    throw new Error('unexpected network, child process, or native operation in pure fixture');
}

beforeEach(async () => {
    const fetchGuard = vi.fn(forbidden);
    const webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    const eventSourceGuard = vi.fn(function ForbiddenEventSource() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    vi.stubGlobal('EventSource', eventSourceGuard);
    guards = [
        fetchGuard,
        webSocketGuard,
        eventSourceGuard,
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
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];
    // Also guard named Node built-in imports, before importing any subject module.
    syncBuiltinESMExports();
    ticketApi = await import('../../src/v12-runtime/source-ticket');
    generationApi = await import('../../src/v12-runtime/source-generation');
    recall = await import('../../src/v12-runtime/private-recall-source');
});

afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllGlobals();
    guards = [];
    expect(calls).toEqual(calls.map(() => 0));
});

type Recall = Extract<QQEventVariant, { kind: 'friend_recall' }>;
type Options = {
    generation?: SourceGeneration;
    binding?: object;
    ticket?: V12Source;
    selfUin?: number;
    messageId?: number;
    recalledBySelf?: boolean;
};
const SELF = 10001;
const PEER = 20002;
const TIME = 1_700_000_100;

function required<T>(value: T | undefined | null, name: string): T {
    if (value === undefined || value === null) {
        throw new Error(`synthetic ${name} missing`);
    }

    return value;
}

function fixture(options: Options = {}) {
    const selfUin = options.selfUin ?? SELF;
    const messageId = options.messageId ?? -2147483648;
    const generation = options.generation ?? new ticketApi.SourceGeneration();

    if (!options.generation) {
        generation.setOnline(true);
    }

    const binding = options.binding ?? {};
    const ticket = required(options.ticket ?? generation.capture(binding), 'event ticket');
    const context = { uin: String(selfUin), selfId: selfUin };
    const self = { platform: 'qq', user_id: String(selfUin) };
    const raw: Recall = {
        kind: 'friend_recall',
        selfUin,
        userUin: PEER,
        msgSeq: 445,
        clientSeq: 446,
        time: TIME,
        recalledBySelf: options.recalledBySelf ?? false,
    };
    const event: JsonObject = {
        time: TIME,
        self_id: selfUin,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: PEER,
        message_id: messageId,
    };
    const snapshot = required(recall.capturePrivateRecallSource(context, raw, ticket), 'snapshot');

    if (!recall.rememberPrivateRecallSource(context, event, snapshot, messageId)) {
        throw new Error('synthetic provenance not remembered');
    }

    const source = required(recall.getPrivateRecallSource(context, event), 'source');
    const candidate = required(recall.convertPrivateRecallEvent(event, self, source), 'candidate');
    const proof = required(
        recall.createPrivateRecallPollProof(event, source, ticket, self, candidate),
        'proof',
    );
    return {
        generation,
        binding,
        ticket,
        context,
        self,
        raw,
        event,
        snapshot,
        source,
        candidate,
        proof,
    };
}

type Fixture = ReturnType<typeof fixture>;

function ownerTicket(f: Fixture): V12Source {
    return required(f.generation.capture(f.binding), 'owner ticket');
}

function scope(source: unknown, self: unknown) {
    return required(recall.createPrivateRecallPollEpochAccountScope(source, self), 'scope');
}

function accepts(f: Fixture, ownerScope: unknown, exactTicket: unknown = f.ticket): boolean {
    return recall.isPrivateRecallPollProofInEpochAccountScope(f.proof, exactTicket, ownerScope);
}

describe('private recall epoch/account scope (pure synthetic objects)', () => {
    it('reexports the exact source-ticket functions and interchanges their tokens', () => {
        expect(generationApi.SourceGeneration).toBe(ticketApi.SourceGeneration);
        expect(generationApi.sameSourceEpoch).toBe(ticketApi.sameSourceEpoch);
        expect(generationApi.sourceHasBinding).toBe(ticketApi.sourceHasBinding);

        const binding = {};
        const fromTicket = new ticketApi.SourceGeneration();
        const fromGeneration = new generationApi.SourceGeneration();
        fromTicket.setOnline(true);
        fromGeneration.setOnline(true);
        const first = required(fromTicket.capture(binding), 'first ticket');
        const second = required(fromTicket.capture(binding), 'second ticket');
        const other = required(fromGeneration.capture(binding), 'other generation ticket');
        const otherAgain = required(fromGeneration.capture(binding), 'second other ticket');
        expect(first).not.toBe(second);
        expect(generationApi.sameSourceEpoch(first, second)).toBe('same');
        expect(ticketApi.sameSourceEpoch(second, first)).toBe('same');
        expect(ticketApi.sameSourceEpoch(other, otherAgain)).toBe('same');
        expect(generationApi.sameSourceEpoch(otherAgain, other)).toBe('same');
        expect(generationApi.sameSourceEpoch(first, other)).toBe('different');
        expect(ticketApi.sameSourceEpoch(other, first)).toBe('different');
        expect(generationApi.sourceHasBinding(first, binding)).toBe(true);
        expect(ticketApi.sourceHasBinding(second, binding)).toBe(true);
        expect(ticketApi.sourceHasBinding(other, binding)).toBe(true);
        expect(generationApi.sourceHasBinding(otherAgain, binding)).toBe(true);
        expect(fromTicket.isCurrent(second, binding)).toBe(true);
        expect(fromGeneration.isCurrent(otherAgain, binding)).toBe(true);
        expect(fromGeneration.isCurrent(first, binding)).toBe(false);
    });

    it('uses captured ticket checks even if exposed constructor statics are replaced', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const other = required(f.generation.capture({}), 'different binding ticket');
        const ownerScope = scope(owner, f.self);
        const constructor = Object.getPrototypeOf(f.ticket).constructor as object;
        const originals = {
            compare: required(Object.getOwnPropertyDescriptor(constructor, 'compare'), 'compare'),
            hasBinding: required(
                Object.getOwnPropertyDescriptor(constructor, 'hasBinding'),
                'hasBinding',
            ),
            matches: required(Object.getOwnPropertyDescriptor(constructor, 'matches'), 'matches'),
        };
        const compare = vi.fn(() => {
            recall.retirePrivateRecallPollEpochAccountScope(ownerScope);
            throw new Error('unexpected reentrant ticket compare');
        });
        const hasBinding = vi.fn(() => {
            throw new Error('unexpected ticket binding check');
        });
        const matches = vi.fn(() => {
            f.generation.setOnline(false);
            throw new Error('unexpected reentrant ticket match');
        });

        try {
            Object.defineProperties(constructor, {
                compare: { ...originals.compare, value: compare },
                hasBinding: { ...originals.hasBinding, value: hasBinding },
                matches: { ...originals.matches, value: matches },
            });
            expect(ticketApi.sameSourceEpoch(f.ticket, owner)).toBe('same');
            expect(generationApi.sameSourceEpoch(f.ticket, other)).toBe('different');
            expect(ticketApi.sameSourceEpoch({}, owner)).toBe('invalid');
            expect(ticketApi.sourceHasBinding(f.ticket, f.binding)).toBe(true);
            expect(generationApi.sourceHasBinding(other, f.binding)).toBe(false);
            expect(f.generation.isCurrent(f.ticket, f.binding)).toBe(true);
            expect(f.generation.isCurrent(other, f.binding)).toBe(false);
            expect(accepts(f, ownerScope)).toBe(true);
            expect(accepts(f, scope(owner, { ...f.self }))).toBe(true);
            expect(accepts(f, scope(other, f.self))).toBe(false);
            expect(recall.createPrivateRecallPollEpochAccountScope({}, f.self)).toBeUndefined();
        } finally {
            Object.defineProperties(constructor, originals);
        }

        expect(compare).not.toHaveBeenCalled();
        expect(hasBinding).not.toHaveBeenCalled();
        expect(matches).not.toHaveBeenCalled();
        expect(accepts(f, ownerScope)).toBe(true);
    });

    it.each([
        { messageId: -2147483648, recalledBySelf: false, userId: String(PEER) },
        { messageId: -1, recalledBySelf: true, userId: String(SELF) },
    ])('accepts a distinct same-epoch owner ticket with signed id $messageId', (sample) => {
        const f = fixture(sample);
        const owner = ownerTicket(f);
        const ownerScope = scope(owner, { ...f.self });
        expect(owner).not.toBe(f.ticket);
        expect(ticketApi.sameSourceEpoch(f.ticket, owner)).toBe('same');
        expect(f.source.sourceTicket).toBe(f.ticket);
        expect(f.candidate.message_id).toBe(String(sample.messageId));
        expect(f.candidate.user_id).toBe(sample.userId);
        expect(recall.isPrivateRecallPollProofFor(f.proof, f.candidate)).toBe(true);
        expect(accepts(f, ownerScope)).toBe(true);
        // An owner ticket in the same epoch is not the proof's exact event ticket.
        expect(accepts(f, ownerScope, owner)).toBe(false);
    });

    it('leaves event JSON and candidate JSON unchanged without logging scope sidecars', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const eventJson = JSON.stringify(f.event);
        const candidateJson = JSON.stringify(f.candidate);
        const eventProperties = Object.getOwnPropertyDescriptors(f.event);
        const candidateProperties = Object.getOwnPropertyDescriptors(f.candidate);
        const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
        const logs = methods.map((method) =>
            vi.spyOn(console, method).mockImplementation(() => {}),
        );
        let logCalls: number[] = [];
        let ownerScope: ReturnType<typeof scope> | undefined;
        let activeBefore = false;
        let matched = false;
        let retired = false;
        let activeAfter = true;

        try {
            ownerScope = scope(owner, { ...f.self });
            activeBefore = recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope);
            matched = accepts(f, ownerScope);
            retired = recall.retirePrivateRecallPollEpochAccountScope(ownerScope);
            activeAfter = recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope);
        } finally {
            logCalls = logs.map((log) => log.mock.calls.length);

            for (const log of logs) {
                log.mockRestore();
            }
        }

        expect(activeBefore).toBe(true);
        expect(matched).toBe(true);
        expect(retired).toBe(true);
        expect(activeAfter).toBe(false);
        expect(logCalls).toEqual(logCalls.map(() => 0));
        expect(Reflect.ownKeys(required(ownerScope, 'retired scope'))).toEqual([]);
        expect(Reflect.ownKeys(f.proof)).toEqual([]);
        expect(Reflect.ownKeys(f.ticket)).toEqual([]);
        expect(Object.getOwnPropertyDescriptors(f.event)).toEqual(eventProperties);
        expect(Object.getOwnPropertyDescriptors(f.candidate)).toEqual(candidateProperties);
        expect(JSON.stringify(f.event)).toBe(eventJson);
        expect(JSON.stringify(f.candidate)).toBe(candidateJson);
    });

    it('rejects another binding, another generator instance and a later online epoch', () => {
        const f = fixture();
        const firstOwner = ownerTicket(f);
        const initial = scope(firstOwner, f.self);
        const differentBinding = required(f.generation.capture({}), 'different binding ticket');
        const otherGenerator = new generationApi.SourceGeneration();
        otherGenerator.setOnline(true);
        const differentInstance = required(
            otherGenerator.capture(f.binding),
            'other instance ticket',
        );
        expect(ticketApi.sameSourceEpoch(f.ticket, differentBinding)).toBe('different');
        expect(ticketApi.sameSourceEpoch(f.ticket, differentInstance)).toBe('different');
        expect(accepts(f, scope(differentBinding, f.self))).toBe(false);
        expect(accepts(f, scope(differentInstance, f.self))).toBe(false);
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const later = ownerTicket(f);
        expect(ticketApi.sameSourceEpoch(f.ticket, later)).toBe('different');
        expect(accepts(f, scope(later, f.self))).toBe(false);
        // The original scope is a comparison of old local tickets, not live state.
        expect(accepts(f, initial)).toBe(true);
    });

    it('rejects fake, cloned, proxied and revoked tickets without invoking proxy traps', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const ownerScope = scope(owner, f.self);
        const trap = vi.fn(() => {
            throw new Error('ticket proxy trap must not run');
        });
        const proxy = new Proxy(f.ticket, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        });
        const revoked = Proxy.revocable(f.ticket, {});
        revoked.revoke();
        const forgedPrototype = Object.create(Object.getPrototypeOf(f.ticket)) as object;
        const invalid: unknown[] = [
            undefined,
            null,
            0,
            'ticket',
            {},
            { ...f.ticket },
            forgedPrototype,
            proxy,
            revoked.proxy,
        ];

        for (const fake of invalid) {
            expect(ticketApi.sameSourceEpoch(fake, f.ticket)).toBe('invalid');
            expect(ticketApi.sourceHasBinding(fake, f.binding)).toBe(false);
            expect(recall.createPrivateRecallPollEpochAccountScope(fake, f.self)).toBeUndefined();
            expect(
                recall.isPrivateRecallPollProofInEpochAccountScope(f.proof, fake, ownerScope),
            ).toBe(false);
        }

        expect(trap).not.toHaveBeenCalled();
        expect(accepts(f, ownerScope)).toBe(true);
    });

    it('rejects a locally valid proof whose exact ticket is not a genuine source ticket', () => {
        // Existing capture/proof checks bind this object locally, without branding it.
        const fakeTicket = {} as unknown as V12Source;
        const f = fixture({ ticket: fakeTicket });
        const owner = ownerTicket(f);
        const ownerScope = scope(owner, f.self);
        expect(f.source.sourceTicket).toBe(fakeTicket);
        expect(recall.isPrivateRecallPollProofCurrent(f.proof)).toBe(true);
        expect(recall.isPrivateRecallPollProofFor(f.proof, f.candidate)).toBe(true);
        expect(recall.isPrivateRecallPollProofBoundTo(f.proof, fakeTicket, f.self)).toBe(true);
        expect(ticketApi.sameSourceEpoch(fakeTicket, owner)).toBe('invalid');
        expect(accepts(f, ownerScope, fakeTicket)).toBe(false);
    });

    it('keeps scopes opaque and rejects cloned and proxied scopes', () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        expect(Object.getPrototypeOf(ownerScope)).toBeNull();
        expect(Object.isFrozen(ownerScope)).toBe(true);
        expect(Reflect.ownKeys(ownerScope)).toEqual([]);
        expect(Object.getOwnPropertyNames(ownerScope)).toEqual([]);
        expect(Object.getOwnPropertySymbols(ownerScope)).toEqual([]);
        expect(JSON.stringify(ownerScope)).toBe('{}');
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope)).toBe(true);
        expect(accepts(f, ownerScope)).toBe(true);
        const trap = vi.fn(() => {
            throw new Error('scope proxy trap must not run');
        });
        const proxy = new Proxy(ownerScope, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        });
        const revoked = Proxy.revocable(ownerScope, {});
        revoked.revoke();
        const clone = Object.freeze(Object.assign(Object.create(null) as object, ownerScope));

        for (const fake of [undefined, null, {}, clone, proxy, revoked.proxy]) {
            expect(accepts(f, fake)).toBe(false);
            expect(recall.isPrivateRecallPollEpochAccountScopeActive(fake)).toBe(false);
            expect(recall.retirePrivateRecallPollEpochAccountScope(fake)).toBe(false);
        }

        expect(trap).not.toHaveBeenCalled();
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope)).toBe(true);
        expect(accepts(f, ownerScope)).toBe(true);
        expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope)).toBe(false);
        expect(accepts(f, ownerScope)).toBe(false);
        expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(false);
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope)).toBe(false);
    });

    it('rejects fake and proxied proofs without evaluating their traps', () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const trap = vi.fn(() => {
            throw new Error('proof proxy trap must not run');
        });
        const proxy = new Proxy(f.proof, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        });
        const revoked = Proxy.revocable(f.proof, {});
        revoked.revoke();

        for (const fake of [undefined, null, {}, { ...f.proof }, proxy, revoked.proxy]) {
            expect(
                recall.isPrivateRecallPollProofInEpochAccountScope(fake, f.ticket, ownerScope),
            ).toBe(false);
        }

        expect(trap).not.toHaveBeenCalled();
        expect(accepts(f, ownerScope)).toBe(true);
    });

    it('accepts only plain data-only QQ self snapshots with canonical safe positive IDs', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const nullPrototype = Object.assign(Object.create(null) as object, f.self);
        expect(accepts(f, scope(owner, nullPrototype))).toBe(true);
        expect(
            recall.createPrivateRecallPollEpochAccountScope(owner, {
                platform: 'qq',
                user_id: '1',
            }),
        ).toBeDefined();
        expect(
            recall.createPrivateRecallPollEpochAccountScope(owner, {
                platform: 'qq',
                user_id: String(Number.MAX_SAFE_INTEGER),
            }),
        ).toBeDefined();
        const getter = vi.fn(() => {
            throw new Error('self getter must not run');
        });
        const trap = vi.fn(() => {
            throw new Error('self proxy trap must not run');
        });

        const accessor = (key: 'platform' | 'user_id') => {
            const value = { ...f.self };
            Object.defineProperty(value, key, {
                configurable: true,
                enumerable: true,
                get: getter,
            });
            return value;
        };

        const hidden = (key: 'platform' | 'user_id') => {
            const value = { ...f.self };
            Object.defineProperty(value, key, { enumerable: false });
            return value;
        };

        const hiddenExtra = Object.defineProperty({ ...f.self }, 'hidden', { get: getter });
        const symbolExtra = Object.defineProperty({ ...f.self }, Symbol('hidden'), { get: getter });
        class NonPlainSelf {
            platform = 'qq';
            user_id = String(SELF);
        }
        const proxy = new Proxy(f.self, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        });
        const revoked = Proxy.revocable(f.self, {});
        revoked.revoke();
        const invalid: Array<[string, unknown]> = [
            ['null', null],
            ['undefined', undefined],
            ['number', SELF],
            ['array', Object.assign([], f.self)],
            ['class', new NonPlainSelf()],
            ['custom prototype', Object.assign(Object.create({}), f.self)],
            ['missing platform', { user_id: String(SELF) }],
            ['missing user', { platform: 'qq' }],
            ['wrong platform', { platform: 'other', user_id: String(SELF) }],
            ['numeric platform', { platform: 1, user_id: String(SELF) }],
            ['numeric id', { platform: 'qq', user_id: SELF }],
            ['empty id', { platform: 'qq', user_id: '' }],
            ['zero', { platform: 'qq', user_id: '0' }],
            ['negative', { platform: 'qq', user_id: '-1' }],
            ['leading zero', { platform: 'qq', user_id: '010001' }],
            ['plus sign', { platform: 'qq', user_id: '+1' }],
            ['decimal', { platform: 'qq', user_id: '1.0' }],
            ['exponent', { platform: 'qq', user_id: '1e3' }],
            ['whitespace', { platform: 'qq', user_id: ' 1' }],
            ['unsafe integer', { platform: 'qq', user_id: '9007199254740992' }],
            ['extra field', { ...f.self, extra: true }],
            ['extra hidden getter', hiddenExtra],
            ['symbol getter', symbolExtra],
            ['hidden platform', hidden('platform')],
            ['hidden user', hidden('user_id')],
            ['platform getter', accessor('platform')],
            ['user getter', accessor('user_id')],
            ['proxy', proxy],
            ['revoked proxy', revoked.proxy],
        ];

        for (const [name, value] of invalid) {
            expect(
                recall.createPrivateRecallPollEpochAccountScope(owner, value),
                name,
            ).toBeUndefined();
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(accepts(f, scope(owner, f.self))).toBe(true);
    });

    it('snapshots owner self by value and rejects a different account', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const mutableOwnerSelf = { ...f.self };
        const ownerScope = scope(owner, mutableOwnerSelf);
        const otherAccount = scope(owner, { platform: 'qq', user_id: '10002' });
        expect(accepts(f, ownerScope)).toBe(true);
        expect(accepts(f, otherAccount)).toBe(false);
        mutableOwnerSelf.platform = 'other';
        mutableOwnerSelf.user_id = '10002';
        const getter = vi.fn(() => {
            throw new Error('mutated owner self getter must not run');
        });
        Object.defineProperty(mutableOwnerSelf, 'user_id', { configurable: true, get: getter });
        expect(accepts(f, ownerScope)).toBe(true);
        expect(
            recall.createPrivateRecallPollEpochAccountScope(owner, mutableOwnerSelf),
        ).toBeUndefined();
        expect(getter).not.toHaveBeenCalled();
        expect(f.self).toEqual({ platform: 'qq', user_id: String(SELF) });
    });

    it('makes independent scopes, not a unique owner identity for an epoch/account', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const first = scope(owner, { ...f.self });
        const second = scope(owner, { ...f.self });
        expect(first).not.toBe(second);
        expect(accepts(f, first)).toBe(true);
        expect(accepts(f, second)).toBe(true);
        expect(recall.retirePrivateRecallPollEpochAccountScope(first)).toBe(true);
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(first)).toBe(false);
        expect(accepts(f, first)).toBe(false);
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(second)).toBe(true);
        expect(accepts(f, second)).toBe(true);
        f.generation.setOnline(false);
        const third = scope(owner, { ...f.self });
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(third)).toBe(true);
        expect(accepts(f, third)).toBe(true);
        // Retirement affects an exact object, not the entire epoch or its live gate.
        expect(recall.retirePrivateRecallPollEpochAccountScope(second)).toBe(true);
        expect(recall.retirePrivateRecallPollEpochAccountScope(second)).toBe(false);
        expect(accepts(f, third)).toBe(true);
        expect(recall.retirePrivateRecallPollEpochAccountScope(third)).toBe(true);
    });

    const changedFields = [
        ['time', TIME + 1],
        ['self_id', SELF + 1],
        ['post_type', 'message'],
        ['notice_type', 'group_recall'],
        ['user_id', PEER + 1],
        ['message_id', -2],
    ] as const;

    it.each(changedFields)(
        'fails a changed v11 %s and accepts it again after ABA restore',
        (key, value) => {
            const f = fixture();
            const ownerScope = scope(ownerTicket(f), f.self);
            const original = required(
                Object.getOwnPropertyDescriptor(f.event, key),
                'event descriptor',
            );
            expect(accepts(f, ownerScope)).toBe(true);
            f.event[key] = value;
            expect(accepts(f, ownerScope)).toBe(false);
            Object.defineProperty(f.event, key, original);
            expect(accepts(f, ownerScope)).toBe(true);
        },
    );

    it.each(changedFields)(
        'fails a v11 %s accessor without running it and permits ABA restore',
        (key) => {
            const f = fixture();
            const ownerScope = scope(ownerTicket(f), f.self);
            const original = required(
                Object.getOwnPropertyDescriptor(f.event, key),
                'event descriptor',
            );
            const getter = vi.fn(() => {
                throw new Error('event getter must not run');
            });
            Object.defineProperty(f.event, key, {
                configurable: true,
                enumerable: true,
                get: getter,
            });
            expect(accepts(f, ownerScope)).toBe(false);
            expect(getter).not.toHaveBeenCalled();
            Object.defineProperty(f.event, key, original);
            expect(accepts(f, ownerScope)).toBe(true);
            expect(getter).not.toHaveBeenCalled();
        },
    );

    it('rejects multiple extra v11 keys without reading accessors and accepts restored shape', () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const getter = vi.fn(() => {
            throw new Error('extra event getter must not run');
        });
        const symbol = Symbol('extra');
        Object.defineProperty(f.event, 'extra', {
            configurable: true,
            enumerable: true,
            get: getter,
        });
        Object.defineProperty(f.event, symbol, { configurable: true, get: getter });
        expect(accepts(f, ownerScope)).toBe(false);
        expect(getter).not.toHaveBeenCalled();
        expect(Reflect.deleteProperty(f.event, 'extra')).toBe(true);
        expect(Reflect.deleteProperty(f.event, symbol)).toBe(true);
        expect(accepts(f, ownerScope)).toBe(true);
        expect(getter).not.toHaveBeenCalled();
    });

    it('can still compare retained tickets while offline and does not establish online status', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const ownerScope = scope(owner, f.self);
        expect(f.generation.isCurrent(f.ticket, f.binding)).toBe(true);
        f.generation.setOnline(false);
        expect(f.generation.isCurrent(f.ticket, f.binding)).toBe(false);
        expect(f.generation.isCurrent(owner, f.binding)).toBe(false);
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope)).toBe(true);
        expect(ticketApi.sameSourceEpoch(f.ticket, owner)).toBe('same');
        expect(accepts(f, ownerScope)).toBe(true);
        expect(recall.isPrivateRecallPollProofFor(f.proof, f.candidate)).toBe(true);
        f.generation.setOnline(true);
        expect(f.generation.isCurrent(f.ticket, f.binding)).toBe(false);
        expect(ticketApi.sameSourceEpoch(f.ticket, owner)).toBe('same');
        expect(accepts(f, ownerScope)).toBe(true);
    });

    it('depends on trusted capture: a real A ticket can be paired with a synthetic B account', () => {
        const a = fixture();
        const owner = ownerTicket(a);
        const b = fixture({
            generation: a.generation,
            binding: a.binding,
            ticket: a.ticket,
            selfUin: 10002,
            messageId: -41,
        });
        const scopeA = scope(owner, a.self);
        const scopeB = scope(owner, b.self);
        expect(b.context).not.toBe(a.context);
        expect(b.ticket).toBe(a.ticket);
        expect(b.source.sourceTicket).toBe(a.ticket);
        expect(recall.isPrivateRecallPollProofFor(b.proof, b.candidate)).toBe(true);
        expect(accepts(b, scopeA)).toBe(false);
        expect(accepts(b, scopeB)).toBe(true);
        // Ticket/account pairing is supplied by trusted capture, not authenticated by scope.
    });

    it('leaves candidate identity to isPrivateRecallPollProofFor even for equal JSON twins', () => {
        const first = fixture({ messageId: -41 });
        const second = fixture({
            generation: first.generation,
            binding: first.binding,
            ticket: first.ticket,
            messageId: -41,
        });
        const ownerScope = scope(ownerTicket(first), first.self);
        expect(first.event).not.toBe(second.event);
        expect(first.event).toEqual(second.event);
        expect(first.candidate).not.toBe(second.candidate);
        expect(first.candidate.id).toBe(second.candidate.id);
        expect(JSON.stringify(first.candidate)).toBe(JSON.stringify(second.candidate));
        expect(accepts(first, ownerScope)).toBe(true);
        expect(accepts(second, ownerScope)).toBe(true);
        expect(recall.isPrivateRecallPollProofFor(first.proof, first.candidate)).toBe(true);
        expect(recall.isPrivateRecallPollProofFor(second.proof, second.candidate)).toBe(true);
        expect(recall.isPrivateRecallPollProofFor(first.proof, second.candidate)).toBe(false);
        expect(recall.isPrivateRecallPollProofFor(second.proof, first.candidate)).toBe(false);
    });
});
