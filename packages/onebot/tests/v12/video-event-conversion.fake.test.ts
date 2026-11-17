import { describe, expect, it, vi } from 'vitest';
import { convertV11Event } from '../../src/v12/events';
import { isV12SealableFileUrl } from '../../src/v12/image-file-token';
import type { V12CoreOptions, V12MessageSegment, V12VideoSegment } from '../../src/v12/types';

// Converter-only synthetic fixtures: no account, real socket, process, QQ,
// signing service, or issuer lifecycle is exercised here. A visible V11 video
// segment is a lossy observation, not proof of original bytes or playback.
const self = { platform: 'qq', user_id: '10001' };
const imageUrl = 'https://media.example.invalid/image?secret=synthetic-image';
const voiceUrl = 'https://media.example.invalid/voice?secret=synthetic-voice';
const videoUrl = 'https://media.example.invalid/video?secret=synthetic-video';
const secondVideoUrl = 'https://media.example.invalid/video2?secret=synthetic-second';
const file = 'synthetic-private-file';
const imageId = 'image-id';
const voiceId = 'voice-id';
const videoId = 'video-id';

const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: string) => ({ type: 'at', data: { qq } });
const image = (url = imageUrl, filename = file) => ({
    type: 'image',
    data: { file: filename, url, sub_type: 0, summary: '' },
});
const voice = (url = voiceUrl, filename = file) => ({
    type: 'record',
    data: { file: filename, url },
});
const video = (url = videoUrl, filename = file) => ({
    type: 'video',
    data: { file: filename, url },
});

function received(kind: 'private' | 'group', message: unknown[]) {
    return {
        time: 1700000000.25,
        self_id: 10001,
        post_type: 'message',
        message_type: kind,
        sub_type: kind === 'private' ? 'friend' : 'normal',
        message_id: -123,
        user_id: 42,
        ...(kind === 'group' ? { group_id: 43 } : {}),
        message,
        raw_message: 'synthetic CQ representation',
    };
}

function issuerFixtures(log: string[] = []) {
    const issueImageFileId = vi.fn((url: string) => {
        log.push(`image:${url}`);
        return imageId;
    });
    const issueVoiceFileId = vi.fn((url: string) => {
        log.push(`voice:${url}`);
        return voiceId;
    });
    const issueVideoFileId = vi.fn((url: string) => {
        log.push(`video:${url}`);
        return videoId;
    });
    return { issueImageFileId, issueVoiceFileId, issueVideoFileId };
}

// This local validator models the existing runtime's single per-conversion
// image/voice/video admission budget. It exercises converter ordering and the
// callback contract, not the separately owned runtime integration.
function budgetValidator(log: string[] = []) {
    let count = 0;
    let bytes = 0;
    return vi.fn((url: string) => {
        log.push(`validate:${url}`);

        if (!isV12SealableFileUrl(url)) {
            return false;
        }

        const size = Buffer.byteLength(url, 'utf8');

        if (count >= 128 || size > 256 * 1024 - bytes) {
            return false;
        }

        count += 1;
        bytes += size;
        return true;
    });
}

describe('visible v11 inbound video to v12: pure converter', () => {
    it.each(['private', 'group'] as const)(
        'preflights and issues mixed image, voice and video in source order for %s',
        (kind) => {
            const log: string[] = [];
            const issuers = issuerFixtures(log);
            const validateMediaFileUrl = budgetValidator(log);
            const input = received(kind, [
                text('start '),
                video(),
                at('42'),
                image(),
                voice(),
                video(secondVideoUrl, ''),
                at('all'),
                text('!'),
            ]);
            const before = structuredClone(input);
            const result = convertV11Event(input, self, { ...issuers, validateMediaFileUrl });

            expect(result).toEqual({
                id: expect.any(String),
                time: 1700000000.25,
                type: 'message',
                detail_type: kind,
                sub_type: '',
                self,
                message_id: '-123',
                user_id: '42',
                ...(kind === 'group' ? { group_id: '43' } : {}),
                message: [
                    text('start '),
                    { type: 'video', data: { file_id: videoId } },
                    { type: 'mention', data: { user_id: '42' } },
                    { type: 'image', data: { file_id: imageId } },
                    { type: 'voice', data: { file_id: voiceId } },
                    { type: 'video', data: { file_id: videoId } },
                    { type: 'mention_all', data: {} },
                    text('!'),
                ],
                alt_message: 'start [视频]@42[图片][语音][视频]@全体成员!',
            });
            expect(log).toEqual([
                `validate:${videoUrl}`,
                `validate:${imageUrl}`,
                `validate:${voiceUrl}`,
                `validate:${secondVideoUrl}`,
                `video:${videoUrl}`,
                `image:${imageUrl}`,
                `voice:${voiceUrl}`,
                `video:${secondVideoUrl}`,
            ]);
            expect(input).toEqual(before);
            const output = JSON.stringify(result);
            expect(output).not.toContain(imageUrl);
            expect(output).not.toContain(voiceUrl);
            expect(output).not.toContain(videoUrl);
            expect(output).not.toContain(secondVideoUrl);
            expect(output).not.toContain(file);
            expect(output).not.toContain('secret=');
        },
    );

    it('adds the video union and optional resolver contracts without calling a resolver', () => {
        const segment: V12VideoSegment = { type: 'video', data: { file_id: videoId } };
        const messageSegment: V12MessageSegment = segment;
        const resolve: NonNullable<V12CoreOptions['resolveVideoFileUrl']> = (_id) => null;
        expect(messageSegment).toEqual(segment);
        expect(typeof resolve).toBe('function');
    });

    it('accepts an empty V11 file and leaves URL policy to the supplied validator', () => {
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const result = convertV11Event(received('private', [video(videoUrl, '')]), self, {
            ...issuers,
            validateMediaFileUrl,
        });
        expect(result).toMatchObject({
            message: [{ type: 'video', data: { file_id: videoId } }],
            alt_message: '[视频]',
        });
        expect(validateMediaFileUrl).toHaveBeenCalledExactlyOnceWith(videoUrl);
        expect(issuers.issueVideoFileId).toHaveBeenCalledExactlyOnceWith(videoUrl);
        expect(issuers.issueImageFileId).not.toHaveBeenCalled();
        expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
    });

    it.each([1, 4096])(
        'accepts a %i-unit video ID with the legacy optional validator',
        (length) => {
            const id = 'x'.repeat(length);
            const unvalidatedUrl = 'not-http:synthetic';
            const issueImageFileId = vi.fn((_url: string) => imageId);
            const issueVideoFileId = vi.fn((_url: string) => id);
            const result = convertV11Event(received('group', [video(unvalidatedUrl, '')]), self, {
                issueImageFileId,
                issueVideoFileId,
            });

            // Without an injected validator, as for legacy voice, the issuer owns
            // URL policy. The runtime supplies its separate sealability preflight.
            expect(result).toMatchObject({
                message: [{ type: 'video', data: { file_id: id } }],
                alt_message: '[视频]',
            });
            expect(issueVideoFileId).toHaveBeenCalledExactlyOnceWith(unvalidatedUrl);
            expect(issueImageFileId).not.toHaveBeenCalled();
        },
    );

    it('does not reconstruct video from raw_message when no V11 video segment is visible', () => {
        // The preceding V11 codec may have omitted a malformed element. This
        // synthetic already-observed event has no video segment to project.
        const input = {
            ...received('group', [text('visible text')]),
            raw_message: '[CQ:video,file=synthetic-omitted]',
        };
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const result = convertV11Event(input, self, { ...issuers, validateMediaFileUrl });

        expect(result).toMatchObject({
            message: [text('visible text')],
            alt_message: 'visible text',
        });
        expect(validateMediaFileUrl).not.toHaveBeenCalled();
        expect(issuers.issueImageFileId).not.toHaveBeenCalled();
        expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
        expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
    });

    it('accepts hidden symbol metadata without evaluating it', () => {
        const hidden = vi.fn(() => {
            throw new Error('hidden metadata must not be read');
        });
        const media = video();
        Object.setPrototypeOf(media, null);
        Object.setPrototypeOf(media.data, null);
        Object.defineProperty(media, Symbol('internal'), { enumerable: false, get: hidden });
        Object.defineProperty(media.data, Symbol('internal-data'), {
            enumerable: false,
            get: hidden,
        });
        const issuers = issuerFixtures();
        const result = convertV11Event(received('group', [media]), self, {
            ...issuers,
            validateMediaFileUrl: budgetValidator(),
        });
        expect(result).toMatchObject({
            message: [{ type: 'video', data: { file_id: videoId } }],
            alt_message: '[视频]',
        });
        expect(hidden).not.toHaveBeenCalled();
    });

    it('rejects malformed video, accessors, public extras, proxies and mixed unsupported segments before callbacks', () => {
        const getter = vi.fn(() => {
            throw new Error('media getter must not run');
        });
        const trap = vi.fn((): never => {
            throw new Error('proxy trap must not run');
        });
        const handlers = {
            get: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            getPrototypeOf: trap,
        };
        const hiddenType = { data: video().data };
        Object.defineProperty(hiddenType, 'type', { value: 'video', enumerable: false });
        const inheritedType = Object.assign(Object.create({ type: 'video' }), {
            data: video().data,
        });
        const typeGetter = { data: video().data };
        Object.defineProperty(typeGetter, 'type', { enumerable: true, get: getter });
        const hiddenData = { type: 'video' };
        Object.defineProperty(hiddenData, 'data', { value: video().data, enumerable: false });
        const dataGetter = { type: 'video' };
        Object.defineProperty(dataGetter, 'data', { enumerable: true, get: getter });
        const hiddenFile = video();
        Object.defineProperty(hiddenFile.data, 'file', { value: file, enumerable: false });
        const hiddenUrl = video();
        Object.defineProperty(hiddenUrl.data, 'url', { value: videoUrl, enumerable: false });
        const inheritedFile = {
            type: 'video',
            data: Object.assign(Object.create({ file }), { url: videoUrl }),
        };
        const inheritedUrl = {
            type: 'video',
            data: Object.assign(Object.create({ url: videoUrl }), { file }),
        };
        const fileGetter = video();
        Object.defineProperty(fileGetter.data, 'file', { enumerable: true, get: getter });
        const urlGetter = video();
        Object.defineProperty(urlGetter.data, 'url', { enumerable: true, get: getter });
        const hiddenAccessor = video();
        Object.defineProperty(hiddenAccessor.data, 'hidden-extra', { get: getter });
        const publicSymbol = video();
        Object.defineProperty(publicSymbol, Symbol('public'), { enumerable: true, value: 1 });
        const publicDataSymbol = video();
        Object.defineProperty(publicDataSymbol.data, Symbol('public'), {
            enumerable: true,
            value: 1,
        });
        const badText = text('text');
        Object.defineProperty(badText.data, 'text', { enumerable: true, get: getter });
        const badMention = at('42');
        Object.defineProperty(badMention.data, 'qq', { enumerable: true, get: getter });
        const invalid: Array<[string, unknown]> = [
            ['missing type', { data: video().data }],
            ['hidden type', hiddenType],
            ['inherited type', inheritedType],
            ['type accessor', typeGetter],
            ['missing data', { type: 'video' }],
            ['hidden data', hiddenData],
            ['data accessor', dataGetter],
            ['missing file', { type: 'video', data: { url: videoUrl } }],
            ['missing URL', { type: 'video', data: { file } }],
            ['hidden file', hiddenFile],
            ['hidden URL', hiddenUrl],
            ['inherited file', inheritedFile],
            ['inherited URL', inheritedUrl],
            ['file accessor', fileGetter],
            ['URL accessor', urlGetter],
            ['hidden string accessor', hiddenAccessor],
            ['empty URL', video('')],
            ['non-string file', { type: 'video', data: { file: null, url: videoUrl } }],
            ['non-string URL', { type: 'video', data: { file, url: 1 } }],
            ['extra segment field', { ...video(), extra: true }],
            ['extra data URL', { type: 'video', data: { file, url: videoUrl, thumb: videoUrl } }],
            ['extra data field', { type: 'video', data: { file, url: videoUrl, extra: true } }],
            ['public segment symbol', publicSymbol],
            ['public data symbol', publicDataSymbol],
            ['proxy video', new Proxy(video(), handlers)],
            ['proxy data', { type: 'video', data: new Proxy(video().data, handlers) }],
            ['bad text getter', badText],
            ['bad mention getter', badMention],
            ['unknown segment', { type: 'unsupported', data: {} }],
        ];

        for (const [name, candidate] of invalid) {
            const issuers = issuerFixtures();
            const validateMediaFileUrl = budgetValidator();
            const sentinel = Symbol('no event');
            let result: unknown = sentinel;
            expect(() => {
                result = convertV11Event(
                    received('group', [image(), voice(), video(), candidate]),
                    self,
                    { ...issuers, validateMediaFileUrl },
                );
            }, name).toThrow();
            expect(result, name).toBe(sentinel);
            expect(validateMediaFileUrl, name).not.toHaveBeenCalled();
            expect(issuers.issueImageFileId, name).not.toHaveBeenCalled();
            expect(issuers.issueVoiceFileId, name).not.toHaveBeenCalled();
            expect(issuers.issueVideoFileId, name).not.toHaveBeenCalled();
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects proxy arrays, accessor indices and holes without issuing any media', () => {
        const trap = vi.fn((): never => {
            throw new Error('array trap must not run');
        });
        const getter = vi.fn(() => video());
        const proxy = new Proxy([video()], {
            get: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            getPrototypeOf: trap,
        });
        const accessor = [video(), image()];
        Object.defineProperty(accessor, '1', { enumerable: true, get: getter });
        const hole = [video(), image()];
        Reflect.deleteProperty(hole, '1');

        for (const message of [proxy, accessor, hole]) {
            const issuers = issuerFixtures();
            const validateMediaFileUrl = budgetValidator();
            expect(() =>
                convertV11Event(received('group', message), self, {
                    ...issuers,
                    validateMediaFileUrl,
                }),
            ).toThrow();
            expect(validateMediaFileUrl).not.toHaveBeenCalled();
            expect(issuers.issueImageFileId).not.toHaveBeenCalled();
            expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
            expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
        }

        expect(trap).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
    });

    it('preflights a later unsealable video URL before issuing any kind of handle', () => {
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const invalidUrl = 'ftp://media.example.invalid/video?secret=synthetic';
        let failure: unknown;

        try {
            convertV11Event(received('private', [image(), voice(), video(invalidUrl)]), self, {
                ...issuers,
                validateMediaFileUrl,
            });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('invalid V12 media file URL');
        expect((failure as Error).message).not.toContain(invalidUrl);
        expect(validateMediaFileUrl.mock.calls).toEqual([[imageUrl], [voiceUrl], [invalidUrl]]);
        expect(issuers.issueImageFileId).not.toHaveBeenCalled();
        expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
        expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
    });

    it('preflights an individually oversized UTF-8 video URL before any media issuance', () => {
        const base = 'https://media.example.invalid/🪶?payload=';
        const oversized = base + 'x'.repeat(3001 - Buffer.byteLength(base, 'utf8'));
        expect(Buffer.byteLength(oversized, 'utf8')).toBe(3001);
        expect(isV12SealableFileUrl(oversized)).toBe(false);
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();

        expect(() =>
            convertV11Event(received('group', [voice(), video(oversized), image()]), self, {
                ...issuers,
                validateMediaFileUrl,
            }),
        ).toThrow('invalid V12 media file URL');
        expect(validateMediaFileUrl.mock.calls).toEqual([[voiceUrl], [oversized]]);
        expect(issuers.issueImageFileId).not.toHaveBeenCalled();
        expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
        expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
    });

    it('sanitizes a throwing mixed-media validator without issuing any handles', () => {
        const issuers = issuerFixtures();
        const validateMediaFileUrl = vi.fn((url: string) => {
            if (url === videoUrl) {
                throw new Error(`synthetic failure ${url}`);
            }

            return true;
        });
        const sentinel = Symbol('no event');
        let result: unknown = sentinel;
        let failure: unknown;

        try {
            result = convertV11Event(received('private', [image(), voice(), video()]), self, {
                ...issuers,
                validateMediaFileUrl,
            });
        } catch (error) {
            failure = error;
        }

        expect(result).toBe(sentinel);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('invalid V12 media file URL');
        expect((failure as Error).message).not.toContain(videoUrl);
        expect(validateMediaFileUrl.mock.calls).toEqual([[imageUrl], [voiceUrl], [videoUrl]]);
        expect(issuers.issueImageFileId).not.toHaveBeenCalled();
        expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
        expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
    });

    it.each(['image', 'voice', 'video'] as const)(
        'requires the %s issuer before any validator or issuer callback',
        (missing) => {
            const issuers = issuerFixtures();
            const validateMediaFileUrl = budgetValidator();
            const options = {
                issueImageFileId:
                    missing === 'image'
                        ? (undefined as unknown as (url: string) => string)
                        : issuers.issueImageFileId,
                issueVoiceFileId: missing === 'voice' ? undefined : issuers.issueVoiceFileId,
                issueVideoFileId: missing === 'video' ? undefined : issuers.issueVideoFileId,
                validateMediaFileUrl,
            };
            expect(() =>
                convertV11Event(received('group', [video(), voice(), image()]), self, options),
            ).toThrow('unsupported or invalid V11 message segment');
            expect(validateMediaFileUrl).not.toHaveBeenCalled();
            expect(issuers.issueImageFileId).not.toHaveBeenCalled();
            expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
            expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
        },
    );

    it.each(['empty', 'oversized', 'non-string', 'throws'] as const)(
        'returns no partial event when a later video issuer is %s',
        (failureKind) => {
            const log: string[] = [];
            const issuers = issuerFixtures(log);
            const failure = new Error('synthetic video issuer failure');
            const issueVideoFileId = vi.fn((url: string): unknown => {
                log.push(`video:${url}`);

                if (failureKind === 'throws') {
                    throw failure;
                }

                return failureKind === 'empty'
                    ? ''
                    : failureKind === 'oversized'
                      ? 'x'.repeat(4097)
                      : null;
            });
            const sentinel = Symbol('no event');
            let result: unknown = sentinel;
            let thrown: unknown;

            try {
                result = convertV11Event(
                    received('group', [image(), voice(), video(), image()]),
                    self,
                    {
                        ...issuers,
                        issueVideoFileId: issueVideoFileId as (url: string) => string,
                        validateMediaFileUrl: budgetValidator(),
                    },
                );
            } catch (error) {
                thrown = error;
            }

            expect(result).toBe(sentinel);
            expect(thrown).toBeInstanceOf(Error);

            if (failureKind === 'throws') {
                expect(thrown).toBe(failure);
            } else {
                expect((thrown as Error).message).toBe('invalid V12 video file id');
            }

            // Earlier callbacks have already consumed their effects; there is no
            // rollback claim, and the final image must not be issued.
            expect(log).toEqual([`image:${imageUrl}`, `voice:${voiceUrl}`, `video:${videoUrl}`]);
            expect(issuers.issueImageFileId).toHaveBeenCalledTimes(1);
            expect(issuers.issueVoiceFileId).toHaveBeenCalledTimes(1);
            expect(issueVideoFileId).toHaveBeenCalledTimes(1);
        },
    );

    it('snapshots URLs, identity and all callbacks before validator reentry mutates the input', () => {
        const picture = image();
        const audio = voice();
        const movie = video();
        const input = received('group', [movie, picture, at('42'), audio]);
        const account = { ...self };
        const log: string[] = [];
        const issuers = issuerFixtures(log);
        const replacement = vi.fn((_url: string) => 'replacement');
        const replacementValidator = vi.fn((_url: string) => false);
        let nested: unknown;
        let calls = 0;
        const validateMediaFileUrl = vi.fn((url: string) => {
            log.push(`validate:${url}`);
            calls += 1;

            if (calls === 1) {
                nested = convertV11Event(received('private', [text('nested')]), self);
                input.time = 1;
                input.post_type = 'message_sent';
                input.user_id = 999;
                input.group_id = 999;
                input.message = [text('replacement')];
                movie.data.url = 'changed-video';
                picture.data.url = 'changed-image';
                audio.data.url = 'changed-voice';
                account.user_id = '999';
                options.issueImageFileId = replacement;
                options.issueVoiceFileId = replacement;
                options.issueVideoFileId = replacement;
                Object.defineProperty(options, 'validateMediaFileUrl', {
                    configurable: true,
                    value: replacementValidator,
                });
            }

            return isV12SealableFileUrl(url);
        });
        const readValidator = vi.fn(() => validateMediaFileUrl);
        const options = { ...issuers, validateMediaFileUrl };
        Object.defineProperty(options, 'validateMediaFileUrl', {
            configurable: true,
            get: readValidator,
        });
        const result = convertV11Event(input, account, options);

        expect(nested).toMatchObject({ message: [text('nested')] });
        expect(result).toMatchObject({
            time: 1700000000.25,
            self,
            detail_type: 'group',
            user_id: '42',
            group_id: '43',
            message: [
                { type: 'video', data: { file_id: videoId } },
                { type: 'image', data: { file_id: imageId } },
                { type: 'mention', data: { user_id: '42' } },
                { type: 'voice', data: { file_id: voiceId } },
            ],
            alt_message: '[视频][图片]@42[语音]',
        });
        expect(log).toEqual([
            `validate:${videoUrl}`,
            `validate:${imageUrl}`,
            `validate:${voiceUrl}`,
            `video:${videoUrl}`,
            `image:${imageUrl}`,
            `voice:${voiceUrl}`,
        ]);
        expect(readValidator).toHaveBeenCalledTimes(1);
        expect(replacementValidator).not.toHaveBeenCalled();
        expect(replacement).not.toHaveBeenCalled();
    });

    it('keeps later image and voice snapshots when the video issuer reenters and mutates input', () => {
        const movie = video();
        const picture = image();
        const audio = voice();
        const input = received('group', [movie, picture, audio]);
        const account = { ...self };
        const log: string[] = [];
        const issuers = issuerFixtures(log);
        const replacement = vi.fn((_url: string) => 'replacement');
        let nested: unknown;
        const issueVideoFileId = vi.fn((url: string) => {
            log.push(`video:${url}`);
            nested = convertV11Event(received('private', [text('nested')]), self);
            input.time = 1;
            input.post_type = 'message_sent';
            input.message = [text('replacement')];
            account.user_id = '999';
            picture.data.url = 'changed-image';
            audio.data.url = 'changed-voice';
            options.issueImageFileId = replacement;
            options.issueVoiceFileId = replacement;
            return videoId;
        });
        const options = { ...issuers, issueVideoFileId, validateMediaFileUrl: budgetValidator() };
        const result = convertV11Event(input, account, options);

        expect(nested).toMatchObject({ message: [text('nested')] });
        expect(result).toMatchObject({
            time: 1700000000.25,
            self,
            detail_type: 'group',
            message: [
                { type: 'video', data: { file_id: videoId } },
                { type: 'image', data: { file_id: imageId } },
                { type: 'voice', data: { file_id: voiceId } },
            ],
            alt_message: '[视频][图片][语音]',
        });
        expect(log).toEqual([`video:${videoUrl}`, `image:${imageUrl}`, `voice:${voiceUrl}`]);
        expect(replacement).not.toHaveBeenCalled();
    });

    it.each([128, 129])('uses one injected media count budget for %i mixed segments', (count) => {
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const source = Array.from({ length: count }, (_, index) =>
            index % 3 === 0 ? image() : index % 3 === 1 ? voice() : video(),
        );
        const sentinel = Symbol('no event');
        let result: unknown = sentinel;
        let failed = false;

        try {
            result = convertV11Event(received('group', source), self, {
                ...issuers,
                validateMediaFileUrl,
            });
        } catch {
            failed = true;
        }

        expect(validateMediaFileUrl).toHaveBeenCalledTimes(count);

        if (count === 128) {
            expect(failed).toBe(false);
            expect(result).toMatchObject({ type: 'message', message: expect.any(Array) });
            const message = (result as { message: unknown[] }).message;
            expect(message).toHaveLength(count);
            expect(issuers.issueImageFileId).toHaveBeenCalledTimes(43);
            expect(issuers.issueVoiceFileId).toHaveBeenCalledTimes(43);
            expect(issuers.issueVideoFileId).toHaveBeenCalledTimes(42);
        } else {
            expect(failed).toBe(true);
            expect(result).toBe(sentinel);
            expect(issuers.issueImageFileId).not.toHaveBeenCalled();
            expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
            expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
        }
    });

    it('counts only media, not the containing array length or intervening text', () => {
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const message = [...Array.from({ length: 129 }, () => text('')), video()];
        const result = convertV11Event(received('private', message), self, {
            ...issuers,
            validateMediaFileUrl,
        });
        expect(result).toMatchObject({ alt_message: '[视频]' });
        expect((result as { message: unknown[] }).message).toHaveLength(130);
        expect(validateMediaFileUrl).toHaveBeenCalledExactlyOnceWith(videoUrl);
        expect(issuers.issueVideoFileId).toHaveBeenCalledTimes(1);
    });

    it.each([262144, 262145])('shares one injected UTF-8 URL budget at %i bytes', (total) => {
        const base = 'https://media.example.invalid/🪶?payload=';

        const urlOfBytes = (length: number) => {
            const padding = length - Buffer.byteLength(base, 'utf8');

            if (padding < 0) {
                throw new Error('invalid fixture length');
            }

            return base + 'x'.repeat(padding);
        };

        const lengths = [...Array.from({ length: 87 }, () => 3000), total - 87 * 3000];
        const urls = lengths.map(urlOfBytes);
        const source = urls.map((url, index) =>
            index % 3 === 0 ? image(url) : index % 3 === 1 ? voice(url) : video(url),
        );
        expect(urls).toHaveLength(88);
        expect(urls.reduce((sum, url) => sum + Buffer.byteLength(url, 'utf8'), 0)).toBe(total);
        expect(urls.reduce((sum, url) => sum + url.length, 0)).toBeLessThan(total);
        expect(urls.every((url) => isV12SealableFileUrl(url))).toBe(true);
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const sentinel = Symbol('no event');
        let result: unknown = sentinel;
        let failed = false;

        try {
            result = convertV11Event(received('group', source), self, {
                ...issuers,
                validateMediaFileUrl,
            });
        } catch {
            failed = true;
        }

        expect(validateMediaFileUrl).toHaveBeenCalledTimes(88);

        if (total === 262144) {
            expect(failed).toBe(false);
            expect((result as { message: unknown[] }).message).toHaveLength(88);
            expect(issuers.issueImageFileId).toHaveBeenCalledTimes(30);
            expect(issuers.issueVoiceFileId).toHaveBeenCalledTimes(29);
            expect(issuers.issueVideoFileId).toHaveBeenCalledTimes(29);
        } else {
            expect(failed).toBe(true);
            expect(result).toBe(sentinel);
            expect(issuers.issueImageFileId).not.toHaveBeenCalled();
            expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
            expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
        }
    });

    it('keeps legacy image and voice conversion without reading an unused video issuer', () => {
        const issuers = issuerFixtures();
        const readVideoIssuer = vi.fn(() => {
            throw new Error('unused video issuer must not be read');
        });
        const options = { ...issuers };
        Object.defineProperty(options, 'issueVideoFileId', { get: readVideoIssuer });
        const result = convertV11Event(received('private', [image(), voice()]), self, options);
        expect(result).toMatchObject({
            message: [
                { type: 'image', data: { file_id: imageId } },
                { type: 'voice', data: { file_id: voiceId } },
            ],
            alt_message: '[图片][语音]',
        });
        expect(readVideoIssuer).not.toHaveBeenCalled();
        expect(issuers.issueImageFileId).toHaveBeenCalledExactlyOnceWith(imageUrl);
        expect(issuers.issueVoiceFileId).toHaveBeenCalledExactlyOnceWith(voiceUrl);
    });

    it.each([
        { message_type: 'private', sub_type: 'group' },
        { message_type: 'group', sub_type: 'anonymous' },
    ])('does not extend unsupported inbound subtype $sub_type', (fields) => {
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const input = { ...received('group', [video()]), ...fields };
        expect(() => convertV11Event(input, self, { ...issuers, validateMediaFileUrl })).toThrow();
        expect(validateMediaFileUrl).not.toHaveBeenCalled();
        expect(issuers.issueImageFileId).not.toHaveBeenCalled();
        expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
        expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
    });

    it.each(['private', 'group'] as const)('does not extend %s self echoes to video', (kind) => {
        const issuers = issuerFixtures();
        const validateMediaFileUrl = budgetValidator();
        const input = {
            ...received(kind, [video()]),
            post_type: 'message_sent',
            user_id: 10001,
            ...(kind === 'private' ? { target_id: 42 } : {}),
        };
        expect(() => convertV11Event(input, self, { ...issuers, validateMediaFileUrl })).toThrow();
        expect(validateMediaFileUrl).not.toHaveBeenCalled();
        expect(issuers.issueImageFileId).not.toHaveBeenCalled();
        expect(issuers.issueVoiceFileId).not.toHaveBeenCalled();
        expect(issuers.issueVideoFileId).not.toHaveBeenCalled();
    });
});
