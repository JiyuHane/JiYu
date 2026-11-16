import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { Elem, MsgInfo } from '@snowluma/proto-defs/element';
import type { PushMsg, PushMsgBody, RichText } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { parseDirectMsgPushOrThrow } from '@snowluma/protocol/msg-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    convertEvent,
    type ConverterContext,
    type MediaSegmentSink,
    type MediaUrlResolver,
} from '../../src/event-converter';
import type { JsonObject, JsonValue } from '../../src/types';
import { convertV11Event } from '../../src/v12/events';

// Every packet and identifier below is synthetic. The real schema and decoders
// establish local transformations, not QQ origin, interoperability, media bytes,
// playback, URL reachability, or successful delivery.
const fixture = vi.hoisted(() => ({ sqliteConstructions: 0 }));
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fixture.sqliteConstructions += 1;
            throw new Error('unexpected SQLite construction');
        }
    },
}));

const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const ACCOUNT = '2000000001';
const SELF = { platform: 'qq', user_id: ACCOUNT };
const PEER = 10001;
const GROUP = 9999;
const MEMBER = 222;
const TIME = 1700000000;
const VOICE_FILE = 'synthetic-voice.silk';
const VOICE_UUID = 'synthetic-voice-uuid';
const LEGACY_FILE = 'synthetic-legacy.silk';
const LEGACY_UUID = 'synthetic-legacy-uuid';
const VOICE_URL = 'https://media.example.invalid/voice?sig=SYNTHETIC_SECRET%2F';
const VOICE_ID = 'synthetic-v12-voice-id';
const BEFORE = 'before ';
const AFTER = ' after';

type Detail = 'private' | 'group';
type FixtureOptions = {
    url?: string;
    noResolver?: boolean;
    throwResolver?: boolean;
    unsupported?: boolean;
    legacy?: boolean;
};

let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let guards: Array<{ mock: { calls: unknown[] } }>;

beforeEach(() => {
    fixture.sqliteConstructions = 0;

    const blocked = () => {
        throw new Error('unexpected network or native operation');
    };

    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function BlockWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
});

afterEach(() => {
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const guardCalls = guards.map((guard) => guard.mock.calls.length);
    const sqliteConstructions = fixture.sqliteConstructions;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(guardCalls).toEqual(guardCalls.map(() => 0));
    expect(sqliteConstructions).toBe(0);
});

function voicePush(detail: Detail, options: FixtureOptions = {}): Uint8Array {
    const elements: Elem[] = [{ text: { str: BEFORE } }];

    if (!options.legacy) {
        // This nested MsgInfo mirrors the schema-generated NTV2 voice fixture in
        // protocol/tests/msg-push/rich-body-decoder.test.ts; it is not a capture.
        const voiceInfo = protobuf_encode<MsgInfo>({
            msgInfoBody: [
                {
                    index: {
                        fileUuid: VOICE_UUID,
                        storeId: 1,
                        uploadTime: 1700000000,
                        ttl: 3600,
                        info: {
                            fileName: VOICE_FILE,
                            fileSize: 2015,
                            fileHash: 'a'.repeat(32),
                            fileSha1: 'b'.repeat(40),
                            time: 3,
                            type: { type: 3, voiceFormat: 1 },
                        },
                    },
                },
            ],
        });
        elements.push({
            commonElem: {
                serviceType: 48,
                businessType: detail === 'group' ? 12 : 22,
                pbElem: voiceInfo,
            },
        });
    }

    elements.push({ text: { str: AFTER } });

    if (options.unsupported) {
        elements.push({ face: { index: 7 } });
    }

    const richText: RichText = { elems: elements };

    if (options.legacy) {
        richText.ptt = {
            fileName: LEGACY_FILE,
            fileUuid: Buffer.from(LEGACY_UUID, 'utf8'),
            fileMd5: Buffer.alloc(16, 0x11),
            fileSize: 12,
            time: 1,
            format: 1,
        };
    }

    const message: PushMsgBody =
        detail === 'private'
            ? {
                  responseHead: { fromUin: PEER, fromUid: 'synthetic_peer' },
                  contentHead: {
                      msgType: 166,
                      sequence: 32743,
                      ntMsgSeq: 63214,
                      timestamp: TIME,
                      msgId: 1,
                  },
                  body: { richText },
              }
            : {
                  responseHead: {
                      fromUin: MEMBER,
                      grp: { groupUin: GROUP, memberName: 'Synthetic' },
                  },
                  contentHead: { msgType: 82, sequence: 120, timestamp: TIME, msgId: 5120 },
                  body: { richText },
              };
    return protobuf_encode<PushMsg>({ message });
}

async function convertFixture(detail: Detail, options: FixtureOptions = {}) {
    const identity = IdentityService.memory(ACCOUNT);
    const resolver = vi.fn<MediaUrlResolver>(async () => {
        if (options.throwResolver) {
            throw new Error('synthetic resolver failure');
        }

        return options.url ?? VOICE_URL;
    });
    const sink = vi.fn<MediaSegmentSink>(async () => {});
    const context: ConverterContext = {
        selfId: Number(ACCOUNT),
        imageUrlResolver: null,
        mediaUrlResolver: options.noResolver ? null : resolver,
        messageIdResolver: () => -123,
        mediaSegmentSink: sink,
    };

    try {
        const decoded = parseDirectMsgPushOrThrow(
            {
                uin: ACCOUNT,
                sequence: 91,
                command: COMMAND,
                retCode: 0,
                body: voicePush(detail, options),
            },
            identity,
        );
        expect(decoded).toHaveLength(1);
        const event = decoded[0];

        if (!event || (event.kind !== 'friend_message' && event.kind !== 'group_message')) {
            throw new Error('synthetic message was not decoded');
        }

        const v11 = await convertEvent(context, event);

        if (!v11) {
            throw new Error('synthetic message conversion returned null');
        }

        return { event, v11, resolver, sink };
    } finally {
        await identity.close();
    }
}

function recordSegment(event: JsonObject): JsonObject {
    if (!Array.isArray(event.message)) {
        throw new Error('v11 message array missing');
    }

    const segment = event.message.find(
        (value: JsonValue): value is JsonObject =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            value.type === 'record',
    );

    if (!segment) {
        throw new Error('v11 record missing');
    }

    return segment;
}

function issuers() {
    return {
        issueImageFileId: vi.fn((_url: string) => 'unexpected-image-id'),
        issueVoiceFileId: vi.fn((_url: string) => VOICE_ID),
    };
}

describe('synthetic voice push through real protocol and v11/v12 converters', () => {
    it.each(['private', 'group'] as const)(
        'projects an NTV2 %s record in visible v11 order and leaves its media snapshot private',
        async (detail) => {
            const { event, v11, resolver, sink } = await convertFixture(detail);
            const isGroup = detail === 'group';
            const sessionId = isGroup ? GROUP : PEER;
            expect(event.kind).toBe(isGroup ? 'group_message' : 'friend_message');
            expect(event.elements).toMatchObject([
                { type: 'text', text: BEFORE },
                {
                    type: 'record',
                    fileName: VOICE_FILE,
                    fileId: VOICE_UUID,
                    duration: 3,
                    fileSize: 2015,
                    voiceFormat: 1,
                    mediaNode: { fileUuid: VOICE_UUID },
                },
                { type: 'text', text: AFTER },
            ]);
            expect(resolver).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ type: 'record', fileId: VOICE_UUID }),
                isGroup,
                sessionId,
            );
            expect(sink).toHaveBeenCalledExactlyOnceWith(
                'record',
                expect.objectContaining({ type: 'record', fileId: VOICE_UUID }),
                { file: VOICE_FILE, url: VOICE_URL },
                isGroup,
                sessionId,
            );
            expect(v11).toMatchObject({
                self_id: Number(ACCOUNT),
                post_type: 'message',
                message_type: detail,
                sub_type: isGroup ? 'normal' : 'friend',
                message_id: -123,
                user_id: isGroup ? MEMBER : PEER,
                ...(isGroup ? { group_id: GROUP } : {}),
                message: [
                    { type: 'text', data: { text: BEFORE } },
                    { type: 'record', data: { file: VOICE_FILE, url: VOICE_URL } },
                    { type: 'text', data: { text: AFTER } },
                ],
            });

            const record = recordSegment(v11);
            const symbols = Object.getOwnPropertySymbols(record);
            expect(symbols.length).toBeGreaterThan(0);
            expect(
                symbols.some(
                    (key) => Object.getOwnPropertyDescriptor(record, key)?.enumerable === false,
                ),
            ).toBe(true);
            const fake = issuers();
            const v12 = convertV11Event(v11, SELF, fake);
            expect(v12).toMatchObject({
                type: 'message',
                detail_type: detail,
                self: SELF,
                message_id: '-123',
                user_id: String(isGroup ? MEMBER : PEER),
                ...(isGroup ? { group_id: String(GROUP) } : {}),
                message: [
                    { type: 'text', data: { text: BEFORE } },
                    { type: 'voice', data: { file_id: VOICE_ID } },
                    { type: 'text', data: { text: AFTER } },
                ],
                alt_message: `${BEFORE}[语音]${AFTER}`,
            });
            expect(fake.issueVoiceFileId.mock.calls).toEqual([[VOICE_URL]]);
            expect(fake.issueImageFileId).not.toHaveBeenCalled();
            const serialized = JSON.stringify(v12);
            expect(serialized).not.toContain(VOICE_URL);
            expect(serialized).not.toContain('SYNTHETIC_SECRET');
            expect(serialized).not.toContain(VOICE_FILE);
            expect(serialized).not.toContain(VOICE_UUID);
            expect(recordSegment(v11)).toEqual({
                type: 'record',
                data: { file: VOICE_FILE, url: VOICE_URL },
            });
        },
    );

    it('preserves decoder-observed order for legacy private PTT appended after richText elems', async () => {
        const { event, v11, resolver, sink } = await convertFixture('private', { legacy: true });
        expect(event.elements).toMatchObject([
            { type: 'text', text: BEFORE },
            { type: 'text', text: AFTER },
            {
                type: 'record',
                fileName: LEGACY_FILE,
                fileId: LEGACY_UUID,
                duration: 1,
                voiceFormat: 1,
                mediaNode: { fileUuid: LEGACY_UUID },
            },
        ]);
        expect(resolver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ type: 'record', fileId: LEGACY_UUID }),
            false,
            PEER,
        );
        expect(sink).toHaveBeenCalledExactlyOnceWith(
            'record',
            expect.objectContaining({ type: 'record', fileId: LEGACY_UUID }),
            { file: LEGACY_FILE, url: VOICE_URL },
            false,
            PEER,
        );
        expect(recordSegment(v11)).toEqual({
            type: 'record',
            data: { file: LEGACY_FILE, url: VOICE_URL },
        });
        const fake = issuers();
        expect(convertV11Event(v11, SELF, fake)).toMatchObject({
            message: [
                { type: 'text', data: { text: BEFORE } },
                { type: 'text', data: { text: AFTER } },
                { type: 'voice', data: { file_id: VOICE_ID } },
            ],
            alt_message: `${BEFORE}${AFTER}[语音]`,
        });
        expect(fake.issueVoiceFileId.mock.calls).toEqual([[VOICE_URL]]);
        expect(fake.issueImageFileId).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'empty resolver result', options: { url: '' }, resolverCalls: 1 },
        { name: 'absent resolver', options: { noResolver: true }, resolverCalls: 0 },
    ])(
        'retains a v11 record for $name but fails v12 before issuance',
        async ({ options, resolverCalls }) => {
            const { v11, resolver, sink } = await convertFixture('private', options);
            expect(resolver).toHaveBeenCalledTimes(resolverCalls);
            expect(sink).toHaveBeenCalledOnce();
            expect(recordSegment(v11)).toEqual({
                type: 'record',
                data: { file: VOICE_FILE, url: '' },
            });
            const fake = issuers();
            expect(() => convertV11Event(v11, SELF, fake)).toThrow();
            expect(fake.issueVoiceFileId).not.toHaveBeenCalled();
            expect(fake.issueImageFileId).not.toHaveBeenCalled();
        },
    );

    it('observes a thrown resolver as a skipped v11 record, not as a fabricated voice', async () => {
        const previousLevel = getLogLevel();
        const entries: LogEntry[] = [];
        setLogLevel('warn');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            const { event, v11, resolver, sink } = await convertFixture('group', {
                throwResolver: true,
            });
            expect(event.elements.map((element) => element.type)).toEqual([
                'text',
                'record',
                'text',
            ]);
            expect(resolver).toHaveBeenCalledOnce();
            expect(sink).not.toHaveBeenCalled();
            expect(v11.message).toEqual([
                { type: 'text', data: { text: BEFORE } },
                { type: 'text', data: { text: AFTER } },
            ]);
            expect(entries).toContainEqual(
                expect.objectContaining({
                    level: 'warn',
                    scope: 'OneBot',
                    message: expect.stringMatching(/segment convert skipped type=record/),
                }),
            );
            const fake = issuers();
            expect(convertV11Event(v11, SELF, fake)).toMatchObject({
                message: [
                    { type: 'text', data: { text: BEFORE } },
                    { type: 'text', data: { text: AFTER } },
                ],
                alt_message: `${BEFORE}${AFTER}`,
            });
            expect(fake.issueVoiceFileId).not.toHaveBeenCalled();
            expect(fake.issueImageFileId).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
            setLogLevel(previousLevel);
        }
    });

    it('rejects a later unsupported decoded face before issuing the preceding voice', async () => {
        const { event, v11, resolver, sink } = await convertFixture('group', { unsupported: true });
        expect(event.elements.map((element) => element.type)).toEqual([
            'text',
            'record',
            'text',
            'face',
        ]);
        expect(resolver).toHaveBeenCalledOnce();
        expect(sink).toHaveBeenCalledOnce();
        expect(v11.message).toEqual([
            { type: 'text', data: { text: BEFORE } },
            { type: 'record', data: { file: VOICE_FILE, url: VOICE_URL } },
            { type: 'text', data: { text: AFTER } },
            { type: 'face', data: { id: '7' } },
        ]);
        const fake = issuers();
        expect(() => convertV11Event(v11, SELF, fake)).toThrow();
        expect(fake.issueVoiceFileId).not.toHaveBeenCalled();
        expect(fake.issueImageFileId).not.toHaveBeenCalled();
    });
});
