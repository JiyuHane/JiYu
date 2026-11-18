import { OneBot12ClientError } from './client-types.js';
import {
    createFragmentedOperation,
    exceedsFragmentBudget,
    invalidFragmentOptions,
    readFragmentedSettings,
} from './file-fragmented-operation.js';
import type { FragmentedTransferOptions } from './file-fragmented-operation.js';
import {
    finishOneBot12FragmentedUpload,
    prepareOneBot12FragmentedUpload,
    transferOneBot12FragmentedUpload,
} from './file-fragmented-upload.js';
import type { OneBot12FileFragmentRequester } from './file-fragmented.js';
import type { OneBot12ActionResponse } from './types.js';

const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getTag = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)!.get!;
const getBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

export type OneBot12FragmentedUploadOptions = FragmentedTransferOptions;

export type OneBot12FragmentedUploadResult =
    | { status: 'ok'; fileId: string; sha256: string; size: number }
    | {
          status: 'failed';
          stage: 'prepare' | 'transfer' | 'finish';
          response: OneBot12ActionResponse & { status: 'failed' };
      };

function inputView(input: unknown): Uint8Array<ArrayBuffer> {
    try {
        if (getTag.call(input) !== 'Uint8Array') {
            throw new TypeError();
        }

        const buffer = getBuffer.call(input) as ArrayBuffer;
        // This intrinsic excludes SharedArrayBuffer and spoofed prototypes.
        getBufferLength.call(buffer);

        if (getResizable?.call(buffer) === true) {
            throw new TypeError();
        }

        // Constructing a fresh fixed view also rejects detached buffers.
        return new Uint8Array(buffer, getOffset.call(input), getLength.call(input));
    } catch {
        throw new OneBot12ClientError('invalid_options', 'Invalid fragmented upload bytes');
    }
}

function encodeChunk(chunk: Uint8Array): string {
    const pieces: string[] = [];

    for (let i = 0; i < chunk.length; i += 16_384) {
        pieces.push(String.fromCharCode(...chunk.subarray(i, i + 16_384)));
    }

    return btoa(pieces.join(''));
}

/**
 * Upload a private snapshot in ordered, non-retried stages. A lost response or
 * abort cannot establish that a mutating stage had no effect on the server.
 */
export async function uploadOneBot12FragmentedFile(
    transport: OneBot12FileFragmentRequester,
    name: string,
    input: Uint8Array,
    options: OneBot12FragmentedUploadOptions,
): Promise<OneBot12FragmentedUploadResult> {
    if (typeof name !== 'string' || name.length > 4096) {
        throw invalidFragmentOptions('upload');
    }

    const source = inputView(input);
    const size = source.length;
    const prepare = { stage: 'prepare', name, total_size: size } as const;
    const settings = readFragmentedSettings(options, 'upload', prepare);

    if (exceedsFragmentBudget(size, settings)) {
        throw new OneBot12ClientError('limit', 'Fragmented upload exceeds the transfer budget');
    }

    const operation = createFragmentedOperation(settings, 'upload');
    let staging: Uint8Array<ArrayBuffer> | undefined;

    try {
        operation.check();
        const bytes = new Uint8Array(size);
        staging = bytes;

        try {
            // Snapshot the accepted view before the first await. Do not use slice
            // on caller objects: Node Buffer slices alias their original storage.
            bytes.set(source);
        } catch {
            throw new OneBot12ClientError('invalid_options', 'Invalid fragmented upload bytes');
        }

        // Finish must describe exactly these bytes; do this before reserving a draft.
        const sha256 = await operation.sha256(bytes);
        const prepared = await operation.step(() =>
            prepareOneBot12FragmentedUpload(transport, prepare, operation.requestOptions()),
        );

        if (prepared.status === 'failed') {
            return { status: 'failed', stage: 'prepare', response: prepared };
        }

        const draft = prepared.data.file_id;

        for (let offset = 0; offset < size; offset += settings.chunkSize) {
            const chunk = bytes.subarray(offset, offset + settings.chunkSize);
            const transferred = await operation.step(() =>
                transferOneBot12FragmentedUpload(
                    transport,
                    { stage: 'transfer', file_id: draft, offset, data: encodeChunk(chunk) },
                    operation.requestOptions(),
                ),
            );

            if (transferred.status === 'failed') {
                return { status: 'failed', stage: 'transfer', response: transferred };
            }
        }

        const finished = await operation.step(() =>
            finishOneBot12FragmentedUpload(
                transport,
                { stage: 'finish', file_id: draft, sha256 },
                operation.requestOptions(),
            ),
        );
        operation.check();

        if (finished.status === 'failed') {
            return { status: 'failed', stage: 'finish', response: finished };
        }

        return { status: 'ok', fileId: finished.data.file_id, sha256, size };
    } finally {
        operation.cleanup();
        staging?.fill(0);
    }
}
