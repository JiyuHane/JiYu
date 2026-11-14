import { describe, expect, it } from 'vitest';
import { convertEvent } from '../../src/event-converter';
import { convertV11Event } from '../../src/v12/events';

const self = { platform: 'qq', user_id: '10001' };
const context = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: null,
    mediaSegmentSink: null,
};
const leave = {
    time: 1700000000.5,
    self_id: 10001,
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: 'leave',
    group_id: 43,
    user_id: 42,
    operator_id: 42,
};

describe('v11 group decrease to v12 member decrease', () => {
    it('maps real v11 converter output from a synthetic protocol event without mutation', async () => {
        const v11 = await convertEvent(context, {
            kind: 'group_member_leave',
            time: 1700000000.5,
            selfUin: 10001,
            groupId: 43,
            userUin: 42,
            operatorUin: 42,
            leaveType: 'leave',
        });
        expect(v11).toEqual(leave);
        const before = structuredClone(v11);
        const result = convertV11Event(v11, self);
        expect(result).toEqual({
            id: expect.any(String),
            time: 1700000000.5,
            type: 'notice',
            detail_type: 'group_member_decrease',
            sub_type: '',
            self,
            group_id: '43',
            user_id: '42',
            operator_id: '42',
        });
        expect(result!.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(convertV11Event(v11, self)!.id).not.toBe(result!.id);
        expect(v11).toEqual(before);
    });

    it('uses the converter context account rather than synthetic protocol selfUin', async () => {
        // This fixture demonstrates converter provenance, not a real QQ observation.
        const v11 = await convertEvent(
            { ...context, selfId: 100 },
            {
                kind: 'group_member_leave',
                time: 1,
                selfUin: 200,
                groupId: 300,
                userUin: 400,
                operatorUin: 500,
                leaveType: 'leave',
            },
        );
        expect(v11).toMatchObject({
            self_id: 100,
            group_id: 300,
            user_id: 400,
            operator_id: 500,
        });
        expect(convertV11Event(v11, { platform: 'qq', user_id: '100' })).toMatchObject({
            self: { platform: 'qq', user_id: '100' },
            group_id: '300',
            user_id: '400',
            operator_id: '500',
            sub_type: '',
        });
        expect(() => convertV11Event(v11, { platform: 'qq', user_id: '200' })).toThrow();
    });

    it('retains four distinct identity roles from a JSON-shaped v11 event', () => {
        const input = JSON.parse(
            '{"time":1,"self_id":100,"post_type":"notice","notice_type":"group_decrease",' +
                '"sub_type":"leave","group_id":300,"user_id":400,"operator_id":500}',
        ) as unknown;
        expect(convertV11Event(input, { platform: 'qq', user_id: '100' })).toMatchObject({
            self: { platform: 'qq', user_id: '100' },
            group_id: '300',
            user_id: '400',
            operator_id: '500',
            sub_type: '',
        });
    });

    it('preserves distinct operator and member values without inferring provenance', () => {
        const input = { ...leave, operator_id: '44', user_id: '42', self_id: '10001', time: 0 };
        const before = structuredClone(input);
        expect(convertV11Event(input, self)).toMatchObject({
            time: 0,
            self,
            sub_type: '',
            user_id: '42',
            operator_id: '44',
        });
        expect(input).toEqual(before);
        expect(
            convertV11Event({ ...leave, user_id: 10001, operator_id: 10001 }, self),
        ).toMatchObject({
            user_id: '10001',
            operator_id: '10001',
            sub_type: '',
        });
    });

    it('accepts canonical positive safe account IDs as numbers or strings', () => {
        for (const value of [1, '1', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
            expect(
                convertV11Event(
                    { ...leave, group_id: value, user_id: value, operator_id: value },
                    self,
                ),
            ).toMatchObject({
                group_id: String(value),
                user_id: String(value),
                operator_id: String(value),
            });
        }
    });

    it('rejects missing, unresolved, invalid and noncanonical actor or group IDs', () => {
        const invalid = [
            undefined,
            null,
            0,
            '0',
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
        ];

        for (const field of ['group_id', 'user_id', 'operator_id'] as const) {
            for (const value of invalid) {
                expect(() => convertV11Event({ ...leave, [field]: value }, self)).toThrow(
                    'invalid or unsupported V11 group decrease event',
                );
            }
        }
    });

    it('rejects invalid times, account mismatches and unknown fields', () => {
        for (const time of [undefined, null, -1, NaN, Infinity, -Infinity, '1']) {
            expect(() => convertV11Event({ ...leave, time }, self)).toThrow();
        }

        for (const self_id of [undefined, null, 0, '010001', 10002, '10002', 1e20]) {
            expect(() => convertV11Event({ ...leave, self_id }, self)).toThrow();
        }

        expect(() => convertV11Event(leave, { ...self, user_id: '010001' })).toThrow();
        expect(() => convertV11Event(leave, { ...self, user_id: '10002' })).toThrow();
        expect(() => convertV11Event({ ...leave, extra: false }, self)).toThrow();
        expect(() => convertV11Event({ ...leave, [Symbol('extra')]: 1 }, self)).toThrow();
    });

    it.each(['kick', 'kick_me'] as const)('maps %s to the complete v12 event', (sub_type) => {
        const input = { ...leave, sub_type };
        const before = structuredClone(input);
        expect(convertV11Event(input, self)).toEqual({
            id: expect.any(String),
            time: 1700000000.5,
            type: 'notice',
            detail_type: 'group_member_decrease',
            sub_type: '',
            self,
            group_id: '43',
            user_id: '42',
            operator_id: '42',
        });
        expect(input).toEqual(before);
    });

    it('returns null for unsupported and unknown decrease subtypes', () => {
        for (const sub_type of ['disband', '', 'future', undefined, null, 0]) {
            expect(convertV11Event({ ...leave, sub_type }, self)).toBeNull();
        }

        expect(() =>
            convertV11Event({ ...leave, self_id: 10002, sub_type: 'disband' }, self),
        ).toThrow();
    });
});
