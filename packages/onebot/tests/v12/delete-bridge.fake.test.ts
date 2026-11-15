import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { describe, expect, it, vi } from 'vitest';

import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { deleteMessage } from '../../src/modules/message-actions';
import type { MessageMeta } from '../../src/types';
import { V12Dispatcher } from '../../src/v12/dispatcher';

const privateMeta: MessageMeta = {
    isGroup: false,
    targetId: 20001,
    sequence: 34567,
    sequenceAuthoritative: true,
    eventName: 'friend_message',
    clientSequence: 12345,
    privateDirection: 'outgoing',
    random: 45678,
    timestamp: 1700000000,
};

function setup(meta: MessageMeta) {
    const recallPrivate = vi.fn(async (..._args: number[]): Promise<void> => {});
    const recallGroup = vi.fn(async (..._args: number[]): Promise<void> => {});
    const bridge = { apis: { message: { recallPrivate, recallGroup } } };
    const fakeBridge = bridge as unknown as BridgeInterface;
    const getMessageMeta = vi.fn((_messageId: number) => meta);
    const deleteFromContext = vi.fn(async (_messageId: number, value: MessageMeta) => {
        await deleteMessage(fakeBridge, value);
    });
    const context = {
        bridge: fakeBridge,
        getMessageMeta,
        deleteMessage: deleteFromContext,
    } as unknown as ApiActionContext;
    const api = new ApiHandler(context);
    const handle = vi.spyOn(api, 'handle');
    const dispatcher = new V12Dispatcher({
        self: { platform: 'qq', user_id: '10001' },
        version: { impl: 'jiyu', version: '1.0' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });

    return {
        dispatcher,
        handle,
        getMessageMeta,
        deleteFromContext,
        recallPrivate,
        recallGroup,
        cleanup() {
            handle.mockRestore();
            getMessageMeta.mockReset();
            deleteFromContext.mockReset();
            recallPrivate.mockReset();
            recallGroup.mockReset();
        },
    };
}

const request = { action: 'delete_message', params: { message_id: '-123' }, echo: '' };
const success = { status: 'ok', retcode: 0, data: null, message: '', echo: '' };

function expectForwarded(fixture: ReturnType<typeof setup>, meta: MessageMeta) {
    expect(fixture.handle).toHaveBeenCalledExactlyOnceWith('delete_msg', { message_id: -123 });
    expect(fixture.getMessageMeta).toHaveBeenCalledExactlyOnceWith(-123);
    expect(fixture.deleteFromContext).toHaveBeenCalledExactlyOnceWith(-123, meta);
    expect(fixture.deleteFromContext.mock.calls[0]?.[1]).toBe(meta);
}

describe('v12 delete_message through the real action and message module with an in-memory bridge', () => {
    it('forwards a signed id and complete private metadata exactly once, preserving empty echo', async () => {
        const fixture = setup(privateMeta);

        try {
            expect(await fixture.dispatcher.handle(request)).toEqual(success);
            expectForwarded(fixture, privateMeta);
            expect(fixture.recallPrivate).toHaveBeenCalledExactlyOnceWith(
                privateMeta.targetId,
                privateMeta.clientSequence,
                privateMeta.sequence,
                privateMeta.random,
                privateMeta.timestamp,
            );
            expect(fixture.recallGroup).not.toHaveBeenCalled();
        } finally {
            fixture.cleanup();
        }
    }, 5000);

    it('routes group metadata to recallGroup exactly once', async () => {
        const meta: MessageMeta = {
            isGroup: true,
            targetId: 30001,
            sequence: 87654,
            sequenceAuthoritative: true,
            eventName: 'group_message',
            clientSequence: 56789,
            random: 67890,
            timestamp: 1700000100,
        };
        const fixture = setup(meta);

        try {
            expect(await fixture.dispatcher.handle(request)).toEqual(success);
            expectForwarded(fixture, meta);
            expect(fixture.recallGroup).toHaveBeenCalledExactlyOnceWith(
                meta.targetId,
                meta.sequence,
            );
            expect(fixture.recallPrivate).not.toHaveBeenCalled();
        } finally {
            fixture.cleanup();
        }
    }, 5000);

    it('does not call the bridge or claim success without authoritative sequence', async () => {
        const meta: MessageMeta = { ...privateMeta, sequenceAuthoritative: false };
        const fixture = setup(meta);

        try {
            const result = await fixture.dispatcher.handle(request);
            expect(result).toMatchObject({
                status: 'failed',
                retcode: 20002,
                data: null,
                echo: '',
            });
            expectForwarded(fixture, meta);
            expect(fixture.recallPrivate).not.toHaveBeenCalled();
            expect(fixture.recallGroup).not.toHaveBeenCalled();
        } finally {
            fixture.cleanup();
        }
    }, 5000);

    it('reports one rejected recall as failure without retry or synthetic error disclosure', async () => {
        const fixture = setup(privateMeta);
        fixture.recallPrivate.mockRejectedValueOnce(new Error('synthetic-private-error-marker'));

        try {
            const result = await fixture.dispatcher.handle(request);
            expect(result).toEqual({
                status: 'failed',
                retcode: 20002,
                data: null,
                message: 'action outcome unavailable; do not retry automatically',
                echo: '',
            });
            expect(JSON.stringify(result)).not.toContain('synthetic-private-error-marker');
            expectForwarded(fixture, privateMeta);
            expect(fixture.recallPrivate).toHaveBeenCalledExactlyOnceWith(
                privateMeta.targetId,
                privateMeta.clientSequence,
                privateMeta.sequence,
                privateMeta.random,
                privateMeta.timestamp,
            );
            expect(fixture.recallGroup).not.toHaveBeenCalled();
        } finally {
            fixture.cleanup();
        }
    }, 5000);
});
