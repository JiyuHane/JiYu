import { describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/websocket', () => ({ WebSocket: class {}, WebSocketServer: class {} }));
vi.mock('../../src/v12-network', () => ({ V12Transport: class {} }));

import { buildApiContext } from '../../src/instance-context';
import { captureSource, SourceGeneration } from '../../src/v12-runtime/source-generation';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('real self-sent dispatch with fake bridge', () => {
    it('preserves the pre-send source across the asynchronous receipt', async () => {
        const generation = new SourceGeneration();
        const binding = {};
        generation.setOnline(true);
        const entered = deferred();
        const receipt = deferred();
        const dispatch = vi.fn(async () => {});
        const capture = vi.fn(() => generation.capture(binding));
        const bridge = {
            identity: { nickname: 'fixture' },
            apis: {
                message: {
                    sendPrivate: async () => {
                        entered.resolve();
                        await receipt.promise;
                        return {
                            messageId: 1,
                            sequence: 10,
                            clientSequence: 20,
                            random: 30,
                            timestamp: 100,
                        };
                    },
                },
            },
        };
        const context = {
            uin: '12345',
            selfId: 12345,
            bridge,
            messageStore: { findEvent: async () => null, storeEvent: async () => true },
            mediaStore: {},
            reactionStore: {},
            converterCtx: {},
            cacheMessageMeta: async () => {},
            dispatchEvent: dispatch,
            [captureSource]: capture,
        };
        const api = buildApiContext(context as never);
        const pending = api.sendPrivateMessage(23456, 'hello', false);
        expect(capture).toHaveBeenCalledOnce();
        const source = capture.mock.results[0]!.value;
        await entered.promise;
        generation.setOnline(false);
        generation.setOnline(true);
        receipt.resolve();
        await pending;
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]![3]).toBe(source);
        expect(dispatch.mock.calls[0]![0]).toMatchObject({ post_type: 'message_sent' });
        expect(generation.isCurrent(source, binding)).toBe(false);
    });
});
