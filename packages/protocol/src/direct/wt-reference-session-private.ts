import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { decodeServiceResponse } from './service-frame';
import { decodeSsoResponse } from './sso';
import { isWtReferencePushCommand, isWtReferencePushProtocol } from './wt-reference-push-commands';
import type { DirectSendMessageRequestInput } from './send-message-request';
import type { SsoSendTextOutcome } from './sso-reference-send-text-flow';
import type { RawSessionLease } from './raw-session-broker';
import type {
    PreparedReferenceFriendInput,
    ReferenceFriendProgress,
    WtReferenceFriendResult,
    WtReferenceFriendStepId,
} from './wt-reference-friend-flow';
import type { WtActiveReferenceSession } from './wt-reference-session';
import {
    isWtReferencePacketCommand,
    type WtReferencePacketCommand,
    type WtReferencePacketInput,
    type WtReferencePacketResult,
    type ReferencePacketProgress,
} from './wt-reference-packet-flow';

export type ReferenceSessionSendInput = {
    request: DirectSendMessageRequestInput;
    maxResponseBodyBytes: number;
};
export type ReferenceSessionSendImplementation = (
    input: ReferenceSessionSendInput,
) => Promise<Extract<SsoSendTextOutcome, { status: 'response' }>>;
export type ReferenceSessionFriendImplementation = (
    input: PreparedReferenceFriendInput,
    workflowRun: object,
    deadline: number,
    progress: ReferenceFriendProgress,
) => Promise<WtReferenceFriendResult>;
export type ReferenceSessionPacketImplementation = (
    input: WtReferencePacketInput,
    run: object,
    deadline: number,
    progress: ReferencePacketProgress,
) => Promise<WtReferencePacketResult>;
export type ReferenceSessionSendHandle = ReferenceSessionSendImplementation & {
    readonly friendRequest: ReferenceSessionFriendImplementation;
    readonly requestPacket: ReferenceSessionPacketImplementation;
};
const sendImplementations = new WeakMap<
    ReferenceSessionSendHandle,
    {
        send: ReferenceSessionSendImplementation;
        friend?: ReferenceSessionFriendImplementation;
        packet?: ReferenceSessionPacketImplementation;
    }
>();

// Both call shapes retain only the same revocable handle, never the implementation.
function createSendHandle(): ReferenceSessionSendHandle {
    const send: ReferenceSessionSendImplementation = (input) => {
        const implementation = sendImplementations.get(handle);
        return implementation
            ? implementation.send(input)
            : Promise.reject(new Error('session send revoked'));
    };

    const friendRequest: ReferenceSessionFriendImplementation = (...args) => {
        const implementation = sendImplementations.get(handle)?.friend;
        return implementation
            ? implementation(...args)
            : Promise.reject(new Error('session send revoked'));
    };

    const requestPacket: ReferenceSessionPacketImplementation = (...args) => {
        const implementation = sendImplementations.get(handle)?.packet;
        return implementation
            ? implementation(...args)
            : Promise.reject(new Error('session packet capability revoked'));
    };

    const handle = Object.assign(send, { friendRequest, requestPacket });
    return Object.freeze(handle);
}

// A capability is scoped to one owner, not a security boundary against code in
// this process. In particular, this module is reachable by a deep import.
type BusinessOperation =
    'poll' | 'login-register' | 'restore-register' | 'heartbeat' | 'alive' | 'refresh-tickets';
type Slot = {
    phase: 'empty' | 'tentative' | 'active' | 'revoked';
    restored?: boolean;
    attempt?: object;
    reservation?: object;
    ownerLease?: object;
    sessionOwner?: WtActiveReferenceSession;
    sessionHandle?: ReferenceSessionSendHandle;
    sessionHandleTaken?: boolean;
    sendRun?: object;
    usedSendRuns?: WeakSet<object>;
    ticketRefreshRun?: object;
    ticketRefreshCandidateKey?: Uint8Array;
    ticketRefreshContinuation?: {
        owner: WtActiveReferenceSession;
        lease: RawSessionLease;
        attempt: object;
        run: object;
        release: () => void;
    };
    packetOperation?: ReferencePacketOperation;
    friendWorkflow?: {
        run: object;
        step?: ReferenceFriendStep;
        settingsFinished: boolean;
        applicationAttempted: boolean;
    };
    businessOwner?: object;
    businessFinalized?: boolean;
    businessFailure?: {
        operation: BusinessOperation;
        status: string;
        exactResult?: object;
        deadline?: number;
    };
    transportUin?: string;
    confirmedUin?: string;
    sequence?: number;
    key?: Uint8Array;
};
const slots = new WeakMap<object, Slot>();
const borrowedAttempts = new WeakMap<object, object>();
const fill = Uint8Array.prototype.fill;
const set = Uint8Array.prototype.set;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;

function slot(token: object): Slot {
    const value = slots.get(token);

    if (!value) {
        throw new Error('invalid reference capability');
    }

    return value;
}

/** Internal composition capability. It exposes no raw key or plaintext. */
export function createReferenceKeyCapability(): object {
    const token = Object.freeze({});
    slots.set(token, { phase: 'empty' });
    return token;
}

export function assertReferenceKeyCapabilityAvailable(token: object): void {
    const value = slot(token);

    if (value.phase !== 'empty' || value.attempt || value.reservation) {
        throw new Error('reference capability already bound or stopped');
    }
}

/** Reserve before any owner callbacks can reenter construction. */
export function reserveReferenceKeyCapability(token: object): object {
    assertReferenceKeyCapabilityAvailable(token);
    const reservation = Object.freeze({});
    slot(token).reservation = reservation;
    return reservation;
}

/** Recheck the original reservation without invoking caller-provided properties. */
export function assertReferenceKeyReservation(token: object, reservation: object): void {
    const value = slot(token);

    if (value.phase !== 'empty' || value.attempt || value.reservation !== reservation) {
        throw new Error('reference capability reservation stopped');
    }
}

export function bindReferenceKeyAttempt(token: object, attempt: object, reservation: object): void {
    const value = slot(token);

    if (value.phase !== 'empty' || value.attempt || value.reservation !== reservation) {
        throw new Error('reference capability already bound or stopped');
    }

    value.reservation = undefined;
    value.attempt = attempt;
    value.businessOwner = reservation;
}

function isReferenceObject(value: unknown): value is object {
    return value !== null && typeof value === 'object' && !isProxy(value);
}

/** Internal coordination only: deep imports can register objects; this is not
 * same-process isolation or proof of an attempt's origin or peer identity. */
export function registerReferenceBorrowedAttempt(attempt: object, lease: object): void {
    if (!isReferenceObject(attempt) || !isReferenceObject(lease) || borrowedAttempts.has(attempt)) {
        throw new Error('invalid reference attempt binding');
    }

    borrowedAttempts.set(attempt, lease);
}

/** Bind the registered borrowed lease before owner callbacks. Deep direct calls do
 * not register with the attempt's lifecycle and are not equivalent to the owner. */
export function bindReferenceKeyAttemptOwnerLease(
    token: object,
    attempt: object,
    reservation: object,
    lease: object,
): void {
    if (
        !isReferenceObject(token) ||
        !isReferenceObject(attempt) ||
        !isReferenceObject(reservation) ||
        !isReferenceObject(lease) ||
        borrowedAttempts.get(attempt) !== lease
    ) {
        throw new Error('invalid reference attempt binding');
    }

    // This deep-importable entry point also rejects stopped or in-flight
    // attempts without evaluating an accessor. It is not a security boundary.
    const state = Object.getOwnPropertyDescriptor(attempt, 'state');
    const busy = Object.getOwnPropertyDescriptor(attempt, 'busy');

    if (
        !state ||
        !('value' in state) ||
        state.value !== 'new' ||
        !busy ||
        !('value' in busy) ||
        busy.value !== false
    ) {
        throw new Error('invalid reference attempt binding');
    }

    const value = slot(token);

    if (value.phase !== 'empty' || value.attempt || value.reservation !== reservation) {
        throw new Error('reference capability already bound or stopped');
    }

    value.reservation = undefined;
    value.attempt = attempt;
    value.businessOwner = reservation;
    value.ownerLease = lease;
}

/** A distinct persisted origin: no QR attempt, fake state fields, or borrowed-attempt
 * registration. The ordinary send gates treat its identity as an opaque origin. */
export function bindReferenceRestoredOwnerLease(
    token: object,
    reservation: object,
    lease: object,
    uin: string,
): object {
    const value = slot(token);

    if (
        !isReferenceObject(reservation) ||
        !isReferenceObject(lease) ||
        typeof uin !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(uin) ||
        BigInt(uin) > 0xffffffffn ||
        value.phase !== 'empty' ||
        value.attempt ||
        value.reservation !== reservation
    ) {
        throw new Error('invalid restored session binding');
    }

    const origin = Object.freeze({});
    value.reservation = undefined;
    value.attempt = origin;
    value.businessOwner = reservation;
    value.ownerLease = lease;
    value.transportUin = uin;
    value.confirmedUin = uin;
    value.restored = true;
    return origin;
}

/** Stage only after the exact restored owner has published its still-inactive handle. */
export function stageReferenceRestoredKey(
    token: object,
    origin: object,
    lease: object,
    owner: WtActiveReferenceSession,
    key: Uint8Array,
): void {
    const value = slot(token);

    if (
        value.phase !== 'empty' ||
        value.restored !== true ||
        value.attempt !== origin ||
        value.ownerLease !== lease ||
        value.sessionOwner !== owner ||
        !value.sessionHandle ||
        !value.confirmedUin ||
        isProxy(key) ||
        !isUint8Array(key) ||
        isSharedArrayBuffer(buffer.call(key)) ||
        byteLength.call(key) !== 16
    ) {
        throw new Error('invalid restored key stage');
    }

    const copy = new Uint8Array(16);
    set.call(copy, key);
    value.key = copy;
    value.phase = 'tentative';
}

/** Publication is tied to the original reservation, origin and borrowed lease. */
export function publishReferenceSessionSend(
    token: object,
    reservation: object,
    attempt: object,
    lease: RawSessionLease,
    owner: WtActiveReferenceSession,
    implementation: ReferenceSessionSendImplementation,
    friend?: ReferenceSessionFriendImplementation,
    packet?: ReferenceSessionPacketImplementation,
): void {
    const value = slot(token);

    if (
        value.phase !== 'empty' ||
        value.businessOwner !== reservation ||
        value.attempt !== attempt ||
        value.ownerLease !== lease ||
        value.sessionOwner ||
        value.sessionHandle
    ) {
        throw new Error('invalid reference session binding');
    }

    const handle = createSendHandle();
    sendImplementations.set(handle, { send: implementation, friend, packet });
    value.sessionOwner = owner;
    value.sessionHandle = handle;
    value.sessionHandleTaken = false;
}

/** Wrong identity does not consume the one exact claim. */
export function takeReferenceSessionSend(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
): ReferenceSessionSendHandle | undefined {
    const value = slots.get(token);

    if (
        !value ||
        value.phase === 'revoked' ||
        value.sessionOwner !== owner ||
        value.ownerLease !== lease ||
        value.sessionHandleTaken ||
        !value.sessionHandle
    ) {
        return undefined;
    }

    value.sessionHandleTaken = true;
    return value.sessionHandle;
}

/** Exact owner binding remains available after the original attempt is closed. */
export function assertReferenceSessionSendActive(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
): void {
    const value = slot(token);

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.sessionOwner !== owner ||
        value.ownerLease !== lease ||
        value.attempt !== attempt ||
        !value.sessionHandle ||
        !value.sessionHandleTaken ||
        !sendImplementations.has(value.sessionHandle)
    ) {
        throw new Error('invalid reference session binding');
    }
}

/** Bind one native-ticket workflow to the exact active owner generation. The two
 * code-owned exchanges use independent child runs; this outer run survives until
 * durable checkpoint and synchronous activation have both settled. */
export function beginReferenceTicketRefresh(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
): void {
    assertReferenceSessionSendActive(token, owner, lease, attempt);
    const value = slot(token);

    if (
        !isReferenceObject(run) ||
        value.ticketRefreshRun ||
        value.ticketRefreshCandidateKey ||
        value.ticketRefreshContinuation ||
        value.sendRun ||
        value.packetOperation ||
        value.friendWorkflow ||
        value.usedSendRuns?.has(run)
    ) {
        throw new Error('invalid reference ticket refresh binding');
    }

    const used = value.usedSendRuns ?? new WeakSet<object>();
    used.add(run);
    value.usedSendRuns = used;
    value.ticketRefreshRun = run;
}

export function assertReferenceTicketRefresh(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
): void {
    assertReferenceSessionSendActive(token, owner, lease, attempt);
    const value = slot(token);

    if (value.ticketRefreshRun !== run || value.packetOperation || value.friendWorkflow) {
        throw new Error('invalid reference ticket refresh binding');
    }
}

/** Arm the code-owned raw response continuation while the exact second refresh send is active. */
export function armReferenceTicketRefreshContinuation(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    release: () => void,
): void {
    const value = slot(token);
    const attempt = value.attempt;
    const run = value.ticketRefreshRun;

    if (
        !attempt ||
        !run ||
        !value.sendRun ||
        value.ticketRefreshCandidateKey ||
        value.ticketRefreshContinuation ||
        typeof release !== 'function' ||
        isProxy(release)
    ) {
        throw new Error('invalid reference ticket refresh continuation');
    }

    assertReferenceTicketRefresh(token, owner, lease, attempt, run);
    value.ticketRefreshContinuation = { owner, lease, attempt, run, release };
}

function validReferenceKey(value: unknown): value is Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        return false;
    }

    try {
        values.call(value);
        const storage = buffer.call(value) as ArrayBufferLike;
        return (
            !isSharedArrayBuffer(storage) &&
            !(resizable && resizable.call(storage)) &&
            byteLength.call(value) === 16
        );
    } catch {
        return false;
    }
}

function sameReferenceKey(left: Uint8Array, right: Uint8Array): boolean {
    let same = true;

    for (let index = 0; index < 16; index++) {
        if (left[index] !== right[index]) {
            same = false;
        }
    }

    return same;
}

/** Keep one bounded candidate only while the exact refresh owner awaits durability.
 * Routing may decode either generation, but active sends still use the old key. */
export function stageReferenceTicketRefreshCandidate(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
    oldKey: Uint8Array,
    newKey: Uint8Array,
): void {
    assertReferenceTicketRefresh(token, owner, lease, attempt, run);
    const value = slot(token);
    const continuation = value.ticketRefreshContinuation;

    if (
        value.sendRun !== undefined ||
        value.phase !== 'active' ||
        !value.key ||
        value.ticketRefreshCandidateKey ||
        !continuation ||
        continuation.owner !== owner ||
        continuation.lease !== lease ||
        continuation.attempt !== attempt ||
        continuation.run !== run ||
        !validReferenceKey(oldKey) ||
        !validReferenceKey(newKey) ||
        !sameReferenceKey(oldKey, value.key)
    ) {
        throw new Error('invalid reference ticket key candidate');
    }

    const candidate = new Uint8Array(16);
    set.call(candidate, newKey);
    value.ticketRefreshCandidateKey = candidate;
    value.ticketRefreshContinuation = undefined;

    try {
        continuation.release();
    } catch (error) {
        fill.call(candidate, 0);
        value.ticketRefreshCandidateKey = undefined;
        throw error;
    }
}

/** Validate every old-generation binding before allocating the replacement. Once
 * the copy exists, replacement and old-key erasure are synchronous and phase stays active. */
export function rotateReferenceTicketKey(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
    oldKey: Uint8Array,
    newKey: Uint8Array,
): void {
    assertReferenceTicketRefresh(token, owner, lease, attempt, run);
    const value = slot(token);
    const oldMatches =
        validReferenceKey(oldKey) &&
        validReferenceKey(newKey) &&
        value.key !== undefined &&
        value.ticketRefreshCandidateKey !== undefined &&
        sameReferenceKey(oldKey, value.key) &&
        sameReferenceKey(newKey, value.ticketRefreshCandidateKey);

    if (!oldMatches || value.sendRun !== undefined || value.phase !== 'active' || !value.key) {
        throw new Error('invalid reference ticket key rotation');
    }

    const replacement = new Uint8Array(16);
    set.call(replacement, newKey);
    const previous = value.key;
    const candidate = value.ticketRefreshCandidateKey!;
    value.key = replacement;
    value.ticketRefreshCandidateKey = undefined;

    try {
        fill.call(previous, 0);
    } finally {
        fill.call(candidate, 0);
    }
}

export function endReferenceTicketRefresh(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
): void {
    const value = slot(token);

    if (value.phase === 'revoked') {
        return;
    }

    assertReferenceTicketRefresh(token, owner, lease, attempt, run);

    if (value.sendRun !== undefined) {
        throw new Error('ticket refresh exchange still active');
    }

    if (value.ticketRefreshCandidateKey) {
        fill.call(value.ticketRefreshCandidateKey, 0);
        value.ticketRefreshCandidateKey = undefined;
    }

    const continuation = value.ticketRefreshContinuation;
    value.ticketRefreshContinuation = undefined;
    value.ticketRefreshRun = undefined;
    continuation?.release();
}

export type ReferencePacketOperation = Readonly<{
    run: object;
    command: WtReferencePacketCommand;
}>;

export function beginReferencePacketOperation(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
    command: WtReferencePacketCommand,
): ReferencePacketOperation {
    assertReferenceSessionSendActive(token, owner, lease, attempt);
    const value = slot(token);

    if (
        !isReferenceObject(run) ||
        !isWtReferencePacketCommand(command) ||
        value.sendRun ||
        value.ticketRefreshRun ||
        value.packetOperation ||
        value.friendWorkflow ||
        value.usedSendRuns?.has(run)
    ) {
        throw new Error('invalid packet operation binding');
    }

    const operation = Object.freeze({ run, command });
    value.packetOperation = operation;
    return operation;
}

export function assertReferencePacketOperation(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    operation: ReferencePacketOperation,
): void {
    assertReferenceSessionSendActive(token, owner, lease, attempt);
    const value = slot(token);

    if (
        value.packetOperation !== operation ||
        value.friendWorkflow ||
        (value.sendRun !== undefined && value.sendRun !== operation.run)
    ) {
        throw new Error('invalid packet operation binding');
    }
}

/** Resolve command from the private owner run, never from signer-supplied metadata. */
export function referenceActivePacketOperation(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    run: object,
): ReferencePacketOperation {
    const value = slot(token);
    const operation = value.packetOperation;

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.sessionOwner !== owner ||
        value.ownerLease !== lease ||
        !operation ||
        operation.run !== run ||
        value.sendRun !== run
    ) {
        throw new Error('invalid active packet operation');
    }

    return operation;
}

export function endReferencePacketOperation(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    operation: ReferencePacketOperation,
): void {
    const value = slot(token);

    if (value.phase === 'revoked') {
        return;
    }

    assertReferencePacketOperation(token, owner, lease, attempt, operation);

    if (value.sendRun !== undefined) {
        throw new Error('packet exchange still active');
    }

    value.packetOperation = undefined;
}

export type ReferenceFriendStep = Readonly<{
    workflowRun: object;
    childRun: object;
    stepId: WtReferenceFriendStepId;
}>;

export function beginReferenceFriendWorkflow(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
): void {
    assertReferenceSessionSendActive(token, owner, lease, attempt);
    const value = slot(token);

    if (
        !isReferenceObject(run) ||
        value.sendRun ||
        value.ticketRefreshRun ||
        value.friendWorkflow ||
        value.packetOperation
    ) {
        throw new Error('invalid friend workflow binding');
    }

    value.friendWorkflow = { run, settingsFinished: false, applicationAttempted: false };
}

export function endReferenceFriendWorkflow(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    run: object,
): void {
    const value = slot(token);

    if (value.phase === 'revoked') {
        return;
    }

    assertReferenceSessionSendActive(token, owner, lease, attempt);

    if (value.friendWorkflow?.run !== run || value.friendWorkflow.step || value.sendRun) {
        throw new Error('invalid friend workflow binding');
    }

    value.friendWorkflow = undefined;
}

export function beginReferenceFriendStep(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    workflowRun: object,
    childRun: object,
    stepId: WtReferenceFriendStepId,
): ReferenceFriendStep {
    assertReferenceSessionSendActive(token, owner, lease, attempt);
    const value = slot(token);
    const workflow = value.friendWorkflow;

    if (
        !workflow ||
        workflow.run !== workflowRun ||
        workflow.step ||
        value.sendRun ||
        !isReferenceObject(childRun) ||
        value.usedSendRuns?.has(childRun) ||
        (stepId === 'settings'
            ? workflow.settingsFinished || workflow.applicationAttempted
            : stepId !== 'application' ||
              !workflow.settingsFinished ||
              workflow.applicationAttempted)
    ) {
        throw new Error('invalid friend step binding');
    }

    const step = Object.freeze({ workflowRun, childRun, stepId });
    workflow.step = step;

    if (stepId === 'application') {
        workflow.applicationAttempted = true;
    }

    return step;
}

export function assertReferenceFriendStep(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    step: ReferenceFriendStep,
): void {
    assertReferenceSessionSendActive(token, owner, lease, attempt);
    const value = slot(token);

    if (
        value.friendWorkflow?.run !== step.workflowRun ||
        value.friendWorkflow.step !== step ||
        (value.sendRun !== undefined && value.sendRun !== step.childRun)
    ) {
        throw new Error('invalid friend step binding');
    }
}

/** Mux reads the private active slot, not a command supplied by the signer. */
export function referenceActiveFriendStep(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    workflowRun: object,
): ReferenceFriendStep {
    const value = slot(token);
    const step = value.friendWorkflow?.step;

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.sessionOwner !== owner ||
        value.ownerLease !== lease ||
        !step ||
        step.workflowRun !== workflowRun ||
        value.sendRun !== step.childRun
    ) {
        throw new Error('invalid active friend step');
    }

    return step;
}

export function endReferenceFriendStep(
    token: object,
    owner: WtActiveReferenceSession,
    lease: RawSessionLease,
    attempt: object,
    step: ReferenceFriendStep,
): void {
    const value = slot(token);

    if (value.phase === 'revoked') {
        return;
    }

    assertReferenceFriendStep(token, owner, lease, attempt, step);

    if (value.sendRun !== undefined) {
        throw new Error('friend exchange still active');
    }

    const workflow = value.friendWorkflow!;
    workflow.step = undefined;

    if (step.stepId === 'settings') {
        workflow.settingsFinished = true;
    }
}

/** One terminal business outcome, independent of key revocation. */
export function stageReferenceBusinessFailure(
    token: object,
    operation: BusinessOperation,
    status: string,
    exactResult?: object,
    deadline?: number,
): void {
    const value = slot(token);
    const allowed =
        (operation === 'poll' && ['expired', 'canceled', 'invalid', 'unknown'].includes(status)) ||
        (operation === 'login-register' &&
            [
                'verification-required',
                'nonzero',
                'incomplete',
                'error',
                'rejected',
                'missing-result',
                'sso-error',
            ].includes(status)) ||
        (operation === 'restore-register' &&
            ['rejected', 'missing-result', 'sso-error'].includes(status)) ||
        ((operation === 'heartbeat' || operation === 'alive') && status === 'sso-error') ||
        (operation === 'refresh-tickets' && status === 'needs-login');

    if (
        !value.businessOwner ||
        value.businessFinalized ||
        !allowed ||
        (exactResult !== undefined &&
            (typeof deadline !== 'number' || !Number.isFinite(deadline))) ||
        (exactResult === undefined && deadline !== undefined)
    ) {
        throw new Error('invalid reference business failure');
    }

    value.businessFinalized = true;
    value.businessFailure = { operation, status, exactResult, deadline };
}

export function discardReferenceBusinessFailure(token: object, exactOnly = false): void {
    const value = slot(token);

    if (!exactOnly || value.businessFailure?.exactResult !== undefined) {
        value.businessFailure = undefined;
    }
}

/** Consume the tombstone once, including on a mismatched query. */
export function consumeReferenceBusinessFailure(
    token: object,
    operation: BusinessOperation,
    status: string,
    exactResult?: object,
): boolean {
    const value = slot(token);
    const failure = value.businessFailure;
    value.businessFailure = undefined;
    return (
        failure?.operation === operation &&
        failure.status === status &&
        failure.exactResult === undefined &&
        exactResult === undefined
    );
}

/** Burn first; only exact committed WT results carry an absolute monotonic deadline. */
export function takeReferenceExactBusinessFailure(
    token: object,
    operation: BusinessOperation,
    status: string,
    exactResult: object,
): { deadline: number } | undefined {
    const value = slot(token);
    const failure = value.businessFailure;
    value.businessFailure = undefined;

    if (
        !failure ||
        failure.operation !== operation ||
        failure.status !== status ||
        failure.exactResult !== exactResult ||
        typeof failure.deadline !== 'number' ||
        !Number.isFinite(failure.deadline) ||
        performance.now() >= failure.deadline
    ) {
        return undefined;
    }

    return { deadline: failure.deadline };
}

export function stageReferenceConfirmed(
    token: object,
    attempt: object,
    transportUin: string,
    confirmedUin: string,
    sequence: number,
): void {
    const value = slot(token);

    if (
        value.phase !== 'empty' ||
        value.restored === true ||
        value.attempt !== attempt ||
        value.confirmedUin !== undefined ||
        !/^(0|[1-9][0-9]{0,18})$/.test(transportUin) ||
        !/^[1-9][0-9]{0,9}$/.test(confirmedUin) ||
        BigInt(confirmedUin) > 0xffffffffn ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence > 0xffffffff
    ) {
        throw new Error('invalid reference account stage');
    }

    value.transportUin = transportUin;
    value.confirmedUin = confirmedUin;
    value.sequence = sequence;
}

export function referenceExpectedUin(token: object): string | undefined {
    const value = slot(token);
    return value.phase === 'revoked' ? undefined : value.confirmedUin;
}

export function stageReferenceKey(
    token: object,
    attempt: object,
    transportUin: string,
    confirmedUin: string,
    sequence: number,
    key: Uint8Array,
): void {
    const value = slot(token);

    if (
        value.phase !== 'empty' ||
        value.restored === true ||
        value.attempt !== attempt ||
        value.transportUin !== transportUin ||
        value.confirmedUin !== confirmedUin ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence > 0xffffffff ||
        isProxy(key) ||
        !isUint8Array(key) ||
        isSharedArrayBuffer(buffer.call(key)) ||
        byteLength.call(key) !== 16
    ) {
        throw new Error('invalid reference key stage');
    }

    const copy = new Uint8Array(16);
    set.call(copy, key);
    value.transportUin = transportUin;
    value.confirmedUin = confirmedUin;
    value.sequence = sequence;
    value.key = copy;
    value.phase = 'tentative';
}

export function commitReferenceKey(token: object): void {
    const value = slot(token);

    if (value.phase !== 'tentative' || !value.key) {
        throw new Error('reference key not staged');
    }

    value.phase = 'active';
}

/** Internal single-flight coordination, not a same-process or peer security boundary. */
function referenceSendSlot(token: object, attempt: object, lease: object, run: object): Slot {
    if (
        !isReferenceObject(token) ||
        !isReferenceObject(attempt) ||
        !isReferenceObject(lease) ||
        !isReferenceObject(run)
    ) {
        throw new Error('invalid reference send binding');
    }

    return slot(token);
}

export function beginReferenceSend(
    token: object,
    attempt: object,
    lease: object,
    run: object,
): void {
    const value = referenceSendSlot(token, attempt, lease, run);

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.attempt !== attempt ||
        value.ownerLease !== lease ||
        value.sendRun !== undefined ||
        (value.friendWorkflow !== undefined && value.friendWorkflow.step?.childRun !== run) ||
        (value.packetOperation !== undefined && value.packetOperation.run !== run) ||
        value.usedSendRuns?.has(run)
    ) {
        throw new Error('invalid reference send binding');
    }

    const used = value.usedSendRuns ?? new WeakSet<object>();
    used.add(run);
    value.usedSendRuns = used;
    value.sendRun = run;
}

export function assertReferenceSendIdentity(
    token: object,
    attempt: object,
    lease: object,
    run: object,
    identityUin: string,
    confirmedUin: string,
): void {
    const value = referenceSendSlot(token, attempt, lease, run);

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.attempt !== attempt ||
        value.ownerLease !== lease ||
        value.sendRun !== run ||
        typeof identityUin !== 'string' ||
        typeof confirmedUin !== 'string' ||
        value.transportUin !== identityUin ||
        value.confirmedUin !== confirmedUin
    ) {
        throw new Error('invalid reference send binding');
    }
}

/** Byte equality with the active slot only; it does not authenticate a key or peer. */
export function assertReferenceSendKey(
    token: object,
    attempt: object,
    lease: object,
    run: object,
    key: Uint8Array,
): void {
    const value = referenceSendSlot(token, attempt, lease, run);
    let matches = false;

    try {
        if (
            value.phase === 'active' &&
            value.key &&
            value.attempt === attempt &&
            value.ownerLease === lease &&
            value.sendRun === run &&
            !isProxy(key) &&
            isUint8Array(key)
        ) {
            values.call(key);
            const storage = buffer.call(key) as ArrayBufferLike;

            if (
                !isSharedArrayBuffer(storage) &&
                !(resizable && resizable.call(storage)) &&
                byteLength.call(key) === 16
            ) {
                matches = true;

                for (let index = 0; index < 16; index++) {
                    if (key[index] !== value.key[index]) {
                        matches = false;
                    }
                }
            }
        }
    } catch {
        matches = false;
    }

    if (!matches) {
        throw new Error('invalid reference send binding');
    }
}

export function endReferenceSend(token: object, attempt: object, lease: object, run: object): void {
    const value = referenceSendSlot(token, attempt, lease, run);

    if (value.phase === 'revoked') {
        return;
    }

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.attempt !== attempt ||
        value.ownerLease !== lease ||
        value.sendRun !== run
    ) {
        throw new Error('invalid reference send binding');
    }

    value.sendRun = undefined;
}

export function revokeReferenceKey(token: object): void {
    const value = slot(token);
    const continuation = value.ticketRefreshContinuation;
    value.ticketRefreshContinuation = undefined;

    try {
        continuation?.release();
    } catch {
        /* best effort; revocation continues */
    }

    if (value.sessionHandle) {
        sendImplementations.delete(value.sessionHandle);
    }

    value.sessionHandle = undefined;
    value.sessionOwner = undefined;
    value.sessionHandleTaken = true;

    try {
        if (value.key) {
            fill.call(value.key, 0);
        }
    } finally {
        try {
            if (value.ticketRefreshCandidateKey) {
                fill.call(value.ticketRefreshCandidateKey, 0);
            }
        } finally {
            value.key = undefined;
            value.ticketRefreshCandidateKey = undefined;
            value.restored = undefined;
            value.attempt = undefined;
            value.reservation = undefined;
            value.ownerLease = undefined;
            value.sendRun = undefined;
            value.usedSendRuns = undefined;
            value.ticketRefreshRun = undefined;
            value.ticketRefreshContinuation = undefined;
            value.friendWorkflow = undefined;
            value.packetOperation = undefined;
            value.transportUin = undefined;
            value.confirmedUin = undefined;
            value.sequence = undefined;
            value.phase = 'revoked';
        }
    }
}

export function referenceKeyState(token: object): Slot['phase'] {
    return slot(token).phase;
}

type DecodedReferenceFrame = {
    uin: string;
    protocol: 12 | 13;
    encryption: 'none' | 'zero' | 'd2';
    sequence: number;
    command: string;
};

function decodeReferenceFrameWithKey(
    value: Slot,
    frame: Uint8Array,
    key: Uint8Array | undefined,
): DecodedReferenceFrame {
    const outer = decodeServiceResponse(frame, key);

    try {
        if (outer.encryption === 'd2' && (!key || outer.uin !== value.confirmedUin)) {
            throw new Error('reference account mismatch');
        }

        const sso = decodeSsoResponse(outer.body);

        try {
            return {
                uin: outer.uin,
                protocol: outer.protocol,
                encryption: outer.encryption,
                sequence: sso.sequence >>> 0,
                command: sso.command,
            };
        } finally {
            fill.call(sso.body, 0);
            fill.call(sso.cookie, 0);
            fill.call(sso.reserved, 0);
            fill.call(sso.headerExtension, 0);
        }
    } finally {
        fill.call(outer.body, 0);
    }
}

/** Decrypt and project routing metadata only. QQ-TEA is not authentication. During
 * one exact durable refresh, either bounded key generation may route a queued push. */
export function decodeReferenceFrame(
    token: object,
    frame: Uint8Array,
    transportUin: string,
): DecodedReferenceFrame {
    const value = slot(token);

    if (value.phase === 'revoked' || (value.transportUin && value.transportUin !== transportUin)) {
        throw new Error('reference capability stopped');
    }

    try {
        return decodeReferenceFrameWithKey(value, frame, value.key);
    } catch (error) {
        if (!value.ticketRefreshCandidateKey) {
            throw error;
        }

        return decodeReferenceFrameWithKey(value, frame, value.ticketRefreshCandidateKey);
    }
}

function decodeReferencePushBodyWithKey(
    value: Slot,
    key: Uint8Array,
    frame: Uint8Array,
    transportUin: string,
    expected: Readonly<{ uin: string; sequence: number; command: string }>,
    maxBodyBytes: number,
): { body: Uint8Array; retCode: number } {
    const outer = decodeServiceResponse(frame, key);

    try {
        if (
            !isWtReferencePushProtocol(expected.command, outer.protocol) ||
            outer.encryption !== 'd2' ||
            outer.uin !== value.confirmedUin
        ) {
            throw new Error('push account or protocol mismatch');
        }

        const sso = decodeSsoResponse(outer.body);

        try {
            if (
                sso.sequence >>> 0 !== expected.sequence ||
                sso.command !== expected.command ||
                sso.body.byteLength > maxBodyBytes ||
                value.phase !== 'active' ||
                value.transportUin !== transportUin ||
                value.confirmedUin !== outer.uin
            ) {
                throw new Error('push metadata or body limit mismatch');
            }

            return { body: Uint8Array.from(sso.body), retCode: sso.retCode };
        } finally {
            fill.call(sso.body, 0);
            fill.call(sso.cookie, 0);
            fill.call(sso.reserved, 0);
            fill.call(sso.headerExtension, 0);
        }
    } finally {
        fill.call(outer.body, 0);
    }
}

/** Re-decode one already verified push with the same active capability. The returned
 * body is an independent temporary copy; this operation does not authenticate QQ-TEA. */
export function decodeReferencePushBody(
    token: object,
    frame: Uint8Array,
    transportUin: string,
    expected: Readonly<{ uin: string; sequence: number; command: string }>,
    maxBodyBytes: number,
): { body: Uint8Array; retCode: number } {
    const value = slot(token);

    if (
        value.phase !== 'active' ||
        !value.key ||
        value.transportUin !== transportUin ||
        value.confirmedUin !== expected.uin ||
        !isWtReferencePushCommand(expected.command) ||
        !Number.isSafeInteger(maxBodyBytes) ||
        maxBodyBytes < 1 ||
        maxBodyBytes > 16 * 1024 * 1024
    ) {
        throw new Error('invalid push capability or binding');
    }

    try {
        return decodeReferencePushBodyWithKey(
            value,
            value.key,
            frame,
            transportUin,
            expected,
            maxBodyBytes,
        );
    } catch (error) {
        if (!value.ticketRefreshCandidateKey) {
            throw error;
        }

        return decodeReferencePushBodyWithKey(
            value,
            value.ticketRefreshCandidateKey,
            frame,
            transportUin,
            expected,
            maxBodyBytes,
        );
    }
}
