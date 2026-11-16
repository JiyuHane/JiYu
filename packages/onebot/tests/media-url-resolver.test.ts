import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { MediaUrlResolver } from '../src/media-url-resolver';
import type { MessageElement } from '@snowluma/protocol/events';

function makeBridge(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return {
        apis: {
            groupFile: {
                getUrl: overrides.getUrl ?? vi.fn(async () => 'http://group/file'),
                getPrivateUrl: overrides.getPrivateUrl ?? vi.fn(async () => 'http://private/file'),
                getPttUrl: overrides.getPttUrl ?? vi.fn(async () => 'http://group/ptt'),
                getPrivatePttUrl:
                    overrides.getPrivatePttUrl ?? vi.fn(async () => 'http://private/ptt'),
                getVideoUrl: overrides.getVideoUrl ?? vi.fn(async () => 'http://group/video'),
                getPrivateVideoUrl:
                    overrides.getPrivateVideoUrl ?? vi.fn(async () => 'http://private/video'),
            },
        },
    };
}

function makeRkey(overrides: { resolveMediaUrl?: ReturnType<typeof vi.fn> } = {}) {
    return {
        resolveMediaUrl:
            overrides.resolveMediaUrl ?? vi.fn(async (_bridge, el: MessageElement) => el.url ?? ''),
    };
}

const MEDIA_NODE = { fileUuid: 'uuid-1' };
const FAILURE_CASES = [
    ['file', true, 'getUrl'],
    ['file', false, 'getPrivateUrl'],
    ['record', true, 'getPttUrl'],
    ['record', false, 'getPrivatePttUrl'],
    ['video', true, 'getVideoUrl'],
    ['video', false, 'getPrivateVideoUrl'],
] as const;

describe('MediaUrlResolver — file element', () => {
    let bridge: ReturnType<typeof makeBridge>;
    let rkey: ReturnType<typeof makeRkey>;
    beforeEach(() => {
        bridge = makeBridge();
        rkey = makeRkey();
    });

    it('group + fileId: uses fetchGroupFileUrl, then applies rkey', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid-x' };
        const out = await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getUrl).toHaveBeenCalledWith(12345, 'fid-x');
        expect(element.url).toBe('http://group/file');
        expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
        expect(out).toBe('http://group/file');
    });

    it('c2c + fileId + fileHash: uses fetchPrivateFileUrl', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid-x', fileHash: 'hash-y' };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivateUrl).toHaveBeenCalledWith(67890, 'fid-x', 'hash-y');
        expect(element.url).toBe('http://private/file');
    });

    it('c2c + fileId but no fileHash: sets url to empty string (no bridge call)', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid-x' };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivateUrl).not.toHaveBeenCalled();
        expect(element.url).toBe('');
    });
});

describe('MediaUrlResolver — record / video element', () => {
    let bridge: ReturnType<typeof makeBridge>;
    let rkey: ReturnType<typeof makeRkey>;
    beforeEach(() => {
        bridge = makeBridge();
        rkey = makeRkey();
    });

    it('group record: uses fetchGroupPttUrlByNode', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'record', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getPttUrl).toHaveBeenCalledWith(12345, MEDIA_NODE);
        expect(element.url).toBe('http://group/ptt');
    });

    it('c2c record: uses fetchPrivatePttUrlByNode (no sessionId argument)', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'record', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivatePttUrl).toHaveBeenCalledWith(MEDIA_NODE);
        expect(element.url).toBe('http://private/ptt');
    });

    it('group video: uses fetchGroupVideoUrlByNode', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'video', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getVideoUrl).toHaveBeenCalledWith(12345, MEDIA_NODE);
        expect(element.url).toBe('http://group/video');
    });

    it('c2c video: uses fetchPrivateVideoUrlByNode', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'video', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivateVideoUrl).toHaveBeenCalledWith(MEDIA_NODE);
        expect(element.url).toBe('http://private/video');
    });

    it('record without mediaNode: no bridge call, url untouched', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'record' };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getPttUrl).not.toHaveBeenCalled();
        expect(element.url).toBeUndefined();
    });
});

describe('MediaUrlResolver — short-circuits and resilience', () => {
    it('element.url already set: no bridge call, just rkey pass', async () => {
        const bridge = makeBridge();
        const rkey = makeRkey();
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid', url: 'already-set' };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getUrl).not.toHaveBeenCalled();
        expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
    });

    it.each(FAILURE_CASES)(
        '%s group=%s: reports URL failure and preserves the media',
        async (type, isGroup, method) => {
            const bridge = makeBridge({
                [method]: vi.fn().mockRejectedValue(new Error('network down')),
            });
            const rkey = makeRkey();
            const resolver = new MediaUrlResolver(bridge as any, rkey as any);
            const element: MessageElement = {
                type,
                fileId: 'fid',
                fileHash: 'hash',
                mediaNode: MEDIA_NODE,
            };
            const original = structuredClone(element);
            const entries: LogEntry[] = [];
            const unsubscribe = subscribeLogs((entry) => entries.push(entry));

            try {
                await expect(resolver.resolve(element, isGroup, 12345)).resolves.toBe('');
                expect(element).toEqual(original);
                expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
                expect(rkey.resolveMediaUrl).toHaveBeenCalledWith(bridge, element, isGroup);
                expect(rkey.resolveMediaUrl.mock.calls[0]?.[0]).toBe(bridge);
                expect(rkey.resolveMediaUrl.mock.calls[0]?.[1]).toBe(element);
                expect(entries).toContainEqual(
                    expect.objectContaining({
                        level: 'warn',
                        scope: 'OneBot',
                        message: `media URL resolution failed type=${type} is_group=${isGroup}: [redacted]`,
                    }),
                );
                expect(JSON.stringify(entries)).not.toContain('network down');
            } finally {
                unsubscribe();
            }
        },
    );

    for (const [type, isGroup, method] of FAILURE_CASES) {
        it.each(['Error', 'Error getters', 'getter object', 'string'] as const)(
            `${type} group=${isGroup}: redacts %s failures without inspecting them`,
            async (kind) => {
                const marker = 'synthetic_media_url_token_marker_01';
                const syntheticUrl = `https://media.invalid/download?token=${marker}&sig=fake_signature`;
                const messageGetter = vi.fn(() => {
                    if (kind === 'getter object') {
                        throw new Error('unexpected message getter access');
                    }

                    return `download failed: ${syntheticUrl}`;
                });
                const stackGetter = vi.fn(() => {
                    throw new Error('unexpected stack getter access');
                });
                const toStringGetter = vi.fn(() => {
                    throw new Error('unexpected toString getter access');
                });
                const toPrimitiveGetter = vi.fn(() => {
                    throw new Error('unexpected Symbol.toPrimitive getter access');
                });
                const accessors = {
                    stack: { configurable: true, enumerable: true, get: stackGetter },
                    toString: { configurable: true, enumerable: true, get: toStringGetter },
                    [Symbol.toPrimitive]: { configurable: true, get: toPrimitiveGetter },
                    message: { configurable: true, enumerable: true, get: messageGetter },
                };
                let thrown: unknown;

                if (kind === 'Error') {
                    thrown = new Error(`download failed: ${syntheticUrl}`);
                } else if (kind === 'Error getters') {
                    thrown = Object.defineProperties(
                        new Error(`download failed: ${syntheticUrl}`),
                        accessors,
                    );
                } else if (kind === 'getter object') {
                    thrown = Object.defineProperties({ payload: syntheticUrl }, accessors);
                } else {
                    thrown = `download failed: ${syntheticUrl}`;
                }

                const failingApi =
                    kind === 'getter object'
                        ? vi.fn(() => {
                              throw thrown;
                          })
                        : vi.fn().mockRejectedValue(thrown);
                const bridge = makeBridge({ [method]: failingApi });
                const rkeyResult = 'resolved-by-fake-rkey';
                const rkey = makeRkey({ resolveMediaUrl: vi.fn(async () => rkeyResult) });
                const resolver = new MediaUrlResolver(bridge as any, rkey as any);
                const element: MessageElement = {
                    type,
                    fileId: 'fid',
                    fileHash: 'hash',
                    mediaNode: MEDIA_NODE,
                    url: '',
                };
                const original = structuredClone(element);
                const entries: LogEntry[] = [];
                const unsubscribe = subscribeLogs((entry) => entries.push(entry));

                try {
                    await expect(resolver.resolve(element, isGroup, 12345)).resolves.toBe(
                        rkeyResult,
                    );
                    expect(element).toEqual(original);
                    const api = bridge.apis.groupFile[method];
                    expect(api).toHaveBeenCalledOnce();

                    if (type === 'file') {
                        if (isGroup) {
                            expect(api).toHaveBeenCalledWith(12345, 'fid');
                        } else {
                            expect(api).toHaveBeenCalledWith(12345, 'fid', 'hash');
                        }
                    } else if (isGroup) {
                        expect(api).toHaveBeenCalledWith(12345, MEDIA_NODE);
                    } else {
                        expect(api).toHaveBeenCalledWith(MEDIA_NODE);
                    }

                    expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
                    expect(rkey.resolveMediaUrl).toHaveBeenCalledWith(bridge, element, isGroup);
                    expect(rkey.resolveMediaUrl.mock.calls[0]?.[0]).toBe(bridge);
                    expect(rkey.resolveMediaUrl.mock.calls[0]?.[1]).toBe(element);
                    expect(api.mock.invocationCallOrder[0]!).toBeLessThan(
                        rkey.resolveMediaUrl.mock.invocationCallOrder[0]!,
                    );
                    expect(entries).toContainEqual(
                        expect.objectContaining({
                            level: 'warn',
                            scope: 'OneBot',
                            message: `media URL resolution failed type=${type} is_group=${isGroup}: [redacted]`,
                        }),
                    );
                    expect(JSON.stringify(entries)).not.toContain(marker);
                    expect(JSON.stringify(entries)).not.toContain(syntheticUrl);
                    expect(messageGetter).not.toHaveBeenCalled();
                    expect(stackGetter).not.toHaveBeenCalled();
                    expect(toStringGetter).not.toHaveBeenCalled();
                    expect(toPrimitiveGetter).not.toHaveBeenCalled();
                } finally {
                    unsubscribe();
                }
            },
        );
    }

    it.each([
        [true, 'getPttUrl'],
        [false, 'getPrivatePttUrl'],
    ] as const)(
        'record group=%s: preserves a subsequent RKey rejection',
        async (isGroup, method) => {
            const bridge = makeBridge({
                [method]: vi.fn().mockRejectedValue(new Error('fake media failure')),
            });
            const rkeyFailure = new Error('fake rkey failure');
            const rkey = makeRkey({ resolveMediaUrl: vi.fn().mockRejectedValue(rkeyFailure) });
            const resolver = new MediaUrlResolver(bridge as any, rkey as any);
            const element: MessageElement = { type: 'record', mediaNode: MEDIA_NODE };
            const original = structuredClone(element);

            await expect(resolver.resolve(element, isGroup, 12345)).rejects.toBe(rkeyFailure);
            expect(element).toEqual(original);
            expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
            expect(rkey.resolveMediaUrl).toHaveBeenCalledWith(bridge, element, isGroup);
        },
    );

    it('always calls rkey.resolveMediaUrl at the end', async () => {
        const bridge = makeBridge();
        const rkey = makeRkey({ resolveMediaUrl: vi.fn(async () => 'http://signed') });
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'image' };
        const out = await resolver.resolve(element, true, 12345);
        expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
        expect(out).toBe('http://signed');
    });
});
