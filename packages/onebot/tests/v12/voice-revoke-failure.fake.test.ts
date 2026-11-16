import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';
import type { JsonObject } from '../../src/types';
import type { V12Runtime } from '../../src/v12-runtime/runtime';

type FakeToken = {
    issue: ReturnType<typeof vi.fn>;
    redeem: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
};
type FakeTransport = {
    options: V12TransportOptions;
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    quiesce: ReturnType<typeof vi.fn>;
    forceClose: ReturnType<typeof vi.fn>;
};

// These are in-memory fakes; no transport or token provider performs I/O.
const fixture = vi.hoisted(() => ({
    transports: [] as FakeTransport[],
    images: [] as FakeToken[],
    voices: [] as FakeToken[],
    forbiddenModules: [] as string[],
    warn: vi.fn(),
}));

vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        readonly open = vi.fn(async () => {});
        readonly close = vi.fn(async () => {});
        readonly quiesce = vi.fn();
        readonly forceClose = vi.fn();

        constructor(readonly options: V12TransportOptions) {
            fixture.transports.push(this);
        }
    },
}));
vi.mock('../../src/network', async () => ({
    IOneBotNetworkAdapter: (await import('../../src/network/adapter')).IOneBotNetworkAdapter,
}));
vi.mock('@snowluma/common/logger', () => {
    const logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warn: fixture.warn,
        error: vi.fn(),
        child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { createLogger: () => logger };
});
vi.mock('../../src/v12/image-file-token', () => {
    const imagePrefix = 'jiyu-image:v1:';
    const voicePrefix = 'jiyu-voice:v1:';

    class FakeTokens {
        private url: string | null = null;
        readonly issue = vi.fn((url: string) => {
            this.url = url;
            return this.id;
        });
        readonly redeem = vi.fn((id: string) => (id === this.id ? this.url : null));
        readonly revoke = vi.fn(() => {
            this.url = null;
        });

        constructor(private readonly id: string) {}
    }

    return {
        V12_IMAGE_TOKEN_PREFIX: imagePrefix,
        V12_VOICE_TOKEN_PREFIX: voicePrefix,
        isV12ImageToken: (id: string) => id.startsWith(imagePrefix),
        isV12VoiceToken: (id: string) => id.startsWith(voicePrefix),
        isV12SealableFileUrl: (url: unknown) =>
            typeof url === 'string' && url.startsWith('https://media.example.invalid/'),
        V12ImageFileTokens: class extends FakeTokens {
            constructor(_accountId: string) {
                super(`${imagePrefix}synthetic-image`);
                fixture.images.push(this);
            }
        },
        V12VoiceFileTokens: class extends FakeTokens {
            constructor(_accountId: string) {
                super(`${voicePrefix}synthetic-voice`);
                fixture.voices.push(this);
            }
        },
    };
});
vi.mock('@snowluma/websocket', () => {
    fixture.forbiddenModules.push('websocket');
    throw new Error('unexpected websocket module');
});
vi.mock('@snowluma/sqlite', () => {
    fixture.forbiddenModules.push('sqlite');
    throw new Error('unexpected sqlite module');
});

const IMAGE_ID = 'jiyu-image:v1:synthetic-image';
const VOICE_ID = 'jiyu-voice:v1:synthetic-voice';
const IMAGE_SECRET = 'SYNTHETIC_IMAGE_TOKEN_SECRET_R101';
const VOICE_SECRET = 'SYNTHETIC_VOICE_TOKEN_SECRET_R102';
const FAILURE_SECRET = 'SYNTHETIC_REVOKE_FAILURE_SECRET_R103';
const IMAGE_URL = `https://media.example.invalid/image?token=${IMAGE_SECRET}`;
const VOICE_URL = `https://media.example.invalid/voice?token=${VOICE_SECRET}`;
const FAILURE_URL = `https://failure.example.invalid/path?token=${FAILURE_SECRET}`;
const IMAGE_DIAGNOSTIC = 'v12 image token revocation failed';
const VOICE_DIAGNOSTIC = 'v12 voice token revocation failed';
const activeRuntimes: V12Runtime[] = [];

let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let identityApi: typeof import('../../src/v12-runtime/identity');
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] } }>;
let nativeGuard: { mock: { calls: unknown[] } };

beforeEach(async () => {
    fixture.transports.length = 0;
    fixture.images.length = 0;
    fixture.voices.length = 0;
    fixture.forbiddenModules.length = 0;
    fixture.warn.mockReset();

    const blocked = (): never => {
        throw new Error('unexpected network or native operation in fake lifecycle test');
    };

    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function BlockWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    networkGuards = [
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
        vi.spyOn(http2, 'createServer').mockImplementation(blocked),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(blocked),
        vi.spyOn(http2, 'connect').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
    ];
    nativeGuard = vi.spyOn(process, 'dlopen').mockImplementation(blocked);
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    sourceApi = await import('../../src/v12-runtime/source-generation');
    identityApi = await import('../../src/v12-runtime/identity');
    runtimeApi = await import('../../src/v12-runtime/runtime');
});

afterEach(async () => {
    try {
        fixture.warn.mockImplementation(() => {});
        vi.mocked(process.emitWarning).mockImplementation(() => {});

        for (const runtime of activeRuntimes.splice(0)) {
            await runtime.close();
        }
    } finally {
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const networkCalls = networkGuards.map((guard) => guard.mock.calls.length);
        const nativeCalls = nativeGuard.mock.calls.length;
        const modules = [...fixture.forbiddenModules];
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(networkCalls).toEqual(networkCalls.map(() => 0));
        expect(nativeCalls).toBe(0);
        expect(modules).toEqual([]);
    }
});

function syntheticMessage(): JsonObject {
    return {
        post_type: 'message',
        self_id: 10001,
        user_id: 20001,
        message_type: 'private',
        sub_type: 'friend',
        message_id: -123,
        time: 1_700_000_000,
        raw_message: 'synthetic media',
        message: [
            {
                type: 'image',
                data: { file: 'fake-image', url: IMAGE_URL, sub_type: 0, summary: '[图片]' },
            },
            { type: 'record', data: { file: 'fake-voice', url: VOICE_URL } },
        ],
    };
}

async function createRuntimeFixture() {
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const legacyHandle = vi.fn(async () => {
        throw new Error('unexpected legacy alias fallback');
    });
    let runtime!: V12Runtime;
    runtime = new runtimeApi.V12Runtime(
        {
            name: identityApi.V12_ADAPTER_NAME,
            enabled: true,
            host: 'fixture.invalid',
            port: 1,
            accessToken: 'synthetic-access-token',
            allowNonLoopback: false,
            messageFormat: 'array',
            reportSelfMessage: false,
        },
        {
            uin: '10001',
            api: { handle: legacyHandle } as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: async () => null,
            trackAction: <T>(_label: string, start: () => Promise<T>) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            isSourceCurrent: (source, binding) => generation.isCurrent(source, binding),
        },
    );
    activeRuntimes.push(runtime);
    await runtime.open();
    const transport = fixture.transports.at(-1);

    if (!transport) {
        throw new Error('fake transport was not constructed');
    }

    const wire: unknown[] = [];
    transport.options.subscribe((event) => wire.push(event));
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ type: 'meta', detail_type: 'status_update' });
    wire.length = 0;
    const source = generation.capture(runtime[sourceApi.captureBinding]());

    if (!source) {
        throw new Error('synthetic source was not captured');
    }

    expect(runtime.isActive).toBe(true);
    expect(generation.isCurrent(source, runtime[sourceApi.captureBinding]())).toBe(true);
    expect(runtime[sourceApi.verifySource](source)).toBe(true);
    const input = syntheticMessage();
    const { convertV11Event } = await import('../../src/v12/events');
    expect(
        convertV11Event(
            input,
            { platform: 'qq', user_id: '10001' },
            {
                validateMediaFileUrl: (url) => url.startsWith('https://media.example.invalid/'),
                issueImageFileId: () => IMAGE_ID,
                issueVoiceFileId: () => VOICE_ID,
            },
        ),
    ).toMatchObject({ type: 'message' });
    const cleanError = vi.spyOn(
        runtime as unknown as { cleanError(error: unknown): string },
        'cleanError',
    );
    const emit = (event: JsonObject) =>
        runtime[sourceApi.receiveSourceEvent](
            event,
            {
                isSelfMessage: false,
                arrayJson: '{}',
                stringJson: '{}',
            },
            source,
        );
    await emit(input);
    const conversionFailures = cleanError.mock.calls.map(([error]) => {
        let message = error instanceof Error ? error.message : 'non-Error conversion failure';

        for (const secret of [
            IMAGE_URL,
            VOICE_URL,
            FAILURE_URL,
            IMAGE_SECRET,
            VOICE_SECRET,
            FAILURE_SECRET,
        ]) {
            message = message.replaceAll(secret, '[redacted]');
        }

        return message;
    });
    expect(conversionFailures, 'runtime setup failure class').toEqual([]);
    expect(fixture.warn.mock.calls, 'runtime setup warnings').toEqual([]);
    expect(fixture.images, 'runtime image issuer').toHaveLength(1);
    expect(fixture.voices, 'runtime voice issuer').toHaveLength(1);
    expect(wire, 'runtime media fanout').toHaveLength(1);
    expect(wire[0]).toMatchObject({
        type: 'message',
        message: [
            { type: 'image', data: { file_id: IMAGE_ID } },
            { type: 'voice', data: { file_id: VOICE_ID } },
        ],
    });
    expect(JSON.stringify(wire)).not.toContain(IMAGE_SECRET);
    expect(JSON.stringify(wire)).not.toContain(VOICE_SECRET);
    expect(fixture.images).toHaveLength(1);
    expect(fixture.voices).toHaveLength(1);
    const image = fixture.images[0]!;
    const voice = fixture.voices[0]!;
    expect(image.issue).toHaveBeenCalledExactlyOnceWith(IMAGE_URL);
    expect(voice.issue).toHaveBeenCalledExactlyOnceWith(VOICE_URL);
    const getFile = (fileId: string) =>
        transport.options.handle({
            action: 'get_file',
            params: { file_id: fileId, type: 'url' },
            self: { platform: 'qq', user_id: '10001' },
        });
    expect(await getFile(IMAGE_ID)).toMatchObject({
        status: 'ok',
        retcode: 0,
        data: { name: '', url: IMAGE_URL },
    });
    expect(await getFile(VOICE_ID)).toMatchObject({
        status: 'ok',
        retcode: 0,
        data: { name: '', url: VOICE_URL },
    });
    expect(image.redeem).toHaveBeenCalledExactlyOnceWith(IMAGE_ID);
    expect(voice.redeem).toHaveBeenCalledExactlyOnceWith(VOICE_ID);
    return { runtime, transport, image, voice, wire, emit, getFile, legacyHandle };
}

type RuntimeFixture = Awaited<ReturnType<typeof createRuntimeFixture>>;

async function expectRetired(f: RuntimeFixture) {
    // Deliberately invoke saved callbacks rather than relying on transport admission.
    for (const id of [IMAGE_ID, VOICE_ID]) {
        expect(await f.getFile(id)).toMatchObject({ status: 'failed', retcode: 20001, data: null });
    }

    expect(f.image.redeem).toHaveBeenCalledTimes(1);
    expect(f.voice.redeem).toHaveBeenCalledTimes(1);
    expect(f.legacyHandle).not.toHaveBeenCalled();
    await f.emit(syntheticMessage());
    f.runtime.statusUpdate();
    expect(f.wire).toHaveLength(1);
    expect(f.image.issue).toHaveBeenCalledTimes(1);
    expect(f.voice.issue).toHaveBeenCalledTimes(1);
    await expect(f.runtime.open()).rejects.toThrow('v12 instance is disposing');
}

function expectDiagnostics(expected: string[], fallback: string[]) {
    const warning = vi.mocked(process.emitWarning);
    expect(fixture.warn.mock.calls).toEqual(expected.map((message) => [message]));
    expect(warning.mock.calls).toEqual(fallback.map((message) => [message]));
    const captured = JSON.stringify({
        logger: fixture.warn.mock.calls,
        warning: warning.mock.calls,
    });

    for (const secret of [
        IMAGE_SECRET,
        VOICE_SECRET,
        FAILURE_SECRET,
        IMAGE_URL,
        VOICE_URL,
        FAILURE_URL,
    ]) {
        expect(captured).not.toContain(secret);
    }
}

const CASES = [
    {
        name: 'image fails and voice succeeds',
        image: true,
        voice: false,
        logger: false,
        warning: false,
    },
    {
        name: 'image succeeds and voice fails',
        image: false,
        voice: true,
        logger: false,
        warning: false,
    },
    { name: 'both revocations fail', image: true, voice: true, logger: false, warning: false },
    { name: 'both fail and logger throws', image: true, voice: true, logger: true, warning: false },
    {
        name: 'both fail and both diagnostics throw',
        image: true,
        voice: true,
        logger: true,
        warning: true,
    },
] as const;

describe('v12 media revocation failures through fake lifecycle boundaries', () => {
    for (const method of ['quiesce', 'forceClose'] as const) {
        it.each(CASES)(`${method}: $name`, async (scenario) => {
            const f = await createRuntimeFixture();
            const order: string[] = [];
            const sensitiveError = () =>
                new Error(
                    `synthetic failure ${FAILURE_SECRET} ${FAILURE_URL} ${IMAGE_URL} ${VOICE_URL}`,
                );
            // A successful fake returns normally; these tests make no erasure claim.
            f.image.revoke.mockImplementation(() => {
                order.push('image');

                if (scenario.image) {
                    throw sensitiveError();
                }
            });
            f.voice.revoke.mockImplementation(() => {
                order.push('voice');

                if (scenario.voice) {
                    throw sensitiveError();
                }
            });
            f.transport.quiesce.mockImplementation(() => {
                order.push('quiesce');
            });
            f.transport.forceClose.mockImplementation(() => {
                order.push('forceClose');
            });
            fixture.warn.mockImplementation(() => {
                if (scenario.logger) {
                    throw sensitiveError();
                }
            });
            vi.mocked(process.emitWarning).mockImplementation(() => {
                if (scenario.warning) {
                    throw sensitiveError();
                }
            });

            expect(() => f.runtime[method]()).not.toThrow();
            expect(f.image.revoke).toHaveBeenCalledOnce();
            expect(f.voice.revoke).toHaveBeenCalledOnce();
            expect(order).toEqual(['image', 'voice', method]);
            expect(f.transport[method]).toHaveBeenCalledOnce();
            expect(
                f.transport[method === 'quiesce' ? 'forceClose' : 'quiesce'],
            ).not.toHaveBeenCalled();
            const expected = [
                ...(scenario.image ? [IMAGE_DIAGNOSTIC] : []),
                ...(scenario.voice ? [VOICE_DIAGNOSTIC] : []),
            ];
            expectDiagnostics(expected, scenario.logger ? expected : []);
            await expectRetired(f);
            expectDiagnostics(expected, scenario.logger ? expected : []);
            await f.runtime.close();
            expect(f.transport.close).toHaveBeenCalledOnce();
            expect(f.image.revoke).toHaveBeenCalledOnce();
            expect(f.voice.revoke).toHaveBeenCalledOnce();
        });

        it(`${method}: clears both issuers before a reentrant revoke callback`, async () => {
            const f = await createRuntimeFixture();
            const order: string[] = [];
            let reentered = false;
            f.image.revoke.mockImplementation(() => {
                order.push('image:start');

                if (!reentered) {
                    reentered = true;
                    f.runtime.quiesce();
                }

                order.push('image:end');
                throw new Error(`image ${FAILURE_SECRET} ${FAILURE_URL}`);
            });
            f.voice.revoke.mockImplementation(() => {
                order.push('voice');
                throw new Error(`voice ${FAILURE_SECRET} ${FAILURE_URL}`);
            });
            f.transport.quiesce.mockImplementation(() => {
                order.push('quiesce');
            });
            f.transport.forceClose.mockImplementation(() => {
                order.push('forceClose');
            });

            expect(() => f.runtime[method]()).not.toThrow();
            expect(reentered).toBe(true);
            expect(f.image.revoke).toHaveBeenCalledOnce();
            expect(f.voice.revoke).toHaveBeenCalledOnce();
            expect(order).toEqual(['image:start', 'quiesce', 'image:end', 'voice', method]);
            expectDiagnostics([IMAGE_DIAGNOSTIC, VOICE_DIAGNOSTIC], []);
            await expectRetired(f);
            expectDiagnostics([IMAGE_DIAGNOSTIC, VOICE_DIAGNOSTIC], []);
        });
    }
});
