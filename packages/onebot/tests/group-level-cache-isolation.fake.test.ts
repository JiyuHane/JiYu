import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { getGroupInfo } from '../src/modules/contact-actions';

function fixture(uin: string, initialLevel: number) {
    let level = initialLevel;
    const findGroup = vi.fn((groupId: number) => ({
        groupId,
        groupName: 'fixture',
        remark: '',
        memberCount: 1,
        memberMax: 500,
    }));
    const fetchGroupList = vi.fn(async () => []);
    const fetchGroupDetail = vi.fn(async (_groupId: number) => ({ level }));
    const bridge = {
        identity: { uin, findGroup },
        apis: { contacts: { fetchGroupList, fetchGroupDetail } },
    } as unknown as BridgeInterface;
    return {
        bridge,
        findGroup,
        fetchGroupList,
        fetchGroupDetail,
        setLevel(value: number) {
            level = value;
        },
    };
}

describe('joined group level cache session isolation', () => {
    it('fetches for each bridge, reuses only its own entry, and refreshes independently', async () => {
        const groupId = 81001;
        const a = fixture('fixture-a', 4);
        const b = fixture('fixture-b', 9);

        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
        expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 9 });
        expect(a.fetchGroupDetail).toHaveBeenCalledExactlyOnceWith(groupId);
        expect(b.fetchGroupDetail).toHaveBeenCalledExactlyOnceWith(groupId);
        expect(a.findGroup).toHaveBeenCalledWith(groupId);
        expect(b.findGroup).toHaveBeenCalledWith(groupId);

        a.setLevel(5);
        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
        expect(a.fetchGroupDetail).toHaveBeenCalledOnce();
        expect(await getGroupInfo(a.bridge, groupId, true)).toMatchObject({ group_level: 5 });
        expect(a.fetchGroupList).toHaveBeenCalledOnce();
        expect(a.fetchGroupDetail).toHaveBeenCalledTimes(2);
        expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 9 });
        expect(b.fetchGroupDetail).toHaveBeenCalledOnce();
    });

    it('keeps distinct sessions separate even when their uin is identical', async () => {
        const groupId = 81002;
        const a = fixture('same-fixture', 4);
        const b = fixture('same-fixture', 9);
        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
        expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 9 });
        expect(b.fetchGroupDetail).toHaveBeenCalledExactlyOnceWith(groupId);
    });

    it('expires each session cache at five minutes', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

        try {
            const groupId = 81003;
            const a = fixture('fixture-a', 4);
            const b = fixture('fixture-b', 9);
            expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
            now.mockReturnValue(1_000_001);
            expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 9 });
            a.setLevel(5);
            b.setLevel(10);
            now.mockReturnValue(1_299_999);
            expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
            now.mockReturnValue(1_300_000);
            expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 5 });
            expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 9 });
            now.mockReturnValue(1_300_001);
            expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 10 });
            expect(a.fetchGroupDetail).toHaveBeenCalledTimes(2);
            expect(b.fetchGroupDetail).toHaveBeenCalledTimes(2);
        } finally {
            now.mockRestore();
        }
    });

    it('retains concurrent misses for different groups of the same session', async () => {
        const a = fixture('fixture-a', 4);
        let finishFirst!: (value: { level: number }) => void;
        let finishSecond!: (value: { level: number }) => void;
        const first = new Promise<{ level: number }>((resolve) => {
            finishFirst = resolve;
        });
        const second = new Promise<{ level: number }>((resolve) => {
            finishSecond = resolve;
        });
        a.fetchGroupDetail.mockImplementation((groupId) => (groupId === 81004 ? first : second));
        const resultFirst = getGroupInfo(a.bridge, 81004);
        const resultSecond = getGroupInfo(a.bridge, 81005);
        finishSecond({ level: 9 });
        expect(await resultSecond).toMatchObject({ group_level: 9 });
        finishFirst({ level: 4 });
        expect(await resultFirst).toMatchObject({ group_level: 4 });
        expect(await getGroupInfo(a.bridge, 81004)).toMatchObject({ group_level: 4 });
        expect(await getGroupInfo(a.bridge, 81005)).toMatchObject({ group_level: 9 });
        expect(a.fetchGroupDetail).toHaveBeenCalledTimes(2);
    });

    it('isolates detail and list refresh failures for the same group', async () => {
        const groupId = 81008;
        const a = fixture('fixture-a', 4);
        const b = fixture('fixture-b', 9);
        const detailFailure = new Error('synthetic detail failure');
        const listFailure = new Error('synthetic list failure');

        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
        b.fetchGroupDetail.mockRejectedValueOnce(detailFailure);
        expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 0 });
        expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 9 });
        expect(b.fetchGroupDetail).toHaveBeenCalledTimes(2);
        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
        expect(a.fetchGroupDetail).toHaveBeenCalledOnce();

        b.fetchGroupList.mockRejectedValueOnce(listFailure);
        await expect(getGroupInfo(b.bridge, groupId, true)).rejects.toBe(listFailure);
        expect(b.fetchGroupDetail).toHaveBeenCalledTimes(2);
        expect(await getGroupInfo(b.bridge, groupId)).toMatchObject({ group_level: 9 });
        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 4 });
        expect(a.fetchGroupDetail).toHaveBeenCalledOnce();
        expect(b.fetchGroupDetail).toHaveBeenCalledTimes(2);
    });

    it('preserves nullish detail caching and refresh failure behavior', async () => {
        const a = fixture('fixture-a', 4);
        const groupId = 81006;
        a.fetchGroupDetail.mockResolvedValueOnce(undefined as unknown as { level: number });
        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 0 });
        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 0 });
        expect(a.fetchGroupDetail).toHaveBeenCalledOnce();
        const failure = new Error('synthetic permission failure');
        a.fetchGroupDetail.mockRejectedValueOnce(failure);
        await expect(getGroupInfo(a.bridge, groupId, true)).rejects.toBe(failure);
        expect(await getGroupInfo(a.bridge, groupId)).toMatchObject({ group_level: 0 });
        const b = fixture('fixture-b', 9);
        b.fetchGroupDetail.mockRejectedValueOnce(failure);
        expect(await getGroupInfo(b.bridge, 81007)).toMatchObject({ group_level: 0 });
        expect(await getGroupInfo(b.bridge, 81007)).toMatchObject({ group_level: 9 });
        expect(b.fetchGroupDetail).toHaveBeenCalledTimes(2);
    });
});
