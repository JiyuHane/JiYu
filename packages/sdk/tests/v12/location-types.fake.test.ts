import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type {
    OneBot12JsonObject,
    OneBot12LocationSegment,
    OneBot12Message,
    OneBot12MessageSegment,
    OneBot12OutgoingMessage,
} from '../../src/v12/index.js';
import {
    parseOneBot12EventJson,
    parseOneBot12MessageSegment,
    serializeOneBot12Event,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsExact<Left, Right> =
    (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;
type LocationData = { latitude: number; longitude: number; title: string; content: string };
type Location = { type: 'location'; data: LocationData };
type SegmentWithData<Data> = { type: 'location'; data: Data };
type OptionalField<Key extends keyof LocationData> = Omit<LocationData, Key> &
    Partial<Pick<LocationData, Key>>;
type ReplaceField<Key extends keyof LocationData, Value> = Omit<LocationData, Key> & {
    [Field in Key]: Value;
};

export type Checks = [
    Assert<IsAssignable<Location, OneBot12LocationSegment>>,
    Assert<IsAssignable<OneBot12LocationSegment, OneBot12MessageSegment>>,
    Assert<IsAssignable<OneBot12LocationSegment, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12LocationSegment['data'], OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12LocationSegment[], OneBot12Message>>,
    Assert<IsAssignable<OneBot12LocationSegment, OneBot12OutgoingMessage>>,
    Assert<IsExact<OneBot12LocationSegment['type'], 'location'>>,
    Assert<IsExact<OneBot12LocationSegment['data']['latitude'], number>>,
    Assert<IsExact<OneBot12LocationSegment['data']['longitude'], number>>,
    Assert<IsExact<OneBot12LocationSegment['data']['title'], string>>,
    Assert<IsExact<OneBot12LocationSegment['data']['content'], string>>,
    IsFalse<IsAssignable<SegmentWithData<Omit<LocationData, 'latitude'>>, OneBot12LocationSegment>>,
    IsFalse<
        IsAssignable<SegmentWithData<Omit<LocationData, 'longitude'>>, OneBot12LocationSegment>
    >,
    IsFalse<IsAssignable<SegmentWithData<Omit<LocationData, 'title'>>, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<SegmentWithData<Omit<LocationData, 'content'>>, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<SegmentWithData<OptionalField<'latitude'>>, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<SegmentWithData<OptionalField<'longitude'>>, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<SegmentWithData<OptionalField<'title'>>, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<SegmentWithData<OptionalField<'content'>>, OneBot12LocationSegment>>,
    IsFalse<
        IsAssignable<SegmentWithData<ReplaceField<'latitude', string>>, OneBot12LocationSegment>
    >,
    IsFalse<
        IsAssignable<SegmentWithData<ReplaceField<'longitude', string>>, OneBot12LocationSegment>
    >,
    IsFalse<IsAssignable<SegmentWithData<ReplaceField<'title', number>>, OneBot12LocationSegment>>,
    IsFalse<
        IsAssignable<SegmentWithData<ReplaceField<'content', number>>, OneBot12LocationSegment>
    >,
    IsFalse<IsAssignable<SegmentWithData<ReplaceField<'latitude', null>>, OneBot12LocationSegment>>,
    IsFalse<
        IsAssignable<SegmentWithData<ReplaceField<'longitude', null>>, OneBot12LocationSegment>
    >,
    IsFalse<IsAssignable<SegmentWithData<ReplaceField<'title', null>>, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<SegmentWithData<ReplaceField<'content', null>>, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<{ type: 'location' }, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<{ data: LocationData }, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<{ type: 'text'; data: LocationData }, OneBot12LocationSegment>>,
    IsFalse<IsAssignable<{ type: string; data: LocationData }, OneBot12LocationSegment>>,
    Assert<
        IsAssignable<
            {
                type: 'location';
                data: LocationData & { 'x.location': { nested: (string | number | null)[] } };
                'x.segment': boolean;
            },
            OneBot12LocationSegment
        >
    >,
    IsFalse<
        IsAssignable<
            { type: 'location'; data: LocationData & { 'x.invalid': () => void } },
            OneBot12LocationSegment
        >
    >,
    IsFalse<
        IsAssignable<
            { type: 'location'; data: LocationData; 'x.invalid': () => void },
            OneBot12LocationSegment
        >
    >,
];

const location: OneBot12LocationSegment = {
    type: 'location',
    data: {
        latitude: 12.345,
        longitude: -67.89,
        title: 'Synthetic place',
        content: 'Example location',
        'x.location': { values: [1, 'synthetic', null] },
    },
    'x.segment': true,
};
const message: OneBot12Message = [location];
const event = {
    id: 'location-fixture-event',
    time: 1_720_000_000,
    type: 'message',
    detail_type: 'group',
    sub_type: '',
    self: { platform: 'synthetic', user_id: '42' },
    message_id: '-123',
    user_id: '7',
    group_id: '10',
    message,
    alt_message: 'location fixture',
};

describe('OneBot 12 location types and generic message codec', () => {
    it('typechecks the exported location API and its valid and invalid shapes', () => {
        // The SDK's normal tsconfig includes src only, so check this fixture explicitly.
        const testFile = fileURLToPath(import.meta.url);
        const configFile = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
        const config = ts.readConfigFile(configFile, ts.sys.readFile);

        if (config.error) {
            throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
        }

        const parsed = ts.parseJsonConfigFileContent(
            config.config,
            ts.sys,
            dirname(configFile),
            undefined,
            configFile,
        );
        const program = ts.createProgram([testFile], {
            ...parsed.options,
            rootDir: undefined,
            noEmit: true,
        });
        const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
        const host: ts.FormatDiagnosticsHost = {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: ts.sys.getCurrentDirectory,
            getNewLine: () => ts.sys.newLine,
        };
        expect(ts.formatDiagnostics(diagnostics, host)).toBe('');
    }, 30_000);

    it('round trips an inbound message containing a location through JSON', () => {
        const wire = serializeOneBot12Event(event);
        expect(JSON.parse(wire)).toEqual(event);
        expect(parseOneBot12EventJson(wire)).toEqual(event);
        expect(parseOneBot12EventJson(JSON.stringify(event))).toEqual(event);
        expect(parseOneBot12MessageSegment(JSON.parse(JSON.stringify(location)))).toEqual(location);
    });

    it('accepts location-specific missing, mistyped and out-of-range fields as generic JSON', () => {
        const valid = { latitude: 12.345, longitude: -67.89, title: 'Place', content: 'Example' };

        for (const data of [
            {},
            { longitude: -67.89, title: 'Place', content: 'Example' },
            { latitude: 12.345, title: 'Place', content: 'Example' },
            { latitude: 12.345, longitude: -67.89, content: 'Example' },
            { latitude: 12.345, longitude: -67.89, title: 'Place' },
            { ...valid, latitude: '12.345' },
            { ...valid, longitude: null },
            { ...valid, title: false },
            { ...valid, content: 42 },
            { ...valid, latitude: 91, longitude: 181 },
            { latitude: [1, 2], longitude: { nested: true }, title: null, content: ['text'] },
            { ...valid, 'x.location': { nested: [true, null, 3] } },
        ]) {
            const segment = { type: 'location', data };
            const input = { ...event, message: [segment] };
            expect(parseOneBot12MessageSegment(JSON.parse(JSON.stringify(segment)))).toEqual(
                segment,
            );
            expect(parseOneBot12EventJson(JSON.stringify(input))).toEqual(input);
            expect(parseOneBot12EventJson(serializeOneBot12Event(input))).toEqual(input);
        }
    });

    it('still rejects segments that violate the generic base shape', () => {
        for (const segment of [
            { type: 'location', data: null },
            { type: 'location', data: [] },
            { type: 'location', data: { type: 'nested', latitude: 12 } },
            { type: 'location' },
            { data: { latitude: 12 } },
            { type: 42, data: { latitude: 12 } },
        ]) {
            expect(() => parseOneBot12MessageSegment(segment)).toThrow(TypeError);
            expect(() =>
                parseOneBot12EventJson(JSON.stringify({ ...event, message: [segment] })),
            ).toThrow(TypeError);
        }
    });

    it('still applies generic JSON value and numeric restrictions', () => {
        for (const value of [
            undefined,
            Number.NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            () => 1,
        ]) {
            const segment = { type: 'location', data: { latitude: value } };
            expect(() => parseOneBot12MessageSegment(segment)).toThrow(TypeError);
            expect(() => serializeOneBot12Event({ ...event, message: [segment] })).toThrow(
                TypeError,
            );
        }
    });
});
