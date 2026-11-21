import type { DirectAccountStatus, DirectOperation } from '@snowluma/common/direct-account';

export const directAccount: DirectAccountStatus = {
    id: 'test-account',
    label: 'Test account',
    protocol: 'linux',
    revision: 'a'.repeat(32),
    generation: null,
    uin: null,
    phase: 'stopped',
    online: false,
    onebotReady: false,
    receiveHealthy: false,
    hasStoredAccount: true,
    autoRestore: false,
    autoRenew: false,
    canRenew: false,
    renewAt: null,
    lastRenewedAt: null,
    retryAt: null,
    error: null,
    operationId: null,
    capabilities: ['private-text', 'message-events'],
};
export const directOperation: DirectOperation = {
    id: 'b'.repeat(32),
    accountId: directAccount.id,
    generation: 'c'.repeat(32),
    kind: 'qr',
    status: 'running',
    phase: 'qr-ready',
    qrAvailable: true,
    error: null,
    startedAt: 1700000000000,
    finishedAt: null,
};
export const pngBytes = Uint8Array.from(
    Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJv0AAAAASUVORK5CYII=',
        'base64',
    ),
);
export const controlInput = {
    expectedRevision: directAccount.revision,
    operationKey: 'c8dfc567-86df-4e8c-9e7b-373f43d19020',
};
