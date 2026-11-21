import { describe, expect, it } from 'vitest';
import {
    DIRECT_ACCOUNT_PHASES,
    parseDirectAcceptedResponse,
    parseDirectAccountResponse,
    parseDirectAccountsResponse,
    parseDirectAccountStatus,
    parseDirectCancelRequest,
    parseDirectControlRequest,
    parseDirectFailureResponse,
    parseDirectOperation,
    parseDirectOperationResponse,
    parseDirectStartRequest,
    type DirectAccountStatus,
    type DirectOperation,
} from '../src/direct-account';

const revision = 'a'.repeat(32);
const key = 'c8dfc567-86df-4e8c-9e7b-373f43d19020';
const account: DirectAccountStatus = {
    id: 'fixture-account',
    label: 'Fixture',
    protocol: 'linux',
    revision,
    generation: null,
    uin: null,
    phase: 'stopped',
    online: false,
    onebotReady: false,
    receiveHealthy: false,
    hasStoredAccount: false,
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
const operation: DirectOperation = {
    id: revision,
    accountId: account.id,
    generation: 'b'.repeat(32),
    kind: 'qr',
    status: 'running',
    phase: 'qr-ready',
    qrAvailable: true,
    error: null,
    startedAt: 1700000000000,
    finishedAt: null,
};

describe('direct account public contract', () => {
    it('round-trips public envelopes with independent account arrays', () => {
        const parsed = parseDirectAccountsResponse({
            supported: true,
            configured: true,
            reason: null,
            accounts: [account],
        });
        expect(parsed.accounts).toEqual([account]);
        expect(parsed.accounts[0]).not.toBe(account);
        expect(parsed.accounts[0].capabilities).not.toBe(account.capabilities);
        expect(parseDirectAccountResponse({ account })).toEqual({ account });
        expect(parseDirectOperationResponse({ operation })).toEqual({ operation });
        expect(parseDirectAcceptedResponse({ account, operation })).toEqual({ account, operation });
    });

    it.each(DIRECT_ACCOUNT_PHASES)('retains the real %s phase', (phase) => {
        expect(parseDirectAccountStatus({ ...account, phase }).phase).toBe(phase);
    });

    it('distinguishes selector presence from a validated account and known renewal times', () => {
        expect(parseDirectAccountStatus({ ...account, hasStoredAccount: true })).toMatchObject({
            hasStoredAccount: true,
            uin: null,
            lastRenewedAt: null,
            renewAt: null,
        });
    });

    it.each([
        { id: '../private' },
        { uin: '4294967296' },
        { uin: '01' },
        { online: 'true' },
        { generation: 'x'.repeat(32) },
        { revision: null },
        { retryAt: -1 },
        { renewAt: Infinity },
        { lastRenewedAt: 1.5 },
        { capabilities: ['text', 'text'] },
        { label: 'bad\nlabel' },
        { error: '/private/secret' },
        { tickets: { d2: 'secret-marker' } },
    ])('rejects invalid or private account fields without echoing input', (patch) => {
        expect(() => parseDirectAccountStatus({ ...account, ...patch })).toThrow(
            'Invalid direct account contract',
        );
    });

    it('rejects accessors without evaluating them', () => {
        let read = false;
        const invalid = { ...account };
        Object.defineProperty(invalid, 'label', {
            enumerable: true,
            get() {
                read = true;
                return 'x';
            },
        });
        expect(() => parseDirectAccountStatus(invalid)).toThrow();
        expect(read).toBe(false);
    });

    it('rejects non-objects, oversized lists and duplicate accounts', () => {
        for (const value of [null, [], 'secret-marker', 1]) {
            expect(() => parseDirectAccountStatus(value)).toThrow();
        }

        for (const accounts of [[account, account], Array.from({ length: 33 }, () => account)]) {
            expect(() =>
                parseDirectAccountsResponse({
                    supported: true,
                    configured: true,
                    reason: null,
                    accounts,
                }),
            ).toThrow();
        }
    });

    it('requires matching mutation account identity and coherent operation completion', () => {
        expect(() =>
            parseDirectAcceptedResponse({
                account,
                operation: { ...operation, accountId: 'other' },
            }),
        ).toThrow();

        for (const patch of [
            { status: 'succeeded' },
            { finishedAt: operation.startedAt },
            { kind: 'restore' },
            { status: 'failed', finishedAt: operation.startedAt - 1 },
        ]) {
            expect(() => parseDirectOperation({ ...operation, ...patch })).toThrow();
        }

        expect(
            parseDirectOperation({
                ...operation,
                status: 'succeeded',
                qrAvailable: false,
                finishedAt: operation.startedAt + 1,
            }).status,
        ).toBe('succeeded');
    });

    it('strictly parses control requests and UUIDv4 idempotency keys', () => {
        const control = { expectedRevision: revision, operationKey: key };
        expect(parseDirectControlRequest(control)).toEqual(control);
        expect(parseDirectStartRequest({ ...control, mode: 'restore' })).toEqual({
            ...control,
            mode: 'restore',
        });
        expect(parseDirectCancelRequest({})).toEqual({});

        for (const patch of [
            { mode: 'restore' },
            { expectedRevision: 'bad' },
            { operationKey: 'bad' },
        ]) {
            expect(() => parseDirectControlRequest({ ...control, ...patch })).toThrow();
        }

        expect(() =>
            parseDirectStartRequest({ ...control, mode: 'qr', configFile: 'secret-marker' }),
        ).toThrow();
        expect(() => parseDirectCancelRequest({ generation: revision })).toThrow();
    });

    it('retains fixed failures but rejects raw extra diagnostic fields', () => {
        const error = { status: 'failed', code: 'account-store-locked', message: '操作失败' };
        expect(parseDirectFailureResponse(error)).toEqual(error);
        expect(() => parseDirectFailureResponse({ ...error, cause: 'secret-marker' })).toThrow();
    });
});
