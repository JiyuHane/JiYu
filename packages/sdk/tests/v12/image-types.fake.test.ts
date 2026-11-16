import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type {
    OneBot12ImageSegment,
    OneBot12JsonObject,
    OneBot12Message,
    OneBot12MessageSegment,
    OneBot12OutgoingMessage,
    OneBot12TextSegment,
} from '../../src/v12/index.js';
import {
    parseOneBot12EventJson,
    parseOneBot12MessageSegment,
    serializeOneBot12Event,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Image = { type: 'image'; data: { file_id: string } };

export type Checks = [
    Assert<IsAssignable<Image, OneBot12ImageSegment>>,
    Assert<IsAssignable<OneBot12ImageSegment, OneBot12MessageSegment>>,
    Assert<IsAssignable<OneBot12ImageSegment, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12ImageSegment[], OneBot12Message>>,
    Assert<IsAssignable<OneBot12ImageSegment, OneBot12OutgoingMessage>>,
    Assert<IsAssignable<OneBot12ImageSegment['type'], 'image'>>,
    Assert<IsAssignable<'image', OneBot12ImageSegment['type']>>,
    Assert<IsAssignable<OneBot12ImageSegment['data']['file_id'], string>>,
    Assert<IsAssignable<string, OneBot12ImageSegment['data']['file_id']>>,
    IsFalse<IsAssignable<{ type: 'image'; data: {} }, OneBot12ImageSegment>>,
    IsFalse<IsAssignable<{ type: 'image'; data: { file_id?: string } }, OneBot12ImageSegment>>,
    IsFalse<IsAssignable<{ type: 'image'; data: { file_id: number } }, OneBot12ImageSegment>>,
    IsFalse<IsAssignable<{ type: 'image'; data: { file_id: null } }, OneBot12ImageSegment>>,
    IsFalse<IsAssignable<{ type: 'image' }, OneBot12ImageSegment>>,
    IsFalse<IsAssignable<{ data: { file_id: string } }, OneBot12ImageSegment>>,
    IsFalse<IsAssignable<{ type: 'text'; data: { file_id: string } }, OneBot12ImageSegment>>,
    IsFalse<IsAssignable<{ type: string; data: { file_id: string } }, OneBot12ImageSegment>>,
    Assert<
        IsAssignable<
            { type: 'image'; data: { file_id: string; 'x.image': { nested: string[] } } },
            OneBot12ImageSegment
        >
    >,
    IsFalse<
        IsAssignable<
            { type: 'image'; data: { file_id: string; 'x.invalid': () => void } },
            OneBot12ImageSegment
        >
    >,
];

const image: OneBot12ImageSegment = {
    type: 'image',
    data: { file_id: 'file:image/图片-01' },
};
const text: OneBot12TextSegment = { type: 'text', data: { text: 'image: ' } };
const message: OneBot12Message = [text, image];
const event = {
    id: 'image-event',
    time: 1_720_000_000,
    type: 'message',
    detail_type: 'group',
    sub_type: '',
    self: { platform: 'qq', user_id: '42' },
    message_id: '-123',
    user_id: '7',
    group_id: '10',
    message,
    alt_message: 'image',
};

describe('OneBot 12 image types and generic message codec', () => {
    it('typechecks public image types and their valid and invalid shapes', () => {
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

    it('round trips an inbound message containing an image through JSON', () => {
        const wire = serializeOneBot12Event(event);
        expect(JSON.parse(wire)).toEqual(event);
        expect(parseOneBot12EventJson(wire)).toEqual(event);
        expect(parseOneBot12EventJson(JSON.stringify(event))).toEqual(event);
        expect(parseOneBot12MessageSegment(JSON.parse(JSON.stringify(image)))).toEqual(image);
    });

    it('does not validate image file_id or enforce image-specific data keys', () => {
        for (const data of [
            {},
            { file_id: '' },
            { file_id: 42 },
            { file_id: null },
            { file_id: { nested: true } },
            { file_id: 'x'.repeat(4097) },
            { file_id: 'fixture', extra: true },
        ]) {
            const segment = { type: 'image', data };
            const input = { ...event, message: [segment] };
            expect(parseOneBot12MessageSegment(JSON.parse(JSON.stringify(segment)))).toEqual(
                segment,
            );
            expect(parseOneBot12EventJson(serializeOneBot12Event(input))).toEqual(input);
        }
    });

    it('still rejects segments that violate the generic base shape', () => {
        for (const segment of [
            { type: 'image', data: null },
            { type: 'image', data: [] },
            { type: 'image', data: { type: 'nested', file_id: 'fixture' } },
            { type: 'image' },
            { data: { file_id: 'fixture' } },
            { type: 42, data: { file_id: 'fixture' } },
        ]) {
            expect(() => parseOneBot12MessageSegment(segment)).toThrow(TypeError);
            expect(() =>
                parseOneBot12EventJson(JSON.stringify({ ...event, message: [segment] })),
            ).toThrow(TypeError);
        }
    });
});
