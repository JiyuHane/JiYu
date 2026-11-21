/** Browser-safe, public management contract. No paths, credentials or runtime owners belong here. */
export const DIRECT_ACCOUNT_PHASES = [
    'stopped',
    'starting',
    'qr-ready',
    'waiting-scan',
    'waiting-confirmation',
    'registering',
    'restoring',
    'online',
    'renewing',
    'backoff',
    'needs-login',
    'stopping',
    'failed',
] as const;
export type DirectAccountPhase = (typeof DIRECT_ACCOUNT_PHASES)[number];
export type DirectOperationKind = 'qr' | 'restore' | 'stop' | 'renew';
export type DirectOperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface DirectAccountStatus {
    id: string;
    label: string;
    protocol: 'linux';
    revision: string;
    generation: string | null;
    uin: string | null;
    phase: DirectAccountPhase;
    online: boolean;
    onebotReady: boolean;
    receiveHealthy: boolean;
    /** A selector exists; this is not proof that its ciphertext was freshly validated. */
    hasStoredAccount: boolean;
    autoRestore: boolean;
    autoRenew: boolean;
    canRenew: boolean;
    renewAt: number | null;
    lastRenewedAt: number | null;
    retryAt: number | null;
    error: string | null;
    operationId: string | null;
    capabilities: readonly string[];
}

export interface DirectOperation {
    id: string;
    accountId: string;
    generation: string;
    kind: DirectOperationKind;
    status: DirectOperationStatus;
    phase: DirectAccountPhase;
    qrAvailable: boolean;
    error: string | null;
    startedAt: number;
    finishedAt: number | null;
}

export interface DirectAccountsResponse {
    supported: boolean;
    configured: boolean;
    reason: string | null;
    accounts: DirectAccountStatus[];
}
export interface DirectAccountResponse {
    account: DirectAccountStatus;
}
export interface DirectOperationResponse {
    operation: DirectOperation;
}
/** A 202 response means accepted, even if a fast operation already reached a terminal state. */
export interface DirectAcceptedResponse extends DirectAccountResponse, DirectOperationResponse {}
export interface DirectFailureResponse {
    status: 'failed';
    code: string;
    message: string;
}
export interface DirectControlRequest {
    expectedRevision: string;
    operationKey: string;
}
export interface DirectStartRequest extends DirectControlRequest {
    mode: 'qr' | 'restore';
}

const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,47}$/;
const OPAQUE_ID = /^[0-9a-f]{32}$/;
const OPERATION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,63}$/;

function invalid(): never {
    // Never interpolate an external value: failures may be shown in the management UI.
    throw new TypeError('Invalid direct account contract');
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return invalid();
    }

    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);

    if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.length !== fields.length ||
        keys.some((key) => typeof key !== 'string' || !fields.includes(key))
    ) {
        return invalid();
    }

    const result: Record<string, unknown> = Object.create(null);

    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);

        if (!descriptor || !('value' in descriptor)) {
            return invalid();
        }

        result[field] = descriptor.value;
    }

    return result;
}

function matching(value: unknown, pattern: RegExp): string {
    return typeof value === 'string' && pattern.test(value) ? value : invalid();
}

function text(value: unknown, maximum: number): string {
    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximum ||
        Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
        return invalid();
    }

    return value;
}

function boolean(value: unknown): boolean {
    return typeof value === 'boolean' ? value : invalid();
}

function timestamp(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : invalid();
}

function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
    return value === null ? null : parse(value);
}

function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
    return typeof value === 'string' && choices.includes(value as T) ? (value as T) : invalid();
}

export function isDirectAccountId(value: unknown): value is string {
    return typeof value === 'string' && ACCOUNT_ID.test(value);
}

export function parseDirectAccountId(value: unknown): string {
    return matching(value, ACCOUNT_ID);
}

export function parseDirectOperationId(value: unknown): string {
    return matching(value, OPAQUE_ID);
}

function uin(value: unknown): string {
    const result = matching(value, /^[1-9][0-9]{0,9}$/);
    return Number(result) <= 0xffff_ffff ? result : invalid();
}

export function parseDirectAccountStatus(value: unknown): DirectAccountStatus {
    const v = record(value, [
        'id',
        'label',
        'protocol',
        'revision',
        'generation',
        'uin',
        'phase',
        'online',
        'onebotReady',
        'receiveHealthy',
        'hasStoredAccount',
        'autoRestore',
        'autoRenew',
        'canRenew',
        'renewAt',
        'lastRenewedAt',
        'retryAt',
        'error',
        'operationId',
        'capabilities',
    ]);

    if (!Array.isArray(v.capabilities) || v.capabilities.length > 64) {
        return invalid();
    }

    const capabilities = v.capabilities.map((item: unknown) => matching(item, CAPABILITY));

    if (new Set(capabilities).size !== capabilities.length) {
        return invalid();
    }

    return {
        id: parseDirectAccountId(v.id),
        label: text(v.label, 120),
        protocol: enumeration(v.protocol, ['linux']),
        revision: parseDirectOperationId(v.revision),
        generation: nullable(v.generation, parseDirectOperationId),
        uin: nullable(v.uin, uin),
        phase: enumeration(v.phase, DIRECT_ACCOUNT_PHASES),
        online: boolean(v.online),
        onebotReady: boolean(v.onebotReady),
        receiveHealthy: boolean(v.receiveHealthy),
        hasStoredAccount: boolean(v.hasStoredAccount),
        autoRestore: boolean(v.autoRestore),
        autoRenew: boolean(v.autoRenew),
        canRenew: boolean(v.canRenew),
        renewAt: nullable(v.renewAt, timestamp),
        lastRenewedAt: nullable(v.lastRenewedAt, timestamp),
        retryAt: nullable(v.retryAt, timestamp),
        error: nullable(v.error, (item) => matching(item, CODE)),
        operationId: nullable(v.operationId, parseDirectOperationId),
        capabilities,
    };
}

export function parseDirectOperation(value: unknown): DirectOperation {
    const v = record(value, [
        'id',
        'accountId',
        'generation',
        'kind',
        'status',
        'phase',
        'qrAvailable',
        'error',
        'startedAt',
        'finishedAt',
    ]);
    const operation: DirectOperation = {
        id: parseDirectOperationId(v.id),
        accountId: parseDirectAccountId(v.accountId),
        generation: parseDirectOperationId(v.generation),
        kind: enumeration(v.kind, ['qr', 'restore', 'stop', 'renew']),
        status: enumeration(v.status, ['running', 'succeeded', 'failed', 'cancelled']),
        phase: enumeration(v.phase, DIRECT_ACCOUNT_PHASES),
        qrAvailable: boolean(v.qrAvailable),
        error: nullable(v.error, (item) => matching(item, CODE)),
        startedAt: timestamp(v.startedAt),
        finishedAt: nullable(v.finishedAt, timestamp),
    };

    if (
        (operation.status === 'running') !== (operation.finishedAt === null) ||
        (operation.finishedAt !== null && operation.finishedAt < operation.startedAt) ||
        (operation.qrAvailable && (operation.kind !== 'qr' || operation.status !== 'running'))
    ) {
        return invalid();
    }

    return operation;
}

export function parseDirectAccountsResponse(value: unknown): DirectAccountsResponse {
    const v = record(value, ['supported', 'configured', 'reason', 'accounts']);

    if (!Array.isArray(v.accounts) || v.accounts.length > 32) {
        return invalid();
    }

    const accounts = v.accounts.map(parseDirectAccountStatus);

    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
        return invalid();
    }

    return {
        supported: boolean(v.supported),
        configured: boolean(v.configured),
        reason: nullable(v.reason, (item) => matching(item, CODE)),
        accounts,
    };
}

export function parseDirectAccountResponse(value: unknown): DirectAccountResponse {
    const v = record(value, ['account']);
    return { account: parseDirectAccountStatus(v.account) };
}

export function parseDirectOperationResponse(value: unknown): DirectOperationResponse {
    const v = record(value, ['operation']);
    return { operation: parseDirectOperation(v.operation) };
}

export function parseDirectAcceptedResponse(value: unknown): DirectAcceptedResponse {
    const v = record(value, ['account', 'operation']);
    const account = parseDirectAccountStatus(v.account);
    const operation = parseDirectOperation(v.operation);

    if (account.id !== operation.accountId) {
        return invalid();
    }

    return { account, operation };
}

export function parseDirectFailureResponse(value: unknown): DirectFailureResponse {
    const v = record(value, ['status', 'code', 'message']);
    return {
        status: enumeration(v.status, ['failed']),
        code: matching(v.code, CODE),
        message: text(v.message, 300),
    };
}

export function parseDirectControlRequest(value: unknown): DirectControlRequest {
    const v = record(value, ['expectedRevision', 'operationKey']);
    return {
        expectedRevision: parseDirectOperationId(v.expectedRevision),
        operationKey: matching(v.operationKey, OPERATION_KEY),
    };
}

export function parseDirectStartRequest(value: unknown): DirectStartRequest {
    const v = record(value, ['mode', 'expectedRevision', 'operationKey']);
    return {
        ...parseDirectControlRequest({
            expectedRevision: v.expectedRevision,
            operationKey: v.operationKey,
        }),
        mode: enumeration(v.mode, ['qr', 'restore']),
    };
}

export function parseDirectCancelRequest(value: unknown): Record<string, never> {
    record(value, []);
    return {};
}
