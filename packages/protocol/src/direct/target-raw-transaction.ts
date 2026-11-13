import { isProxy } from 'node:util/types';
import { encodeTargetSso12Head, type TargetSso12Head } from './target-sso12-head';
import { encodeTargetServiceBusiness } from './target-service-business';
import {
    encodeTargetServiceRequest,
    type TargetBasicBranch,
    type TargetSourceCommand,
} from './target-service-request';
import {
    composeTargetResponseCandidateWithLookup,
    type CandidateWithLookup,
    type TargetReserveMode,
} from './target-response-candidate';
import type { Sso12RawTransport, Sso12RawResult } from './sso12-packet-client';

export interface TargetRawTransactionOptions {
    head: TargetSso12Head;
    rawBody: Uint8Array;
    service: {
        sourceCommand: TargetSourceCommand;
        virtualProtocol: number;
        basicBranch: TargetBasicBranch;
        requestObjectByte: number;
        uin: string;
        targetTeaKey: Uint8Array;
    };
    response: {
        expectedSelector: 0 | 1 | 2;
        key: Uint8Array | undefined;
        collection: readonly Uint8Array[];
        compression: 'reject' | 'node-zlib-strict';
        maxOutputBytes: number;
        reserveMode?: TargetReserveMode;
    };
    verifyRaw: (info: {
        transportUin: string;
        targetUin: string;
        sequence: number;
        requestFrame: Uint8Array;
        responseFrame: Uint8Array;
    }) => boolean | Promise<boolean>;
    /** Includes synchronous preparation; required because the client's default is private. */
    timeoutMs: number;
    signal?: AbortSignal;
}

const MAX_BYTES = 16 * 1024 * 1024;
const Bytes = Uint8Array;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const values = Uint8Array.prototype.values;
const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Cleanup is independently attempted for every owned buffer.
        }
    }
}

function chain(value: object): void {
    let next: object | null = value;

    for (let depth = 0; next !== null; depth++) {
        if (depth >= 256 || isProxy(next)) {
            throw new TypeError();
        }

        next = Object.getPrototypeOf(next) as object | null;
    }
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError();
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== null && proto !== Object.prototype) {
        throw new TypeError();
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, unknown>;

    for (const name of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, name) as PropertyDescriptor;

        if (!Object.hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }

        if (typeof name === 'string') {
            result[name] = descriptor.value;
        }
    }

    return result;
}

function copy(value: unknown, owned: Uint8Array[], limit = MAX_BYTES): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || tag.call(value) !== 'Uint8Array') {
        throw new TypeError();
    }

    chain(value);
    const backing = buffer.call(value) as ArrayBuffer;
    arrayBufferLength.call(backing); // rejects shared backing, including across realms
    values.call(value); // rejects detached and out-of-bounds views
    const size = length.call(value) as number;
    const start = offset.call(value) as number;

    if (size > limit) {
        throw new RangeError();
    }

    const result = new Bytes(size);
    owned.push(result);
    set.call(result, new Bytes(backing, start, size));
    return result;
}

function uint(value: unknown, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * Experimental single raw transaction on an already-connected client. Caller
 * prepares reserve, trust, endpoint and keys independently; no target peer identity,
 * login or request/response sequence or command binding is established. The built-in
 * raw client enforces a local inclusive frame length and does not retry. Successful
 * results remain owned by the caller after client.close(). The verifier receives
 * separate copies; an async verifier may continue after timeout and observe those
 * copies zeroed, or retain its own copies and external effects. Wiping is best effort.
 * head.sequence is a validated placeholder replaced by the local raw sequence;
 * reserve and opaque fields are prepared beforehand and cannot be signed here
 * after sequence allocation. Their consistency is caller-owned. The local frame
 * length rule is not a verified target rule. Input byte budget is not a peak-memory
 * bound; lookup additionally counts the decoded field2 against its own 16 MiB cap.
 * Callback order, identity and verified bytes are checked locally. The caller still
 * must trust its transport's actual writes, deadlines and write-state reporting.
 */
export async function transactTargetRawOnce(
    client: Sso12RawTransport,
    options: TargetRawTransactionOptions,
): Promise<Sso12RawResult<CandidateWithLookup>> {
    const started = performance.now();
    const owned: Uint8Array[] = [];
    let staged: CandidateWithLookup | undefined;
    let stagedBuffers: Uint8Array[] = [];
    const token = Object.freeze({});
    let candidateObserved = false;
    let rawStarted = false;
    let finished = false;
    let settled = false;
    type Phase =
        | 'NEW'
        | 'BUILDING'
        | 'BUILT'
        | 'VERIFYING'
        | 'VERIFIED'
        | 'CONSUMING'
        | 'CONSUMED'
        | 'COMMITTED'
        | 'FAILED';
    let phase: Phase = 'NEW';
    let violation = false;
    let identitySnapshot: { uin: string; sequence: number } | undefined;
    let verifiedFrame: Uint8Array | undefined;

    const fail = (): never => {
        violation = true;
        phase = 'FAILED';
        throw new Error('invalid raw transaction');
    };

    const enter = (expected: Phase, next: Phase): void => {
        if (finished || settled || phase !== expected) {
            fail();
        }

        phase = next;
    };

    const snapshotIdentity = (identity: { uin: string; sequence: number }) => {
        // Read once each, including inherited getters, as permitted by the raw API.
        try {
            const uin: unknown = identity.uin;
            const sequence: unknown = identity.sequence;

            if (typeof uin !== 'string' || !uint(sequence, 0xffffffff)) {
                fail();
            }

            return { uin: uin as string, sequence: sequence as number };
        } catch {
            return fail();
        }
    };

    const checkIdentity = (identity: { uin: string; sequence: number }, current: Phase): void => {
        const snapshot = snapshotIdentity(identity);

        if (
            finished ||
            phase !== current ||
            !identitySnapshot ||
            snapshot.uin !== identitySnapshot.uin ||
            snapshot.sequence !== identitySnapshot.sequence
        ) {
            fail();
        }
    };

    try {
        const root = record(options);
        const service = record(root.service);
        const branch = record(service.basicBranch);
        const response = record(root.response);
        const headRecord = record(root.head);
        let inputBytes = 0;

        const inputCopy = (value: unknown, maximum = MAX_BYTES): Uint8Array => {
            const result = copy(value, owned, Math.min(maximum, MAX_BYTES - inputBytes));
            inputBytes += result.length;
            return result;
        };

        // The existing encoder checks fields and performs its own private snapshot.
        // Reject proxy prototype chains and out-of-bounds views before passing them in.
        for (const name of [
            'a2',
            'requestCommand',
            'this8',
            'arg28',
            'this20',
            'versionArg10',
            'reserved',
        ]) {
            inputCopy(headRecord[name]);
        }

        const head = encodeTargetSso12Head(root.head as TargetSso12Head);
        owned.push(head);
        const bodyInput = inputCopy(root.rawBody);
        const busi = encodeTargetServiceBusiness(bodyInput);
        owned.push(busi);
        const teaKey = inputCopy(service.targetTeaKey, 16);

        if (teaKey.length !== 16) {
            throw new TypeError();
        }

        let basicBranch: TargetBasicBranch;

        if (branch.kind === 'span' && branch.virtualResultByte === 0) {
            basicBranch = { kind: 'span', virtualResultByte: 0, span: inputCopy(branch.span) };
        } else if (
            branch.kind === 'value' &&
            uint(branch.virtualResultByte, 255) &&
            branch.virtualResultByte !== 0 &&
            uint(branch.value, 0xffffffff)
        ) {
            basicBranch = {
                kind: 'value',
                virtualResultByte: branch.virtualResultByte,
                value: branch.value,
            };
        } else {
            throw new TypeError();
        }

        const key = response.key === undefined ? undefined : inputCopy(response.key, 16);
        const selector = response.expectedSelector;

        if (
            (selector !== 0 && selector !== 1 && selector !== 2) ||
            (selector === 0 ? key !== undefined : key === undefined || key.length !== 16)
        ) {
            throw new TypeError();
        }

        const collectionInput = response.collection;

        if (isProxy(collectionInput) || !Array.isArray(collectionInput)) {
            throw new TypeError();
        }

        chain(collectionInput);
        const count = Object.getOwnPropertyDescriptor(collectionInput, 'length')?.value as unknown;

        if (!uint(count, 4096)) {
            throw new TypeError();
        }

        let total = 0;
        const collection: Uint8Array[] = [];

        for (let i = 0; i < count; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(collectionInput, String(i));

            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError();
            }

            const item = inputCopy(descriptor.value, MAX_BYTES - total);
            total += item.length;
            collection.push(item);
        }

        const compression = response.compression;
        const maximum = response.maxOutputBytes;
        const reserveMode = response.reserveMode;
        const timeout = root.timeoutMs;
        const signal = root.signal;
        const verify = root.verifyRaw;

        if (
            (service.sourceCommand !== 'wtlogin64.login' &&
                service.sourceCommand !== 'wtlogin64.trans_emp') ||
            !uint(service.virtualProtocol, 0xffffffff) ||
            !uint(service.requestObjectByte, 255) ||
            typeof service.uin !== 'string' ||
            /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(
                service.uin,
            ) ||
            (compression !== 'reject' && compression !== 'node-zlib-strict') ||
            (reserveMode !== undefined && reserveMode !== 'numeric-candidate') ||
            !uint(maximum, MAX_BYTES) ||
            !uint(timeout, 0x7fffffff) ||
            timeout === 0 ||
            typeof verify !== 'function' ||
            (signal !== undefined && (!(signal instanceof AbortSignal) || isProxy(signal)))
        ) {
            throw new TypeError();
        }

        const targetUin = service.uin;
        const sourceCommand = service.sourceCommand;
        const virtualProtocol = service.virtualProtocol;
        const requestObjectByte = service.requestObjectByte;
        const uinLength = Buffer.byteLength(targetUin, 'utf8');
        const spanLength = basicBranch.kind === 'span' ? basicBranch.span.length : 0;
        const headerLength = 18 + spanLength + uinLength;
        const cipherLength = Math.ceil((head.length + busi.length + 10) / 8) * 8;

        if (headerLength + cipherLength > MAX_BYTES) {
            throw new RangeError();
        }

        const remaining = Math.floor(started + timeout - performance.now());

        if (signal !== undefined && aborted.call(signal)) {
            return { kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' };
        }

        if (remaining < 1) {
            return { kind: 'failure', code: 'raw-timeout', writeState: 'not-written' };
        }

        let requestFrame: Uint8Array | undefined;
        rawStarted = true;
        const result = await client.transactRaw({
            timeoutMs: remaining,
            signal,
            buildRequest: (identity) => {
                enter('NEW', 'BUILDING');

                try {
                    identitySnapshot = snapshotIdentity(identity);

                    if (finished || phase !== 'BUILDING') {
                        fail();
                    }

                    const patched = copy(head, owned);
                    new DataView(patched.buffer, patched.byteOffset, patched.byteLength).setUint32(
                        4,
                        identitySnapshot.sequence,
                        false,
                    );
                    const frame = encodeTargetServiceRequest({
                        sourceCommand,
                        virtualProtocol,
                        basicBranch,
                        requestObjectByte,
                        uin: targetUin,
                        head: patched,
                        busi,
                        targetTeaKey: teaKey,
                    });
                    owned.push(frame);
                    requestFrame = copy(frame, owned);
                    enter('BUILDING', 'BUILT');
                    return { frame, context: null };
                } catch (error) {
                    phase = 'FAILED';
                    throw error;
                }
            },
            verifyCandidate: async (candidate, _context, identity) => {
                enter('BUILT', 'VERIFYING');
                candidateObserved = true;
                let requestCopy: Uint8Array | undefined;
                let responseCopy: Uint8Array | undefined;

                try {
                    checkIdentity(identity, 'VERIFYING');
                    verifiedFrame = copy(candidate, owned);
                    requestCopy = copy(requestFrame, owned);
                    responseCopy = copy(verifiedFrame, owned);
                    const accepted = await (verify as TargetRawTransactionOptions['verifyRaw'])({
                        transportUin: identitySnapshot!.uin,
                        targetUin,
                        sequence: identitySnapshot!.sequence,
                        requestFrame: requestCopy,
                        responseFrame: responseCopy,
                    });

                    if (finished) {
                        return false;
                    }

                    if (phase !== 'VERIFYING') {
                        fail();
                    }

                    if (accepted !== true) {
                        phase = 'FAILED';
                        return false;
                    }

                    phase = 'VERIFIED';
                    return true;
                } catch (error) {
                    phase = 'FAILED';
                    throw error;
                } finally {
                    clear(requestCopy);
                    clear(responseCopy);
                }
            },
            consumeCandidate: (candidate, _context, identity) => {
                enter('VERIFIED', 'CONSUMING');

                try {
                    checkIdentity(identity, 'CONSUMING');
                    const frame = copy(candidate, owned);

                    if (
                        !verifiedFrame ||
                        frame.length !== verifiedFrame.length ||
                        !frame.every((byte, index) => byte === verifiedFrame![index])
                    ) {
                        fail();
                    }

                    if (frame[8] !== selector) {
                        throw new Error('selector mismatch');
                    }

                    staged = composeTargetResponseCandidateWithLookup(
                        frame,
                        collection,
                        compression,
                        maximum,
                        key,
                        reserveMode,
                    );
                    stagedBuffers = [
                        staged.basic.opaque,
                        staged.head.field1,
                        staged.head.field2,
                        staged.head.field3,
                        staged.head.reserve,
                        staged.head.tail,
                        staged.body,
                        staged.trailing,
                    ];
                    enter('CONSUMING', 'CONSUMED');
                    return token;
                } catch (error) {
                    phase = 'FAILED';
                    throw error;
                }
            },
        });

        settled = true;
        const resultKind = result.kind;

        if (!violation && resultKind === 'failure') {
            const code = result.code;
            const writeState = result.writeState;

            if (
                !violation &&
                typeof code === 'string' &&
                (writeState === 'unknown' || (writeState === 'not-written' && !candidateObserved))
            ) {
                return { kind: 'failure', code, writeState };
            }
        }

        const isConsumed = (): boolean => phase === 'CONSUMED';

        if (!violation && resultKind === 'response' && isConsumed() && staged !== undefined) {
            const value = result.value;
            const sequence = result.sequence;
            const writeState = result.writeState;

            if (
                !violation &&
                isConsumed() &&
                value === token &&
                sequence === identitySnapshot?.sequence &&
                writeState === 'written'
            ) {
                phase = 'COMMITTED';
                const candidate = staged;
                staged = undefined;
                stagedBuffers = [];
                return { kind: 'response', value: candidate, sequence, writeState };
            }
        }

        return { kind: 'failure', code: 'target-transaction-failed', writeState: 'unknown' };
    } catch {
        return rawStarted
            ? { kind: 'failure', code: 'target-transaction-failed', writeState: 'unknown' }
            : { kind: 'failure', code: 'target-input-invalid', writeState: 'not-written' };
    } finally {
        finished = true;

        for (const bytes of stagedBuffers) {
            clear(bytes);
        }

        for (const bytes of owned) {
            clear(bytes);
        }
    }
}
