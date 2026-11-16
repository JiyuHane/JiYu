import type { PushMsg } from '@snowluma/proto-defs/message';
import type { GroupSpecialTitleChange, NotifyMessageBody } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

import { IdentityService } from '../../src/identity-service';
import { MSG_PUSH_CMD, parseDirectMsgPushOrThrow } from '../../src/msg-push';

// Synthetic values only; the parser and Proton codecs are the production implementations.
const SELF = '2000000001';
const OTHER_SELF = '2000000002';
const GROUP = 70001;
const MEMBER = 80001;
const TIME = 1700000123;
type DirectInput = Parameters<typeof parseDirectMsgPushOrThrow>[0];

function input(tipText: string, uin = SELF): DirectInput {
    const eventParam = protobuf_encode<GroupSpecialTitleChange>({ tipText, memberUin: MEMBER });
    const notify = protobuf_encode<NotifyMessageBody>({ groupUin: GROUP, eventParam, field13: 6 });
    // The subtype-16 decoder skips this seven-byte transport prefix.
    const content = new Uint8Array(7 + notify.length);
    content.set(notify, 7);
    const body = protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: GROUP },
            contentHead: { msgType: 732, subType: 16, sequence: 71, timestamp: TIME, msgId: 72 },
            body: { msgContent: content },
        },
    });
    return { uin, sequence: 91, command: MSG_PUSH_CMD, retCode: 0, body };
}

function token(value: unknown): string {
    return `<${JSON.stringify(value)}>`;
}

function parseUnchanged(value: DirectInput, identity: IdentityService) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const originalBody = value.body;
    const originalBytes = Uint8Array.from(originalBody);
    const events = parseDirectMsgPushOrThrow(value, identity);
    expect(Object.getOwnPropertyDescriptors(value)).toEqual(descriptors);
    expect(value.body).toBe(originalBody);
    expect(value.body).toEqual(originalBytes);
    return events;
}

async function withIdentity(run: (identity: IdentityService) => void): Promise<void> {
    const identity = IdentityService.memory(SELF);

    try {
        await identity.initialization;
        run(identity);
    } finally {
        await identity.close();
    }
}

describe('direct synthetic group title push', () => {
    it('decodes ordinary JSON text and carries the account, group and timestamp', async () => {
        await withIdentity((identity) => {
            // Explicit wire assertion: NotifyMessageBody field 13, varint 6.
            expect(protobuf_encode<NotifyMessageBody>({ field13: 6 })).toEqual(
                Uint8Array.of(0x68, 0x06),
            );
            const tip = `恭喜${token({ text: '成员' })}获得${token({ text: '星光守护者' })}头衔`;
            const value = Object.freeze(input(tip));
            expect(parseUnchanged(value, identity)).toEqual([
                {
                    kind: 'group_title_change',
                    time: TIME,
                    selfUin: Number(SELF),
                    groupId: GROUP,
                    userUin: MEMBER,
                    title: '星光守护者',
                },
            ]);
        });
    });

    it.each([
        ['object', token({ text: { label: '伪标题' } })],
        ['array', token({ text: ['伪标题'] })],
        ['number', token({ text: 123 })],
        ['boolean', token({ text: true })],
        ['null', token({ text: null })],
        ['missing text', token({ label: '无标题' })],
        ['empty text', token({ text: '' })],
        ['invalid JSON', '<{"text":}>'],
    ])('emits no title event for %s', async (_label, invalidToken) => {
        await withIdentity((identity) => {
            expect(parseUnchanged(input(`获得${invalidToken}头衔`), identity)).toEqual([]);
        });
    });

    it('ignores an inherited text property when the JSON token omits text', async () => {
        await withIdentity((identity) => {
            const original = Object.getOwnPropertyDescriptor(Object.prototype, 'text');

            try {
                Object.defineProperty(Object.prototype, 'text', {
                    value: 'inherited',
                    configurable: true,
                    writable: true,
                });
                const events = parseDirectMsgPushOrThrow(
                    input(token({ other: '无标题' })),
                    identity,
                );
                expect(events).toEqual([]);
            } finally {
                if (original) {
                    Object.defineProperty(Object.prototype, 'text', original);
                } else {
                    delete (Object.prototype as { text?: unknown }).text;
                }
            }
        });
    });

    it('uses the last rich token when both contain valid strings', async () => {
        await withIdentity((identity) => {
            const tip = `${token({ text: '第一段' })}获得${token({ text: '最后标题' })}头衔`;
            expect(parseUnchanged(input(tip), identity)).toEqual([
                {
                    kind: 'group_title_change',
                    time: TIME,
                    selfUin: Number(SELF),
                    groupId: GROUP,
                    userUin: MEMBER,
                    title: '最后标题',
                },
            ]);
        });
    });

    it.each([
        ['object', token({ text: { value: '无效' } })],
        ['empty string', token({ text: '' })],
        ['missing text', token({ other: '无效' })],
        ['malformed JSON', '<{"text":}>'],
    ])('does not fall back to an earlier valid token when the last is %s', async (_label, last) => {
        await withIdentity((identity) => {
            expect(
                parseUnchanged(input(`${token({ text: '先前标题' })}${last}`), identity),
            ).toEqual([]);
        });
    });

    it('binds events to the selected matching identity and rejects another account', async () => {
        const first = IdentityService.memory(SELF);
        const second = IdentityService.memory(OTHER_SELF);

        try {
            await Promise.all([first.initialization, second.initialization]);
            const value = Object.freeze(input(token({ text: '专属头衔' }), OTHER_SELF));
            const originalBody = value.body;
            const bytes = Uint8Array.from(originalBody);
            const descriptors = Object.getOwnPropertyDescriptors(value);
            expect(() => parseDirectMsgPushOrThrow(value, first)).toThrow(/identity UIN mismatch/);
            expect(Object.getOwnPropertyDescriptors(value)).toEqual(descriptors);
            expect(value.body).toBe(originalBody);
            expect(value.body).toEqual(bytes);
            expect(parseUnchanged(value, second)).toEqual([
                {
                    kind: 'group_title_change',
                    time: TIME,
                    selfUin: Number(OTHER_SELF),
                    groupId: GROUP,
                    userUin: MEMBER,
                    title: '专属头衔',
                },
            ]);
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    });
});
