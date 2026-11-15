import { describe, expect, it } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12GroupInfo,
    OneBot12GroupInfoResponse,
    OneBot12JsonValue,
} from '../../src/v12/index.js';
import {
    parseOneBot12ActionResponseJson,
    serializeOneBot12ActionResponse,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Ok = Extract<OneBot12GroupInfoResponse, { status: 'ok' }>;
type Failed = Extract<OneBot12GroupInfoResponse, { status: 'failed' }>;
type Envelope = { retcode: number; message: string };

export type Checks = [
    Assert<IsAssignable<Ok['data'], OneBot12GroupInfo>>,
    Assert<IsAssignable<OneBot12GroupInfo, Ok['data']>>,
    IsFalse<IsAssignable<null, Ok['data']>>,
    IsFalse<IsAssignable<{ group_id: string }, Ok['data']>>,
    IsFalse<IsAssignable<{ group_id: number; group_name: string }, Ok['data']>>,
    IsFalse<IsAssignable<{ group_id: string; group_name: number }, Ok['data']>>,
    Assert<
        IsAssignable<
            Envelope & {
                status: 'ok';
                data: { group_id: string; group_name: string; 'x.extra': { nested: string[] } };
                'x.envelope': boolean;
            },
            OneBot12GroupInfoResponse
        >
    >,
    Assert<IsAssignable<Failed['data'], OneBot12JsonValue>>,
    Assert<IsAssignable<OneBot12JsonValue, Failed['data']>>,
    Assert<IsAssignable<Envelope & { status: 'failed'; data: null }, OneBot12GroupInfoResponse>>,
    Assert<IsAssignable<OneBot12GroupInfoResponse, OneBot12ActionResponse>>,
    IsFalse<IsAssignable<Envelope & { status: 'other'; data: null }, OneBot12GroupInfoResponse>>,
];

const success: OneBot12GroupInfoResponse = {
    status: 'ok',
    retcode: 0,
    data: {
        group_id: 'platform:group-01',
        group_name: 'Example',
        'x.extra': { nested: [true, null, 'value'] },
    },
    message: '',
    'x.envelope': { retained: true },
};
const failure: OneBot12GroupInfoResponse = {
    status: 'failed',
    retcode: 20002,
    data: { reason: 'unavailable', retry: false },
    message: 'unavailable',
};

describe('OneBot 12 group info types and generic response codec', () => {
    it('round trips success and failure envelopes with extensions', () => {
        for (const response of [success, failure]) {
            expect(
                parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response)),
            ).toEqual(response);
        }
    });

    it('does not validate group-specific fields in the generic codec', () => {
        const response = { status: 'ok', retcode: 0, data: { group_id: 42 }, message: '' };
        expect(parseOneBot12ActionResponseJson(serializeOneBot12ActionResponse(response))).toEqual(
            response,
        );
    });
});
