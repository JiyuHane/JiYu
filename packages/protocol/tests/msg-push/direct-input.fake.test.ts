import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';

import { IdentityService } from '../../src/identity-service';
import { parseDirectMsgPushOrThrow, SysMsgDedup } from '../../src/msg-push';

const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const SELF = '2000000001';
type DirectInput = Parameters<typeof parseDirectMsgPushOrThrow>[0];

function input(body = new Uint8Array(0), uin = SELF): DirectInput {
    return { uin, sequence: 0, command: COMMAND, retCode: 0, body };
}

function parse(value: unknown, identity = IdentityService.memory(SELF), dedup?: SysMsgDedup) {
    return parseDirectMsgPushOrThrow(value as DirectInput, identity, dedup);
}

function encode(message: PushMsgBody): Uint8Array {
    return protobuf_encode<PushMsg>({ message });
}

function friendBody(): Uint8Array {
    return encode({
        responseHead: { fromUin: 10001, fromUid: 'u_peer' },
        contentHead: {
            msgType: 166,
            subType: 0,
            sequence: 32743,
            ntMsgSeq: 63214,
            timestamp: 1781540572,
            msgId: 1,
        },
        body: { richText: { elems: [{ text: { str: 'hello friend' } }] } },
    });
}

function groupBody(): Uint8Array {
    return encode({
        responseHead: { fromUin: 222, grp: { groupUin: 9999, memberName: 'Bob' } },
        contentHead: { msgType: 82, sequence: 120, timestamp: 1700000120, msgId: 5120 },
        body: { richText: { elems: [{ text: { str: 'hello group' } }] } },
    });
}

function joinBody(): Uint8Array {
    return encode({
        responseHead: { fromUin: 700, fromUid: '' },
        contentHead: { msgType: 33, subType: 0, sequence: 800, timestamp: 1781540572, msgId: 555 },
        body: {
            msgContent: protobuf_encode<GroupChange>({ groupUin: 700, memberUid: '2854207029' }),
        },
    });
}

describe('parseDirectMsgPushOrThrow input boundary', () => {
    it('accepts ordinary and frozen own-data inputs without mutating them', () => {
        for (const frozen of [false, true]) {
            const body = friendBody();
            const bytes = [...body];
            const value = input(body);

            if (frozen) {
                Object.freeze(value);
            }

            const descriptors = Object.getOwnPropertyDescriptors(value);
            const result = parse(value);
            expect(result).toMatchObject([
                { kind: 'friend_message', elements: [{ type: 'text', text: 'hello friend' }] },
            ]);
            expect(Object.getOwnPropertyDescriptors(value)).toEqual(descriptors);
            expect(value.body).toBe(body);
            expect([...body]).toEqual(bytes);
        }

        expect(parse(Object.freeze(input()))).toEqual([]);
    });

    it('accepts an exact null-prototype own-data record', () => {
        const value = Object.assign(Object.create(null), input(friendBody()));
        const descriptors = Object.getOwnPropertyDescriptors(value);
        expect(parse(value)).toMatchObject([
            { kind: 'friend_message', elements: [{ type: 'text', text: 'hello friend' }] },
        ]);
        expect(Object.getPrototypeOf(value)).toBeNull();
        expect(Object.getOwnPropertyDescriptors(value)).toEqual(descriptors);
    });

    it('accepts non-enumerable own data fields', () => {
        const ordinary = input();
        const value = Object.create(Object.prototype);

        for (const key of Reflect.ownKeys(ordinary)) {
            Object.defineProperty(value, key, {
                value: Reflect.get(ordinary, key),
                enumerable: false,
            });
        }

        expect(parse(value)).toEqual([]);
    });

    it.each([null, undefined, 1, 'x', true, [], () => {}, new Date()])(
        'rejects non-record input %s',
        (value) => {
            expect(() => parse(value)).toThrow();
        },
    );

    it('rejects proxies before invoking their traps', () => {
        let traps = 0;
        const proxy = new Proxy(input(), {
            get() {
                traps++;
                throw new Error('get trap');
            },
            getPrototypeOf() {
                traps++;
                throw new Error('prototype trap');
            },
            ownKeys() {
                traps++;
                throw new Error('keys trap');
            },
            getOwnPropertyDescriptor() {
                traps++;
                throw new Error('descriptor trap');
            },
        });
        expect(() => parse(proxy)).toThrow();
        expect(traps).toBe(0);
        const revoked = Proxy.revocable(input(), {});
        revoked.revoke();
        expect(() => parse(revoked.proxy)).toThrow();
    });

    it('rejects getters on each required property without calling them', () => {
        for (const key of ['uin', 'sequence', 'command', 'retCode', 'body'] as const) {
            let reads = 0;
            const value = { ...input() };
            Object.defineProperty(value, key, {
                enumerable: true,
                get() {
                    reads++;
                    return undefined;
                },
            });
            expect(() => parse(value)).toThrow();
            expect(reads).toBe(0);
        }
    });

    it('rejects extra keys including non-enumerable, symbols and accessors without invoking them', () => {
        for (const key of ['extra', Symbol('extra')]) {
            for (const enumerable of [true, false]) {
                let reads = 0;
                const value = { ...input() };
                Object.defineProperty(value, key, {
                    enumerable,
                    get() {
                        reads++;
                        return 1;
                    },
                });
                expect(() => parse(value)).toThrow();
                expect(reads).toBe(0);
            }
        }

        expect(() => parse({ ...input(), extra: undefined })).toThrow();
    });

    it('rejects missing and inherited fields, custom prototypes and function records', () => {
        for (const key of ['uin', 'sequence', 'command', 'retCode', 'body'] as const) {
            const value: Record<string, unknown> = { ...input() };
            delete value[key];
            expect(() => parse(value)).toThrow();
            const inherited = Object.assign(Object.create({ [key]: input()[key] }), value);
            expect(() => parse(inherited)).toThrow();
        }

        expect(() => parse(Object.assign(Object.create({ custom: true }), input()))).toThrow();
        expect(() => parse(Object.assign(() => {}, input()))).toThrow();
    });

    it('does not inspect or coerce arbitrary invalid field references', () => {
        for (const key of ['uin', 'sequence', 'command', 'retCode', 'body'] as const) {
            let reads = 0;
            const reference = Object.defineProperty({}, Symbol.toPrimitive, {
                get() {
                    reads++;
                    throw new Error('coercion');
                },
            });
            Object.defineProperty(reference, 'value', {
                get() {
                    reads++;
                    throw new Error('getter');
                },
            });
            const value = { ...input(), [key]: reference };
            expect(() => parse(value)).toThrow();
            expect(reads).toBe(0);
            expect(Object.getOwnPropertyDescriptor(reference, 'value')?.get).toBeTypeOf('function');
        }
    });

    it.each(['1', '4294967295'])('accepts canonical uin boundary %s', (uin) => {
        expect(parse(input(new Uint8Array(0), uin), IdentityService.memory(uin))).toEqual([]);
    });

    it.each([
        '',
        '0',
        '00',
        '01',
        '-1',
        '+1',
        ' 1',
        '1 ',
        '1.0',
        '1e2',
        '4294967296',
        '999999999999999999999',
        '１２３',
    ])('rejects noncanonical or out-of-range uin %s', (uin) => {
        expect(() => parse(input(new Uint8Array(0), uin), IdentityService.memory(uin))).toThrow();
    });

    it.each([
        ['LF', '\n'],
        ['CR', '\r'],
        ['U+2028', '\u2028'],
        ['U+2029', '\u2029'],
    ])(
        'rejects trailing %s even when identity uin matches and leaves dedup untouched',
        (_label, suffix) => {
            const malformedUin = SELF + suffix;
            const identity = IdentityService.memory(malformedUin);
            const dedup = new SysMsgDedup();
            const body = joinBody();
            expect(identity.uin).toBe(malformedUin);
            expect(() => parse(input(body, malformedUin), identity, dedup)).toThrow();
            expect(parse(input(body), IdentityService.memory(SELF), dedup)).toMatchObject([
                { kind: 'group_member_join', groupId: 700, userUin: 2854207029 },
            ]);
            expect(parse(input(body), IdentityService.memory(SELF), dedup)).toEqual([]);
        },
    );

    it.each([0, 1, 4294967295])('accepts uint32 sequence %s', (sequence) => {
        expect(parse({ ...input(), sequence })).toEqual([]);
    });

    it.each([-1, 4294967296, 1.5, NaN, Infinity, -Infinity, '1', null])(
        'rejects invalid sequence %s',
        (sequence) => {
            expect(() => parse({ ...input(), sequence })).toThrow();
        },
    );

    it.each(['', 'other', COMMAND + ' ', null, 1])(
        'rejects an unexpected command %s',
        (command) => {
            expect(() => parse({ ...input(), command })).toThrow();
        },
    );

    it.each([1, -1, NaN, Infinity, '0', null])('rejects retCode %s', (retCode) => {
        expect(() => parse({ ...input(), retCode })).toThrow();
    });

    it('rejects invalid byte shapes, detached and shared buffers', () => {
        const detached = new Uint8Array([1]);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const shared = new Uint8Array(new SharedArrayBuffer(8));
        const badBodies: unknown[] = [
            null,
            undefined,
            [],
            {},
            'bytes',
            new ArrayBuffer(8),
            new DataView(new ArrayBuffer(8)),
            new Uint16Array(2),
            new Int8Array(2),
            detached,
            shared,
            Buffer.from(shared.buffer),
        ];

        for (const body of badBodies) {
            expect(() => parse({ ...input(), body })).toThrow();
        }
    });

    it('rejects spoofed or proxied byte views without invoking reference getters', () => {
        let reads = 0;
        const spoof = Object.create(Uint8Array.prototype);

        for (const key of ['buffer', 'byteLength', 'byteOffset', 'length']) {
            Object.defineProperty(spoof, key, {
                get() {
                    reads++;
                    throw new Error('view getter');
                },
            });
        }

        const proxied = new Proxy(new Uint8Array(0), {
            get() {
                reads++;
                throw new Error('view proxy');
            },
            getPrototypeOf() {
                reads++;
                throw new Error('view proxy');
            },
        });
        expect(() => parse({ ...input(), body: spoof })).toThrow();
        expect(() => parse({ ...input(), body: proxied })).toThrow();
        expect(reads).toBe(0);
    });

    it('does not invoke getters attached to a real Uint8Array reference', () => {
        const body = friendBody();
        let reads = 0;

        for (const key of ['buffer', 'byteLength', 'byteOffset', 'length', Symbol.iterator]) {
            Object.defineProperty(body, key, {
                get() {
                    reads++;
                    throw new Error('view getter');
                },
            });
        }

        expect(parse(input(body))).toMatchObject([
            { kind: 'friend_message', elements: [{ type: 'text', text: 'hello friend' }] },
        ]);
        expect(reads).toBe(0);
    });

    it('decodes the selected Uint8Array subarray and Buffer without changing their backing bytes', () => {
        const bytes = friendBody();
        const backing = new Uint8Array(bytes.length + 2);
        backing[0] = 255;
        backing.set(bytes, 1);
        backing[backing.length - 1] = 255;
        const original = [...backing];
        const view = backing.subarray(1, -1);

        for (const body of [view, Buffer.from(view.buffer, view.byteOffset, view.byteLength)]) {
            const value = input(body);
            expect(parse(value)).toMatchObject([
                { kind: 'friend_message', elements: [{ type: 'text', text: 'hello friend' }] },
            ]);
            expect(value.body).toBe(body);
            expect([...backing]).toEqual(original);
        }
    });
});

describe('parseDirectMsgPushOrThrow real decoding and state', () => {
    it('decodes real friend and group protobuf using per-account selfUin', () => {
        const a = IdentityService.memory(SELF);
        const b = IdentityService.memory('2000000002');

        for (const [uin, identity] of [
            [SELF, a],
            ['2000000002', b],
        ] as const) {
            expect(parse(input(friendBody(), uin), identity)).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(uin),
                    senderUin: 10001,
                    senderUid: 'u_peer',
                    msgSeq: 32743,
                    ntMsgSeq: 63214,
                    elements: [{ type: 'text', text: 'hello friend' }],
                },
            ]);
            expect(parse(input(groupBody(), uin), identity)).toMatchObject([
                {
                    kind: 'group_message',
                    selfUin: Number(uin),
                    groupId: 9999,
                    senderUin: 222,
                    senderNick: 'Bob',
                    msgSeq: 120,
                    elements: [{ type: 'text', text: 'hello group' }],
                },
            ]);
        }
    });

    it('uses the supplied in-memory identity to resolve a group join', () => {
        const identity = IdentityService.memory(SELF);
        identity.rememberRequestIdentity({ uid: 'u_joiner', uin: 23456 });
        const body = encode({
            responseHead: { fromUin: 700, fromUid: '' },
            contentHead: {
                msgType: 33,
                subType: 0,
                sequence: 800,
                timestamp: 1781540572,
                msgId: 555,
            },
            body: {
                msgContent: protobuf_encode<GroupChange>({ groupUin: 700, memberUid: 'u_joiner' }),
            },
        });
        expect(parse(input(body), identity)).toMatchObject([
            { kind: 'group_member_join', userUin: 23456, userUid: 'u_joiner' },
        ]);
        expect(IdentityService.memory(SELF).findUinByUid('u_joiner')).toBeNull();
    });

    it('honors optional dedup and rejects account mismatch without consuming it', () => {
        const identity = IdentityService.memory(SELF);
        const dedup = new SysMsgDedup();
        const message = input(joinBody());
        expect(() => parse(message, IdentityService.memory('2000000002'), dedup)).toThrow();
        expect(parse(message, identity, dedup)).toMatchObject([
            { kind: 'group_member_join', groupId: 700, userUin: 2854207029 },
        ]);
        expect(parse(message, identity, dedup)).toEqual([]);
        expect(parse(message, identity)).toHaveLength(1);
        expect(parse(message, identity)).toHaveLength(1);
    });

    it('requires caller-owned per-account dedup trackers for identical system pushes', () => {
        const body = joinBody();
        const accountA = IdentityService.memory(SELF);
        const uinB = '2000000002';
        const accountB = IdentityService.memory(uinB);
        const ownA = new SysMsgDedup();
        const ownB = new SysMsgDedup();
        expect(parse(input(body), accountA, ownA)).toMatchObject([
            { selfUin: Number(SELF), kind: 'group_member_join' },
        ]);
        expect(parse(input(body, uinB), accountB, ownB)).toMatchObject([
            { selfUin: Number(uinB), kind: 'group_member_join' },
        ]);

        // A shared tracker has no account dimension: ownership stays with its caller.
        const shared = new SysMsgDedup();
        expect(parse(input(body), accountA, shared)).toHaveLength(1);
        expect(parse(input(body, uinB), accountB, shared)).toEqual([]);
    });

    it('keeps an undecoded direct message without logging its synthetic payload on the warning path', () => {
        const secret = 'SyntheticPrivatePayload_7f19a5';
        const secretHex = Buffer.from(secret).toString('hex');
        const body = encode({
            responseHead: { fromUin: 10001, fromUid: 'u_peer' },
            contentHead: {
                msgType: 166,
                subType: 0,
                sequence: 101,
                timestamp: 1781540572,
                msgId: 2,
            },
            body: {
                richText: {
                    elems: [
                        {
                            commonElem: {
                                serviceType: 999,
                                businessType: 0,
                                pbElem: Buffer.from(secret),
                            },
                        },
                    ],
                },
            },
        });
        const entries: LogEntry[] = [];
        const previous = getLogLevel();
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            expect(parse(input(body))).toMatchObject([{ kind: 'friend_message', elements: [] }]);
            const warnings = entries.filter(
                (entry) => entry.level === 'warn' && entry.scope === 'MsgPush',
            );
            expect(warnings.length).toBeGreaterThan(0);

            for (const entry of warnings) {
                expect(entry.message).not.toContain(secret);
                expect(entry.message.toLowerCase()).not.toContain(secretHex);
                expect(entry.message.toLowerCase()).not.toContain(
                    Buffer.from(body).toString('hex'),
                );
            }
        } finally {
            unsubscribe();
            setLogLevel(previous);
        }
    });

    it('keeps the original decoder exception while omitting its synthetic token from direct exception traces', () => {
        const secret = 'SyntheticDecoderToken_6a290c';
        const secretHex = Buffer.from(secret).toString('hex');
        const marker = new Error(`decoder fixture ${secret} ${secretHex}`);
        const identity = IdentityService.memory(SELF);
        const spy = vi.spyOn(identity, 'findFriend').mockImplementation(() => {
            throw marker;
        });
        const entries: LogEntry[] = [];
        const previous = getLogLevel();
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            let thrown: unknown;

            try {
                parse(input(friendBody()), identity);
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBe(marker);
            expect((thrown as Error).message).toContain(secret);
            const traces = entries.filter(
                (entry) =>
                    entry.level === 'trace' && entry.message.includes('branch=decoder_exception'),
            );
            expect(traces.length).toBeGreaterThan(0);

            for (const entry of traces) {
                expect(entry.message).not.toContain(secret);
                expect(entry.message.toLowerCase()).not.toContain(secretHex);
            }
        } finally {
            unsubscribe();
            setLogLevel(previous);
            spy.mockRestore();
        }
    });

    it('preserves the original decoder error when a trace subscriber throws', () => {
        const original = new Error('synthetic original decoder failure');
        const subscriberFailure = new Error('synthetic subscriber failure');
        const identity = IdentityService.memory(SELF);
        const spy = vi.spyOn(identity, 'findFriend').mockImplementation(() => {
            throw original;
        });
        const previous = getLogLevel();
        let seen = false;
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => {
            if (entry.level === 'trace' && entry.message.includes('branch=decoder_exception')) {
                seen = true;
                throw subscriberFailure;
            }
        });

        try {
            let thrown: unknown;

            try {
                parse(input(friendBody()), identity);
            } catch (error) {
                thrown = error;
            }

            expect(seen).toBe(true);
            expect(thrown).toBe(original);
        } finally {
            unsubscribe();
            setLogLevel(previous);
            spy.mockRestore();
        }
    });

    it('omits the synthetic peer UID from direct duplicate-system-push logs', () => {
        const peer = 'SyntheticPeerMarker_23af41';
        const peerHex = Buffer.from(peer).toString('hex');
        const body = encode({
            responseHead: { fromUin: 700, fromUid: peer },
            contentHead: {
                msgType: 166,
                subType: 133,
                sequence: 900,
                timestamp: 1781540572,
                msgId: 7,
            },
            body: { richText: { elems: [{ text: { str: 'hello' } }] } },
        });
        const identity = IdentityService.memory(SELF);
        const dedup = new SysMsgDedup();
        const entries: LogEntry[] = [];
        const previous = getLogLevel();
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            expect(parse(input(body), identity, dedup)).toHaveLength(1);
            expect(parse(input(body), identity, dedup)).toEqual([]);
            const logs = entries.filter(
                (entry) => entry.level === 'trace' || entry.level === 'debug',
            );
            expect(
                logs.some((entry) => entry.message.includes('branch=duplicate_system_push')),
            ).toBe(true);

            for (const entry of logs) {
                expect(entry.message).not.toContain(peer);
                expect(entry.message.toLowerCase()).not.toContain(peerHex);
            }
        } finally {
            unsubscribe();
            setLogLevel(previous);
        }
    });

    it('propagates decoder errors and leaves injected identity exceptions observable', () => {
        const identity = IdentityService.memory(SELF);
        const marker = new Error('identity failure');
        const spy = vi.spyOn(identity, 'findFriend').mockImplementation(() => {
            throw marker;
        });

        try {
            expect(() => parse(input(friendBody()), identity)).toThrow(marker);
        } finally {
            spy.mockRestore();
        }

        expect(parse(input(friendBody()), identity)).toHaveLength(1);
        expect(() => parse(input(new Uint8Array([0x0a, 0x80])), identity)).toThrow();
    });
});
