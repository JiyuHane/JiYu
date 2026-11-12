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

function clearCandidate(value: CandidateWithLookup | undefined): void {
    if (!value) {
        return;
    }

    for (const bytes of [
        value.basic.opaque,
        value.head.field1,
        value.head.field2,
        value.head.field3,
        value.head.reserve,
        value.head.tail,
        value.body,
        value.trailing,
    ]) {
        clear(bytes);
    }
}

/**
 * Experimental single raw transaction on an already-connected client. Caller
 * prepares reserve, trust, endpoint and keys independently; no target peer identity,
 * login or request/response sequence or command binding is established. The raw
 * transport enforces a local inclusive frame length and does not retry. Successful
 * results remain owned by the caller after client.close(). The verifier receives
 * separate copies; an async verifier may continue after timeout and observe those
 * copies zeroed, or retain its own copies and external effects. Wiping is best effort.
 * head.sequence is a validated placeholder replaced by the local raw sequence;
 * reserve and opaque fields are prepared beforehand and cannot be signed here
 * after sequence allocation. Their consistency is caller-owned. The local frame
 * length rule is not a verified target rule. Input byte budget is not a peak-memory
 * bound; lookup additionally counts the decoded field2 against its own 16 MiB cap.
 */
export async function transactTargetRawOnce(
    client: Sso12RawTransport,
    options: TargetRawTransactionOptions,
): Promise<Sso12RawResult<CandidateWithLookup>> {
    const started = performance.now();
    const owned: Uint8Array[] = [];
    let staged: CandidateWithLookup | undefined;
    let rawStarted = false;
    let finished = false;
    let verified = false;
    let consumed = false;

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
                if (finished) {
                    throw new Error('transaction finished');
                }

                const patched = copy(head, owned);
                new DataView(patched.buffer, patched.byteOffset, patched.byteLength).setUint32(
                    4,
                    identity.sequence,
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
                return { frame, context: null };
            },
            verifyCandidate: async (candidate, _context, identity) => {
                if (finished) {
                    throw new Error('transaction finished');
                }

                const requestCopy = copy(requestFrame, owned);
                const responseCopy = copy(candidate, owned);

                try {
                    const accepted =
                        (await (verify as TargetRawTransactionOptions['verifyRaw'])({
                            transportUin: identity.uin,
                            targetUin,
                            sequence: identity.sequence,
                            requestFrame: requestCopy,
                            responseFrame: responseCopy,
                        })) === true;
                    verified = !finished && accepted;
                    return verified;
                } finally {
                    clear(requestCopy);
                    clear(responseCopy);
                }
            },
            consumeCandidate: (candidate) => {
                if (finished || !verified || consumed) {
                    throw new Error('transaction not active');
                }

                consumed = true;

                if (candidate[8] !== selector) {
                    throw new Error('selector mismatch');
                }

                staged = composeTargetResponseCandidateWithLookup(
                    candidate,
                    collection,
                    compression,
                    maximum,
                    key,
                );

                if (finished) {
                    clearCandidate(staged);
                    staged = undefined;
                    throw new Error('transaction finished');
                }

                return staged;
            },
        });

        if (result.kind === 'response' && staged !== undefined && result.value === staged) {
            staged = undefined;
            return result;
        }

        if (result.kind === 'failure') {
            return result;
        }

        return { kind: 'failure', code: 'target-transaction-failed', writeState: 'unknown' };
    } catch {
        return rawStarted
            ? { kind: 'failure', code: 'target-transaction-failed', writeState: 'unknown' }
            : { kind: 'failure', code: 'target-input-invalid', writeState: 'not-written' };
    } finally {
        finished = true;
        clearCandidate(staged);

        for (const bytes of owned) {
            clear(bytes);
        }
    }
}
