import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbLeaveGroup } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { LeaveGroup } from '../../../src/oidb-services/group-admin/leave-group';

function makeDeps() {
    const r: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.alloc(0),
    };
    return { sendRawPacket: vi.fn(async () => r) };
}

describe('LeaveGroup namespace', () => {
    it('declares 0x1097_1', () => {
        expect(LeaveGroup.command).toBe(0x1097);
        expect(LeaveGroup.subCommand).toBe(1);
    });

    it('routes to 0x1097_1 with groupUin only', async () => {
        const deps = makeDeps();
        await LeaveGroup.invoke(deps, { groupId: 12345 });
        const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
        expect(wire).toBe('OidbSvcTrpcTcp.0x1097_1');
        const env = protobuf_decode<OidbBase<OidbLeaveGroup>>(bytes);
        expect(env.body).toMatchObject({ groupUin: 12345 });
    });

    it.each([
        [1, 1],
        [0xffffffff, 0xffffffff],
        [0x10000002a, 42],
    ])('encodes group %d as uint32 %d with an in-memory sender', async (groupId, expected) => {
        const deps = makeDeps();
        await LeaveGroup.invoke(deps, { groupId });
        expect(deps.sendRawPacket).toHaveBeenCalledTimes(1);
        const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
        expect(wire).toBe('OidbSvcTrpcTcp.0x1097_1');
        expect(protobuf_decode<OidbBase<OidbLeaveGroup>>(bytes).body?.groupUin).toBe(expected);
    });
});
