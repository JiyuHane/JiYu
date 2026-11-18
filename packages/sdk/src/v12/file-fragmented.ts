import { OneBot12ClientError } from './client-types.js';
import type { OneBot12RequestOptions } from './client-types.js';
import { parseOneBot12ActionRequest, parseOneBot12ActionResponse } from './protocol.js';
import type {
    OneBot12ActionResponse,
    OneBot12GetFileFragmentedPrepareParams,
    OneBot12GetFileFragmentedPrepareResponse,
    OneBot12GetFileFragmentedTransferParams,
    OneBot12GetFileFragmentedTransferResponse,
    OneBot12JsonObject,
    OneBot12JsonValue,
} from './types.js';

/** Structural single-request surface shared by the SDK's v12 transports. */
export interface OneBot12FileFragmentRequester {
    request(
        action: string,
        params?: OneBot12JsonObject,
        options?: OneBot12RequestOptions,
    ): Promise<OneBot12ActionResponse>;
}

type Stage = 'prepare' | 'transfer';

/** Snapshot the complete JSON input before reading any action-specific fields. */
function snapshotParams(input: unknown, stage: Stage): OneBot12JsonObject {
    try {
        const params = parseOneBot12ActionRequest({
            action: 'get_file_fragmented',
            params: input,
        }).params;

        if (
            params.stage === stage &&
            typeof params.file_id === 'string' &&
            (stage === 'prepare' ||
                (typeof params.offset === 'number' &&
                    Number.isSafeInteger(params.offset) &&
                    typeof params.size === 'number' &&
                    Number.isSafeInteger(params.size)))
        ) {
            return params;
        }
    } catch {
        // Never expose caller-controlled parser or proxy errors.
    }

    throw new OneBot12ClientError('invalid_options', 'Invalid get_file_fragmented parameters');
}

function isObject(value: OneBot12JsonValue): value is OneBot12JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Snapshot the whole envelope, then validate only the selected success shape. */
function snapshotResponse(input: unknown, stage: Stage): OneBot12ActionResponse {
    try {
        const response = parseOneBot12ActionResponse(input);

        if (response.status === 'failed') {
            return response;
        }

        const data = response.data;

        if (
            isObject(data) &&
            (stage === 'prepare'
                ? typeof data.name === 'string' &&
                  typeof data.total_size === 'number' &&
                  Number.isSafeInteger(data.total_size) &&
                  typeof data.sha256 === 'string'
                : typeof data.data === 'string')
        ) {
            return response;
        }
    } catch {
        // Never expose response bodies or caller-controlled parser errors.
    }

    throw new OneBot12ClientError('invalid_response', 'Invalid get_file_fragmented response');
}

/**
 * Issue exactly one prepare action and validate a snapshot of its response.
 * This does not establish server support or authenticate the reported digest.
 */
export async function prepareOneBot12FileFragment<T extends OneBot12FileFragmentRequester>(
    transport: T,
    params: OneBot12GetFileFragmentedPrepareParams,
    options?: Parameters<T['request']>[2],
): Promise<OneBot12GetFileFragmentedPrepareResponse> {
    const prepared = snapshotParams(params, 'prepare');
    // This cast only widens the static type; the original options object is passed through.
    const response = await transport.request(
        'get_file_fragmented',
        prepared,
        options as OneBot12RequestOptions | undefined,
    );
    return snapshotResponse(response, 'prepare') as OneBot12GetFileFragmentedPrepareResponse;
}

/**
 * Issue exactly one transfer action and validate a snapshot of its response.
 * The helper does not decode, assemble, verify, download or retry file data.
 */
export async function transferOneBot12FileFragment<T extends OneBot12FileFragmentRequester>(
    transport: T,
    params: OneBot12GetFileFragmentedTransferParams,
    options?: Parameters<T['request']>[2],
): Promise<OneBot12GetFileFragmentedTransferResponse> {
    const prepared = snapshotParams(params, 'transfer');
    const response = await transport.request(
        'get_file_fragmented',
        prepared,
        options as OneBot12RequestOptions | undefined,
    );
    return snapshotResponse(response, 'transfer') as OneBot12GetFileFragmentedTransferResponse;
}
