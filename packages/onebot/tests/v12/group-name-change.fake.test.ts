import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { GroupNameChange, NotifyMessageBody } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

// Jiyu's qq.group_name_change is a project extension, not a standard v12
// event or a claim about actual QQ delivery. All source events are synthetic.
const fake = vi.hoisted(() => ({
    transports: [] as Array<{ options: V12TransportOptions; instance: V12Transport }>,
    peer: null as FakePeer | null,
    violations: [] as string[],
    warnings: [] as unknown[][],
}));

vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    return {
        ...actual,
        createServer: () => {
            fake.violations.push('named HTTP createServer');
            throw new Error('unexpected server');
        },
    };
});

vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            fake.violations.push('WebSocket constructor');
            throw new Error('unexpected socket');
        }
    },
    WebSocketServer: class {
        constructor(options: { noServer?: boolean }) {
            if (options?.noServer !== true) {
                fake.violations.push('WebSocket listener');
                throw new Error('unexpected listener');
            }
        }
        handleUpgrade(
            _request: unknown,
            _socket: unknown,
            _head: unknown,
            accept: (ws: unknown) => void,
        ) {
            if (!fake.peer) {
                fake.violations.push('upgrade without fake peer');
                throw new Error('no fake peer');
            }

            accept(fake.peer);
        }
        destroy() {}
    },
}));

vi.mock('@snowluma/common/logger', () => {
    type Logger = {
        child: () => Logger;
        trace: (...args: unknown[]) => void;
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        success: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
    const logger: Logger = {
        child: () => logger,
        trace: () => {},
        debug: () => {},
        info: () => {},
        success: () => {},
        warn: (...args) => fake.warnings.push(args),
        error: (...args) => fake.warnings.push(args),
    };
    return {
        createLogger: () => logger,
        runWithTraceRequest: <T>(callback: () => T): T => callback(),
    };
});

// This local integration exercises only a non-message notification. Do not
// import the reply-history/media stack or silently handle message backfills.
vi.mock('../../src/modules/message-actions', () => ({
    backfillReplyTarget: async (_context: unknown, event: { kind: string }) => {
        if (event.kind !== 'group_name_change') {
            throw new Error('unexpected event in fake backfill');
        }

        return event;
    },
}));

vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fake.violations.push('SQLite constructor');
            throw new Error('unexpected database');
        }
    },
}));
vi.mock('../../src/network', async () => ({
    IOneBotNetworkAdapter: (await import('../../src/network/adapter')).IOneBotNetworkAdapter,
}));
vi.mock('../../src/v12-network', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/v12-network')>();
    class NoListenTransport extends actual.V12Transport {
        constructor(options: V12TransportOptions) {
            super(options);
            fake.transports.push({ options, instance: this });
        }
        override async open(): Promise<AddressInfo> {
            this.attach();
            return { address: 'fixture', family: 'IPv4', port: 1 };
        }
    }
    return { ...actual, V12Transport: NoListenTransport };
});

let decoder: typeof import('@snowluma/protocol/msg-push/decoders/event-0x2dc');
let converters: typeof import('../../src/event-converter/to-notice');
let v12: typeof import('../../src/v12/events');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let ownerApi: typeof import('../../src/v12-runtime/poll-owner');
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
const fixtures: Array<{
    manager: import('../../src/network/network-manager').OneBotNetworkManager;
    apiCalls: ReturnType<typeof vi.fn>;
    sentTimeCalls: ReturnType<typeof vi.fn>;
}> = [];

const self = { platform: 'qq', user_id: '10001' };
const context = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: null,
    mediaSegmentSink: null,
};
const sourceEvent = {
    kind: 'group_name_change' as const,
    time: 1700000000.5,
    selfUin: 10001,
    groupId: 43,
    operatorUin: 42,
    name: '  新群名 😺  ',
};
const v11Event = {
    time: sourceEvent.time,
    self_id: 10001,
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'group_name',
    group_id: 43,
    user_id: 42,
    name_new: sourceEvent.name,
};
const expected = {
    id: expect.any(String),
    time: sourceEvent.time,
    type: 'notice',
    detail_type: 'qq.group_name_change',
    sub_type: '',
    self,
    group_id: '43',
    group_name: sourceEvent.name,
    operator_id: '42',
};
const TOKEN = 'synthetic-token';

function forbidden(): never {
    throw new Error('unexpected network, process, native, account or plugin operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.violations.length = 0;
    fake.warnings.length = 0;
    fake.peer = null;
    fixtures.length = 0;
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
        vi.spyOn(dns, 'lookup').mockImplementation(forbidden),
        vi.spyOn(dns, 'resolve').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
    ];
    // Dynamic imports ensure the guards are in place before production modules load.
    decoder = await import('@snowluma/protocol/msg-push/decoders/event-0x2dc');
    converters = await import('../../src/event-converter/to-notice');
    v12 = await import('../../src/v12/events');
    sourceApi = await import('../../src/v12-runtime/source-generation');
    ownerApi = await import('../../src/v12-runtime/poll-owner');
    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
    adapterApi = await import('../../src/network/adapter');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    runtimeApi = await import('../../src/v12-runtime/runtime');
});

afterEach(async () => {
    let cleanupFailed = false;
    const resources = fixtures.splice(0);

    try {
        for (const { manager } of resources) {
            try {
                const result = await manager.shutdown();
                cleanupFailed ||= !result.closed;
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const backend = resources.flatMap((fixture) => [
            fixture.apiCalls.mock.calls.length,
            fixture.sentTimeCalls.mock.calls.length,
        ]);
        const fetchCalls = fetchGuard.mock.calls.length;
        const socketCalls = webSocketGuard.mock.calls.length;
        const violations = [...fake.violations];
        const timers = vi.getTimerCount();
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
        expect(cleanupFailed).toBe(false);
        expect(calls).toEqual(calls.map(() => 0));
        expect(backend).toEqual(backend.map(() => 0));
        expect(fetchCalls).toBe(0);
        expect(socketCalls).toBe(0);
        expect(violations).toEqual([]);
        expect(timers).toBe(0);
    }
});

async function settle() {
    for (let i = 0; i < 50; i++) {
        await Promise.resolve();
    }
}

function convert(input: unknown, account = self) {
    return v12.convertV11Event(input, account);
}

function syntheticNameEvent(operator: number | null = 42) {
    const name = protobuf_encode<GroupNameChange>({ name: sourceEvent.name });
    const payload = protobuf_encode<NotifyMessageBody>({
        groupUin: sourceEvent.groupId,
        field13: 12,
        operatorUid: 'synthetic-operator',
        eventParam: name,
    });
    const content = new Uint8Array(7 + payload.length);
    content[5] = payload.length >>> 8;
    content[6] = payload.length & 0xff;
    content.set(payload, 7);
    const before = [...content];
    const lookup = vi.fn(() => operator);
    const decoded = decoder.decodeEvent0x2DC({
        head: {
            msgType: 0x2dc,
            subType: 16,
            c2cCmd: 0,
            sequence: 0,
            ntMsgSeq: 0,
            timestamp: sourceEvent.time,
            msgId: 0,
        },
        fromUin: sourceEvent.groupId,
        fromUid: '',
        selfUin: sourceEvent.selfUin,
        content,
        body: undefined,
        responseHead: undefined,
        identity: { findUinByUid: lookup } as never,
        isHistorical: false,
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('synthetic-operator', sourceEvent.groupId);
    expect([...content]).toEqual(before);
    const event = decoded[0];

    if (decoded.length !== 1 || !event || event.kind !== 'group_name_change') {
        throw new Error('synthetic name event not decoded');
    }

    return event;
}

describe('synthetic v11 group name notification to Jiyu v12 extension', () => {
    it('uses the real v11 converter, preserves both inputs, and makes a fresh event ID', () => {
        const original = structuredClone(sourceEvent);
        const v11 = converters.convertGroupNameChange(context, sourceEvent);
        expect(v11).toEqual(v11Event);
        const before = structuredClone(v11);
        const converted = convert(v11);
        expect(converted).toEqual(expected);
        expect(converted!.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(convert(v11)!.id).not.toBe(converted!.id);
        expect(sourceEvent).toEqual(original);
        expect(v11).toEqual(before);
    });

    it('keeps account, ID, time, and exact UTF-16 name values', () => {
        for (const id of [1, '1', Number.MAX_SAFE_INTEGER, '9007199254740991']) {
            expect(convert({ ...v11Event, group_id: id, user_id: id, time: 0 })).toMatchObject({
                group_id: String(id),
                operator_id: String(id),
                time: 0,
            });
        }

        for (const time of [0, 1.25, Number.MAX_SAFE_INTEGER]) {
            expect(convert({ ...v11Event, time })).toMatchObject({ time });
        }

        for (const name_new of [' ', '\u0000', '😀'.repeat(512), 'x'.repeat(1024), '  a\n']) {
            expect(convert({ ...v11Event, name_new })).toMatchObject({ group_name: name_new });
        }

        const other = { platform: 'qq', user_id: '20002' };
        const event = converters.convertGroupNameChange(
            { ...context, selfId: 20002 },
            { ...sourceEvent, selfUin: 20002, groupId: 99 },
        );
        expect(convert(event, other)).toMatchObject({ self: other, group_id: '99' });
        expect(() => convert(event, self)).toThrow();
        expect(() => convert(v11Event, other)).toThrow();
    });

    it('omits an unknown numeric-zero operator without asserting no operator existed', () => {
        const v11 = converters.convertGroupNameChange(context, { ...sourceEvent, operatorUin: 0 });
        expect(v11).toEqual({ ...v11Event, user_id: 0 });
        const before = structuredClone(v11);
        const output = convert(v11)!;
        expect(output).toEqual({
            id: expect.any(String),
            time: sourceEvent.time,
            type: 'notice',
            detail_type: 'qq.group_name_change',
            sub_type: '',
            self,
            group_id: '43',
            group_name: sourceEvent.name,
        });
        expect(Object.hasOwn(output, 'operator_id')).toBe(false);
        expect(v11).toEqual(before);
    });

    it('rejects noncanonical IDs, mismatched accounts, invalid time, name and extra fields', () => {
        const invalidIds = [
            undefined,
            null,
            '0',
            '-0',
            -0,
            -1,
            '-1',
            '01',
            ' 42',
            '42 ',
            '1e3',
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            '9007199254740992',
            false,
            {},
            1n,
        ];

        for (const field of ['group_id', 'user_id'] as const) {
            for (const value of invalidIds) {
                expect(
                    () => convert({ ...v11Event, [field]: value }),
                    `${field}: ${String(value)}`,
                ).toThrow();
            }

            const absent: Record<string, unknown> = { ...v11Event };
            delete absent[field];
            expect(() => convert(absent)).toThrow();
        }

        expect(() => convert({ ...v11Event, group_id: 0 })).toThrow();

        for (const value of [
            undefined,
            null,
            0,
            '010001',
            10002,
            '10002',
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => convert({ ...v11Event, self_id: value })).toThrow();
        }

        expect(() => convert(v11Event, { ...self, user_id: '010001' })).toThrow();

        for (const time of [
            undefined,
            null,
            -1,
            NaN,
            Infinity,
            -Infinity,
            '1',
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => convert({ ...v11Event, time })).toThrow();
        }

        for (const name_new of [
            undefined,
            null,
            '',
            0,
            false,
            {},
            'x'.repeat(1025),
            '😀'.repeat(513),
        ]) {
            expect(() => convert({ ...v11Event, name_new })).toThrow();
        }

        expect(() => convert({ ...v11Event, extra: false })).toThrow();
        expect(() => convert({ ...v11Event, [Symbol('extra')]: 1 })).toThrow();
        const hidden = { ...v11Event };
        const hiddenGetter = vi.fn(() => {
            throw new Error('hidden getter executed');
        });
        Object.defineProperty(hidden, 'extra', { get: hiddenGetter });
        expect(() => convert(hidden)).toThrow();
        expect(hiddenGetter).not.toHaveBeenCalled();
        expect(v11Event.name_new).toBe(sourceEvent.name);
    });

    it('rejects accessor, inherited and proxy target fields without invoking those getters', () => {
        // This checks the target fields only; common preflight behavior for
        // unrelated event families is covered separately below.
        for (const field of ['group_id', 'user_id', 'name_new'] as const) {
            const getter = vi.fn(() => {
                throw new Error('target getter executed');
            });
            const candidate = { ...v11Event };
            Object.defineProperty(candidate, field, { enumerable: true, get: getter });
            expect(() => convert(candidate)).toThrow();
            expect(getter).not.toHaveBeenCalled();

            const inherited = Object.create({ [field]: v11Event[field] }) as Record<
                string,
                unknown
            >;
            Object.assign(inherited, v11Event);
            delete inherited[field];
            expect(() => convert(inherited)).toThrow();
        }

        const targetReads: PropertyKey[] = [];
        const proxy = new Proxy(
            { ...v11Event },
            {
                get(target, key, receiver) {
                    if (
                        key === 'sub_type' ||
                        key === 'group_id' ||
                        key === 'user_id' ||
                        key === 'name_new'
                    ) {
                        targetReads.push(key);
                    }

                    return Reflect.get(target, key, receiver);
                },
            },
        );
        // Common preflight is outside this claim; the new branch ignores Proxy notify inputs.
        expect(convert(proxy)).toBeNull();
        expect(targetReads).toEqual([]);
    });

    it('does not retroactively project a group-name event created by a post_type getter', () => {
        const candidate = { ...v11Event };
        const getter = vi.fn(() => {
            Object.defineProperty(candidate, 'post_type', {
                configurable: true,
                enumerable: true,
                writable: true,
                value: 'notice',
            });
            candidate.name_new = 'reentrant replacement';
            return 'notice';
        });
        Object.defineProperty(candidate, 'post_type', {
            configurable: true,
            enumerable: true,
            get: getter,
        });
        // The legacy preflight may invoke this getter, but its mutation must not
        // turn a previously unidentified input into a new extension projection.
        expect(convert(candidate)).toBeNull();
        expect(getter).toHaveBeenCalledOnce();
        expect(candidate.name_new).toBe('reentrant replacement');
    });

    it.each(['self_id', 'time', 'name_new'] as const)(
        'rejects an identified candidate %s getter before it can replace the name',
        (field) => {
            const candidate = { ...v11Event };
            const getter = vi.fn(() => {
                Object.defineProperty(candidate, field, {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: v11Event[field],
                });
                candidate.name_new = 'reentrant replacement';
                return v11Event[field];
            });
            Object.defineProperty(candidate, field, {
                configurable: true,
                enumerable: true,
                get: getter,
            });
            expect(() => convert(candidate)).toThrow();

            if (field === 'name_new') {
                expect(Object.getOwnPropertyDescriptor(candidate, field)?.get).toBe(getter);
            } else {
                expect(candidate.name_new).toBe(sourceEvent.name);
            }

            expect(getter).not.toHaveBeenCalled();
        },
    );

    it.each(['platform', 'user_id'] as const)(
        'never projects a name replaced by the self %s getter',
        (field) => {
            const candidate = { ...v11Event };
            const account = { ...self };
            const getter = vi.fn(() => {
                candidate.name_new = 'reentrant replacement';
                return self[field];
            });
            Object.defineProperty(account, field, {
                configurable: true,
                enumerable: true,
                get: getter,
            });
            let rejected = false;
            let projected: ReturnType<typeof convert> | undefined;

            try {
                projected = convert(candidate, account);
            } catch {
                rejected = true;
            }

            if (!rejected) {
                expect(getter).toHaveBeenCalledOnce();
                expect(projected).toMatchObject({ group_name: sourceEvent.name, self });
                expect(candidate.name_new).toBe('reentrant replacement');
            }
        },
    );

    it('does not reclassify a snapshotted group-name event as friend_add during self access', () => {
        const candidate: Record<string, unknown> = { ...v11Event };
        const account = { ...self };
        const getter = vi.fn(() => {
            candidate.notice_type = 'friend_add';
            delete candidate.sub_type;
            delete candidate.group_id;
            delete candidate.name_new;
            return self.user_id;
        });
        Object.defineProperty(account, 'user_id', {
            configurable: true,
            enumerable: true,
            get: getter,
        });
        let rejected = false;
        let projected: ReturnType<typeof convert> | undefined;

        try {
            projected = convert(candidate, account);
        } catch {
            rejected = true;
        }

        if (!rejected) {
            expect(getter).toHaveBeenCalledOnce();
            expect(candidate.notice_type).toBe('friend_add');
            expect(projected).toEqual(expected);
        }
    });

    it('preserves legacy message and other notice getter and Proxy behavior', () => {
        const message = {
            time: 1,
            self_id: 10001,
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            message_id: -1,
            user_id: 42,
            message: [{ type: 'text', data: { text: 'hello' } }],
            raw_message: 'hello',
        };
        const messageWithGetter = { ...message };
        const postType = vi.fn(() => 'message');
        Object.defineProperty(messageWithGetter, 'post_type', { enumerable: true, get: postType });
        expect(convert(messageWithGetter)).toMatchObject({ type: 'message', message_id: '-1' });
        expect(postType).toHaveBeenCalledOnce();
        const messageReads: PropertyKey[] = [];
        const messageProxy = new Proxy(message, {
            get(target, key, receiver) {
                messageReads.push(key);
                return Reflect.get(target, key, receiver);
            },
        });
        expect(convert(messageProxy)).toMatchObject({ type: 'message', message_id: '-1' });
        expect(messageReads).toContain('post_type');
        const request = { self_id: 10001, post_type: 'request' };
        const requestPostType = vi.fn(() => 'request');
        Object.defineProperty(request, 'post_type', { enumerable: true, get: requestPostType });
        expect(convert(request)).toBeNull();
        expect(requestPostType).toHaveBeenCalledOnce();

        const friend = {
            time: 1,
            self_id: 10001,
            post_type: 'notice',
            notice_type: 'friend_add',
            user_id: 42,
        };
        const friendWithGetter = { ...friend };
        const user = vi.fn(() => 42);
        Object.defineProperty(friendWithGetter, 'user_id', { enumerable: true, get: user });
        expect(convert(friendWithGetter)).toMatchObject({
            detail_type: 'friend_increase',
            user_id: '42',
        });
        expect(user).toHaveBeenCalledOnce();
        const friendReads: PropertyKey[] = [];
        const friendProxy = new Proxy(friend, {
            get(target, key, receiver) {
                friendReads.push(key);
                return Reflect.get(target, key, receiver);
            },
        });
        expect(convert(friendProxy)).toMatchObject({
            detail_type: 'friend_increase',
            user_id: '42',
        });
        expect(friendReads).toContain('user_id');
    });

    it('keeps unrelated notify and non-notify paths unchanged', () => {
        for (const sub_type of ['poke', 'title', 'input_status', '', 'future', undefined]) {
            expect(convert({ ...v11Event, sub_type })).toBeNull();
        }

        for (const notice_type of ['future', 'friend_recall']) {
            expect(convert({ ...v11Event, notice_type })).toBeNull();
        }

        expect(convert({ ...v11Event, post_type: 'request' })).toBeNull();
        const friend = {
            time: 1,
            self_id: 10001,
            post_type: 'notice',
            notice_type: 'friend_add',
            user_id: 42,
        };
        expect(convert(friend)).toEqual({
            id: expect.any(String),
            time: 1,
            type: 'notice',
            detail_type: 'friend_increase',
            sub_type: '',
            self,
            user_id: '42',
        });
        const ignoredGetter = vi.fn(() => {
            throw new Error('subtype getter executed');
        });
        const ignored = { self_id: 10001, post_type: 'notice', notice_type: 'notify' };
        Object.defineProperty(ignored, 'sub_type', { enumerable: true, get: ignoredGetter });
        expect(convert(ignored)).toBeNull();
        expect(ignoredGetter).not.toHaveBeenCalled();
        expect(() => convert({ ...v11Event, sub_type: 'poke', self_id: 10002 })).toThrow();
    });
});

class FakeRequest extends EventEmitter {
    url = '/';
    method = 'POST';
    headers: Record<string, string> = { 'content-type': 'application/json' };
    rawHeaders = ['Authorization', `Bearer ${TOKEN}`];
    pause(): void {}
}
class FakeResponse extends EventEmitter {
    headersSent = false;
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    finished = false;
    status = 0;
    writes = 0;
    bodies: string[] = [];
    setHeader(): void {}
    writeHead(status: number): this {
        this.writes++;
        this.status = status;
        this.headersSent = true;
        return this;
    }
    end(body: string): this {
        this.bodies.push(body);
        this.writableEnded = this.writableFinished = this.finished = true;
        this.emit('finish');
        return this;
    }
    destroy(): this {
        if (!this.destroyed) {
            this.destroyed = true;
            this.emit('close');
        }

        return this;
    }
    json(): { status: string; retcode: number; data: unknown; message: string; echo?: string } {
        expect(this.status).toBe(200);
        expect(this.writes).toBe(1);
        expect(this.bodies).toHaveLength(1);
        return JSON.parse(this.bodies[0]!);
    }
}
class FakeUpgradeSocket extends EventEmitter {
    end(): void {
        fake.violations.push('fake upgrade rejected');
    }
    destroy(): void {
        fake.violations.push('fake upgrade destroyed');
    }
}
class FakePeer extends EventEmitter {
    frames: Array<Record<string, unknown>> = [];
    terminated = false;
    send(text: string, callback: (error?: Error) => void): void {
        this.frames.push(JSON.parse(text));
        callback();
    }
    terminate(): void {
        if (!this.terminated) {
            this.terminated = true;
            this.emit('close');
        }
    }
    _onData(): void {
        fake.violations.push('unexpected pipelined data');
    }
}

function connect(transport: V12Transport): FakePeer {
    const peer = new FakePeer();
    const request = new FakeRequest();
    request.method = 'GET';
    fake.peer = peer;

    try {
        transport.handleUpgrade(
            request as unknown as IncomingMessage,
            new FakeUpgradeSocket() as unknown as Duplex,
            Buffer.alloc(0),
        );
    } finally {
        fake.peer = null;
    }

    expect(peer.frames).toMatchObject([
        { type: 'meta', detail_type: 'connect' },
        { type: 'meta', detail_type: 'status_update' },
    ]);
    return peer;
}

function send(transport: V12Transport, input: object): FakeResponse {
    const request = new FakeRequest();
    const response = new FakeResponse();
    transport.handleRequest(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
    );
    request.emit('data', Buffer.from(JSON.stringify(input)));
    request.emit('end');
    return response;
}

async function poll(transport: V12Transport, params: object = {}, extra: object = {}) {
    const response = send(transport, { action: 'get_latest_events', params, ...extra });
    await settle();
    return response.json();
}

function notices(peer: FakePeer) {
    return peer.frames.filter((frame) => frame.detail_type === 'qq.group_name_change');
}

async function account(uin = '10001') {
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const manager = new managerApi.OneBotNetworkManager();
    const api = { handle: vi.fn(forbidden) };
    const sentTimeCalls = vi.fn(forbidden);
    let runtime!: V12Runtime;
    runtime = new runtimeApi.V12Runtime(
        {
            name: identityApi.V12_ADAPTER_NAME,
            enabled: true,
            host: 'fixture.invalid',
            port: 1,
            accessToken: TOKEN,
            allowNonLoopback: false,
            messageFormat: 'array',
            reportSelfMessage: false,
        },
        {
            uin,
            api: api as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: sentTimeCalls,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) =>
                manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                generation.isCurrent(source, binding),
        },
    );
    const legacy = new (class extends adapterApi.IOneBotNetworkAdapter<NetworkBase> {
        readonly received: JsonObject[] = [];
        constructor() {
            super(
                'synthetic-v11',
                {
                    name: 'synthetic-v11',
                    enabled: true,
                    messageFormat: 'array',
                    reportSelfMessage: false,
                },
                {
                    uin,
                    api: api as never,
                    buildLifecycleEvent: () => ({}),
                    buildHeartbeatEvent: () => ({}),
                },
            );
        }
        open(): void {
            this.isEnabled = true;
        }
        close(): void {
            this.isEnabled = false;
        }
        onEvent(event: JsonObject, _payload: DispatchPayload): void {
            this.received.push(event);
        }
        describeStatus() {
            return {
                name: this.name,
                kind: 'httpClient' as const,
                status: 'ok' as const,
                detail: 'fake',
            };
        }
        protected bindingSignature(config: NetworkBase): string {
            return config.name;
        }
    })();
    manager.register(runtime);
    manager.register(legacy);
    fixtures.push({ manager, apiCalls: api.handle, sentTimeCalls });
    legacy.open();
    const index = fake.transports.length;
    await runtime.open();
    expect(fake.transports).toHaveLength(index + 1);
    const transport = fake.transports[index]!.instance;
    expect(fake.transports[index]!.options.httpPoll).toBeDefined();

    const ticket = () => {
        const current = generation.capture(runtime[sourceApi.captureBinding]());

        if (!current) {
            throw new Error('fixture source unavailable');
        }

        return current;
    };

    return { generation, manager, runtime, legacy, transport, ticket };
}

describe('in-memory production runtime and HTTP/WS transport', () => {
    it('sends the same converted ID to WS and HTTP, preserves v11, and checks the binding', async () => {
        const a = await account();
        const b = await account('20002');
        const peer = connect(a.transport);
        const bPeer = connect(b.transport);
        expect((await poll(a.transport)).data).toEqual([]); // Activate the HTTP owner first.
        const decoded = syntheticNameEvent();
        expect(decoded).toEqual(sourceEvent);
        const input = converters.convertGroupNameChange(context, decoded);
        const before = structuredClone(input);
        await a.manager.emitEvent(input, a.ticket());
        expect(a.legacy.received).toEqual([before]);
        expect(input).toEqual(before);
        expect(notices(peer)).toEqual([expected]);
        expect(notices(bPeer)).toEqual([]);
        const response = await poll(a.transport, {}, { echo: 'synthetic' });
        expect(response).toEqual({
            status: 'ok',
            retcode: 0,
            data: [expected],
            message: '',
            echo: 'synthetic',
        });
        const httpEvent = (response.data as Array<{ id: string }>)[0]!;
        expect(httpEvent.id).toBe(notices(peer)[0]!.id);
        expect((await poll(a.transport)).data).toEqual([]);
        expect((await poll(b.transport)).data).toEqual([]);
    });

    it('keeps unticketed WS-only fanout and drops expired or foreign ticket projections', async () => {
        const a = await account();
        const b = await account('20002');
        const peer = connect(a.transport);
        const first = converters.convertGroupNameChange(context, sourceEvent);
        const oldTicket = a.ticket();
        await a.manager.emitEvent(first); // Existing non-media WS policy; no HTTP admission.
        expect(notices(peer)).toHaveLength(1);
        expect((await poll(a.transport)).data).toEqual([]);
        a.generation.setOnline(false);
        a.runtime.statusUpdate();
        a.generation.setOnline(true);
        a.runtime.statusUpdate();
        await settle();
        await a.manager.emitEvent(
            converters.convertGroupNameChange(context, sourceEvent),
            oldTicket,
        );
        await a.manager.emitEvent(
            converters.convertGroupNameChange(context, sourceEvent),
            b.ticket(),
        );
        expect(notices(peer)).toHaveLength(1);
        expect((await poll(a.transport)).data).toEqual([]);
        const current = converters.convertGroupNameChange(context, {
            ...sourceEvent,
            operatorUin: 0,
        });
        await a.manager.emitEvent(current, a.ticket());
        expect(notices(peer)).toHaveLength(2);
        const response = await poll(a.transport);
        expect(response.data).toEqual([
            {
                id: expect.any(String),
                time: sourceEvent.time,
                type: 'notice',
                detail_type: 'qq.group_name_change',
                sub_type: '',
                self,
                group_id: '43',
                group_name: sourceEvent.name,
            },
        ]);
        expect((response.data as Array<{ id: string }>)[0]!.id).toBe(notices(peer)[1]!.id);
        expect(a.legacy.received).toHaveLength(4);
    });

    it('records queue loss and reports bad HTTP parameters without consuming the batch', async () => {
        const a = await account();
        const peer = connect(a.transport);
        const ticket = a.ticket();

        for (let index = 0; index < 129; index++) {
            await a.manager.emitEvent(
                converters.convertGroupNameChange(context, {
                    ...sourceEvent,
                    time: index,
                    name: `name-${index}`,
                }),
                ticket,
            );
        }

        expect(ownerApi.pollOwnerStats(a.runtime)).toMatchObject({
            accepted: 129,
            dropped_oldest: '1',
        });
        expect(notices(peer)).toHaveLength(129);
        expect(a.legacy.received).toHaveLength(129);
        expect(await poll(a.transport, { limit: -1 }, { echo: 'bad' })).toEqual({
            status: 'failed',
            retcode: 10003,
            data: null,
            message: 'invalid poll parameters',
            echo: 'bad',
        });
        const batch = (await poll(a.transport)).data as Array<{ id: string; group_name: string }>;
        expect(batch).toHaveLength(128);
        expect(batch.map((event) => event.group_name)).toEqual(
            Array.from({ length: 128 }, (_, index) => `name-${index + 1}`),
        );
        expect(batch.map((event) => event.id)).toEqual(
            notices(peer)
                .slice(1)
                .map((event) => event.id),
        );
    });
});

function orderedOwner() {
    const binding = {};
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const runtime = {};
    ownerApi.registerPollHost(
        runtime,
        {
            self,
            captureBinding: () => binding,
            captureSource: () => generation.capture(binding),
            verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
        },
        ownerApi.createPollGate(),
    );
    const activation = ownerApi.activateOrderedPollOwner(runtime);

    if (activation.status !== 'ready') {
        throw new Error('ordered owner unavailable');
    }

    return { runtime, owner: activation.owner, source: generation.capture(binding)! };
}

describe('ordered poll exact extension admission', () => {
    it.each([42, 0])('admits the real converted shape with source operator %s', async (user_id) => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = orderedOwner();

        try {
            const event = convert({ ...v11Event, user_id });
            const parent = f.owner.begin(f.source)!;
            expect(parent.child()!.resolve(event)).toBe(true);
            parent.seal();
            await vi.advanceTimersByTimeAsync(0);
            expect(enqueue).toHaveBeenCalledExactlyOnceWith(event);
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 1,
                invalid: 0,
                ordering_gap: false,
            });
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });

    it('rejects an unsafe time during the sequencer snapshot before ordered validation', async () => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = orderedOwner();

        try {
            const event = { ...convert(v11Event)!, time: Number.MAX_SAFE_INTEGER + 1 };
            const parent = f.owner.begin(f.source)!;
            expect(parent.child()!.resolve(event)).toBe(false);
            parent.seal();
            await vi.advanceTimersByTimeAsync(0);
            await settle();
            expect(enqueue).not.toHaveBeenCalled();
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                invalid: 0,
                ordering_gap: true,
                ordering_reason: 'invalid_event',
            });
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });

    it.each([
        'extra',
        'missing group',
        'numeric group',
        'invalid operator',
        'bad name',
        'long name',
        'subtype',
        'time',
        'self',
    ] as const)('rejects %s and exposes the ordered gap', async (kind) => {
        const enqueue = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue');
        const f = orderedOwner();

        try {
            const event: Record<string, unknown> = { ...convert(v11Event)! };

            switch (kind) {
                case 'extra':
                    event.user_id = '42';
                    break;
                case 'missing group':
                    delete event.group_id;
                    break;
                case 'numeric group':
                    event.group_id = 43;
                    break;
                case 'invalid operator':
                    event.operator_id = '0';
                    break;
                case 'bad name':
                    event.group_name = '';
                    break;
                case 'long name':
                    event.group_name = 'x'.repeat(1025);
                    break;
                case 'subtype':
                    event.sub_type = 'group_name';
                    break;
                case 'time':
                    event.time = -1;
                    break;
                case 'self':
                    event.self = { platform: 'qq', user_id: '20002' };
                    break;
            }

            const parent = f.owner.begin(f.source)!;
            expect(parent.child()!.resolve(event)).toBe(true);
            parent.seal();
            await vi.advanceTimersByTimeAsync(0);
            await settle();
            expect(enqueue).not.toHaveBeenCalled();
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                invalid: 1,
                ordering_gap: true,
            });
            expect(ownerApi.activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });
});

// Local integration of the real subscription and conversion with a deliberately
// stubbed non-message backfill; this is not a packet pipeline or live QQ test.
it('delivers a synthetic decoded event through the registered pipeline', async () => {
    const { registerEventPipeline } = await import('../../src/event-pipeline');
    const a = await account();
    const peer = connect(a.transport);
    expect((await poll(a.transport)).data).toEqual([]);
    const ticket = a.ticket();
    const emitter = new EventEmitter();
    const bridgeEvents = {
        on(kind: string, listener: (event: unknown) => void) {
            emitter.on(kind, listener);
            return () => emitter.off(kind, listener);
        },
    };
    const dispatch = vi.fn(
        async (
            event: JsonObject,
            _origin: string,
            _startedAt: number,
            source: V12Source | undefined,
        ) => {
            await a.manager.emitEvent(event, source);
        },
    );
    const ctx = {
        uin: '10001',
        bridge: { events: bridgeEvents },
        converterCtx: context,
        dispatchEvent: dispatch,
        [sourceApi.captureSource]: () => ticket,
    };
    const pipeline = registerEventPipeline(ctx as never);
    const warningCount = fake.warnings.length;

    try {
        const decoded = syntheticNameEvent();
        const before = structuredClone(decoded);
        expect(decoded).toEqual(sourceEvent);
        expect(emitter.listenerCount('group_name_change')).toBe(1);
        expect(emitter.emit(decoded.kind, decoded)).toBe(true);
        pipeline.stop();
        await pipeline.drain();
        expect(emitter.listenerCount('group_name_change')).toBe(0);
        expect(emitter.emit(decoded.kind, decoded)).toBe(false);
        expect(decoded).toEqual(before);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith(v11Event, 'bridge', expect.any(Number), ticket);
        expect(a.legacy.received).toEqual([v11Event]);
        expect(notices(peer)).toEqual([expected]);
        const response = await poll(a.transport);
        expect(response).toEqual({ status: 'ok', retcode: 0, data: [expected], message: '' });
        expect((response.data as Array<{ id: string }>)[0]!.id).toBe(notices(peer)[0]!.id);
        expect(fake.warnings.slice(warningCount)).toEqual([]);
    } finally {
        pipeline.stop();
        await pipeline.drain();
    }
});
