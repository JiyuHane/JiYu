import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs } from '@snowluma/common/logger';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { MarkdownData } from '@snowluma/proto-defs/action';
import type { Elem, InlineKeyboardExtra } from '@snowluma/proto-defs/element';
import type { MessageElement } from '../../src/events';
import { decodeRichBody } from '../../src/msg-push/rich-body-decoder';

// Fixtures are synthetic. Size counts the UTF-8 bytes that inflate produces,
// not JavaScript code units; the non-ASCII sentinel makes that distinction visible.
const MIB = 1024 * 1024;
const CARD_BYTES = 4 * MIB;
const MESSAGE_BYTES = 8 * MIB;
const ACCOUNT = 123456789n;

function sizedJson(tag: string, bytes: number): string {
    const prefix = `{"tag":"${tag}","text":"雪`;
    const suffix = '"}';
    const padding = bytes - Buffer.byteLength(prefix + suffix, 'utf8');

    if (padding < 0) {
        throw new Error('fixture size is too small');
    }

    const json = prefix + 'x'.repeat(padding) + suffix;
    expect(Buffer.byteLength(json, 'utf8')).toBe(bytes);
    return json;
}

function compressed(text: string): Uint8Array {
    return Buffer.concat([Buffer.from([1]), deflateSync(Buffer.from(text, 'utf8'))]);
}

function light(text: string): Elem {
    return { lightApp: { data: compressed(text) } };
}

function rich(text: string): Elem {
    return { richMsg: { serviceId: 1, template1: compressed(text) } };
}

function quote(seq: number, elems: Elem[]): Elem {
    return {
        srcMsg: {
            origSeqs: [seq],
            senderUin: ACCOUNT,
            time: 12345,
            elemsRaw: elems.map((elem) => protobuf_encode<Elem>(elem)),
        },
    };
}

function decode(elems: Elem[]): MessageElement[] {
    // Round-trip root elements too. Each nested srcMsg.elemsRaw is separately
    // encoded as a genuine Elem and decoded by production's recursive path.
    const wire = elems.map((elem) => protobuf_decode<Elem>(protobuf_encode<Elem>(elem)));
    return decodeRichBody({ richText: { elems: wire } }, true);
}

function reply(elements: MessageElement[], seq: number): MessageElement[] {
    const found = elements.find((element) => element.type === 'reply' && element.replySeq === seq);
    expect(found?.type).toBe('reply');

    if (!found || found.type !== 'reply' || !found.replyElements) {
        throw new Error(`missing synthetic reply ${seq}`);
    }

    return found.replyElements;
}

function expectJson(element: MessageElement | undefined, original: string): void {
    expect(element?.type).toBe('json');

    if (!element || element.type !== 'json') {
        throw new Error('missing decoded json');
    }

    expect(Buffer.byteLength(element.text, 'utf8')).toBe(Buffer.byteLength(original, 'utf8'));
    expect(element.text.slice(0, 80)).toBe(original.slice(0, 80));
    expect(element.text.slice(-24)).toBe(original.slice(-24));
    const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    expect(digest(element.text)).toBe(digest(original));
}

function captureLogs<T>(operation: () => T): {
    value: T;
    logs: Array<{ level: string; scope: string; message: string }>;
} {
    const previousLevel = getLogLevel();
    const logs: Array<{ level: string; scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => logs.push(entry));

    try {
        return { value: operation(), logs };
    } finally {
        unsubscribe();
        setLogLevel(previousLevel);
    }
}

function cardErrors(
    logs: Array<{ level: string; scope: string; message: string }>,
    reason: string,
) {
    return logs.filter(
        (entry) =>
            entry.scope === 'MsgPush.UnknownElement' &&
            entry.level === 'debug' &&
            entry.message.includes(`reason=${reason}`) &&
            entry.message.includes('card ignored'),
    );
}

describe('decodeRichBody synthetic nested card message budget', () => {
    it('shares exact 8 MiB across root, nested and sibling quotes; the next card is ignored', () => {
        const root = sizedJson('root', CARD_BYTES);
        const child = sizedJson('child', CARD_BYTES - 128);
        const sibling = sizedJson('sibling', 128);
        const rejected = sizedJson('private-synthetic-card', 64);
        const rejectedBytes = compressed(rejected);
        const { value, logs } = captureLogs(() =>
            decode([
                light(root),
                quote(1, [quote(2, [rich(child)])]),
                quote(3, [
                    light(sibling),
                    { lightApp: { data: rejectedBytes } },
                    { text: { str: 'sibling fallback' } },
                ]),
                quote(4, [light(rejected), { text: { str: 'last fallback' } }]),
            ]),
        );
        expect(CARD_BYTES + (CARD_BYTES - 128) + 128).toBe(MESSAGE_BYTES);
        expectJson(
            value.find((element) => element.type === 'json'),
            root,
        );
        expectJson(reply(reply(value, 1), 2)[0], child);
        const siblingOutput = reply(value, 3);
        expect(siblingOutput.map((element) => element.type)).toEqual(['json']);
        expectJson(siblingOutput[0], sibling);
        expect(reply(value, 4)).toEqual([{ type: 'text', text: 'last fallback' }]);
        const errors = cardErrors(logs, 'message_output_budget_exceeded');
        expect(errors).toHaveLength(2);
        expect(errors[0].message).toBe(
            `wire light card ignored inputBytes=${rejectedBytes.length} reason=message_output_budget_exceeded`,
        );
        expect(errors[1].message).toBe(errors[0].message);
        expect(JSON.stringify(logs)).not.toContain('private-synthetic-card');
        expect(JSON.stringify(logs)).not.toContain(String(ACCOUNT));
    });

    it('accepts both 4 MiB cards exactly, but rejects an additional card and charges each root independently', () => {
        const first = sizedJson('first', CARD_BYTES);
        const second = sizedJson('second', CARD_BYTES);
        const small = '{"tag":"extra"}';
        const elems = [light(first), quote(10, [rich(second)]), quote(11, [light(small)])];
        const { value: firstOutput, logs } = captureLogs(() => decode(elems));
        expectJson(firstOutput[0], first);
        expectJson(reply(firstOutput, 10)[0], second);
        expect(reply(firstOutput, 11)).toEqual([]);
        expect(cardErrors(logs, 'message_output_budget_exceeded')).toHaveLength(1);
        const secondOutput = decode([quote(12, [light(small)])]);
        expectJson(reply(secondOutput, 12)[0], small);
    });

    it('isolates a reentrant decode started by the exhausted-card debug subscriber', () => {
        const big = sizedJson('reentrant', CARD_BYTES);
        const bigCard = light(big);
        let entered = false;
        let reentrant: MessageElement[] | undefined;
        const { value, logs } = captureLogs(() => {
            const unsubscribe = subscribeLogs((entry) => {
                if (!entered && entry.message.includes('reason=message_output_budget_exceeded')) {
                    entered = true;
                    reentrant = decode([bigCard, rich(big)]);
                }
            });

            try {
                return decode([bigCard, rich(big), light('{}')]);
            } finally {
                unsubscribe();
            }
        });
        expect(entered).toBe(true);
        expect(value).toHaveLength(2);
        expect(reentrant).toHaveLength(2);
        expectJson(reentrant?.[0], big);
        expectJson(reentrant?.[1], big);
        expect(cardErrors(logs, 'message_output_budget_exceeded')).toHaveLength(1);

        const ordinary = captureLogs(() => decode([{ text: { str: 'plain synthetic text' } }]));
        expect(ordinary.value).toEqual([{ type: 'text', text: 'plain synthetic text' }]);
        expect(cardErrors(ordinary.logs, 'message_output_budget_exceeded')).toHaveLength(0);
    });

    it('prescans all root cards before a quoted element that appears earlier', () => {
        const rootFirst = sizedJson('root-first', CARD_BYTES);
        const rootLast = sizedJson('root-last', CARD_BYTES - 48);
        const childTooLarge = sizedJson('child-49', 49);
        const childFits = sizedJson('child-48', 48);
        // The first rejected card consumes the remaining allowance, so use a
        // separate call to show a 48-byte nested card fits the exact remainder.
        const { value, logs } = captureLogs(() =>
            decode([light(rootFirst), quote(20, [light(childTooLarge)]), rich(rootLast)]),
        );
        expectJson(value[0], rootFirst);
        expectJson(value[2], rootLast);
        expect(reply(value, 20)).toEqual([]);
        expect(cardErrors(logs, 'message_output_budget_exceeded')).toHaveLength(1);
        const fitting = decode([light(rootFirst), quote(21, [light(childFits)]), rich(rootLast)]);
        expectJson(reply(fitting, 21)[0], childFits);
    });

    it('charges rich before light when both occur on the same element', () => {
        const first = sizedJson('large-a', CARD_BYTES);
        const second = sizedJson('large-b', CARD_BYTES - 64);
        const richFirst = sizedJson('rich-priority', 64);
        const lightSecond = sizedJson('light-later', 64);
        const { value, logs } = captureLogs(() =>
            decode([
                light(first),
                rich(second),
                quote(30, [
                    {
                        richMsg: { serviceId: 1, template1: compressed(richFirst) },
                        lightApp: { data: compressed(lightSecond) },
                    },
                ]),
            ]),
        );
        const nested = reply(value, 30);
        expect(nested).toHaveLength(1);
        expectJson(nested[0], richFirst);
        expect(cardErrors(logs, 'message_output_budget_exceeded')).toHaveLength(1);
        expect(cardErrors(logs, 'message_output_budget_exceeded')[0].message).toContain(
            'wire light card ignored',
        );
    });

    it('charges successfully inflated invalid JSON, while malformed zlib consumes zero', () => {
        const first = sizedJson('charged-first', CARD_BYTES);
        const invalid = 'x'.repeat(CARD_BYTES - 2);
        const malformed = Uint8Array.of(1, 0x78, 0x9c, 0xff);
        const { value, logs } = captureLogs(() =>
            decode([
                light(first),
                quote(40, [{ lightApp: { data: compressed(invalid) } }]),
                quote(41, [{ lightApp: { data: malformed } }, light('{}')]),
            ]),
        );
        expect(reply(value, 40)).toEqual([]);
        expectJson(reply(value, 41)[0], '{}');
        expect(cardErrors(logs, 'invalid_json')).toHaveLength(1);
        expect(cardErrors(logs, 'inflate_failed:Z_DATA_ERROR')).toHaveLength(1);
        expect(cardErrors(logs, 'message_output_budget_exceeded')).toHaveLength(0);
    });

    it('keeps non-card elements and applies compatibility fallback per level', () => {
        const first = sizedJson('budget-a', CARD_BYTES);
        const second = sizedJson('budget-b', CARD_BYTES);
        const markdown = protobuf_encode<MarkdownData>({ content: '# synthetic markdown' });
        const keyboard = protobuf_encode<InlineKeyboardExtra>({
            keyboard: { botAppid: 42n, rows: [] },
        });
        const failure = light('{"tag":"no-budget"}');
        const { value, logs } = captureLogs(() =>
            decode([
                light(first),
                rich(second),
                quote(50, [
                    failure,
                    { text: { str: 'readable fallback' } },
                    { face: { index: 7 } },
                    { commonElem: { serviceType: 46, businessType: 1, pbElem: keyboard } },
                    quote(51, [{ text: { str: 'nested reply text' } }]),
                ]),
                quote(52, [
                    failure,
                    { text: { str: 'suppressed by markdown' } },
                    { commonElem: { serviceType: 45, businessType: 1, pbElem: markdown } },
                ]),
            ]),
        );
        const plain = reply(value, 50);
        expect(plain.map((element) => element.type)).toEqual([
            'text',
            'face',
            'inline_keyboard',
            'reply',
        ]);
        expect(plain[0]).toEqual({ type: 'text', text: 'readable fallback' });
        expect(plain[1]).toEqual({ type: 'face', faceId: 7 });
        expect(plain[2]).toMatchObject({ type: 'inline_keyboard', botAppid: '42', rows: [] });
        expect(reply(plain, 51)).toEqual([{ type: 'text', text: 'nested reply text' }]);
        expect(reply(value, 52)).toEqual([{ type: 'markdown', text: '# synthetic markdown' }]);
        expect(cardErrors(logs, 'message_output_budget_exceeded')).toHaveLength(2);
    });

    it('retains cards beyond sixteen levels of real quote elements', () => {
        const payload = '{"tag":"deep-synthetic"}';
        let nested: Elem = light(payload);

        for (let seq = 80; seq >= 61; seq--) {
            nested = quote(seq, [nested]);
        }

        let elements = decode([nested]);

        for (let seq = 61; seq <= 80; seq++) {
            elements = reply(elements, seq);
        }

        expectJson(elements[0], payload);
    });

    it('preserves raw marker and unmarked cards, and the independent 4 MiB single-card limit', () => {
        const raw = '{"tag":"raw-雪"}';
        const unmarked = '{"tag":"unmarked"}';
        const tooBig = sizedJson('single-too-big', CARD_BYTES + 1);
        const { value, logs } = captureLogs(() =>
            decode([
                { lightApp: { data: Buffer.concat([Buffer.from([0]), Buffer.from(raw)]) } },
                { richMsg: { serviceId: 1, template1: Buffer.from(unmarked) } },
                quote(60, [light(tooBig), { text: { str: 'single-card fallback' } }]),
            ]),
        );
        expectJson(value[0], raw);
        expectJson(value[1], unmarked);
        expect(reply(value, 60)).toEqual([{ type: 'text', text: 'single-card fallback' }]);
        expect(cardErrors(logs, 'output_limit_exceeded')).toHaveLength(1);
    });
});
