// Type-only consumer fixture. The companion fake test resolves this public
// package specifier to the source v12 index for an in-process compiler check.
// The separate package test compiles it against a fresh isolated SDK install.
import type {
    OneBot12Event,
    OneBot12JsonObject,
    OneBot12PlatformEvent,
    OneBot12QQGroupNameChangeEvent,
} from '@harehane/sdk/v12';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type GroupNameShape = {
    id: string;
    time: number;
    type: 'notice';
    detail_type: 'qq.group_name_change';
    sub_type: '';
    self: { platform: string; user_id: string };
    group_id: string;
    group_name: string;
};

type RequiredField = keyof GroupNameShape;
type Missing<K extends RequiredField> = IsAssignable<
    Omit<GroupNameShape, K>,
    OneBot12QQGroupNameChangeEvent
>;

export type GroupNameExtensionChecks = [
    Assert<IsAssignable<GroupNameShape, OneBot12QQGroupNameChangeEvent>>,
    Assert<IsAssignable<GroupNameShape & { operator_id: string }, OneBot12QQGroupNameChangeEvent>>,
    Assert<IsAssignable<OneBot12QQGroupNameChangeEvent, OneBot12PlatformEvent>>,
    Assert<IsAssignable<OneBot12QQGroupNameChangeEvent, OneBot12Event>>,
    Assert<IsAssignable<OneBot12QQGroupNameChangeEvent, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12QQGroupNameChangeEvent['operator_id'], string | undefined>>,
    Assert<IsAssignable<string | undefined, OneBot12QQGroupNameChangeEvent['operator_id']>>,
    Assert<
        IsAssignable<
            GroupNameShape & { 'x.extra': { nested: [true, null, string] } },
            OneBot12QQGroupNameChangeEvent
        >
    >,
    IsFalse<Missing<'id'>>,
    IsFalse<Missing<'time'>>,
    IsFalse<Missing<'type'>>,
    IsFalse<Missing<'detail_type'>>,
    IsFalse<Missing<'sub_type'>>,
    IsFalse<Missing<'self'>>,
    IsFalse<Missing<'group_id'>>,
    IsFalse<Missing<'group_name'>>,
    IsFalse<
        IsAssignable<
            Omit<GroupNameShape, 'type'> & { type: 'message' },
            OneBot12QQGroupNameChangeEvent
        >
    >,
    IsFalse<
        IsAssignable<
            Omit<GroupNameShape, 'detail_type'> & { detail_type: 'group_name_change' },
            OneBot12QQGroupNameChangeEvent
        >
    >,
    IsFalse<
        IsAssignable<
            Omit<GroupNameShape, 'sub_type'> & { sub_type: 'change' },
            OneBot12QQGroupNameChangeEvent
        >
    >,
    IsFalse<
        IsAssignable<
            Omit<GroupNameShape, 'group_id'> & { group_id: number },
            OneBot12QQGroupNameChangeEvent
        >
    >,
    IsFalse<
        IsAssignable<
            Omit<GroupNameShape, 'group_name'> & { group_name: number },
            OneBot12QQGroupNameChangeEvent
        >
    >,
    IsFalse<IsAssignable<GroupNameShape & { operator_id: number }, OneBot12QQGroupNameChangeEvent>>,
    IsFalse<IsAssignable<GroupNameShape & { operator_id: null }, OneBot12QQGroupNameChangeEvent>>,
    IsFalse<
        IsAssignable<GroupNameShape & { 'x.invalid': () => void }, OneBot12QQGroupNameChangeEvent>
    >,
];
