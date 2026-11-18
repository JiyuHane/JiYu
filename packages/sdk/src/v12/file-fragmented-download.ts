import { OneBot12ClientError } from './client-types.js';
import { prepareOneBot12FileFragment, transferOneBot12FileFragment } from './file-fragmented.js';
import type { OneBot12FileFragmentRequester } from './file-fragmented.js';
import {
    createFragmentedOperation,
    exceedsFragmentBudget,
    invalidFragmentOptions,
    isSha256,
    readFragmentedSettings,
} from './file-fragmented-operation.js';
import type { FragmentedTransferOptions } from './file-fragmented-operation.js';
import type { OneBot12ActionResponse } from './types.js';

export interface OneBot12FragmentedDownloadOptions extends FragmentedTransferOptions {
    /** Optional independently known lowercase hexadecimal SHA-256. */
    expectedSha256?: string;
}

export type OneBot12FragmentedDownloadResult =
    | { status: 'ok'; name: string; sha256: string; bytes: Uint8Array }
    | {
          status: 'failed';
          stage: 'prepare' | 'transfer';
          response: OneBot12ActionResponse & { status: 'failed' };
      };

function copyChunk(encoded: string, into: Uint8Array): void {
    try {
        if (encoded.length !== 4 * Math.ceil(into.length / 3)) {
            throw new TypeError();
        }

        const binary = atob(encoded);

        if (binary.length !== into.length || btoa(binary) !== encoded) {
            throw new TypeError();
        }

        for (let i = 0; i < into.length; i++) {
            into[i] = binary.charCodeAt(i);
        }
    } catch {
        throw new OneBot12ClientError('invalid_response', 'Invalid fragmented download chunk');
    }
}

/**
 * Read one file through the two staged actions, returning only complete verified bytes.
 * The server-reported digest binds content consistency, not its origin.
 */
export async function downloadOneBot12FragmentedFile(
    transport: OneBot12FileFragmentRequester,
    fileId: string,
    options: OneBot12FragmentedDownloadOptions,
): Promise<OneBot12FragmentedDownloadResult> {
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw invalidFragmentOptions('download');
    }

    const prepare = { stage: 'prepare', file_id: fileId } as const;
    const settings = readFragmentedSettings(options, 'download', prepare);
    const { chunkSize, expectedSha256 } = settings;
    const operation = createFragmentedOperation(settings, 'download');
    let staging: Uint8Array | undefined;
    let verified = false;

    try {
        const metadata = await operation.step(() =>
            prepareOneBot12FileFragment(transport, prepare, operation.requestOptions()),
        );

        if (metadata.status === 'failed') {
            return { status: 'failed', stage: 'prepare', response: metadata };
        }

        const { name, total_size: size, sha256 } = metadata.data;

        if (size < 0 || !isSha256(sha256)) {
            throw new OneBot12ClientError(
                'invalid_response',
                'Invalid fragmented download metadata',
            );
        }

        if (exceedsFragmentBudget(size, settings)) {
            throw new OneBot12ClientError(
                'limit',
                'Fragmented download exceeds the transfer budget',
            );
        }

        if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
            throw new OneBot12ClientError(
                'invalid_response',
                'Fragmented download digest does not match',
            );
        }

        const bytes = new Uint8Array(size);
        staging = bytes;

        for (let offset = 0; offset < size;) {
            const length = Math.min(size - offset, chunkSize);
            const fragment = await operation.step(() =>
                transferOneBot12FileFragment(
                    transport,
                    { stage: 'transfer', file_id: fileId, offset, size: length },
                    operation.requestOptions(),
                ),
            );

            if (fragment.status === 'failed') {
                return { status: 'failed', stage: 'transfer', response: fragment };
            }

            copyChunk(fragment.data.data, bytes.subarray(offset, offset + length));
            offset += length;
        }

        const actualSha256 = await operation.sha256(bytes);
        operation.check();

        if (actualSha256 !== sha256) {
            throw new OneBot12ClientError(
                'invalid_response',
                'Fragmented download digest does not match',
            );
        }

        verified = true;
        return { status: 'ok', name, sha256: actualSha256, bytes };
    } finally {
        operation.cleanup();

        if (!verified) {
            staging?.fill(0);
        }
    }
}
