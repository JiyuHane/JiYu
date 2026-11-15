import { describe, expect, it } from 'vitest';
import {
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12Event,
} from '../../src/v12/index.js';

const event = {
    id: 'fixture-private',
    time: 1700000000,
    type: 'message',
    detail_type: 'private',
    sub_type: '',
    self: { platform: 'qq', user_id: '10001' },
    message_id: '-123',
    user_id: '42',
    message: [{ type: 'text', data: { text: 'hi' } }],
    alt_message: 'hi',
    'x.fixture': { untouched: ['original', true] },
};

describe('SDK QQ auto-reply extension transport', () => {
    it('preserves the true own extension and every other JSON field', () => {
        const input = { ...event, 'qq.auto_reply': true };
        const original = structuredClone(input);
        const parsed = parseOneBot12Event(input);
        expect(parsed).toEqual(original);
        expect(Object.hasOwn(parsed, 'qq.auto_reply')).toBe(true);
        expect(parseOneBot12EventJson(serializeOneBot12Event(parsed))).toEqual(original);
        expect(input).toEqual(original);
        expect(parsed).not.toBe(input);
        expect(parsed['x.fixture']).not.toBe(input['x.fixture']);
    });

    it('preserves absence', () => {
        const parsed = parseOneBot12EventJson(JSON.stringify(event));
        expect(parsed).toEqual(event);
        expect(Object.hasOwn(parsed, 'qq.auto_reply')).toBe(false);
    });

    it.each([false, 0, 1, 'true', null, { unexpected: true }])(
        'preserves arbitrary JSON extension value %j without interpreting it',
        (value) => {
            const input = { ...event, 'qq.auto_reply': value };
            expect(parseOneBot12EventJson(serializeOneBot12Event(input))).toEqual(input);
        },
    );
});
