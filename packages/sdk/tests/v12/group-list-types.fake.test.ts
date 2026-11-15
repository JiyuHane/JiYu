import { describe, expect, it } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12GroupInfo,
    OneBot12GroupListResponse,
    OneBot12JsonObject,
    OneBot12JsonValue,
} from '../../src/v12/index.js';
import {
    parseOneBot12ActionResponseJson,
    serializeOneBot12ActionResponse,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Fields = 'group_id' | 'group_name';
type Shape = { group_id: string; group_name: string };
type Missing<K extends Fields> = IsAssignable<Omit<Shape, K>, OneBot12GroupInfo>;
type Numeric<K extends Fields> = IsAssignable<
    Omit<Shape, K> & Record<K, number>,
    OneBot12GroupInfo
>;
type Ok = Extract<OneBot12GroupListResponse, { status: 'ok' }>;
type Failed = Extract<OneBot12GroupListResponse, { status: 'failed' }>;

export type Checks = [
    Assert<IsAssignable<OneBot12GroupInfo, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12GroupInfo['group_id'], string>>,
    Assert<IsAssignable<OneBot12GroupInfo['group_name'], string>>,
    IsFalse<Missing<'group_id'>>,
    IsFalse<Missing<'group_name'>>,
    IsFalse<Numeric<'group_id'>>,
    IsFalse<Numeric<'group_name'>>,
    Assert<IsAssignable<Shape & { 'x.extra': { nested: string[] } }, OneBot12GroupInfo>>,
    Assert<IsAssignable<Ok['data'], OneBot12GroupInfo[]>>,
    IsFalse<IsAssignable<null, Ok['data']>>,
    Assert<IsAssignable<Failed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, Failed['data']>>,
    Assert<IsAssignable<OneBot12GroupListResponse, OneBot12ActionResponse>>,
    IsFalse<
        IsAssignable<
            { status: 'other'; retcode: number; data: null; message: string },
            OneBot12GroupListResponse
        >
    >,
];

const group: OneBot12GroupInfo = {
    group_id: 'platform:group-01',
    group_name: 'Example',
    'x.extra': { nested: [true, null, 'value'] },
};
const success: OneBot12GroupListResponse = {
    status: 'ok',
    retcode: 0,
    data: [group],
    message: '',
    'x.envelope': { retained: true },
};
const failure: OneBot12GroupListResponse = {
    status: 'failed',
    retcode: 20002,
    data: { reason: 'unavailable', retry: false },
    message: 'unavailable',
};

describe('OneBot 12 group list types and generic response codec', () => {
    it('round trips success and failure envelopes with extensions', () => {
        for (const response of [success, failure]) {
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });

    it('does not validate group-specific fields in the generic codec', () => {
        const response = { status: 'ok', retcode: 0, data: [{ group_id: 42 }], message: '' };
        expect(parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response))).toEqual(
            response,
        );
    });
});
