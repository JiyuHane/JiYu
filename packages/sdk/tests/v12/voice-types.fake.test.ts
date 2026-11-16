import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type {
    OneBot12JsonObject,
    OneBot12Message,
    OneBot12MessageSegment,
    OneBot12OutgoingMessage,
    OneBot12TextSegment,
    OneBot12VoiceSegment,
} from '../../src/v12/index.js';
import {
    parseOneBot12EventJson,
    parseOneBot12MessageSegment,
    serializeOneBot12Event,
} from '../../src/v12/index.js';

type Assert<T extends true> = T;
type IsFalse<T extends false> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Voice = { type: 'voice'; data: { file_id: string } };

export type Checks = [
    Assert<IsAssignable<Voice, OneBot12VoiceSegment>>,
    Assert<IsAssignable<OneBot12VoiceSegment, OneBot12MessageSegment>>,
    Assert<IsAssignable<OneBot12VoiceSegment, OneBot12JsonObject>>,
    Assert<IsAssignable<OneBot12VoiceSegment[], OneBot12Message>>,
    Assert<IsAssignable<OneBot12VoiceSegment, OneBot12OutgoingMessage>>,
    Assert<IsAssignable<OneBot12VoiceSegment['type'], 'voice'>>,
    Assert<IsAssignable<'voice', OneBot12VoiceSegment['type']>>,
    Assert<IsAssignable<OneBot12VoiceSegment['data']['file_id'], string>>,
    Assert<IsAssignable<string, OneBot12VoiceSegment['data']['file_id']>>,
    IsFalse<IsAssignable<{ type: 'voice'; data: {} }, OneBot12VoiceSegment>>,
    IsFalse<IsAssignable<{ type: 'voice'; data: { file_id?: string } }, OneBot12VoiceSegment>>,
    IsFalse<IsAssignable<{ type: 'voice'; data: { file_id: number } }, OneBot12VoiceSegment>>,
    IsFalse<IsAssignable<{ type: 'voice'; data: { file_id: null } }, OneBot12VoiceSegment>>,
    IsFalse<IsAssignable<{ type: 'voice' }, OneBot12VoiceSegment>>,
    IsFalse<IsAssignable<{ data: { file_id: string } }, OneBot12VoiceSegment>>,
    IsFalse<IsAssignable<{ type: 'image'; data: { file_id: string } }, OneBot12VoiceSegment>>,
    IsFalse<IsAssignable<{ type: string; data: { file_id: string } }, OneBot12VoiceSegment>>,
    Assert<
        IsAssignable<
            { type: 'voice'; data: { file_id: string; 'x.voice': { nested: string[] } } },
            OneBot12VoiceSegment
        >
    >,
    IsFalse<
        IsAssignable<
            { type: 'voice'; data: { file_id: string; 'x.invalid': () => void } },
            OneBot12VoiceSegment
        >
    >,
];

const voice: OneBot12VoiceSegment = {
    type: 'voice',
    data: { file_id: 'fixture-voice-id' },
};
const text: OneBot12TextSegment = { type: 'text', data: { text: 'voice: ' } };
const message: OneBot12Message = [text, voice];
const event = {
    id: 'voice-fixture-event',
    time: 1_720_000_000,
    type: 'message',
    detail_type: 'group',
    sub_type: '',
    self: { platform: 'qq', user_id: '42' },
    message_id: '-123',
    user_id: '7',
    group_id: '10',
    message,
    alt_message: 'voice fixture',
};

describe('OneBot 12 voice types and generic message codec', () => {
    it('typechecks the exported voice API and its valid and invalid shapes', () => {
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

    it('round trips an inbound message containing a voice segment through JSON', () => {
        const wire = serializeOneBot12Event(event);
        expect(JSON.parse(wire)).toEqual(event);
        expect(parseOneBot12EventJson(wire)).toEqual(event);
        expect(parseOneBot12EventJson(JSON.stringify(event))).toEqual(event);
        expect(parseOneBot12MessageSegment(JSON.parse(JSON.stringify(voice)))).toEqual(voice);
    });

    it('does not validate voice file_id or enforce voice-specific fields', () => {
        for (const data of [
            {},
            { file_id: '' },
            { file_id: 42 },
            { file_id: null },
            { file_id: { nested: true } },
            { file_id: 'v'.repeat(4097) },
            { file_id: 'fixture', extra: true },
        ]) {
            const segment = { type: 'voice', data };
            const input = { ...event, message: [segment] };
            expect(parseOneBot12MessageSegment(JSON.parse(JSON.stringify(segment)))).toEqual(
                segment,
            );
            expect(parseOneBot12EventJson(JSON.stringify(input))).toEqual(input);
            expect(parseOneBot12EventJson(serializeOneBot12Event(input))).toEqual(input);
        }

        const extended = { type: 'voice', data: { file_id: 'fixture' }, extra: true };
        expect(parseOneBot12MessageSegment(JSON.parse(JSON.stringify(extended)))).toEqual(extended);
        expect(parseOneBot12EventJson(JSON.stringify({ ...event, message: [extended] }))).toEqual({
            ...event,
            message: [extended],
        });
    });

    it('still rejects segments that violate the generic base shape', () => {
        for (const segment of [
            { type: 'voice', data: null },
            { type: 'voice', data: [] },
            { type: 'voice', data: { type: 'nested', file_id: 'fixture' } },
            { type: 'voice' },
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
