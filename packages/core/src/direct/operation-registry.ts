import { randomBytes } from 'node:crypto';
import {
    parseDirectAccountId,
    parseDirectControlRequest,
    parseDirectOperation,
    parseDirectOperationId,
    type DirectAccountPhase,
    type DirectControlRequest,
    type DirectOperation,
    type DirectOperationKind,
    type DirectOperationStatus,
} from '@snowluma/common/direct-account';
import {
    assertDirectRequestScope,
    DirectServiceError,
    type DirectRequestScope,
} from './service-contract';

interface Entry {
    owner: string;
    deduplicationKey: string;
    fingerprint: string;
    operation: DirectOperation;
}

export interface NewDirectOperation {
    accountId: string;
    generation: string;
    kind: DirectOperationKind;
    phase: DirectAccountPhase;
    request: DirectControlRequest;
    scope: DirectRequestScope;
}

/** Bounded metadata only. Credentials, QR bytes and management tokens never enter
 * this registry. A repeated key is checked before the actor's revision gate, so
 * an HTTP retry can recover its original result without replaying the effect. */
export class DirectOperationRegistry {
    private readonly entries = new Map<string, Entry>();
    private readonly keys = new Map<string, string>();
    private readonly maxRecords: number;
    private readonly retentionMs: number;

    constructor(options: { maxRecords?: number; retentionMs?: number } = {}) {
        this.maxRecords = options.maxRecords ?? 256;
        this.retentionMs = options.retentionMs ?? 15 * 60 * 1000;

        if (
            !Number.isSafeInteger(this.maxRecords) ||
            this.maxRecords < 1 ||
            this.maxRecords > 4096 ||
            !Number.isSafeInteger(this.retentionMs) ||
            this.retentionMs < 1 ||
            this.retentionMs > 24 * 60 * 60 * 1000
        ) {
            throw new TypeError('invalid direct operation registry limits');
        }
    }

    get size(): number {
        this.prune();
        return this.entries.size;
    }

    private identity(
        accountId: string,
        kind: DirectOperationKind,
        request: DirectControlRequest,
        scope: DirectRequestScope,
    ): { key: string; fingerprint: string } {
        assertDirectRequestScope(scope);
        parseDirectAccountId(accountId);
        const validated = parseDirectControlRequest(request);

        if (!/^[0-9a-f]{64}$/.test(scope.owner)) {
            throw new DirectServiceError('invalid-request');
        }

        return {
            key: `${scope.owner}\0${accountId}\0${validated.operationKey}`,
            fingerprint: `${kind}\0${validated.expectedRevision}`,
        };
    }

    find(
        accountId: string,
        kind: DirectOperationKind,
        request: DirectControlRequest,
        scope: DirectRequestScope,
    ): DirectOperation | undefined {
        const identity = this.identity(accountId, kind, request, scope);
        this.prune();
        const id = this.keys.get(identity.key);
        const entry = id === undefined ? undefined : this.entries.get(id);

        if (!entry) {
            return undefined;
        }

        if (entry.fingerprint !== identity.fingerprint) {
            throw new DirectServiceError('operation-key-conflict');
        }

        assertDirectRequestScope(scope);
        return { ...entry.operation };
    }

    create(input: NewDirectOperation): DirectOperation {
        const existing = this.find(input.accountId, input.kind, input.request, input.scope);

        if (existing) {
            return existing;
        }

        const identity = this.identity(input.accountId, input.kind, input.request, input.scope);
        parseDirectOperationId(input.generation);
        this.makeRoom();
        let id = randomBytes(16).toString('hex');

        while (this.entries.has(id)) {
            id = randomBytes(16).toString('hex');
        }

        const operation = parseDirectOperation({
            id,
            accountId: input.accountId,
            generation: input.generation,
            kind: input.kind,
            status: 'running',
            phase: input.phase,
            qrAvailable: false,
            error: null,
            startedAt: Date.now(),
            finishedAt: null,
        });
        assertDirectRequestScope(input.scope);
        this.entries.set(id, {
            owner: input.scope.owner,
            deduplicationKey: identity.key,
            fingerprint: identity.fingerprint,
            operation,
        });
        this.keys.set(identity.key, id);
        return { ...operation };
    }

    get(id: string, scope: DirectRequestScope): DirectOperation {
        assertDirectRequestScope(scope);
        parseDirectOperationId(id);
        this.prune();
        const entry = this.entries.get(id);

        if (!entry || entry.owner !== scope.owner) {
            throw new DirectServiceError('operation-not-found');
        }

        assertDirectRequestScope(scope);
        return { ...entry.operation };
    }

    /** Internal actor view; never used by an HTTP operation/QR handler. */
    peek(id: string): DirectOperation | undefined {
        const operation = this.entries.get(id)?.operation;
        return operation ? { ...operation } : undefined;
    }

    visibleId(id: string | undefined, scope: DirectRequestScope): string | null {
        assertDirectRequestScope(scope);
        const entry = id === undefined ? undefined : this.entries.get(id);
        return entry?.owner === scope.owner ? entry.operation.id : null;
    }

    update(
        id: string,
        patch: Pick<DirectOperation, 'phase'> &
            Partial<Pick<DirectOperation, 'qrAvailable' | 'error'>>,
    ): void {
        const entry = this.entries.get(id);

        if (!entry || entry.operation.status !== 'running') {
            return;
        }

        entry.operation = parseDirectOperation({ ...entry.operation, ...patch });
    }

    /** First terminal result wins. Late old-generation callbacks cannot change it. */
    finish(
        id: string,
        status: Exclude<DirectOperationStatus, 'running'>,
        phase: DirectAccountPhase,
        error: string | null,
    ): void {
        const entry = this.entries.get(id);

        if (!entry || entry.operation.status !== 'running') {
            return;
        }

        entry.operation = parseDirectOperation({
            ...entry.operation,
            status,
            phase,
            error,
            qrAvailable: false,
            finishedAt: Math.max(Date.now(), entry.operation.startedAt),
        });
    }

    clear(): void {
        this.entries.clear();
        this.keys.clear();
    }

    private remove(id: string, entry: Entry): void {
        this.entries.delete(id);
        this.keys.delete(entry.deduplicationKey);
    }

    private prune(): void {
        const now = Date.now();

        for (const [id, entry] of this.entries) {
            const finishedAt = entry.operation.finishedAt;

            if (finishedAt !== null && now - finishedAt >= this.retentionMs) {
                this.remove(id, entry);
            }
        }
    }

    private makeRoom(): void {
        this.prune();

        if (this.entries.size < this.maxRecords) {
            return;
        }

        let oldest: [string, Entry] | undefined;

        for (const item of this.entries) {
            const time = item[1].operation.finishedAt;

            if (time !== null && (!oldest || time < oldest[1].operation.finishedAt!)) {
                oldest = item;
            }
        }

        if (oldest) {
            this.remove(...oldest);
            return;
        }

        throw new DirectServiceError('operation-capacity');
    }
}
