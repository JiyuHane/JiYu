import { describe, expect, it } from 'vitest';
import type {
    OneBot12MentionAllSegment,
    OneBot12MentionSegment,
    OneBot12Message,
    OneBot12MessageSegment,
    OneBot12OutgoingMessage,
    OneBot12TextSegment,
} from '../../src/v12/index.js';
import {
    parseOneBot12ActionRequest,
    parseOneBot12ActionRequestJson,
    serializeOneBot12ActionRequest,
} from '../../src/v12/protocol.js';

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsFalse<T extends false> = T;

type TextLiteral = Assert<IsAssignable<OneBot12TextSegment['type'], 'text'>>;
type MentionLiteral = Assert<IsAssignable<OneBot12MentionSegment['type'], 'mention'>>;
type MentionAllLiteral = Assert<IsAssignable<OneBot12MentionAllSegment['type'], 'mention_all'>>;
type MissingText = IsFalse<IsAssignable<{ type: 'text'; data: {} }, OneBot12TextSegment>>;
type NumericText = IsFalse<
    IsAssignable<{ type: 'text'; data: { text: number } }, OneBot12TextSegment>
>;
type NumericUser = IsFalse<
    IsAssignable<{ type: 'mention'; data: { user_id: number } }, OneBot12MentionSegment>
>;
type WrongMentionType = IsFalse<
    IsAssignable<{ type: 'other'; data: { user_id: string } }, OneBot12MentionSegment>
>;
export type Checks = [
    TextLiteral,
    MentionLiteral,
    MentionAllLiteral,
    MissingText,
    NumericText,
    NumericUser,
    WrongMentionType,
];

const text: OneBot12TextSegment = { type: 'text', data: { text: 'Hello ' } };
const mention: OneBot12MentionSegment = { type: 'mention', data: { user_id: '42' } };
const mentionAll: OneBot12MentionAllSegment = { type: 'mention_all', data: {} };
const extension: OneBot12MessageSegment = {
    type: 'vendor.segment',
    data: { nested: [true, null, 'value'] },
};
const message: OneBot12Message = [text, mention, mentionAll, extension];
const outgoing: OneBot12OutgoingMessage[] = [message, text, 'plain text'];
const genericIdentifier: OneBot12MentionSegment = {
    type: 'mention',
    data: { user_id: 'platform:user-01', 'x.extension': true },
};
const extendedAll: OneBot12MentionAllSegment = {
    type: 'mention_all',
    data: { 'x.extension': 'retained' },
};

describe('OneBot 12 structured mention types and codec', () => {
    it('round trips a group message mixed with a generic extension segment', () => {
        const request = {
            action: 'send_message',
            params: { detail_type: 'group', group_id: '123', message },
            echo: 'fixture',
        };
        const wire = serializeOneBot12ActionRequest(request);
        expect(parseOneBot12ActionRequest(request)).toEqual(request);
        expect(parseOneBot12ActionRequestJson(wire)).toEqual(request);
        expect(JSON.parse(wire)).toEqual(request);
    });

    it('preserves generic identifiers and extension data without server validation', () => {
        const request = {
            action: 'send_message',
            params: { message: [genericIdentifier, extendedAll] },
        };
        expect(parseOneBot12ActionRequestJson(serializeOneBot12ActionRequest(request))).toEqual(
            request,
        );
        expect(outgoing).toEqual([message, text, 'plain text']);
    });
});
