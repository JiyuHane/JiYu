import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const consumerSource = `
import type {
    OneBot12ActionRequest,
    OneBot12ActionResponse,
    OneBot12JsonValue,
    OneBot12UploadFileFragmentedFinishParams,
    OneBot12UploadFileFragmentedFinishResponse,
    OneBot12UploadFileFragmentedFinishResult,
    OneBot12UploadFileFragmentedPrepareParams,
    OneBot12UploadFileFragmentedPrepareResponse,
    OneBot12UploadFileFragmentedPrepareResult,
    OneBot12UploadFileFragmentedTransferParams,
    OneBot12UploadFileFragmentedTransferResponse,
} from '@harehane/sdk/v12';

const prepare: OneBot12UploadFileFragmentedPrepareParams = {
    stage: 'prepare',
    name: 'fixture.txt',
    total_size: 5,
    'vendor.extra': { nested: [true, null] },
};
const transfer: OneBot12UploadFileFragmentedTransferParams = {
    stage: 'transfer',
    file_id: 'temporary-id',
    offset: 0,
    data: 'aGVsbG8=',
};
const finish: OneBot12UploadFileFragmentedFinishParams = {
    stage: 'finish',
    file_id: 'temporary-id',
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
};

export const requests: OneBot12ActionRequest[] = [prepare, transfer, finish].map((params) => ({
    action: 'upload_file_fragmented',
    params,
}));

const prepareResult: OneBot12UploadFileFragmentedPrepareResult = {
    file_id: 'temporary-id',
    'vendor.extra': [1, null],
};
const finishResult: OneBot12UploadFileFragmentedFinishResult = { file_id: 'usable-id' };
const envelope = { retcode: 0, message: '' };

export const successes: OneBot12ActionResponse[] = [
    { ...envelope, status: 'ok', data: prepareResult } satisfies OneBot12UploadFileFragmentedPrepareResponse,
    { ...envelope, status: 'ok', data: null } satisfies OneBot12UploadFileFragmentedTransferResponse,
    { ...envelope, status: 'ok', data: finishResult } satisfies OneBot12UploadFileFragmentedFinishResponse,
];

// All three failed branches accept any JSON, not just their success data shape.
declare const failureData: OneBot12JsonValue;
const failure = { status: 'failed', retcode: 10002, message: 'failure', data: failureData } satisfies OneBot12ActionResponse;
void (failure satisfies OneBot12UploadFileFragmentedPrepareResponse);
void (failure satisfies OneBot12UploadFileFragmentedTransferResponse);
void (failure satisfies OneBot12UploadFileFragmentedFinishResponse);

export function narrowSuccessData(
    prepared: OneBot12UploadFileFragmentedPrepareResponse,
    transferred: OneBot12UploadFileFragmentedTransferResponse,
    finished: OneBot12UploadFileFragmentedFinishResponse,
): void {
    if (prepared.status === 'ok') {
        void (prepared.data.file_id satisfies string);
    }
    if (transferred.status === 'ok') {
        void (transferred.data satisfies null);
    }
    if (finished.status === 'ok') {
        void (finished.data.file_id satisfies string);
    }
}

// @ts-expect-error prepare requires total_size
void ({ stage: 'prepare', name: 'fixture.txt' } satisfies OneBot12UploadFileFragmentedPrepareParams);
// @ts-expect-error total_size is a number, not a string
void ({ ...prepare, total_size: '5' } satisfies OneBot12UploadFileFragmentedPrepareParams);
// @ts-expect-error transfer requires a string file_id
void ({ ...transfer, file_id: 42 } satisfies OneBot12UploadFileFragmentedTransferParams);
// @ts-expect-error offset is a number, not a string
void ({ ...transfer, offset: '0' } satisfies OneBot12UploadFileFragmentedTransferParams);
// @ts-expect-error data must be Base64 text, not a JSON array of bytes
void ({ ...transfer, data: [1] } satisfies OneBot12UploadFileFragmentedTransferParams);
// @ts-expect-error finish params require the literal finish stage
void ({ ...finish, stage: 'transfer' } satisfies OneBot12UploadFileFragmentedFinishParams);
// @ts-expect-error finish requires sha256
void ({ stage: 'finish', file_id: 'temporary-id' } satisfies OneBot12UploadFileFragmentedFinishParams);
// @ts-expect-error sha256 is a string
void ({ ...finish, sha256: 42 } satisfies OneBot12UploadFileFragmentedFinishParams);
// @ts-expect-error extension fields must be JSON values
void ({ ...finish, 'vendor.invalid': () => 1 } satisfies OneBot12UploadFileFragmentedFinishParams);

// @ts-expect-error prepare success data requires a file_id
void ({ ...envelope, status: 'ok', data: {} } satisfies OneBot12UploadFileFragmentedPrepareResponse);
// @ts-expect-error transfer success data must be null
void ({ ...envelope, status: 'ok', data: prepareResult } satisfies OneBot12UploadFileFragmentedTransferResponse);
// @ts-expect-error finish success data requires a string file_id
void ({ ...envelope, status: 'ok', data: { file_id: 42 } } satisfies OneBot12UploadFileFragmentedFinishResponse);

declare const generic: OneBot12ActionResponse;
// @ts-expect-error a generic response does not establish the transfer success shape
void (generic satisfies OneBot12UploadFileFragmentedTransferResponse);
`;

describe('OneBot 12 fragmented upload public types', () => {
    it('checks valid and invalid stage shapes in a virtual consumer without emitting files', () => {
        const virtualFile = fileURLToPath(
            new URL('./__virtual_file_fragmented_upload_consumer__.mts', import.meta.url),
        );
        const publicIndex = fileURLToPath(new URL('../../src/v12/index.ts', import.meta.url));
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
        const options: ts.CompilerOptions = {
            ...parsed.options,
            rootDir: undefined,
            noEmit: true,
            paths: { ...parsed.options.paths, '@harehane/sdk/v12': [publicIndex] },
        };
        const host = ts.createCompilerHost(options);
        const originalRead = host.readFile.bind(host);
        const originalExists = host.fileExists.bind(host);
        const originalSource = host.getSourceFile.bind(host);
        const normal = (path: string) => path.replace(/\\/g, '/').toLowerCase();
        const isVirtual = (path: string) => normal(path) === normal(virtualFile);
        host.fileExists = (path) => isVirtual(path) || originalExists(path);
        host.readFile = (path) => (isVirtual(path) ? consumerSource : originalRead(path));
        host.getSourceFile = (path, version, onError, shouldCreateNewSourceFile) =>
            isVirtual(path)
                ? ts.createSourceFile(path, consumerSource, version, true, ts.ScriptKind.TS)
                : originalSource(path, version, onError, shouldCreateNewSourceFile);

        host.writeFile = () => {
            throw new Error('typecheck must not emit files');
        };

        const program = ts.createProgram([virtualFile], options, host);
        const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
        const formatHost: ts.FormatDiagnosticsHost = {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: ts.sys.getCurrentDirectory,
            getNewLine: () => ts.sys.newLine,
        };
        expect(program.getSourceFile(publicIndex)).toBeDefined();
        expect(ts.formatDiagnostics(diagnostics, formatHost)).toBe('');
    }, 30_000);
});
