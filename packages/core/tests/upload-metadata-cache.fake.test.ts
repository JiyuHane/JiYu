import { describe, expect, it, vi } from 'vitest';
import type { IdentityService } from '@snowluma/protocol/identity-service';
import type { UploadedFileMeta } from '../src/bridge/bridge-context';

// Replace every runtime dependency of Bridge with an in-memory fake before import.
vi.mock('@snowluma/common/logger', () => ({
    createLogger: () => ({ debug: vi.fn(), trace: vi.fn(), warn: vi.fn(), info: vi.fn() }),
    renderTraceBytes: vi.fn(),
    runWithTraceRequest: vi.fn(),
}));
vi.mock('@snowluma/bridge/packet-timeout', () => ({ packetTimeoutMs: vi.fn() }));
vi.mock('@snowluma/protocol/event-bus', () => ({
    BridgeEventBus: class {
        on = vi.fn();
        clear = vi.fn();
    },
}));
vi.mock('@snowluma/protocol/msg-push', () => ({
    MSG_PUSH_CMD: 'fake-message',
    parseMsgPushOrThrow: vi.fn(),
    SysMsgDedup: class {},
    decodeClientMessageReceipt: vi.fn(),
    fetchClientMessage: vi.fn(),
}));
vi.mock('@snowluma/protocol/kick-nt', () => ({
    KICK_NT_CMD: 'fake-kick',
    parseKickNT: vi.fn(),
}));
vi.mock('@snowluma/protocol/packet-pipeline', () => ({
    IncomingPacketPipeline: class {
        registerCmd = vi.fn();
    },
}));
vi.mock('../src/bridge/apis', () => ({
    buildApiHub: () => ({ contacts: { groupInvites: {} } }),
}));
vi.mock('../src/bridge/apis/extras', () => ({ AiVoiceChatType: {} }));

import { Bridge } from '../src/bridge/bridge';

const capacity = 1024;

function metadata(fileId: string, version = 0): UploadedFileMeta {
    return {
        fileId,
        scope: 'private',
        fileName: `fake-${version}`,
        fileSize: version,
        fileMd5: new Uint8Array(),
        fileSha1: new Uint8Array(),
        rememberedAt: version,
    };
}

function fullBridge(): Bridge {
    const identity = { setFetcher: vi.fn() } as unknown as IdentityService;
    const bridge = new Bridge(identity);

    for (let index = 0; index < capacity; index++) {
        bridge.rememberUploadedFile(metadata(`id-${index}`));
    }

    return bridge;
}

describe('upload metadata cache with in-memory dependencies', () => {
    it('updates a non-oldest key without eviction or reordering', () => {
        const bridge = fullBridge();
        const updated = metadata('id-512', 1);
        bridge.rememberUploadedFile(updated);
        expect(bridge.recallUploadedFile('id-0')).toBeDefined();
        expect(bridge.recallUploadedFile('id-512')).toBe(updated);
        expect(bridge.recallUploadedFile('id-1023')).toBeDefined();

        bridge.rememberUploadedFile(metadata('new-id'));
        expect(bridge.recallUploadedFile('id-0')).toBeUndefined();
        expect(bridge.recallUploadedFile('id-1')).toBeDefined();
        expect(bridge.recallUploadedFile('id-512')).toBe(updated);
        expect(bridge.recallUploadedFile('new-id')).toBeDefined();

        for (let index = 1; index <= 512; index++) {
            bridge.rememberUploadedFile(metadata(`new-id-${index}`));
        }

        expect(bridge.recallUploadedFile('id-512')).toBeUndefined();
        expect(bridge.recallUploadedFile('id-513')).toBeDefined();
    });

    it('updates the oldest key without moving it to the end', () => {
        const bridge = fullBridge();
        const updated = metadata('id-0', 1);
        bridge.rememberUploadedFile(updated);
        expect(bridge.recallUploadedFile('id-0')).toBe(updated);
        expect(bridge.recallUploadedFile('id-1')).toBeDefined();

        bridge.rememberUploadedFile(metadata('new-id'));
        expect(bridge.recallUploadedFile('id-0')).toBeUndefined();
        expect(bridge.recallUploadedFile('id-1')).toBeDefined();
        expect(bridge.recallUploadedFile('new-id')).toBeDefined();
    });

    it('evicts exactly the oldest key when inserting a new key into a full cache', () => {
        const bridge = fullBridge();
        const inserted = metadata('new-id');
        bridge.rememberUploadedFile(inserted);
        expect(bridge.recallUploadedFile('id-0')).toBeUndefined();

        for (let index = 1; index < capacity; index++) {
            expect(bridge.recallUploadedFile(`id-${index}`)).toBeDefined();
        }

        expect(bridge.recallUploadedFile('new-id')).toBe(inserted);
    });

    it('keeps identical fileIds isolated between Bridge instances', () => {
        const first = fullBridge();
        const second = fullBridge();
        const firstValue = metadata('id-512', 1);
        const secondValue = metadata('id-512', 2);
        first.rememberUploadedFile(firstValue);
        second.rememberUploadedFile(secondValue);
        first.rememberUploadedFile(metadata('new-id'));

        expect(first.recallUploadedFile('id-512')).toBe(firstValue);
        expect(second.recallUploadedFile('id-512')).toBe(secondValue);
        expect(first.recallUploadedFile('id-0')).toBeUndefined();
        expect(second.recallUploadedFile('id-0')).toBeDefined();
        expect(second.recallUploadedFile('new-id')).toBeUndefined();
    });

    it('takes one stable snapshot of a fileId getter', () => {
        const bridge = fullBridge();
        let reads = 0;
        const value: UploadedFileMeta = {
            ...metadata('getter-id'),
            get fileId() {
                reads++;
                return 'getter-id';
            },
        };

        bridge.rememberUploadedFile(value);
        expect(reads).toBe(1);
        expect(bridge.recallUploadedFile('getter-id')).toBe(value);
    });

    it('ignores an empty fileId without affecting a full cache', () => {
        const bridge = fullBridge();
        bridge.rememberUploadedFile(metadata(''));
        expect(bridge.recallUploadedFile('')).toBeUndefined();
        expect(bridge.recallUploadedFile('id-0')).toBeDefined();
        expect(bridge.recallUploadedFile('id-1023')).toBeDefined();
        bridge.rememberUploadedFile(metadata('new-id'));
        expect(bridge.recallUploadedFile('id-0')).toBeUndefined();
        expect(bridge.recallUploadedFile('id-1')).toBeDefined();
        expect(bridge.recallUploadedFile('new-id')).toBeDefined();
    });
});
