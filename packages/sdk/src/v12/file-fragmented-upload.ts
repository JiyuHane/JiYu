import { OneBot12ClientError } from './client-types.js';
import type { OneBot12RequestOptions } from './client-types.js';
import type { OneBot12FileFragmentRequester } from './file-fragmented.js';
import { parseOneBot12ActionRequest, parseOneBot12ActionResponse } from './protocol.js';
import type {
    OneBot12JsonObject,
    OneBot12JsonValue,
    OneBot12UploadFileFragmentedFinishParams,
    OneBot12UploadFileFragmentedFinishResponse,
    OneBot12UploadFileFragmentedPrepareParams,
    OneBot12UploadFileFragmentedPrepareResponse,
    OneBot12UploadFileFragmentedTransferParams,
    OneBot12UploadFileFragmentedTransferResponse,
} from './types.js';

const ACTION = 'upload_file_fragmented';

type Stage = 'prepare' | 'transfer' | 'finish';
type StageResponse = {
    prepare: OneBot12UploadFileFragmentedPrepareResponse;
    transfer: OneBot12UploadFileFragmentedTransferResponse;
    finish: OneBot12UploadFileFragmentedFinishResponse;
};

function isNonnegativeSafeInteger(value: unknown): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFileId(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0;
}

function matchesStage(params: OneBot12JsonObject, stage: Stage): boolean {
    if (params.stage !== stage) {
        return false;
    }

    switch (stage) {
        case 'prepare':
            return typeof params.name === 'string' && isNonnegativeSafeInteger(params.total_size);
        case 'transfer':
            return (
                isFileId(params.file_id) &&
                isNonnegativeSafeInteger(params.offset) &&
                typeof params.data === 'string'
            );
        case 'finish':
            return (
                isFileId(params.file_id) &&
                typeof params.sha256 === 'string' &&
                params.sha256.length === 64 &&
                /^[0-9a-f]{64}$/.test(params.sha256)
            );
    }
}

function snapshotParams(input: unknown, stage: Stage): OneBot12JsonObject {
    try {
        const params = parseOneBot12ActionRequest({ action: ACTION, params: input }).params;

        if (matchesStage(params, stage)) {
            return params;
        }
    } catch {
        // Do not surface caller-controlled errors from JSON reflection.
    }

    throw new OneBot12ClientError('invalid_options', 'Invalid upload_file_fragmented parameters');
}

function hasFileId(data: OneBot12JsonValue): boolean {
    return (
        data !== null && typeof data === 'object' && !Array.isArray(data) && isFileId(data.file_id)
    );
}

async function requestStage<S extends Stage>(
    transport: OneBot12FileFragmentRequester,
    stage: S,
    params: unknown,
    options: OneBot12RequestOptions | undefined,
): Promise<StageResponse[S]> {
    const prepared = snapshotParams(params, stage);
    // Keep the receiver and the original transport options. Transport errors
    // (including timeout and abort) propagate unchanged and are never retried.
    const result = await transport.request(ACTION, prepared, options);

    try {
        const response = parseOneBot12ActionResponse(result);

        if (
            response.status === 'failed' ||
            (stage === 'transfer' ? response.data === null : hasFileId(response.data))
        ) {
            return response as StageResponse[S];
        }
    } catch {
        // Do not surface response bodies or caller-controlled parser errors.
    }

    throw new OneBot12ClientError('invalid_response', 'Invalid upload_file_fragmented response');
}

/** Reserve one upload draft; this does not start a transfer loop. */
export function prepareOneBot12FragmentedUpload<T extends OneBot12FileFragmentRequester>(
    transport: T,
    params: OneBot12UploadFileFragmentedPrepareParams,
    options?: Parameters<T['request']>[2],
): Promise<OneBot12UploadFileFragmentedPrepareResponse> {
    return requestStage(
        transport,
        'prepare',
        params,
        options as OneBot12RequestOptions | undefined,
    );
}

/** Transfer exactly one supplied fragment without decoding or changing its bytes. */
export function transferOneBot12FragmentedUpload<T extends OneBot12FileFragmentRequester>(
    transport: T,
    params: OneBot12UploadFileFragmentedTransferParams,
    options?: Parameters<T['request']>[2],
): Promise<OneBot12UploadFileFragmentedTransferResponse> {
    return requestStage(
        transport,
        'transfer',
        params,
        options as OneBot12RequestOptions | undefined,
    );
}

/** Ask the implementation to finish one draft using a caller-supplied digest. */
export function finishOneBot12FragmentedUpload<T extends OneBot12FileFragmentRequester>(
    transport: T,
    params: OneBot12UploadFileFragmentedFinishParams,
    options?: Parameters<T['request']>[2],
): Promise<OneBot12UploadFileFragmentedFinishResponse> {
    return requestStage(transport, 'finish', params, options as OneBot12RequestOptions | undefined);
}
