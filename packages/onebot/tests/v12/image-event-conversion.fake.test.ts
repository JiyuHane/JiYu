import { describe, expect, it, vi } from 'vitest';
import { convertV11Event } from '../../src/v12/events';

// Pure converter fixtures: the issuer is synchronous and never opens a socket,
// reads a media store, or contacts an account or a file service.
const self = { platform: 'qq', user_id: '10001' };
const firstUrl = 'https://media.invalid/first?token=synthetic-first-secret';
const secondUrl = 'https://media.invalid/second?token=synthetic-second-secret';
const firstFile = 'synthetic-private-v11-file';
const firstId = 'issued-image-one';
const secondId = 'issued-image-two';

const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: string) => ({ type: 'at', data: { qq } });
const image = (url = firstUrl, file = firstFile, summary = '') => ({
    type: 'image',
    data: { file, url, sub_type: 0, summary },
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
        raw_message: 'CQ-escaped representation; not the alt text',
    };
}

function issuer() {
    return vi.fn((url: string) => {
        if (url === firstUrl) {
            return firstId;
        }

        if (url === secondUrl) {
            return secondId;
        }

        throw new Error('unexpected fixture URL');
    });
}

describe('v11 ordinary inbound image to v12: pure converter', () => {
    it.each(['private', 'group'] as const)(
        'preserves ordered text, mentions and ordinary images for %s',
        (kind) => {
            const issueImageFileId = issuer();
            const literal = '[CQ:at,qq=42] & &#91;,]';
            const input = received(kind, [
                text(literal),
                image(firstUrl, firstFile, ''),
                at('42'),
                image(secondUrl, '', '[图片]'),
                at('all'),
                text('!'),
            ]);
            const before = structuredClone(input);
            const result = convertV11Event(input, self, { issueImageFileId });

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
                    text(literal),
                    { type: 'image', data: { file_id: firstId } },
                    { type: 'mention', data: { user_id: '42' } },
                    { type: 'image', data: { file_id: secondId } },
                    { type: 'mention_all', data: {} },
                    text('!'),
                ],
                alt_message: `${literal}[图片]@42[图片]@全体成员!`,
            });
            expect(issueImageFileId.mock.calls).toEqual([[firstUrl], [secondUrl]]);
            expect(input).toEqual(before);
            const output = JSON.stringify(result);
            expect(output).not.toContain(firstUrl);
            expect(output).not.toContain(secondUrl);
            expect(output).not.toContain(firstFile);
            expect(output).not.toContain('synthetic-first-secret');
            expect(output).not.toContain('synthetic-second-secret');
        },
    );

    it('accepts a 4096 UTF-16-unit ID and forwards a nonempty URL unchanged', () => {
        const id = '🪶'.repeat(2048);
        expect(id.length).toBe(4096);
        // URL syntax and reachability are issuer responsibilities, not established
        // by this converter test. Empty v11 file is permitted when url is present.
        const observedUrl = 'not-a-validated-url';
        const issueImageFileId = vi.fn((_url: string) => id);
        const result = convertV11Event(received('private', [image(observedUrl, '')]), self, {
            issueImageFileId,
        });

        expect(result).toMatchObject({
            message: [{ type: 'image', data: { file_id: id } }],
            alt_message: '[图片]',
        });
        expect(issueImageFileId).toHaveBeenCalledExactlyOnceWith(observedUrl);
    });

    it('allows hidden input and media symbols without reading their values', () => {
        const secret = vi.fn(() => {
            throw new Error('private symbol must not be evaluated');
        });
        const media = image();
        const input = received('group', [media]);
        Object.defineProperty(input, Symbol('input-private'), { enumerable: false, get: secret });
        Object.defineProperty(media, Symbol('message media snapshot'), {
            enumerable: false,
            get: secret,
        });
        Object.defineProperty(media.data, Symbol('media-data-private'), {
            enumerable: false,
            get: secret,
        });
        const issueImageFileId = issuer();

        expect(convertV11Event(input, self, { issueImageFileId })).toMatchObject({
            message: [{ type: 'image', data: { file_id: firstId } }],
            alt_message: '[图片]',
        });
        expect(issueImageFileId).toHaveBeenCalledExactlyOnceWith(firstUrl);
        expect(secret).not.toHaveBeenCalled();
    });

    it('validates the complete segment list before invoking the issuer', () => {
        const getter = vi.fn(() => {
            throw new Error('image accessor must not run');
        });
        const trap = vi.fn((): never => {
            throw new Error('image proxy trap must not run');
        });
        const proxyHandlers = {
            get: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            getPrototypeOf: trap,
        };

        const missingType = { data: image().data };
        const hiddenType = { data: image().data };
        Object.defineProperty(hiddenType, 'type', { value: 'image', enumerable: false });
        const inheritedType = Object.assign(Object.create({ type: 'image' }), {
            data: image().data,
        });
        const getterType = { data: image().data };
        Object.defineProperty(getterType, 'type', { enumerable: true, get: getter });
        const inheritedGetterType = Object.assign(
            Object.create(Object.defineProperty({}, 'type', { enumerable: true, get: getter })),
            { data: image().data },
        );
        const hiddenData = { type: 'image' };
        Object.defineProperty(hiddenData, 'data', { value: image().data, enumerable: false });
        const getterData = { type: 'image' };
        Object.defineProperty(getterData, 'data', { enumerable: true, get: getter });
        const inheritedData = Object.assign(Object.create({ data: image().data }), {
            type: 'image',
        });
        const proxiedImage = new Proxy(image(), proxyHandlers);
        const proxiedData = { type: 'image', data: new Proxy(image().data, proxyHandlers) };
        const symbolOuter = image();
        Object.defineProperty(symbolOuter, Symbol('public-extra'), { enumerable: true, value: 1 });
        const symbolData = image();
        Object.defineProperty(symbolData.data, Symbol('public-extra'), {
            enumerable: true,
            value: 1,
        });
        const accessorFields = (['file', 'url', 'sub_type', 'summary'] as const).map((field) => {
            const candidate = image();
            Object.defineProperty(candidate.data, field, { enumerable: true, get: getter });
            return candidate;
        });
        const missingFile = { type: 'image', data: { url: firstUrl, sub_type: 0, summary: '' } };
        const missingUrl = { type: 'image', data: { file: firstFile, sub_type: 0, summary: '' } };
        const hiddenUrl = image();
        Object.defineProperty(hiddenUrl.data, 'url', { value: firstUrl, enumerable: false });
        const inheritedUrl = {
            type: 'image',
            data: Object.assign(Object.create({ url: firstUrl }), {
                file: firstFile,
                sub_type: 0,
                summary: '',
            }),
        };

        const invalid: Array<[string, unknown]> = [
            ['missing type', missingType],
            ['hidden type', hiddenType],
            ['inherited type', inheritedType],
            ['type getter', getterType],
            ['inherited type getter', inheritedGetterType],
            ['hidden data', hiddenData],
            ['data getter', getterData],
            ['inherited data', inheritedData],
            ['proxied image', proxiedImage],
            ['proxied data', proxiedData],
            ['enumerable segment symbol', symbolOuter],
            ['enumerable data symbol', symbolData],
            ...accessorFields.map((candidate, index): [string, unknown] => [
                `data field getter ${index}`,
                candidate,
            ]),
            ['missing file', missingFile],
            ['missing URL', missingUrl],
            ['hidden URL', hiddenUrl],
            ['inherited URL', inheritedUrl],
            ['empty URL', image('', firstFile)],
            ['non-string file', { type: 'image', data: { ...image().data, file: 1 } }],
            ['non-string URL', { type: 'image', data: { ...image().data, url: null } }],
            ['extra segment field', { ...image(), extra: true }],
            ['extra data field', { type: 'image', data: { ...image().data, extra: true } }],
            ['flash image', { type: 'image', data: { ...image().data, type: 'flash' } }],
            [
                'market face',
                {
                    type: 'image',
                    data: { ...image().data, emoji_id: 'fixture', emoji_package_id: 1, key: 'k' },
                },
            ],
            ['nonzero subtype', { type: 'image', data: { ...image().data, sub_type: 1 } }],
            ['string subtype', { type: 'image', data: { ...image().data, sub_type: '0' } }],
            ['custom summary', image(firstUrl, firstFile, '[动画表情]')],
            ['unknown segment', { type: 'unknown', data: {} }],
            ['voice segment', { type: 'record', data: { file: 'voice' } }],
            ['video segment', { type: 'video', data: { file: 'video' } }],
        ];

        for (const [name, bad] of invalid) {
            const issueImageFileId = issuer();
            const input = received('group', [text('before'), image(), bad, text('after')]);
            expect(() => convertV11Event(input, self, { issueImageFileId }), name).toThrow();
            expect(issueImageFileId, name).not.toHaveBeenCalled();
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects a text data getter without letting it change type or masquerade as a mention', () => {
        const candidate = { type: 'text', data: {} as Record<string, unknown> };
        const getData = vi.fn(() => {
            candidate.type = 'image';
            return { qq: 'all' };
        });
        Object.defineProperty(candidate, 'data', { enumerable: true, get: getData });
        const issueImageFileId = issuer();
        // A preceding valid image must not be issued when a later segment fails.
        const input = received('group', [image(), candidate]);
        const sentinel = Symbol('no event returned');
        let result: unknown = sentinel;

        expect(() => {
            result = convertV11Event(input, self, { issueImageFileId });
        }).toThrow();
        expect(result).toBe(sentinel);
        expect(getData).not.toHaveBeenCalled();
        expect(candidate.type).toBe('text');
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it('rejects a text getter without letting it change the source type to at', () => {
        const candidate = text('placeholder');
        const getText = vi.fn(() => {
            candidate.type = 'at';
            return 'fixed [CQ:at,qq=all] & text';
        });
        Object.defineProperty(candidate.data, 'text', { enumerable: true, get: getText });
        const issueImageFileId = issuer();
        const sentinel = Symbol('no event returned');
        let result: unknown = sentinel;

        expect(() => {
            result = convertV11Event(received('private', [candidate]), self, { issueImageFileId });
        }).toThrow();
        expect(result).toBe(sentinel);
        expect(getText).not.toHaveBeenCalled();
        expect(candidate.type).toBe('text');
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it.each(['data', 'qq'] as const)(
        'rejects an at segment %s getter without executing it or issuing an image ID',
        (field) => {
            const candidate = at('42');
            const getter = vi.fn(() => (field === 'data' ? { qq: 'all' } : 'all'));

            if (field === 'data') {
                Object.defineProperty(candidate, 'data', { enumerable: true, get: getter });
            } else {
                Object.defineProperty(candidate.data, 'qq', { enumerable: true, get: getter });
            }

            const issueImageFileId = issuer();
            expect(() =>
                convertV11Event(received('group', [image(), candidate]), self, {
                    issueImageFileId,
                }),
            ).toThrow();
            expect(getter).not.toHaveBeenCalled();
            expect(issueImageFileId).not.toHaveBeenCalled();
        },
    );

    it('does not let a text data getter rewrite a later flash image as text', () => {
        const flash = { type: 'image', data: { ...image().data, type: 'flash' } };
        const candidate = { type: 'text', data: {} as Record<string, unknown> };
        const getData = vi.fn(() => {
            Reflect.set(flash, 'type', 'text');
            Reflect.set(flash, 'data', { text: 'rewritten flash' });
            return { text: 'seemingly harmless' };
        });
        Object.defineProperty(candidate, 'data', { enumerable: true, get: getData });
        const issueImageFileId = issuer();
        const sentinel = Symbol('no event returned');
        let result: unknown = sentinel;

        expect(() => {
            result = convertV11Event(received('group', [candidate, flash]), self, {
                issueImageFileId,
            });
        }).toThrow();
        expect(result).toBe(sentinel);
        expect(getData).not.toHaveBeenCalled();
        expect(flash.type).toBe('image');
        expect(flash.data.type).toBe('flash');
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it.each(['text', 'qq'] as const)(
        'does not let a %s getter rewrite a later flash image as text',
        (field) => {
            const flash = { type: 'image', data: { ...image().data, type: 'flash' } };
            const candidate = field === 'text' ? text('placeholder') : at('42');
            const getter = vi.fn(() => {
                Reflect.set(flash, 'type', 'text');
                Reflect.set(flash, 'data', { text: 'rewritten flash' });
                return field === 'text' ? 'seemingly harmless' : 'all';
            });
            Object.defineProperty(candidate.data, field, { enumerable: true, get: getter });
            const issueImageFileId = issuer();
            const sentinel = Symbol('no event returned');
            let result: unknown = sentinel;

            expect(() => {
                result = convertV11Event(received('group', [candidate, flash]), self, {
                    issueImageFileId,
                });
            }).toThrow();
            expect(result).toBe(sentinel);
            expect(getter).not.toHaveBeenCalled();
            expect(flash.type).toBe('image');
            expect(flash.data.type).toBe('flash');
            expect(issueImageFileId).not.toHaveBeenCalled();
        },
    );

    it.each([
        {
            kind: 'image',
            message: [image()],
            projected: [{ type: 'image', data: { file_id: firstId } }],
            alt: '[图片]',
            issuerCalls: 1,
        },
        {
            kind: 'text',
            message: [text('literal text')],
            projected: [text('literal text')],
            alt: 'literal text',
            issuerCalls: 0,
        },
    ])('snapshots the validated time exactly once for $kind', (fixture) => {
        const input = received('private', fixture.message);
        let reads = 0;
        const getTime = vi.fn(() => (++reads === 1 ? 123 : -1));
        Object.defineProperty(input, 'time', { enumerable: true, get: getTime });
        const issueImageFileId = issuer();
        const result = convertV11Event(input, self, { issueImageFileId });

        expect(result).toMatchObject({
            time: 123,
            message: fixture.projected,
            alt_message: fixture.alt,
        });
        expect(getTime).toHaveBeenCalledTimes(1);
        expect(issueImageFileId).toHaveBeenCalledTimes(fixture.issuerCalls);

        if (fixture.kind === 'image') {
            expect(issueImageFileId).toHaveBeenCalledExactlyOnceWith(firstUrl);
        }
    });

    it('retains the captured self when the time getter mutates the caller identity', () => {
        const suppliedSelf = { platform: 'qq', user_id: '10001' };
        const input = received('private', [image()]);
        const getTime = vi.fn(() => {
            suppliedSelf.user_id = '10002';
            return 123;
        });
        Object.defineProperty(input, 'time', { enumerable: true, get: getTime });
        const issueImageFileId = issuer();
        const result = convertV11Event(input, suppliedSelf, { issueImageFileId });

        expect(result).toMatchObject({
            self: { platform: 'qq', user_id: '10001' },
            time: 123,
            message: [{ type: 'image', data: { file_id: firstId } }],
            alt_message: '[图片]',
        });
        expect(input.self_id).toBe(10001);
        expect(suppliedSelf.user_id).toBe('10002');
        expect(getTime).toHaveBeenCalledTimes(1);
        expect(issueImageFileId).toHaveBeenCalledExactlyOnceWith(firstUrl);
    });

    it('reads the message container once when its getter changes from text to image', () => {
        const input = received('private', []);
        const firstMessage = [text('first [&]')];
        const laterMessage = [image()];
        let reads = 0;
        const getMessage = vi.fn(() => (++reads === 1 ? firstMessage : laterMessage));
        Object.defineProperty(input, 'message', { enumerable: true, get: getMessage });
        const issueImageFileId = issuer();
        const result = convertV11Event(input, self, { issueImageFileId });

        expect(result).toMatchObject({
            message: [text('first [&]')],
            alt_message: 'first [&]',
        });
        expect(getMessage).toHaveBeenCalledTimes(1);
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it('rejects a Proxy message array without executing its traps', () => {
        const trap = vi.fn((): never => {
            throw new Error('message array proxy trap must not run');
        });
        const proxiedMessage = new Proxy([text('not inspected')], {
            get: trap,
            has: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            getPrototypeOf: trap,
        });
        const issueImageFileId = issuer();
        const input = received('group', proxiedMessage);

        expect(() => convertV11Event(input, self, { issueImageFileId })).toThrow(
            'invalid V11 message event',
        );
        expect(trap).not.toHaveBeenCalled();
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it.each(['value', 'getter'] as const)(
        'rejects the actual flash image without invoking a fake %s iterator',
        (form) => {
            const flash = { type: 'image', data: { ...image().data, type: 'flash' } };
            const source = [flash];
            const fakeIterator = vi.fn(() => [text('fake safe text')].values());
            const getIterator = vi.fn(() => fakeIterator);

            Object.defineProperty(
                source,
                Symbol.iterator,
                form === 'value'
                    ? { value: fakeIterator, configurable: true }
                    : { get: getIterator, configurable: true },
            );
            const issueImageFileId = issuer();

            expect(() =>
                convertV11Event(received('group', source), self, { issueImageFileId }),
            ).toThrow();
            expect(getIterator).not.toHaveBeenCalled();
            expect(fakeIterator).not.toHaveBeenCalled();
            expect(issueImageFileId).not.toHaveBeenCalled();
        },
    );

    it('uses dense own indices without reading a custom iterator getter', () => {
        const source = [text('actual '), image()];
        const fakeIterator = vi.fn(() => [text('fake safe text')].values());
        const getIterator = vi.fn(() => fakeIterator);
        Object.defineProperty(source, Symbol.iterator, { get: getIterator, configurable: true });
        const issueImageFileId = issuer();
        const result = convertV11Event(received('group', source), self, { issueImageFileId });

        expect(result).toMatchObject({
            message: [text('actual '), { type: 'image', data: { file_id: firstId } }],
            alt_message: 'actual [图片]',
        });
        expect(getIterator).not.toHaveBeenCalled();
        expect(fakeIterator).not.toHaveBeenCalled();
        expect(issueImageFileId).toHaveBeenCalledExactlyOnceWith(firstUrl);
    });

    it('rejects an accessor array index without invoking it or issuing an image ID', () => {
        const source = [text('placeholder')];
        const getIndex = vi.fn(() => image());
        Object.defineProperty(source, '0', { enumerable: true, configurable: true, get: getIndex });
        const issueImageFileId = issuer();

        expect(() =>
            convertV11Event(received('group', source), self, { issueImageFileId }),
        ).toThrow();
        expect(getIndex).not.toHaveBeenCalled();
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it('rejects an array hole before issuing an image ID', () => {
        const source = [text('placeholder'), image()];
        Reflect.deleteProperty(source, '0');
        const issueImageFileId = issuer();

        expect(() =>
            convertV11Event(received('group', source), self, { issueImageFileId }),
        ).toThrow();
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it('preserves non-enumerable own data indices at their original positions', () => {
        const source = [text('hidden '), image()];
        Object.defineProperty(source, '0', { enumerable: false });
        Object.defineProperty(source, '1', { enumerable: false });
        const issueImageFileId = issuer();
        const result = convertV11Event(received('group', source), self, { issueImageFileId });

        expect(result).toMatchObject({
            message: [text('hidden '), { type: 'image', data: { file_id: firstId } }],
            alt_message: 'hidden [图片]',
        });
        expect(issueImageFileId).toHaveBeenCalledExactlyOnceWith(firstUrl);
    });

    it.each([4096, 4097])('accepts %d dense own text indices', (count) => {
        const source = Array.from({ length: count }, () => text(''));
        const issueImageFileId = issuer();
        const result = convertV11Event(received('private', source), self, { issueImageFileId });

        if (!result || result.type !== 'message') {
            throw new Error('expected converted message event');
        }

        expect(result.message).toHaveLength(count);
        expect(result.alt_message).toBe('');
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it('reads post_type once and rejects a private self echo without a target', () => {
        const input = { ...received('private', [image()]), user_id: 10001 };
        let reads = 0;
        const getPostType = vi.fn(() => (++reads === 1 ? 'message_sent' : 'message'));
        Object.defineProperty(input, 'post_type', { enumerable: true, get: getPostType });
        const issueImageFileId = issuer();
        const sentinel = Symbol('no event returned');
        let result: unknown = sentinel;

        expect(Object.hasOwn(input, 'target_id')).toBe(false);
        expect(() => {
            result = convertV11Event(input, self, { issueImageFileId });
        }).toThrow();
        expect(result).toBe(sentinel);
        expect(getPostType).toHaveBeenCalledTimes(1);
        expect(issueImageFileId).not.toHaveBeenCalled();
    });

    it.each(['private', 'group'] as const)(
        'does not extend %s message_sent image semantics',
        (kind) => {
            const issueImageFileId = issuer();
            const sent = {
                ...received(kind, [image()]),
                post_type: 'message_sent',
                user_id: 10001,
                ...(kind === 'private' ? { target_id: 42 } : {}),
            };
            expect(() => convertV11Event(sent, self, { issueImageFileId })).toThrow();
            expect(issueImageFileId).not.toHaveBeenCalled();
        },
    );

    it('rejects an image when no issuer was supplied', () => {
        expect(() => convertV11Event(received('private', [image()]), self)).toThrow();
        expect(() =>
            convertV11Event(received('group', [image()]), self, {
                issueImageFileId: undefined as unknown as (url: string) => string,
            }),
        ).toThrow();
    });

    it.each(['empty', 'oversized', 'throws'] as const)(
        'does not return a partial event when a later issuer result is %s',
        (failure) => {
            const issueImageFileId = vi.fn((url: string) => {
                if (url === firstUrl) {
                    return firstId;
                }

                if (failure === 'throws') {
                    throw new Error('synthetic issuance failure');
                }

                return failure === 'empty' ? '' : 'x'.repeat(4097);
            });
            const sentinel = Symbol('no event returned');
            let published: unknown = sentinel;
            const input = received('group', [
                text('before'),
                image(),
                image(secondUrl),
                text('after'),
            ]);

            expect(() => {
                published = convertV11Event(input, self, { issueImageFileId });
            }).toThrow();
            expect(published).toBe(sentinel);
            expect(issueImageFileId.mock.calls).toEqual([[firstUrl], [secondUrl]]);
            // This proves no partial event was returned, not rollback of any
            // side effect the issuer itself performed for the first image.
        },
    );

    it('snapshots a private auto-reply marker before the issuer mutates the input', () => {
        const input = { ...received('private', [image()]), auto_reply: true };
        const issueImageFileId = vi.fn((url: string) => {
            expect(url).toBe(firstUrl);
            input.auto_reply = false;
            input.user_id = 999;
            input.time = 1;
            input.message = [text('replacement')];
            return firstId;
        });

        expect(convertV11Event(input, self, { issueImageFileId })).toMatchObject({
            time: 1700000000.25,
            detail_type: 'private',
            user_id: '42',
            message: [{ type: 'image', data: { file_id: firstId } }],
            alt_message: '[图片]',
            'qq.auto_reply': true,
        });
        expect(issueImageFileId).toHaveBeenCalledExactlyOnceWith(firstUrl);
    });

    it('keeps validated event fields and every URL snapshot when the issuer mutates its inputs', () => {
        const originalText = text('original ');
        const first = image();
        const mention = at('42');
        const second = image(secondUrl, '', '[图片]');
        const input = received('group', [originalText, first, mention, second]);
        const mutableSelf = { ...self };
        const issueImageFileId = vi.fn((url: string) => {
            if (url === firstUrl) {
                input.time = 1;
                input.self_id = 999;
                input.message_id = 999;
                input.user_id = 999;
                input.group_id = 999;
                input.message_type = 'private';
                input.sub_type = 'friend';
                originalText.data.text = 'changed';
                first.data.url = 'changed-first';
                mention.data.qq = 'all';
                second.data.url = 'changed-second';
                input.message = [text('replacement')];
                mutableSelf.platform = 'changed';
                mutableSelf.user_id = '999';
                return firstId;
            }

            return secondId;
        });

        const result = convertV11Event(input, mutableSelf, { issueImageFileId });
        expect(issueImageFileId.mock.calls).toEqual([[firstUrl], [secondUrl]]);
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
                { type: 'image', data: { file_id: firstId } },
                { type: 'mention', data: { user_id: '42' } },
                { type: 'image', data: { file_id: secondId } },
            ],
            alt_message: 'original [图片]@42[图片]',
        });
    });
});
