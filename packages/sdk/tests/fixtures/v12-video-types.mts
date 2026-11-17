// Type-only consumer fixture. It declares no runtime client or socket.
import type {
    OneBot12JsonObject,
    OneBot12Message,
    OneBot12MessageSegment,
    OneBot12OutgoingMessage,
    OneBot12VideoSegment,
} from '@harehane/sdk/v12';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Video = { type: 'video'; data: { file_id: string } };

export type VideoSegmentChecks = [
    Assert<IsAssignable<Video, OneBot12VideoSegment>>,
    Assert<IsAssignable<OneBot12VideoSegment, OneBot12MessageSegment>>,
    Assert<IsAssignable<OneBot12VideoSegment, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12VideoSegment[], OneBot12Message>>,
    Assert<IsAssignable<OneBot12VideoSegment, OneBot12OutgoingMessage>>,
    Assert<IsAssignable<OneBot12VideoSegment[], OneBot12OutgoingMessage>>,
    Assert<IsAssignable<OneBot12VideoSegment['type'], 'video'>>,
    Assert<IsAssignable<'video', OneBot12VideoSegment['type']>>,
    Assert<IsAssignable<OneBot12VideoSegment['data']['file_id'], string>>,
    Assert<IsAssignable<string, OneBot12VideoSegment['data']['file_id']>>,
    Assert<IsAssignable<Video & { 'x.extra': { nested: [string, null, boolean] } }, OneBot12VideoSegment>>,
    Assert<IsAssignable<{ type: 'video'; data: { file_id: string; 'x.video': number[] } }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<OneBot12MessageSegment, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: 'video'; data: {} }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: 'video'; data: { file_id?: string } }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: 'video'; data: { file_id: number } }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: 'video'; data: { file_id: null } }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: 'video' }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ data: { file_id: string } }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: 'voice'; data: { file_id: string } }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: string; data: { file_id: string } }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<Video & { 'x.invalid': () => void }, OneBot12VideoSegment>>,
    IsFalse<IsAssignable<{ type: 'video'; data: { file_id: string; 'x.invalid': () => void } }, OneBot12VideoSegment>>,
];
