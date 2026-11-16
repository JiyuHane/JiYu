import { describe, expect, it, vi } from 'vitest';
import { convertV11Event } from '../../src/v12/events';
import type { V12CoreOptions, V12MessageSegment, V12VoiceSegment } from '../../src/v12/types';

// Pure synthetic fixtures: issuing an ID here is only an in-memory observation.
// V11 record -> V12 voice is a lossy projection, not proof of QQ media or playback.
const self = { platform: 'qq', user_id: '10001' };
const imageUrl = 'synthetic-image-url?secret=image';
const voiceUrl = 'synthetic-voice-url?secret=voice';
const secondVoiceUrl = 'synthetic-second-voice-url?secret=voice2';
const privateFile = 'synthetic-private-file';
const imageId = 'image-id';
const voiceId = 'voice-id';
const secondVoiceId = 'voice-id-two';

const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: string) => ({ type: 'at', data: { qq } });
const image = (url = imageUrl, file = privateFile) => ({
    type: 'image',
    data: { file, url, sub_type: 0, summary: '' },
});
const record = (url = voiceUrl, file = privateFile) => ({
    type: 'record',
    data: { file, url },
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

function issuers() {
    const calls: string[] = [];
    const issueImageFileId = vi.fn((url: string) => {
        calls.push(`image:${url}`);
        return imageId;
    });
    const issueVoiceFileId = vi.fn((url: string) => {
        calls.push(`voice:${url}`);
        return url === secondVoiceUrl ? secondVoiceId : voiceId;
    });
    return { calls, issueImageFileId, issueVoiceFileId };
}

describe('v11 observable record to v12 voice: pure converter', () => {
    it.each(['private', 'group'] as const)(
        'projects ordered text, mentions, images and voices for %s',
        (kind) => {
            const input = received(kind, [
                text('literal [CQ:at,qq=42] '),
                record(),
                at('42'),
                image(),
                record(secondVoiceUrl, ''),
                at('all'),
                text('!'),
            ]);
            const before = structuredClone(input);
            const { calls, issueImageFileId, issueVoiceFileId } = issuers();
            const result = convertV11Event(input, self, { issueImageFileId, issueVoiceFileId });

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
                    text('literal [CQ:at,qq=42] '),
                    { type: 'voice', data: { file_id: voiceId } },
                    { type: 'mention', data: { user_id: '42' } },
                    { type: 'image', data: { file_id: imageId } },
                    { type: 'voice', data: { file_id: secondVoiceId } },
                    { type: 'mention_all', data: {} },
                    text('!'),
                ],
                alt_message: 'literal [CQ:at,qq=42] [语音]@42[图片][语音]@全体成员!',
            });
            expect(calls).toEqual([
                `voice:${voiceUrl}`,
                `image:${imageUrl}`,
                `voice:${secondVoiceUrl}`,
            ]);
            expect(input).toEqual(before);
            const output = JSON.stringify(result);
            expect(output).not.toContain(imageUrl);
            expect(output).not.toContain(voiceUrl);
            expect(output).not.toContain(secondVoiceUrl);
            expect(output).not.toContain(privateFile);
            expect(output).not.toContain('secret=');
        },
    );

    it('exposes the voice type and optional resolver contract without running a resolver', () => {
        const voice: V12VoiceSegment = { type: 'voice', data: { file_id: voiceId } };
        const general: V12MessageSegment = voice;
        const resolve: NonNullable<V12CoreOptions['resolveVoiceFileUrl']> = (_fileId) => null;
        expect(general).toEqual({ type: 'voice', data: { file_id: voiceId } });
        expect(typeof resolve).toBe('function');
    });

    it('accepts an empty file and forwards nonempty URLs unchanged to the issuer', () => {
        // Both HTTP syntax and UTF-8 byte limits are the issuer's responsibility.
        const unvalidatedUrl = 'not-http:' + '语'.repeat(1100);
        const id = '🪶'.repeat(2048);
        expect(id.length).toBe(4096);
        const issueImageFileId = vi.fn((_url: string) => imageId);
        const issueVoiceFileId = vi.fn((_url: string) => id);
        const result = convertV11Event(received('private', [record(unvalidatedUrl, '')]), self, {
            issueImageFileId,
            issueVoiceFileId,
        });

        expect(result).toMatchObject({
            message: [{ type: 'voice', data: { file_id: id } }],
            alt_message: '[语音]',
        });
        expect(issueVoiceFileId).toHaveBeenCalledExactlyOnceWith(unvalidatedUrl);
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it.each(['image', 'voice'] as const)(
        'accepts a one-character %s ID and never reads the unused issuer',
        (kind) => {
            const unused = vi.fn(() => {
                throw new Error('unused issuer must not be read');
            });
            const issueImageFileId = vi.fn((_url: string) => 'i');
            const issueVoiceFileId = vi.fn((_url: string) => 'v');
            const options = { issueImageFileId, issueVoiceFileId };
            Object.defineProperty(
                options,
                kind === 'image' ? 'issueVoiceFileId' : 'issueImageFileId',
                { get: unused },
            );
            const result = convertV11Event(
                received('private', [kind === 'image' ? image() : record()]),
                self,
                options,
            );

            expect(result).toMatchObject({
                message: [{ type: kind, data: { file_id: kind === 'image' ? 'i' : 'v' } }],
                alt_message: kind === 'image' ? '[图片]' : '[语音]',
            });
            expect(unused).not.toHaveBeenCalled();
            expect(issueImageFileId).toHaveBeenCalledTimes(kind === 'image' ? 1 : 0);
            expect(issueVoiceFileId).toHaveBeenCalledTimes(kind === 'voice' ? 1 : 0);
        },
    );

    it('accepts hidden symbols without inspecting their values, including on null prototypes', () => {
        const hidden = vi.fn(() => {
            throw new Error('hidden symbol must not be read');
        });
        const media = record();
        Object.setPrototypeOf(media, null);
        Object.setPrototypeOf(media.data, null);
        Object.defineProperty(media, Symbol('internal'), { enumerable: false, get: hidden });
        Object.defineProperty(media.data, Symbol('internal-data'), {
            enumerable: false,
            get: hidden,
        });
        const input = received('group', [media]);
        Object.defineProperty(input, Symbol('internal-event'), { enumerable: false, get: hidden });
        const { issueImageFileId, issueVoiceFileId } = issuers();

        expect(convertV11Event(input, self, { issueImageFileId, issueVoiceFileId })).toMatchObject({
            message: [{ type: 'voice', data: { file_id: voiceId } }],
            alt_message: '[语音]',
        });
        expect(issueVoiceFileId).toHaveBeenCalledExactlyOnceWith(voiceUrl);
        expect(issueImageFileId).not.toHaveBeenCalled();
        expect(hidden).not.toHaveBeenCalled();
    });

    it('validates every segment before even reading either issuer', () => {
        const getter = vi.fn(() => {
            throw new Error('accessor must not run');
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
        const missingType = { data: record().data };
        const hiddenType = { data: record().data };
        Object.defineProperty(hiddenType, 'type', { value: 'record', enumerable: false });
        const inheritedType = Object.assign(Object.create({ type: 'record' }), {
            data: record().data,
        });
        const getterType = { data: record().data };
        Object.defineProperty(getterType, 'type', { enumerable: true, get: getter });
        const missingData = { type: 'record' };
        const hiddenData = { type: 'record' };
        Object.defineProperty(hiddenData, 'data', { value: record().data, enumerable: false });
        const getterData = { type: 'record' };
        Object.defineProperty(getterData, 'data', { enumerable: true, get: getter });
        const inheritedData = Object.assign(Object.create({ data: record().data }), {
            type: 'record',
        });
        const hiddenFile = record();
        Object.defineProperty(hiddenFile.data, 'file', { value: privateFile, enumerable: false });
        const hiddenUrl = record();
        Object.defineProperty(hiddenUrl.data, 'url', { value: voiceUrl, enumerable: false });
        const inheritedFile = {
            type: 'record',
            data: Object.assign(Object.create({ file: privateFile }), { url: voiceUrl }),
        };
        const inheritedUrl = {
            type: 'record',
            data: Object.assign(Object.create({ url: voiceUrl }), { file: privateFile }),
        };
        const fileGetter = record();
        Object.defineProperty(fileGetter.data, 'file', { enumerable: true, get: getter });
        const urlGetter = record();
        Object.defineProperty(urlGetter.data, 'url', { enumerable: true, get: getter });
        const hiddenAccessor = record();
        Object.defineProperty(hiddenAccessor.data, 'hidden-accessor', { get: getter });
        const publicSymbol = record();
        Object.defineProperty(publicSymbol, Symbol('extra'), { enumerable: true, value: 1 });
        const publicDataSymbol = record();
        Object.defineProperty(publicDataSymbol.data, Symbol('extra'), {
            enumerable: true,
            value: 1,
        });
        const badText = text('placeholder');
        Object.defineProperty(badText.data, 'text', { enumerable: true, get: getter });
        const badAt = at('42');
        Object.defineProperty(badAt.data, 'qq', { enumerable: true, get: getter });
        const badTextData = text('placeholder');
        Object.defineProperty(badTextData, 'data', { enumerable: true, get: getter });
        const badAtData = at('42');
        Object.defineProperty(badAtData, 'data', { enumerable: true, get: getter });

        const invalid: Array<[string, unknown]> = [
            ['missing type', missingType],
            ['hidden type', hiddenType],
            ['inherited type', inheritedType],
            ['type accessor', getterType],
            ['missing data', missingData],
            ['hidden data', hiddenData],
            ['data accessor', getterData],
            ['inherited data', inheritedData],
            ['proxied segment', new Proxy(record(), handlers)],
            ['proxied data', { type: 'record', data: new Proxy(record().data, handlers) }],
            ['public segment symbol', publicSymbol],
            ['public data symbol', publicDataSymbol],
            ['hidden string accessor', hiddenAccessor],
            ['missing file', { type: 'record', data: { url: voiceUrl } }],
            ['missing URL', { type: 'record', data: { file: privateFile } }],
            ['hidden file', hiddenFile],
            ['hidden URL', hiddenUrl],
            ['inherited file', inheritedFile],
            ['inherited URL', inheritedUrl],
            ['file accessor', fileGetter],
            ['URL accessor', urlGetter],
            ['empty URL', record('')],
            ['non-string file', { type: 'record', data: { file: null, url: voiceUrl } }],
            ['non-string URL', { type: 'record', data: { file: '', url: 0 } }],
            ['extra segment field', { ...record(), extra: true }],
            ['extra data field', { type: 'record', data: { ...record().data, extra: true } }],
            ['malformed image', { type: 'image', data: { file: '', url: imageUrl } }],
            ['text accessor', badText],
            ['mention accessor', badAt],
            ['text data accessor', badTextData],
            ['mention data accessor', badAtData],
            ['unknown segment', { type: 'unknown', data: {} }],
        ];

        for (const [name, bad] of invalid) {
            const { issueImageFileId, issueVoiceFileId } = issuers();
            const readImageIssuer = vi.fn(() => issueImageFileId);
            const readVoiceIssuer = vi.fn(() => issueVoiceFileId);
            const validateMediaFileUrl = vi.fn((_url: string) => true);
            const readValidator = vi.fn(() => validateMediaFileUrl);
            const options = { issueImageFileId, issueVoiceFileId, validateMediaFileUrl };
            Object.defineProperty(options, 'issueImageFileId', { get: readImageIssuer });
            Object.defineProperty(options, 'issueVoiceFileId', { get: readVoiceIssuer });
            Object.defineProperty(options, 'validateMediaFileUrl', { get: readValidator });
            const sentinel = Symbol('no event');
            let result: unknown = sentinel;

            expect(() => {
                result = convertV11Event(
                    received('group', [image(), record(), bad, text('after')]),
                    self,
                    options,
                );
            }, name).toThrow();
            expect(result, name).toBe(sentinel);
            expect(readImageIssuer, name).not.toHaveBeenCalled();
            expect(readVoiceIssuer, name).not.toHaveBeenCalled();
            expect(readValidator, name).not.toHaveBeenCalled();
            expect(validateMediaFileUrl, name).not.toHaveBeenCalled();
            expect(issueImageFileId, name).not.toHaveBeenCalled();
            expect(issueVoiceFileId, name).not.toHaveBeenCalled();
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
    });

    it.each(['image', 'voice'] as const)(
        'rejects a missing %s issuer before issuing either kind, regardless of source order',
        (missing) => {
            for (const message of [
                [image(), record()],
                [record(), image()],
            ]) {
                const { issueImageFileId, issueVoiceFileId } = issuers();
                const validateMediaFileUrl = vi.fn((_url: string) => true);
                const readValidator = vi.fn(() => validateMediaFileUrl);
                const options = {
                    issueImageFileId:
                        missing === 'image'
                            ? (undefined as unknown as (url: string) => string)
                            : issueImageFileId,
                    issueVoiceFileId: missing === 'voice' ? undefined : issueVoiceFileId,
                    validateMediaFileUrl,
                };
                Object.defineProperty(options, 'validateMediaFileUrl', { get: readValidator });
                const sentinel = Symbol('no event');
                let result: unknown = sentinel;
                expect(() => {
                    result = convertV11Event(received('private', message), self, options);
                }).toThrow();
                expect(result).toBe(sentinel);
                expect(readValidator).not.toHaveBeenCalled();
                expect(validateMediaFileUrl).not.toHaveBeenCalled();
                expect(issueImageFileId).not.toHaveBeenCalled();
                expect(issueVoiceFileId).not.toHaveBeenCalled();
            }
        },
    );

    it('rejects a voice segment without options or without its corresponding issuer', () => {
        expect(() => convertV11Event(received('private', [record()]), self)).toThrow();
        const issueImageFileId = vi.fn((_url: string) => imageId);
        expect(() =>
            convertV11Event(received('group', [record()]), self, { issueImageFileId }),
        ).toThrow();
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it('preflights every mixed-media URL before either issuer and requires true', () => {
        for (const badResult of [false, null, undefined, 1, 'true']) {
            const { issueImageFileId, issueVoiceFileId } = issuers();
            const validate = vi.fn((url: string): unknown => (url === imageUrl ? true : badResult));
            const sentinel = Symbol('no event');
            let result: unknown = sentinel;
            let failure: unknown;

            try {
                result = convertV11Event(received('group', [image(), record()]), self, {
                    issueImageFileId,
                    issueVoiceFileId,
                    validateMediaFileUrl: validate as (url: string) => boolean,
                });
            } catch (error) {
                failure = error;
            }

            expect(result).toBe(sentinel);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toBe('invalid V12 media file URL');
            expect((failure as Error).message).not.toContain(voiceUrl);
            expect(validate.mock.calls).toEqual([[imageUrl], [voiceUrl]]);
            expect(issueImageFileId).not.toHaveBeenCalled();
            expect(issueVoiceFileId).not.toHaveBeenCalled();
        }
    });

    it.each(['image', 'voice'] as const)(
        'preflights snapshotted URLs in order when a %s-first validator reenters and mutates input',
        (firstKind) => {
            const picture = image();
            const voice = record();
            const input = received('group', [
                text('before '),
                firstKind === 'image' ? picture : voice,
                at('42'),
                firstKind === 'image' ? voice : picture,
            ]);
            const account = { ...self };
            const log: string[] = [];
            let nested: unknown;
            const replacement = vi.fn((_url: string) => 'replacement-id');
            const replacementValidator = vi.fn((_url: string) => false);
            const issueImageFileId = vi.fn((url: string) => {
                log.push(`image:${url}`);
                return imageId;
            });
            const issueVoiceFileId = vi.fn((url: string) => {
                log.push(`voice:${url}`);
                return voiceId;
            });
            let validationCount = 0;
            const validateMediaFileUrl = vi.fn((url: string) => {
                log.push(`validate:${url}`);
                validationCount += 1;

                if (validationCount === 1) {
                    nested = convertV11Event(received('private', [text('nested')]), self);
                    input.time = 1;
                    input.post_type = 'message_sent';
                    input.user_id = 999;
                    input.message = [text('replacement')];
                    picture.data.url = 'changed-image';
                    voice.data.url = 'changed-voice';
                    account.user_id = '999';
                    options.issueImageFileId = replacement;
                    options.issueVoiceFileId = replacement;
                    Object.defineProperty(options, 'validateMediaFileUrl', {
                        configurable: true,
                        value: replacementValidator,
                    });
                }

                return true;
            });
            const readValidator = vi.fn(() => validateMediaFileUrl);
            const options = { issueImageFileId, issueVoiceFileId, validateMediaFileUrl };
            Object.defineProperty(options, 'validateMediaFileUrl', {
                configurable: true,
                get: readValidator,
            });
            const result = convertV11Event(input, account, options);
            const firstUrl = firstKind === 'image' ? imageUrl : voiceUrl;
            const secondUrl = firstKind === 'image' ? voiceUrl : imageUrl;
            const firstSegment =
                firstKind === 'image'
                    ? { type: 'image', data: { file_id: imageId } }
                    : { type: 'voice', data: { file_id: voiceId } };
            const secondSegment =
                firstKind === 'image'
                    ? { type: 'voice', data: { file_id: voiceId } }
                    : { type: 'image', data: { file_id: imageId } };

            expect(nested).toMatchObject({ message: [text('nested')], alt_message: 'nested' });
            expect(result).toMatchObject({
                time: 1700000000.25,
                self,
                detail_type: 'group',
                user_id: '42',
                message: [
                    text('before '),
                    firstSegment,
                    { type: 'mention', data: { user_id: '42' } },
                    secondSegment,
                ],
                alt_message:
                    firstKind === 'image' ? 'before [图片]@42[语音]' : 'before [语音]@42[图片]',
            });
            expect(log).toEqual([
                `validate:${firstUrl}`,
                `validate:${secondUrl}`,
                `${firstKind}:${firstUrl}`,
                `${firstKind === 'image' ? 'voice' : 'image'}:${secondUrl}`,
            ]);
            expect(readValidator).toHaveBeenCalledTimes(1);
            expect(validateMediaFileUrl).toHaveBeenCalledTimes(2);
            expect(replacementValidator).not.toHaveBeenCalled();
            expect(replacement).not.toHaveBeenCalled();
        },
    );

    it('sanitizes validator and validator-getter failures before invoking either issuer', () => {
        for (const failOnRead of [false, true]) {
            const { issueImageFileId, issueVoiceFileId } = issuers();
            const validateMediaFileUrl = vi.fn((url: string) => {
                if (url === voiceUrl) {
                    throw new Error(`synthetic validator failure: ${url}`);
                }

                return true;
            });
            const options = { issueImageFileId, issueVoiceFileId, validateMediaFileUrl };
            const readValidator = vi.fn(() => {
                if (failOnRead) {
                    throw new Error(`synthetic getter failure: ${voiceUrl}`);
                }

                return validateMediaFileUrl;
            });
            Object.defineProperty(options, 'validateMediaFileUrl', { get: readValidator });
            const sentinel = Symbol('no event');
            let result: unknown = sentinel;
            let failure: unknown;

            try {
                result = convertV11Event(received('group', [image(), record()]), self, options);
            } catch (error) {
                failure = error;
            }

            expect(result).toBe(sentinel);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toBe('invalid V12 media file URL');
            expect((failure as Error).message).not.toContain(voiceUrl);
            expect(readValidator).toHaveBeenCalledTimes(1);
            expect(validateMediaFileUrl).toHaveBeenCalledTimes(failOnRead ? 0 : 2);
            expect(issueImageFileId).not.toHaveBeenCalled();
            expect(issueVoiceFileId).not.toHaveBeenCalled();
        }
    });

    it.each(['image', 'voice'] as const)(
        'rejects invalid %s IDs and preserves already-consumed issuance effects',
        (badKind) => {
            for (const badValue of ['', 'x'.repeat(4097), null, 5, { then: 'not a string' }]) {
                const calls: string[] = [];
                const bad = vi.fn((url: string): unknown => {
                    calls.push(`${badKind}:${url}`);
                    return badValue;
                });
                const goodKind = badKind === 'image' ? 'voice' : 'image';
                const good = vi.fn((url: string) => {
                    calls.push(`${goodKind}:${url}`);
                    return 'one-consumed-nonce';
                });
                const issueImageFileId = (badKind === 'image' ? bad : good) as (
                    url: string,
                ) => string;
                const issueVoiceFileId = (badKind === 'voice' ? bad : good) as (
                    url: string,
                ) => string;
                const first = badKind === 'image' ? record() : image();
                const second = badKind === 'image' ? image() : record();
                const third = badKind === 'image' ? record(secondVoiceUrl) : image('later-image');
                const firstUrl = badKind === 'image' ? voiceUrl : imageUrl;
                const badUrl = badKind === 'image' ? imageUrl : voiceUrl;
                const sentinel = Symbol('no event');
                let result: unknown = sentinel;

                expect(() => {
                    result = convertV11Event(received('group', [first, second, third]), self, {
                        issueImageFileId,
                        issueVoiceFileId,
                    });
                }).toThrow(`invalid V12 ${badKind} file id`);
                expect(result).toBe(sentinel);
                expect(calls).toEqual([`${goodKind}:${firstUrl}`, `${badKind}:${badUrl}`]);
                expect(good).toHaveBeenCalledTimes(1);
                expect(bad).toHaveBeenCalledTimes(1);
            }
        },
    );

    it.each(['image', 'voice'] as const)(
        'propagates a failing %s callback without publishing a partial event',
        (badKind) => {
            const calls: string[] = [];
            const failure = new Error('synthetic issuer failure');
            const bad = vi.fn((url: string): string => {
                calls.push(`bad:${url}`);
                throw failure;
            });
            const good = vi.fn((url: string) => {
                calls.push(`good:${url}`);
                return 'consumed';
            });
            const first = badKind === 'image' ? record() : image();
            const second = badKind === 'image' ? image() : record();
            const issueImageFileId = badKind === 'image' ? bad : good;
            const issueVoiceFileId = badKind === 'voice' ? bad : good;
            const sentinel = Symbol('no event');
            let result: unknown = sentinel;

            expect(() => {
                result = convertV11Event(received('private', [first, second, first]), self, {
                    issueImageFileId,
                    issueVoiceFileId,
                });
            }).toThrow(failure);
            expect(result).toBe(sentinel);
            expect(calls).toEqual([
                `good:${badKind === 'image' ? voiceUrl : imageUrl}`,
                `bad:${badKind === 'image' ? imageUrl : voiceUrl}`,
            ]);
            expect(good).toHaveBeenCalledTimes(1);
            expect(bad).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['image', 'voice'] as const)(
        'snapshots both kinds and callbacks before the first %s issuer mutates inputs',
        (firstKind) => {
            const originalText = text('original ');
            const mention = at('42');
            const picture = image();
            const voice = record();
            const first = firstKind === 'image' ? picture : voice;
            const second = firstKind === 'image' ? voice : picture;
            const input = received('group', [originalText, first, mention, second, text('!')]);
            const account = { ...self };
            const replacement = vi.fn((_url: string) => 'replacement-id');
            const calls: string[] = [];

            const mutate = () => {
                input.time = 1;
                input.self_id = 999;
                input.post_type = 'message_sent';
                input.message_type = 'private';
                input.sub_type = 'friend';
                input.message_id = 999;
                input.user_id = 999;
                input.group_id = 999;
                input.message = [text('replacement')];
                originalText.data.text = 'changed';
                mention.data.qq = 'all';
                picture.data.url = 'changed-image';
                voice.data.url = 'changed-voice';
                account.platform = 'changed';
                account.user_id = '999';
                options.issueImageFileId = replacement;
                options.issueVoiceFileId = replacement;
            };

            const issueImageFileId = vi.fn((url: string) => {
                calls.push(`image:${url}`);

                if (firstKind === 'image') {
                    mutate();
                }

                return imageId;
            });
            const issueVoiceFileId = vi.fn((url: string) => {
                calls.push(`voice:${url}`);

                if (firstKind === 'voice') {
                    mutate();
                }

                return voiceId;
            });
            const options = { issueImageFileId, issueVoiceFileId };
            const result = convertV11Event(input, account, options);
            const projectedFirst =
                firstKind === 'image'
                    ? { type: 'image', data: { file_id: imageId } }
                    : { type: 'voice', data: { file_id: voiceId } };
            const projectedSecond =
                firstKind === 'image'
                    ? { type: 'voice', data: { file_id: voiceId } }
                    : { type: 'image', data: { file_id: imageId } };

            expect(result).toEqual({
                id: expect.any(String),
                time: 1700000000.25,
                type: 'message',
                detail_type: 'group',
                sub_type: '',
                self,
                message_id: '-123',
                user_id: '42',
                group_id: '43',
                message: [
                    text('original '),
                    projectedFirst,
                    { type: 'mention', data: { user_id: '42' } },
                    projectedSecond,
                    text('!'),
                ],
                alt_message:
                    firstKind === 'image'
                        ? 'original [图片]@42[语音]!'
                        : 'original [语音]@42[图片]!',
            });
            expect(calls).toEqual(
                firstKind === 'image'
                    ? [`image:${imageUrl}`, `voice:${voiceUrl}`]
                    : [`voice:${voiceUrl}`, `image:${imageUrl}`],
            );
            expect(issueImageFileId).toHaveBeenCalledTimes(1);
            expect(issueVoiceFileId).toHaveBeenCalledTimes(1);
            expect(replacement).not.toHaveBeenCalled();
        },
    );

    it('retains self and reads post_type and time only once with a voice segment', () => {
        const account = { ...self };
        const input = received('private', [record()]);
        let postReads = 0;
        let timeReads = 0;
        const getPostType = vi.fn(() => (++postReads === 1 ? 'message' : 'message_sent'));
        const getTime = vi.fn(() => {
            account.user_id = '999';
            return ++timeReads === 1 ? 123 : -1;
        });
        Object.defineProperty(input, 'post_type', { enumerable: true, get: getPostType });
        Object.defineProperty(input, 'time', { enumerable: true, get: getTime });
        const { issueImageFileId, issueVoiceFileId } = issuers();
        const result = convertV11Event(input, account, { issueImageFileId, issueVoiceFileId });

        expect(result).toMatchObject({
            self,
            time: 123,
            message: [{ type: 'voice', data: { file_id: voiceId } }],
            alt_message: '[语音]',
        });
        expect(account.user_id).toBe('999');
        expect(getPostType).toHaveBeenCalledTimes(1);
        expect(getTime).toHaveBeenCalledTimes(1);
        expect(issueVoiceFileId).toHaveBeenCalledExactlyOnceWith(voiceUrl);
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it.each(['private', 'group'] as const)(
        'does not project a %s self echo containing a record',
        (kind) => {
            const input = {
                ...received(kind, [record()]),
                post_type: 'message_sent',
                user_id: 10001,
                ...(kind === 'private' ? { target_id: 42 } : {}),
            };
            const { issueImageFileId, issueVoiceFileId } = issuers();
            expect(() =>
                convertV11Event(input, self, { issueImageFileId, issueVoiceFileId }),
            ).toThrow();
            expect(issueImageFileId).not.toHaveBeenCalled();
            expect(issueVoiceFileId).not.toHaveBeenCalled();
        },
    );

    it.each([
        { message_type: 'private', sub_type: 'group' },
        { message_type: 'group', sub_type: 'anonymous' },
    ])('does not extend unsupported inbound message subtype $sub_type', (fields) => {
        const { issueImageFileId, issueVoiceFileId } = issuers();
        const input = { ...received('group', [record()]), ...fields };
        expect(() =>
            convertV11Event(input, self, { issueImageFileId, issueVoiceFileId }),
        ).toThrow();
        expect(issueImageFileId).not.toHaveBeenCalled();
        expect(issueVoiceFileId).not.toHaveBeenCalled();
    });
});
