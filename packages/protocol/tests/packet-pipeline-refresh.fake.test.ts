import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { GroupInviteTracker } from '@snowluma/protocol/group-invite-tracker';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import type { QQGroupInfo } from '@snowluma/protocol/qq-info';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SELF = 10001;
const GROUP = 123456789;
const OTHER = 987654321;
const previousLogLevel = getLogLevel();
const releases: Array<() => void> = [];

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    releases.push(resolve);
    return { promise, resolve };
}

async function flush(): Promise<void> {
    // Refresh is detached from processEvents; drain its await/finally continuations.
    for (let i = 0; i < 8; i++) {
        await Promise.resolve();
    }
}

afterEach(async () => {
    for (const release of releases.splice(0)) {
        release();
    }

    await flush();
    vi.restoreAllMocks();
    setLogLevel(previousLogLevel);
});

function packet(): PacketInfo {
    return {
        pid: 1,
        uin: String(SELF),
        serviceCmd: 'test.refresh.fake',
        seqId: 1,
        retCode: 0,
        fromClient: false,
        body: new Uint8Array(),
    };
}

function group(groupId: number): QQGroupInfo {
    return {
        groupId,
        groupName: 'fixture',
        remark: '',
        memberCount: 0,
        memberMax: 500,
        members: new Map(),
    };
}

function admin(groupId = GROUP): QQEventVariant {
    return { kind: 'group_admin', time: 1, selfUin: SELF, groupId, userUin: 22222, set: true };
}

function leave(groupId = GROUP): QQEventVariant {
    return {
        kind: 'group_member_leave',
        time: 1,
        selfUin: SELF,
        groupId,
        userUin: 22222,
        operatorUin: 33333,
        userUid: 'u_member',
        operatorUid: 'u_operator',
        leaveType: 'leave',
    };
}

function join(groupId = GROUP): QQEventVariant {
    return {
        kind: 'group_member_join',
        time: 1,
        selfUin: SELF,
        groupId,
        userUin: 22222,
        operatorUin: 33333,
    };
}

function setup(fetchMember: (groupId: number) => Promise<void> = async () => {}) {
    const identity = IdentityService.memory(String(SELF));
    const events = new BridgeEventBus();
    const captured: QQEventVariant[] = [];
    events.onAny((event) => captured.push(event));
    const fetchGroupList = vi.fn(async () => {});
    const fetchGroupMemberList = vi.fn(fetchMember);
    const pipeline = new IncomingPacketPipeline({
        identity,
        events,
        fetchGroupList,
        fetchGroupMemberList,
        resolveGroupJoinRequest: vi.fn(async () => null),
        groupInvites: new GroupInviteTracker(),
    });
    return { identity, pipeline, captured, fetchGroupList, fetchGroupMemberList };
}

function process(pipeline: IncomingPacketPipeline, event: QQEventVariant): Promise<void> {
    return pipeline.processEvents(packet(), [event]);
}

describe('IncomingPacketPipeline detached member refresh', () => {
    it.each([
        ['leave', leave],
        ['admin', admin],
    ] as const)('retries after a synchronous missing-group %s refresh', async (_kind, event) => {
        const { identity, pipeline, captured, fetchGroupList, fetchGroupMemberList } = setup();
        await process(pipeline, event());
        await flush();
        expect(captured).toHaveLength(1);
        expect(fetchGroupList).not.toHaveBeenCalled();
        expect(fetchGroupMemberList).not.toHaveBeenCalled();

        identity.rememberGroups([group(GROUP)]);
        await process(pipeline, event());
        await flush();
        expect(captured).toHaveLength(2);
        expect(fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(GROUP);
    });

    it('coalesces same-group events while pending, then permits a new refresh', async () => {
        const gate = deferred();
        const { identity, pipeline, captured, fetchGroupMemberList } = setup(() => gate.promise);
        identity.rememberGroups([group(GROUP)]);

        await process(pipeline, leave());
        await process(pipeline, admin());
        await flush();
        expect(captured).toHaveLength(2);
        expect(fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(GROUP);

        gate.resolve();
        await flush();
        await process(pipeline, admin());
        await flush();
        expect(fetchGroupMemberList).toHaveBeenCalledTimes(2);
        expect(fetchGroupMemberList).toHaveBeenLastCalledWith(GROUP);
    });

    it('starts different groups in parallel while each same-group refresh is pending', async () => {
        const first = deferred();
        const second = deferred();
        const { identity, pipeline, fetchGroupMemberList } = setup((id) =>
            id === GROUP ? first.promise : second.promise,
        );
        identity.rememberGroups([group(GROUP), group(OTHER)]);

        await process(pipeline, admin(GROUP));
        await process(pipeline, leave(OTHER));
        await process(pipeline, admin(GROUP));
        await process(pipeline, admin(OTHER));
        expect(fetchGroupMemberList.mock.calls).toEqual([[GROUP], [OTHER]]);

        first.resolve();
        await flush();
        await process(pipeline, admin(GROUP));
        await process(pipeline, admin(OTHER));
        expect(fetchGroupMemberList.mock.calls).toEqual([[GROUP], [OTHER], [GROUP]]);
        second.resolve();
        await flush();
    });

    it.each(['reject', 'throw'] as const)(
        'logs member fetch %s, emits the event and permits a retry',
        async (mode) => {
            const entries: LogEntry[] = [];
            setLogLevel('warn');
            const unsubscribe = subscribeLogs((entry) => entries.push(entry));
            let attempts = 0;
            const { identity, pipeline, captured, fetchGroupMemberList } = setup(() => {
                attempts++;

                if (attempts === 1) {
                    if (mode === 'throw') {
                        throw new Error('fixture member failure');
                    }

                    return Promise.reject(new Error('fixture member failure'));
                }

                return Promise.resolve();
            });
            identity.rememberGroups([group(GROUP)]);

            try {
                await process(pipeline, admin());
                await flush();
                expect(captured).toHaveLength(1);
                expect(entries).toContainEqual(
                    expect.objectContaining({
                        level: 'warn',
                        message: `failed to refresh member cache: group=${GROUP} reason=group_admin err=fixture member failure`,
                    }),
                );
                await process(pipeline, admin());
                await flush();
                expect(fetchGroupMemberList).toHaveBeenCalledTimes(2);
                expect(captured).toHaveLength(2);
            } finally {
                unsubscribe();
            }
        },
    );

    it('reserves before the join findGroup lookup can synchronously reenter', async () => {
        const gate = deferred();
        const { identity, pipeline, captured, fetchGroupMemberList } = setup(() => gate.promise);
        identity.rememberGroups([group(GROUP)]);
        const original = identity.findGroup.bind(identity);
        let nested: Promise<void> | undefined;
        let reentered = false;
        vi.spyOn(identity, 'findGroup').mockImplementation((id) => {
            if (!reentered && id === GROUP) {
                reentered = true;
                nested = process(pipeline, admin());
            }

            return original(id);
        });

        await process(pipeline, join());
        await nested;
        expect(reentered).toBe(true);
        expect(captured).toHaveLength(2);
        expect(fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(GROUP);
        gate.resolve();
        await flush();
        await process(pipeline, admin());
        expect(fetchGroupMemberList).toHaveBeenCalledTimes(2);
    });

    it('reserves before the member fetch can synchronously reenter', async () => {
        const gate = deferred();
        let pipeline!: IncomingPacketPipeline;
        let nested: Promise<void> | undefined;
        let reentered = false;
        const fixture = setup(() => {
            if (!reentered) {
                reentered = true;
                nested = process(pipeline, leave());
            }

            return gate.promise;
        });
        pipeline = fixture.pipeline;
        fixture.identity.rememberGroups([group(GROUP)]);

        await process(pipeline, admin());
        await nested;
        expect(reentered).toBe(true);
        expect(fixture.captured).toHaveLength(2);
        expect(fixture.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(GROUP);
        gate.resolve();
        await flush();
        await process(pipeline, admin());
        expect(fixture.fetchGroupMemberList).toHaveBeenCalledTimes(2);
    });

    it('preserves synchronous join lookup dispatch errors and permits a later retry', async () => {
        const entries: LogEntry[] = [];
        setLogLevel('error');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));
        const { identity, pipeline, captured, fetchGroupMemberList } = setup();
        identity.rememberGroups([group(GROUP)]);
        vi.spyOn(identity, 'findGroup').mockImplementationOnce(() => {
            throw new Error('fixture lookup failure');
        });

        try {
            await process(pipeline, join());
            expect(captured).toHaveLength(0);
            expect(
                entries.some(
                    (entry) =>
                        entry.level === 'error' &&
                        entry.message.includes(
                            'dispatch error for test.refresh.fake event=group_member_join',
                        ) &&
                        entry.message.includes('fixture lookup failure'),
                ),
            ).toBe(true);
            await process(pipeline, admin());
            await flush();
            expect(captured).toHaveLength(1);
            expect(fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(GROUP);
        } finally {
            unsubscribe();
        }
    });
});
