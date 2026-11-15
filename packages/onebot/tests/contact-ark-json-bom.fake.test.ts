import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { OneBotInstanceContext } from '../src/instance-context';
import { sendGroupMessage, sendPrivateMessage } from '../src/modules/message-actions';
import type { JsonValue } from '../src/types';

const arkJson = ' {"app":"contact","meta":{"label":"\uFEFFinside"}} ';
const receipt = {
    messageId: -123,
    sequence: 0,
    clientSequence: 0,
    random: 1,
    timestamp: 1700000000,
};

function fixture(ark: string) {
    const getBuddyRecommendArk = vi.fn(async (_id: number, _text: string) => ark);
    const getGroupRecommendArk = vi.fn(async (_id: number) => ark);
    const sendPrivate = vi.fn(async (_id: number, _elements: unknown[]) => receipt);
    const sendGroup = vi.fn(async (_id: number, _elements: unknown[]) => receipt);
    const bridge = {
        identity: { nickname: 'fixture' },
        apis: {
            contacts: { getBuddyRecommendArk, getGroupRecommendArk },
            message: { sendPrivate, sendGroup },
        },
    } as unknown as BridgeInterface;
    const cacheMessageMeta = vi.fn();
    const ref = {
        uin: '10001',
        selfId: 10001,
        bridge,
        messageStore: {
            findEvent: vi.fn(async () => null),
            storeEvent: vi.fn(async () => {}),
        },
        cacheMessageMeta,
        mediaStore: {},
        converterCtx: {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
        musicSignUrl: '',
    } as unknown as OneBotInstanceContext;

    return {
        ref,
        getBuddyRecommendArk,
        getGroupRecommendArk,
        sendPrivate,
        sendGroup,
        cacheMessageMeta,
    };
}

describe('contact service ARK JSON BOM compatibility', () => {
    for (const contactType of ['qq', 'group'] as const) {
        for (const destination of ['private', 'group'] as const) {
            const send = (ref: OneBotInstanceContext, message: JsonValue) =>
                destination === 'private'
                    ? sendPrivateMessage(ref, 67890, message, false)
                    : sendGroupMessage(ref, 67890, message, false);
            const contact: JsonValue = [
                { type: 'contact', data: { type: contactType, id: 24680 } },
            ];

            it(`${contactType} contact to ${destination}: ordinary and single BOM send identical JSON`, async () => {
                const plain = fixture(arkJson);
                const bom = fixture(`\uFEFF${arkJson}`);

                for (const current of [plain, bom]) {
                    await expect(send(current.ref, contact)).resolves.toEqual({ messageId: -123 });
                    const called =
                        destination === 'private' ? current.sendPrivate : current.sendGroup;
                    expect(called).toHaveBeenCalledOnce();
                    expect(called).toHaveBeenCalledWith(67890, [{ type: 'json', text: arkJson }]);
                    expect(current.cacheMessageMeta).toHaveBeenCalledWith(-123, expect.anything());

                    if (contactType === 'qq') {
                        expect(current.getBuddyRecommendArk).toHaveBeenCalledExactlyOnceWith(
                            24680,
                            '',
                        );
                        expect(current.getGroupRecommendArk).not.toHaveBeenCalled();
                    } else {
                        expect(current.getGroupRecommendArk).toHaveBeenCalledExactlyOnceWith(24680);
                        expect(current.getBuddyRecommendArk).not.toHaveBeenCalled();
                    }
                }
            });

            it(`${contactType} contact to ${destination}: service failure propagates without retries`, async () => {
                const current = fixture(arkJson);
                const failure = new Error('synthetic contact service failure');
                const resolver =
                    contactType === 'qq'
                        ? current.getBuddyRecommendArk
                        : current.getGroupRecommendArk;
                resolver.mockRejectedValueOnce(failure);

                await expect(send(current.ref, contact)).rejects.toBe(failure);
                expect(resolver).toHaveBeenCalledOnce();
                expect(current.sendPrivate).not.toHaveBeenCalled();
                expect(current.sendGroup).not.toHaveBeenCalled();
            });

            it.each([
                ['empty', ''],
                ['BOM only', '\uFEFF'],
            ])(
                `${contactType} contact to ${destination}: %s is unavailable without retries`,
                async (_label, input) => {
                    const current = fixture(input);
                    await expect(send(current.ref, contact)).rejects.toThrow(
                        `contact ark unavailable for ${contactType}:24680`,
                    );
                    expect(
                        contactType === 'qq'
                            ? current.getBuddyRecommendArk
                            : current.getGroupRecommendArk,
                    ).toHaveBeenCalledOnce();
                    expect(current.sendPrivate).not.toHaveBeenCalled();
                    expect(current.sendGroup).not.toHaveBeenCalled();
                    expect(current.cacheMessageMeta).not.toHaveBeenCalled();
                },
            );

            it.each([
                ['double BOM', `\uFEFF\uFEFF${arkJson}`],
                ['malformed JSON', '\uFEFF{"app":'],
                ['BOM after whitespace', ` \uFEFF${arkJson}`],
            ])(
                `${contactType} contact to ${destination}: %s rejects without retries`,
                async (_label, input) => {
                    const current = fixture(input);
                    await expect(send(current.ref, contact)).rejects.toMatchObject({
                        code: 'INVALID_FIELD',
                        message: expect.stringContaining('must contain a JSON object'),
                    });
                    expect(
                        contactType === 'qq'
                            ? current.getBuddyRecommendArk
                            : current.getGroupRecommendArk,
                    ).toHaveBeenCalledOnce();
                    expect(current.sendPrivate).not.toHaveBeenCalled();
                    expect(current.sendGroup).not.toHaveBeenCalled();
                    expect(current.cacheMessageMeta).not.toHaveBeenCalled();
                },
            );
        }
    }

    it('leaves directly supplied JSON and ordinary text untouched', async () => {
        const current = fixture(`\uFEFF${arkJson}`);
        await expect(
            sendPrivateMessage(
                current.ref,
                67890,
                [{ type: 'json', data: { data: arkJson } }],
                false,
            ),
        ).resolves.toEqual({ messageId: -123 });
        expect(current.sendPrivate).toHaveBeenCalledWith(67890, [{ type: 'json', text: arkJson }]);

        await expect(
            sendPrivateMessage(
                current.ref,
                67890,
                [{ type: 'json', data: { data: `\uFEFF${arkJson}` } }],
                false,
            ),
        ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
        expect(current.sendPrivate).toHaveBeenCalledOnce();

        const text = '\uFEFFplain text';
        await expect(
            sendPrivateMessage(current.ref, 67890, [{ type: 'text', data: { text } }], false),
        ).resolves.toEqual({ messageId: -123 });
        expect(current.sendPrivate).toHaveBeenLastCalledWith(67890, [{ type: 'text', text }]);
        expect(current.getBuddyRecommendArk).not.toHaveBeenCalled();
        expect(current.getGroupRecommendArk).not.toHaveBeenCalled();
    });
});
