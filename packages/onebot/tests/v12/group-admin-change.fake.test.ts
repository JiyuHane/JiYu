import { describe, expect, it, vi } from 'vitest';
import { convertEvent } from '../../src/event-converter';
import { convertV11Event } from '../../src/v12/events';

// Synthetic protocol events only; the converter does not establish QQ origin.
const self = { platform: 'qq', user_id: '10001' };
const context = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: null,
    mediaSegmentSink: null,
};

function sourceEvent(set: boolean) {
    return {
        kind: 'group_admin' as const,
        time: 1700000000.5,
        selfUin: 10001,
        groupId: 43,
        userUin: 42,
        set,
    };
}

async function v11Event(set = true): Promise<Record<string, unknown>> {
    const result = await convertEvent(context, sourceEvent(set));

    if (!result) {
        throw new Error('synthetic group admin event was not converted to V11');
    }

    return result;
}

function expected(isAdmin: boolean) {
    return {
        id: expect.any(String),
        time: 1700000000.5,
        type: 'notice',
        detail_type: 'qq.group_admin_change',
        sub_type: '',
        self,
        group_id: '43',
        user_id: '42',
        is_admin: isAdmin,
    };
}

describe('V11 group admin to the Jiyu V12 extension', () => {
    it.each([true, false])(
        'projects the real V11 converter result for set=%s without an invented operator',
        async (set) => {
            const source = sourceEvent(set);
            const sourceBefore = structuredClone(source);
            const v11 = await convertEvent(context, source);
            expect(v11).toEqual({
                time: 1700000000.5,
                self_id: 10001,
                post_type: 'notice',
                notice_type: 'group_admin',
                sub_type: set ? 'set' : 'unset',
                group_id: 43,
                user_id: 42,
            });
            const before = structuredClone(v11);
            const result = convertV11Event(v11, self);
            expect(result).toEqual(expected(set));
            expect(result!.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expect(convertV11Event(v11, self)!.id).not.toBe(result!.id);
            expect(Object.hasOwn(result!, 'operator_id')).toBe(false);
            expect(Object.hasOwn(result!, 'qq.operator_id')).toBe(false);
            expect(v11).toEqual(before);
            expect(source).toEqual(sourceBefore);
        },
    );

    it('preserves canonical positive safe-integer group, user, and account IDs', async () => {
        const v11 = await v11Event();

        for (const id of [1, '1', Number.MAX_SAFE_INTEGER, '9007199254740991']) {
            const account = { platform: 'qq', user_id: String(id) };
            const result = convertV11Event(
                { ...v11, self_id: id, group_id: id, user_id: id },
                account,
            );
            expect(result).toMatchObject({
                self: account,
                group_id: String(id),
                user_id: String(id),
                is_admin: true,
            });
            expect(typeof result!.self!.user_id).toBe('string');
        }

        const other = { platform: 'qq', user_id: '20002' };
        const otherV11 = await convertEvent(
            { ...context, selfId: 20002 },
            { ...sourceEvent(false), selfUin: 20002, groupId: 99 },
        );
        expect(convertV11Event(otherV11, other)).toMatchObject({
            self: other,
            group_id: '99',
            user_id: '42',
            is_admin: false,
        });
        expect(() => convertV11Event(otherV11, self)).toThrow();
        expect(() => convertV11Event(v11, other)).toThrow();
    });

    it('rejects zero, noncanonical, unsafe, or missing group and user IDs', async () => {
        const v11 = await v11Event();
        const invalid = [
            undefined,
            null,
            0,
            -0,
            '0',
            '-0',
            -1,
            '-1',
            '01',
            ' 42',
            '42 ',
            '1e3',
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            '9007199254740992',
            false,
            {},
            [],
            1n,
        ];

        for (const field of ['group_id', 'user_id'] as const) {
            for (const value of invalid) {
                expect(() => convertV11Event({ ...v11, [field]: value }, self)).toThrow();
            }

            const absent = { ...v11 };
            delete absent[field];
            expect(() => convertV11Event(absent, self)).toThrow();
        }
    });

    it('validates account identity and restricts only this extension to QQ', async () => {
        const v11 = await v11Event();

        for (const id of [undefined, null, 0, '0', '010001', 10002, '10002', 1e20]) {
            expect(() => convertV11Event({ ...v11, self_id: id }, self)).toThrow();
        }

        for (const user_id of ['', '010001', '10002', 10001, null, undefined]) {
            expect(() => convertV11Event(v11, { platform: 'qq', user_id } as never)).toThrow();
        }

        expect(() => convertV11Event(v11, { platform: '', user_id: '10001' })).toThrow();
        expect(convertV11Event(v11, { platform: 'other', user_id: '10001' })).toBeNull();

        // The QQ restriction is not a new global restriction on existing events.
        expect(
            convertV11Event(
                {
                    time: 1,
                    self_id: 10001,
                    post_type: 'notice',
                    notice_type: 'friend_add',
                    user_id: 42,
                },
                { platform: 'other', user_id: '10001' },
            ),
        ).toMatchObject({
            detail_type: 'friend_increase',
            self: { platform: 'other', user_id: '10001' },
            user_id: '42',
        });
    });

    it.each([true, false])(
        'checks the source account before the platform restriction for set=%s',
        async (set) => {
            const v11 = await v11Event(set);
            const otherPlatform = { platform: 'other', user_id: '10001' };

            for (const self_id of [10001, '10001']) {
                expect(convertV11Event({ ...v11, self_id }, otherPlatform)).toBeNull();
            }

            for (const self_id of [0, '0', 10002, '10002']) {
                for (const account of [self, otherPlatform]) {
                    expect(() => convertV11Event({ ...v11, self_id }, account)).toThrow(
                        'V11 event account does not match V12 account',
                    );
                }
            }

            for (const platform of ['qq', 'other']) {
                expect(() => convertV11Event(v11, { platform, user_id: '10002' })).toThrow(
                    'V11 event account does not match V12 account',
                );
            }
        },
    );

    it.each([true, false])(
        'uses the captured source account when the platform getter reenters for set=%s',
        async (set) => {
            for (const { initial, changed, mismatch } of [
                { initial: 10002, changed: 10001, mismatch: true },
                { initial: 10001, changed: 10002, mismatch: false },
            ]) {
                const candidate = { ...(await v11Event(set)), self_id: initial };
                const account = { ...self };
                const getter = vi.fn(() => {
                    candidate.self_id = changed;
                    return 'other';
                });
                Object.defineProperty(account, 'platform', { enumerable: true, get: getter });
                expect(Object.getOwnPropertyDescriptor(candidate, 'self_id')).toMatchObject({
                    value: initial,
                    enumerable: true,
                });

                if (mismatch) {
                    expect(() => convertV11Event(candidate, account)).toThrow(
                        'V11 event account does not match V12 account',
                    );
                } else {
                    expect(convertV11Event(candidate, account)).toBeNull();
                }

                expect(getter).toHaveBeenCalledOnce();
                expect(candidate.self_id).toBe(changed);
            }
        },
    );

    it('accepts the existing finite nonnegative safe time range without replacing it', async () => {
        const v11 = await v11Event();

        for (const time of [0, 0.25, 1700000000.5, Number.MAX_SAFE_INTEGER]) {
            expect(convertV11Event({ ...v11, time }, self)).toMatchObject({ time });
        }

        for (const time of [
            undefined,
            null,
            -1,
            NaN,
            Infinity,
            -Infinity,
            '1',
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => convertV11Event({ ...v11, time }, self)).toThrow();
        }
    });

    it('rejects individually missing required fields after the event is recognized', async () => {
        const v11 = await v11Event();

        for (const field of ['time', 'self_id', 'group_id', 'user_id'] as const) {
            const missing = { ...v11 };
            delete missing[field];
            expect(() => convertV11Event(missing, self)).toThrow();
        }

        const missingPost = { ...v11 };
        delete missingPost.post_type;
        expect(() => convertV11Event(missingPost, self)).toThrow();
        const missingNotice = { ...v11 };
        delete missingNotice.notice_type;
        expect(convertV11Event(missingNotice, self)).toBeNull();
        const missingSubtype = { ...v11 };
        delete missingSubtype.sub_type;
        expect(convertV11Event(missingSubtype, self)).toBeNull();
    });

    it.each(['post_type', 'notice_type'] as const)(
        'preserves legacy handling for a hidden %s discriminator',
        async (field) => {
            const candidate = await v11Event();
            Object.defineProperty(candidate, field, {
                value: candidate[field],
                enumerable: false,
            });

            expect(convertV11Event(candidate, self)).toBeNull();
            candidate.self_id = 10002;
            expect(() => convertV11Event(candidate, self)).toThrow(
                'V11 event account does not match V12 account',
            );
        },
    );

    it('checks account identity before ignoring an unsupported subtype', async () => {
        const v11 = await v11Event();

        for (const sub_type of ['future', '', null, undefined]) {
            expect(() => convertV11Event({ ...v11, sub_type, self_id: 10002 }, self)).toThrow(
                'V11 event account does not match V12 account',
            );
        }

        const hidden = { ...v11, self_id: 10002 };
        Object.defineProperty(hidden, 'sub_type', { value: 'set', enumerable: false });
        expect(() => convertV11Event(hidden, self)).toThrow(
            'V11 event account does not match V12 account',
        );

        const getter = vi.fn(() => 'set');
        const accessor = { ...v11, self_id: 10002 };
        Object.defineProperty(accessor, 'sub_type', { enumerable: true, get: getter });
        expect(() => convertV11Event(accessor, self)).toThrow(
            'V11 event account does not match V12 account',
        );
        expect(getter).not.toHaveBeenCalled();
    });

    it('leaves other, hidden, missing, or accessor subtypes unsupported', async () => {
        const v11 = await v11Event();

        for (const sub_type of ['', 'future', 'SET', ' set ', 0, false, null, undefined]) {
            expect(convertV11Event({ ...v11, sub_type }, self)).toBeNull();
        }

        const hidden = { ...v11 };
        Object.defineProperty(hidden, 'sub_type', { value: 'set', enumerable: false });
        expect(convertV11Event(hidden, self)).toBeNull();

        const getter = vi.fn(() => 'set');
        const accessor = { ...v11 };
        Object.defineProperty(accessor, 'sub_type', { enumerable: true, get: getter });
        expect(convertV11Event(accessor, self)).toBeNull();
        expect(getter).not.toHaveBeenCalled();
    });

    it('rejects visible extras without invoking getters', async () => {
        const v11 = await v11Event();

        for (const extra of [
            { extra: false },
            { operator_id: 123 },
            { is_admin: true },
            { [Symbol('visible')]: 'extra' },
        ]) {
            expect(() => convertV11Event({ ...v11, ...extra }, self)).toThrow();
        }

        const getter = vi.fn(() => {
            throw new Error('extra getter executed');
        });
        const candidate = { ...v11 };
        Object.defineProperty(candidate, 'extra', { enumerable: true, get: getter });
        expect(() => convertV11Event(candidate, self)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it('ignores hidden data and symbols, but rejects a hidden string accessor', async () => {
        const v11 = await v11Event();
        const hiddenSymbolGetter = vi.fn(() => {
            throw new Error('hidden symbol getter executed');
        });
        const candidate = { ...v11 };
        Object.defineProperty(candidate, 'hidden_data', { value: 123, enumerable: false });
        Object.defineProperty(candidate, Symbol('hidden-data'), {
            value: 'internal',
            enumerable: false,
        });
        Object.defineProperty(candidate, Symbol('hidden-accessor'), {
            get: hiddenSymbolGetter,
            enumerable: false,
        });
        expect(convertV11Event(candidate, self)).toEqual(expected(true));
        expect(hiddenSymbolGetter).not.toHaveBeenCalled();

        const hiddenGetter = vi.fn(() => {
            throw new Error('hidden string getter executed');
        });
        Object.defineProperty(candidate, 'hidden_accessor', { get: hiddenGetter });
        expect(() => convertV11Event(candidate, self)).toThrow();
        expect(hiddenGetter).not.toHaveBeenCalled();
    });

    it.each(['time', 'self_id', 'group_id', 'user_id'] as const)(
        'rejects an identified candidate %s getter without executing it',
        async (field) => {
            const candidate = await v11Event();
            const getter = vi.fn(() => {
                throw new Error('required getter executed');
            });
            Object.defineProperty(candidate, field, { enumerable: true, get: getter });
            expect(() => convertV11Event(candidate, self)).toThrow();
            expect(getter).not.toHaveBeenCalled();
        },
    );

    it('avoids Proxy discovery traps while retaining the legacy top-level get path', async () => {
        const target = await v11Event();
        const discoveryTrap = vi.fn((): never => {
            throw new Error('unexpected proxy discovery');
        });
        const reads: PropertyKey[] = [];
        const proxy = new Proxy(target, {
            get(object, key, receiver) {
                reads.push(key);
                return Reflect.get(object, key, receiver);
            },
            ownKeys: discoveryTrap,
            getOwnPropertyDescriptor: discoveryTrap,
            getPrototypeOf: discoveryTrap,
        });

        expect(convertV11Event(proxy, self)).toBeNull();
        expect(discoveryTrap).not.toHaveBeenCalled();
        expect(reads).toContain('post_type');
        expect(reads).toContain('self_id');
        expect(reads).toContain('notice_type');
        expect(reads).not.toContain('sub_type');
        expect(reads).not.toContain('group_id');
        expect(reads).not.toContain('user_id');
    });

    it.each(['group_id', 'user_id'] as const)(
        'rejects a nested Proxy in %s without invoking its traps',
        async (field) => {
            const v11 = await v11Event();
            const trap = vi.fn((): never => {
                throw new Error('nested proxy trap executed');
            });
            const proxy = new Proxy(
                {},
                {
                    get: trap,
                    ownKeys: trap,
                    getOwnPropertyDescriptor: trap,
                    getPrototypeOf: trap,
                },
            );
            expect(() => convertV11Event({ ...v11, [field]: proxy }, self)).toThrow();
            expect(trap).not.toHaveBeenCalled();
        },
    );

    it.each(['platform', 'user_id'] as const)(
        'uses the captured admin event when the self %s getter changes the source',
        async (field) => {
            const candidate = await v11Event();
            const account = { ...self };
            const getter = vi.fn(() => {
                candidate.notice_type = 'friend_add';
                delete candidate.sub_type;
                delete candidate.group_id;
                candidate.user_id = 777;
                return self[field];
            });
            Object.defineProperty(account, field, { enumerable: true, get: getter });
            const result = convertV11Event(candidate, account);
            expect(result).toEqual(expected(true));
            expect(getter).toHaveBeenCalledOnce();
            expect(candidate.notice_type).toBe('friend_add');
            expect(candidate.user_id).toBe(777);
        },
    );

    it.each(['post_type', 'notice_type'] as const)(
        'does not create an admin projection after the %s getter self-replaces',
        async (field) => {
            const candidate = await v11Event();
            const value = candidate[field];
            const getter = vi.fn(() => {
                Object.defineProperty(candidate, field, {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value,
                });
                candidate.user_id = 777;
                return value;
            });
            Object.defineProperty(candidate, field, {
                configurable: true,
                enumerable: true,
                get: getter,
            });
            expect(convertV11Event(candidate, self)).toBeNull();
            expect(getter).toHaveBeenCalledOnce();
        },
    );

    it('keeps unrelated notices and the legacy message getter path unchanged', async () => {
        const v11 = await v11Event();

        for (const notice_type of ['notify', 'friend_recall', 'future']) {
            expect(convertV11Event({ ...v11, notice_type }, self)).toBeNull();
        }

        const postGetter = vi.fn(() => 'message');
        const message = {
            time: 1,
            self_id: 10001,
            notice_type: 'group_admin',
            sub_type: 'normal',
            message_type: 'group',
            message_id: 1,
            group_id: 43,
            user_id: 42,
            raw_message: 'fixture',
            message: [{ type: 'text', data: { text: 'fixture' } }],
        };
        Object.defineProperty(message, 'post_type', { enumerable: true, get: postGetter });
        expect(convertV11Event(message, self)).toMatchObject({
            type: 'message',
            detail_type: 'group',
            group_id: '43',
            user_id: '42',
        });
        expect(postGetter).toHaveBeenCalledOnce();
    });
});
