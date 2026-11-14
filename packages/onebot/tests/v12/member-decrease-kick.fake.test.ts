import type { GroupChange } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../../../protocol/src/identity-service';
import { decodeGroupMemberLeave } from '../../../protocol/src/msg-push/decoders/group-member-change';
import { convertGroupMemberLeave } from '../../src/event-converter/to-notice';
import { convertV11Event } from '../../src/v12/events';
import type { V12TransportOptions } from '../../src/v12-network';

const transport = vi.hoisted(() => ({ options: null as V12TransportOptions | null }));
vi.mock('@snowluma/websocket', () => ({ WebSocket: class {}, WebSocketServer: class {} }));
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: V12TransportOptions) {
            transport.options = options;
        }
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));

import { V12Runtime } from '../../src/v12-runtime/runtime';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { captureBinding, SourceGeneration } from '../../src/v12-runtime/source-generation';

const self = { platform: 'qq', user_id: '10001' };
const context = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: null,
    mediaSegmentSink: null,
};
const event = {
    kind: 'group_member_leave' as const,
    time: 1700000000.5,
    selfUin: 10001,
    groupId: 43,
    userUin: 42,
    operatorUin: 44,
    leaveType: 'kick' as const,
};
const expectedV11 = {
    time: event.time,
    self_id: 10001,
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: 'kick',
    group_id: 43,
    user_id: 42,
    operator_id: 44,
};

function expected(userId: number) {
    return {
        id: expect.any(String),
        time: event.time,
        type: 'notice',
        detail_type: 'group_member_decrease',
        sub_type: '',
        self,
        group_id: '43',
        user_id: String(userId),
        operator_id: '44',
    };
}

describe('group decrease synthetic in-memory requester', () => {
    it.each([
        { user: 42, subtype: 'kick' },
        { user: 10001, subtype: 'kick_me' },
    ])(
        'preserves the complete v11 $subtype and converts without claiming the reason',
        ({ user, subtype }) => {
            const input = { ...event, userUin: user };
            const before = structuredClone(input);
            const v11 = convertGroupMemberLeave(context, input);
            expect(v11).toEqual({ ...expectedV11, user_id: user, sub_type: subtype });
            const v11Before = structuredClone(v11);
            const result = convertV11Event(v11, self);
            expect(result).toEqual(expected(user));
            expect(result!.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expect(convertV11Event(v11, self)!.id).not.toBe(result!.id);
            expect(input).toEqual(before);
            expect(v11).toEqual(v11Before);
        },
    );

    it('propagates an unknown QQ decreaseType decoder default without asserting a kick reason', () => {
        const identity = IdentityService.memory('10001');
        identity.rememberRequestIdentity({ uid: 'u_member', uin: 42 });
        identity.rememberRequestIdentity({ uid: 'u_operator', uin: 44 });
        const content = protobuf_encode<GroupChange>({
            groupUin: 43,
            memberUid: 'u_member',
            decreaseType: 222,
            operatorBytes: new TextEncoder().encode('u_operator'),
        });
        const bytesBefore = [...content];
        const decoded = decodeGroupMemberLeave({
            head: {
                msgType: 34,
                subType: 0,
                c2cCmd: 0,
                sequence: 1,
                ntMsgSeq: 0,
                timestamp: event.time,
                msgId: 1,
            },
            fromUin: 0,
            fromUid: '',
            selfUin: 10001,
            content,
            body: undefined,
            responseHead: undefined,
            identity,
            isHistorical: true,
        });
        expect(decoded).toEqual([
            {
                ...event,
                userUid: 'u_member',
                operatorUid: 'u_operator',
            },
        ]);
        const source = decoded[0];

        if (source.kind !== 'group_member_leave') {
            throw new Error('unexpected decoded event');
        }

        const sourceBefore = structuredClone(source);
        const v11 = convertGroupMemberLeave(context, source);
        expect(v11).toEqual(expectedV11);
        const before = structuredClone(v11);
        expect(convertV11Event(v11, self)).toEqual(expected(42));
        expect(v11).toEqual(before);
        expect(source).toEqual(sourceBefore);
        expect([...content]).toEqual(bytesBefore);
    });

    it.each(['kick', 'kick_me'] as const)('fails closed for malformed %s events', (sub_type) => {
        const v11 = { ...expectedV11, sub_type };

        for (const field of ['group_id', 'user_id', 'operator_id'] as const) {
            for (const value of [
                undefined,
                null,
                0,
                '0',
                '01',
                -1,
                1.5,
                Number.MAX_SAFE_INTEGER + 1,
            ]) {
                expect(() => convertV11Event({ ...v11, [field]: value }, self)).toThrow();
            }

            const missing: Record<string, unknown> = { ...v11 };
            delete missing[field];
            expect(() => convertV11Event(missing, self)).toThrow();
        }

        for (const time of [undefined, null, -1, NaN, Infinity, '1']) {
            expect(() => convertV11Event({ ...v11, time }, self)).toThrow();
        }

        for (const self_id of [undefined, null, 0, '010001', 10002]) {
            expect(() => convertV11Event({ ...v11, self_id }, self)).toThrow();
        }

        expect(() => convertV11Event(v11, { ...self, user_id: '10002' })).toThrow();
        expect(() => convertV11Event({ ...v11, extra: false }, self)).toThrow();
        expect(() => convertV11Event({ ...v11, [Symbol('extra')]: 1 }, self)).toThrow();
        expect(v11).toEqual({ ...expectedV11, sub_type });
    });

    it('keeps disband and unknown v11 subtype unsupported', () => {
        const input = { ...event, leaveType: 'disband' as const };
        const v11 = convertGroupMemberLeave(context, input);
        expect(v11).toEqual({ ...expectedV11, sub_type: 'disband' });
        expect(convertV11Event(v11, self)).toBeNull();
        expect(convertV11Event({ ...expectedV11, sub_type: 'future' }, self)).toBeNull();
        expect(() => convertV11Event({ ...v11, self_id: 10002 }, self)).toThrow();
    });

    it('delivers the real converted event through a runtime subscriber with fake transport', async () => {
        const manager = new OneBotNetworkManager();
        const generation = new SourceGeneration();
        let runtime!: V12Runtime;
        runtime = new V12Runtime(
            {
                name: V12_ADAPTER_NAME,
                enabled: true,
                host: '127.0.0.1',
                port: 1,
                allowNonLoopback: false,
            },
            {
                uin: '10001',
                api: {} as never,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
            {
                getStatus: () => ({ good: true, online: true }),
                getSentMessageTime: async () => null,
                trackAction: (_label, start) => start(),
                canAccept: () => true,
                isSourceCurrent: (source, binding) =>
                    manager.get(V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding),
            },
        );
        manager.register(runtime);
        await runtime.open();

        try {
            generation.setOnline(true);
            const received = vi.fn();
            transport.options!.subscribe(received);
            received.mockClear();
            const v11 = convertGroupMemberLeave(context, event);
            await manager.emitEvent(v11, generation.capture(runtime[captureBinding]())!);
            expect(received).toHaveBeenCalledOnce();
            expect(received).toHaveBeenCalledWith(expected(42));
            expect(v11).toEqual(expectedV11);
        } finally {
            await runtime.close();
            transport.options = null;
        }
    });
});
