import { describe, expect, it } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12FriendListResponse,
    OneBot12JsonObject,
    OneBot12JsonValue,
    OneBot12UserInfo,
} from '../../src/v12/index.js';
import {
    parseOneBot12ActionResponseJson,
    serializeOneBot12ActionResponse,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Fields = 'user_id' | 'user_name' | 'user_displayname' | 'user_remark';
type Shape = { user_id: string; user_name: string; user_displayname: string; user_remark: string };
type Missing<K extends Fields> = IsAssignable<Omit<Shape, K>, OneBot12UserInfo>;
type Numeric<K extends Fields> = IsAssignable<Omit<Shape, K> & Record<K, number>, OneBot12UserInfo>;
type Ok = Extract<OneBot12FriendListResponse, { status: 'ok' }>;
type Failed = Extract<OneBot12FriendListResponse, { status: 'failed' }>;

export type Checks = [
    Assert<IsAssignable<OneBot12UserInfo, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12UserInfo[Fields], string>>,
    IsFalse<Missing<'user_id'>>,
    IsFalse<Missing<'user_name'>>,
    IsFalse<Missing<'user_displayname'>>,
    IsFalse<Missing<'user_remark'>>,
    IsFalse<Numeric<'user_id'>>,
    IsFalse<Numeric<'user_name'>>,
    IsFalse<Numeric<'user_displayname'>>,
    IsFalse<Numeric<'user_remark'>>,
    Assert<IsAssignable<Ok['data'], OneBot12UserInfo[]>>,
    IsFalse<IsAssignable<null, Ok['data']>>,
    Assert<IsAssignable<Failed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, Failed['data']>>,
    Assert<IsAssignable<OneBot12FriendListResponse, OneBot12ActionResponse>>,
    IsFalse<
        IsAssignable<
            { status: 'other'; retcode: number; data: null; message: string },
            OneBot12FriendListResponse
        >
    >,
];

const user: OneBot12UserInfo = {
    user_id: 'platform:user-01',
    user_name: 'Example',
    user_displayname: '',
    user_remark: '',
    'x.profile': { nested: [true, null, 'value'] },
};
const success: OneBot12FriendListResponse = {
    status: 'ok',
    retcode: 0,
    data: [user],
    message: '',
    'x.envelope': { retained: true },
};
const failure: OneBot12FriendListResponse = {
    status: 'failed',
    retcode: 20002,
    data: { reason: 'unavailable' },
    message: 'unavailable',
};

describe('OneBot 12 friend list types and generic response codec', () => {
    it('round trips success and failure envelopes with extensions', () => {
        for (const response of [success, failure]) {
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });

    it('does not validate friend-specific fields in the generic codec', () => {
        const response = { status: 'ok', retcode: 0, data: [{ user_id: 42 }], message: '' };
        expect(parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response))).toEqual(
            response,
        );
    });
});
