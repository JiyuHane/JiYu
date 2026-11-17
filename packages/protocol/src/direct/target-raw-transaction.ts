import { isProxy } from 'node:util/types';
import { encodeTargetSso12Head, type TargetSso12Head } from './target-sso12-head';
import {
    decodeTargetMsfSignOutput,
    encodeTargetSso12ReserveFromNativeSlots,
    MAX_TARGET_SSO12_FIELD23_ITEMS,
    type TargetSso12ReserveInput,
} from './target-sso12-reserve';
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
import type { Sso12RawIdentity, Sso12RawTransport, Sso12RawResult } from './sso12-packet-client';

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

/** Only the local transport's allocated identity is described; none is a QQ signer input claim. */
export interface TargetRawCandidateReserveInput {
    transportUin: string;
    targetUin: string;
    sequence: number;
    requestCommand: Uint8Array;
    rawBody: Uint8Array;
}

export interface TargetRawCandidateReserveTransactionOptions extends Omit<
    TargetRawTransactionOptions,
    'head'
> {
    head: Omit<TargetSso12Head, 'sequence' | 'reserved'>;
    reserveBase: Omit<TargetSso12ReserveInput, 'field24'>;
    buildCandidate: (
        input: TargetRawCandidateReserveInput,
    ) => { status: number; output: Uint8Array } | Promise<{ status: number; output: Uint8Array }>;
}

const MAX_BYTES = 16 * 1024 * 1024;
const globalObject = globalThis;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const Bytes = Uint8Array;
const ArrayConstructor = Array;
const ArrayBufferConstructor = ArrayBuffer;
const DataViewConstructor = DataView;
const ObjectConstructor = Object;
const objectDescriptors = ownDescriptor(ObjectConstructor, 'getOwnPropertyDescriptors');
const candidateNow = performance.now.bind(performance);
const signalAnyDescriptor = ownDescriptor(AbortSignal, 'any');
const dependentSignal: ((signals: AbortSignal[]) => AbortSignal) | undefined =
    signalAnyDescriptor &&
    hasOwn(signalAnyDescriptor, 'value') &&
    typeof signalAnyDescriptor.value === 'function'
        ? signalAnyDescriptor.value.bind(AbortSignal)
        : undefined;
const promiseThen = Promise.prototype.then;
const bytePrototype = Bytes.prototype;
const arrayPrototype = ArrayConstructor.prototype;
const dataViewPrototype = DataViewConstructor.prototype;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const iteratorSymbol = Symbol.iterator;
const byteOwnSet = ownDescriptor(bytePrototype, 'set');
const byteOwnFill = ownDescriptor(bytePrototype, 'fill');
const typedSet = ownDescriptor(typedPrototype, 'set');
const typedFill = ownDescriptor(typedPrototype, 'fill');
const arrayPush = ownDescriptor(arrayPrototype, 'push');
const arrayIterator = ownDescriptor(arrayPrototype, iteratorSymbol);
const arrayBufferIsView = ownDescriptor(ArrayBufferConstructor, 'isView');
const viewSetUint16 = ownDescriptor(dataViewPrototype, 'setUint16');
const viewSetUint32 = ownDescriptor(dataViewPrototype, 'setUint32');
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

function sameOwnData(
    object: object,
    key: PropertyKey,
    expected: PropertyDescriptor | undefined,
): boolean {
    const actual = ownDescriptor(object, key);

    if (expected === undefined) {
        return actual === undefined;
    }

    return (
        actual !== undefined &&
        hasOwn(expected, 'value') &&
        hasOwn(actual, 'value') &&
        actual.value === expected.value
    );
}

/** A narrow guard for known codec and cleanup dependencies, not an isolation boundary. */
function checkCandidateBuiltins(): void {
    const array = ownDescriptor(globalObject, 'Array');
    const bytes = ownDescriptor(globalObject, 'Uint8Array');
    const backing = ownDescriptor(globalObject, 'ArrayBuffer');
    const view = ownDescriptor(globalObject, 'DataView');
    const object = ownDescriptor(globalObject, 'Object');

    if (
        !array ||
        !hasOwn(array, 'value') ||
        array.value !== ArrayConstructor ||
        !bytes ||
        !hasOwn(bytes, 'value') ||
        bytes.value !== Bytes ||
        !backing ||
        !hasOwn(backing, 'value') ||
        backing.value !== ArrayBufferConstructor ||
        !view ||
        !hasOwn(view, 'value') ||
        view.value !== DataViewConstructor ||
        !object ||
        !hasOwn(object, 'value') ||
        object.value !== ObjectConstructor ||
        !sameOwnData(ObjectConstructor, 'getOwnPropertyDescriptors', objectDescriptors) ||
        !sameOwnData(arrayPrototype, 'push', arrayPush) ||
        !sameOwnData(arrayPrototype, iteratorSymbol, arrayIterator) ||
        !sameOwnData(bytePrototype, 'set', byteOwnSet) ||
        !sameOwnData(bytePrototype, 'fill', byteOwnFill) ||
        !sameOwnData(typedPrototype, 'set', typedSet) ||
        !sameOwnData(typedPrototype, 'fill', typedFill) ||
        !sameOwnData(ArrayBufferConstructor, 'isView', arrayBufferIsView) ||
        !sameOwnData(dataViewPrototype, 'setUint16', viewSetUint16) ||
        !sameOwnData(dataViewPrototype, 'setUint32', viewSetUint32)
    ) {
        throw new Error('invalid raw transaction');
    }
}

const observeCandidateTask = (): void => {};

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

/** The reserve encoder rejects unknown and symbol properties, including field24 on the base. */
function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    const result = record(value);

    for (const name of Reflect.ownKeys(value as object)) {
        if (typeof name !== 'string' || !allowed.includes(name)) {
            throw new TypeError();
        }
    }

    return result;
}

function candidateSignal(value: unknown): value is AbortSignal {
    if (value === null || typeof value !== 'object' || isProxy(value)) {
        return false;
    }

    try {
        chain(value);
        return value instanceof AbortSignal && typeof aborted.call(value) === 'boolean';
    } catch {
        return false;
    }
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

/** Compare owned snapshots without consulting a mutable typed-array iterator method. */
function candidateFramesEqual(left: Uint8Array, right: Uint8Array): boolean {
    const size = length.call(left) as number;

    if (size !== length.call(right)) {
        return false;
    }

    for (let index = 0; index < size; index++) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
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
export function transactTargetRawOnce(
    client: Sso12RawTransport,
    options: TargetRawTransactionOptions,
): Promise<Sso12RawResult<CandidateWithLookup>> {
    return transactTargetRawCore(client, options, false);
}

/**
 * Explicit opt-in candidate construction after the local transport allocates its
 * sequence. These inputs are not asserted to match a QQ signer or controller K,
 * and neither the candidate nor the response establishes QQ interoperability.
 * The callback borrows independent command/body snapshots; they are wiped best
 * effort on completion and may already be zeroed after timeout or cancellation.
 * Its returned output remains callback-owned and the caller must not modify it
 * until this transaction settles; await may observe it after the callback returns.
 * It is not erased, except that a borrowed-input alias shares that input's cleanup.
 * The caller owns retained copies and external effects. Snapshots, decoded slots, reserve,
 * encoded head and intermediate output are wiped best effort. The input budget
 * includes the fixed 0x300-byte output, not peak memory or internal codec copies.
 *
 * The built-in raw client enforces its deadline and single-flight policy. When a
 * signal is supplied, the transport receives a private AbortSignal.any dependent;
 * this relies on the runtime's dependent-signal semantics rather than event
 * delivery on the original signal. The original is also checked at transaction
 * boundaries. No external listener is registered here; dependent-signal lifetime
 * is managed by the runtime. A structural transport is trusted for its actual
 * writes and settlement and can remain pending indefinitely; no external side
 * effect can be retracted here.
 * Synchronous callbacks or encoders cannot be preempted while running. Guards
 * cover selected constructor and prototype changes, not arbitrary same-process
 * modification; imported codecs and JavaScript built-ins must remain trustworthy
 * throughout the call. The callback is not isolated from global state.
 */
export function transactTargetRawCandidateReserveOnce(
    client: Sso12RawTransport,
    options: TargetRawCandidateReserveTransactionOptions,
): Promise<Sso12RawResult<CandidateWithLookup>> {
    return transactTargetRawCore(client, options, true);
}

async function transactTargetRawCore(
    client: Sso12RawTransport,
    options: TargetRawTransactionOptions | TargetRawCandidateReserveTransactionOptions,
    candidateMode: boolean,
): Promise<Sso12RawResult<CandidateWithLookup>> {
    const started = candidateMode ? candidateNow() : performance.now();
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

            return {
                uin: uin as string,
                sequence: candidateMode && sequence === 0 ? 0 : (sequence as number),
            };
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
        if (candidateMode) {
            checkCandidateBuiltins();
        }

        const root = record(options);
        const service = record(root.service);
        const branch = record(service.basicBranch);
        const response = record(root.response);
        const headRecord = candidateMode
            ? exactRecord(root.head, [
                  'arg0',
                  'arg4',
                  'arg8',
                  'a2',
                  'requestCommand',
                  'this8',
                  'arg28',
                  'this20',
                  'versionArg10',
              ])
            : record(root.head);
        // The future callback output is caller-supplied too, so reserve its fixed size now.
        let inputBytes = candidateMode ? 0x300 : 0;

        const inputCopy = (value: unknown, maximum = MAX_BYTES): Uint8Array => {
            const result = copy(value, owned, Math.min(maximum, MAX_BYTES - inputBytes));
            inputBytes += result.length;
            return result;
        };

        let head: Uint8Array;
        let candidateHead: Omit<TargetSso12Head, 'sequence' | 'reserved'> | undefined;
        let reserveBase: Omit<TargetSso12ReserveInput, 'field24'> | undefined;
        let buildCandidate:
            TargetRawCandidateReserveTransactionOptions['buildCandidate'] | undefined;

        if (!candidateMode) {
            // Preserve the original encoder call and its synchronous error ordering.
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

            head = encodeTargetSso12Head(root.head as TargetSso12Head);
        } else {
            if (
                !uint(headRecord.arg0, 0xffffffff) ||
                !uint(headRecord.arg4, 0xffffffff) ||
                !uint(headRecord.arg8, 0xff) ||
                typeof root.buildCandidate !== 'function'
            ) {
                throw new TypeError();
            }

            buildCandidate =
                root.buildCandidate as TargetRawCandidateReserveTransactionOptions['buildCandidate'];
            candidateHead = {
                arg0: headRecord.arg0,
                arg4: headRecord.arg4,
                arg8: headRecord.arg8,
                a2: inputCopy(headRecord.a2),
                requestCommand: inputCopy(headRecord.requestCommand),
                this8: inputCopy(headRecord.this8),
                arg28: inputCopy(headRecord.arg28),
                this20: inputCopy(headRecord.this20),
                versionArg10: inputCopy(headRecord.versionArg10),
            };

            const source = exactRecord(root.reserveBase, [
                'field12',
                'field13',
                'field15',
                'field16',
                'field21Enabled',
                'field23',
                'field26',
                'field32',
            ]);
            const base: TargetSso12ReserveInput = {};

            for (const name of ['field12', 'field13', 'field15', 'field16', 'field32'] as const) {
                if (Object.hasOwn(source, name)) {
                    base[name] = inputCopy(source[name]);
                }
            }

            if (Object.hasOwn(source, 'field21Enabled')) {
                if (typeof source.field21Enabled !== 'boolean') {
                    throw new TypeError();
                }

                base.field21Enabled = source.field21Enabled;
            }

            if (Object.hasOwn(source, 'field26')) {
                if (!uint(source.field26, 0xffffffff)) {
                    throw new TypeError();
                }

                base.field26 = source.field26;
            }

            if (Object.hasOwn(source, 'field23')) {
                const items = source.field23;

                if (isProxy(items) || !Array.isArray(items)) {
                    throw new TypeError();
                }

                chain(items);
                const count = Object.getOwnPropertyDescriptor(items, 'length')?.value as unknown;

                if (
                    !uint(count, MAX_TARGET_SSO12_FIELD23_ITEMS) ||
                    Reflect.ownKeys(items).length !== count + 1
                ) {
                    throw new TypeError();
                }

                const entries: { field1: Uint8Array; field2: Uint8Array }[] = [];

                for (let index = 0; index < count; index++) {
                    const entry = Object.getOwnPropertyDescriptor(items, String(index));

                    if (!entry || !Object.hasOwn(entry, 'value')) {
                        throw new TypeError();
                    }

                    const fields = exactRecord(entry.value, ['field1', 'field2']);

                    if (!Object.hasOwn(fields, 'field1') || !Object.hasOwn(fields, 'field2')) {
                        throw new TypeError();
                    }

                    entries.push({
                        field1: inputCopy(fields.field1),
                        field2: inputCopy(fields.field2),
                    });
                }

                base.field23 = entries;
            }

            reserveBase = base;
            const empty = new Bytes(0);
            // The real encoder validates the full base, even if no field activates emission.
            checkCandidateBuiltins();
            const preflightReserve = encodeTargetSso12ReserveFromNativeSlots(base, {
                at00: empty,
                at18: empty,
                at30: empty,
            });
            owned.push(preflightReserve);
            checkCandidateBuiltins();
            head = encodeTargetSso12Head({
                ...candidateHead,
                sequence: 0,
                reserved: preflightReserve,
            });
        }

        owned.push(head);
        const bodyInput = inputCopy(root.rawBody);

        if (candidateMode) {
            checkCandidateBuiltins();
        }

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
            (signal !== undefined &&
                (candidateMode
                    ? !candidateSignal(signal)
                    : !(signal instanceof AbortSignal) || isProxy(signal)))
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

        const checkFrameSize = (headLength: number): void => {
            const cipherLength = Math.ceil((headLength + busi.length + 10) / 8) * 8;

            if (headerLength + cipherLength > MAX_BYTES) {
                throw new RangeError();
            }
        };

        checkFrameSize(head.length);
        const transactionSignal = signal as AbortSignal | undefined;
        let remaining = Math.floor(
            started + timeout - (candidateMode ? candidateNow() : performance.now()),
        );

        if (transactionSignal !== undefined && aborted.call(transactionSignal)) {
            return { kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' };
        }

        if (remaining < 1) {
            return { kind: 'failure', code: 'raw-timeout', writeState: 'not-written' };
        }

        let transportSignal = transactionSignal;

        if (candidateMode && transactionSignal !== undefined) {
            checkCandidateBuiltins();

            if (dependentSignal === undefined) {
                throw new TypeError();
            }

            // Node owns this dependent relationship; no external listener is installed here.
            transportSignal = dependentSignal([transactionSignal]);

            if (aborted.call(transactionSignal) || aborted.call(transportSignal)) {
                return { kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' };
            }

            remaining = Math.floor(started + timeout - candidateNow());

            if (remaining < 1) {
                return { kind: 'failure', code: 'raw-timeout', writeState: 'not-written' };
            }
        }

        let requestFrame: Uint8Array | undefined;

        const candidateLive = (expected: Phase): void => {
            if (finished || settled || violation || phase !== expected) {
                fail();
            }

            checkCandidateBuiltins();

            if (
                (transactionSignal !== undefined && aborted.call(transactionSignal)) ||
                candidateNow() >= started + timeout
            ) {
                phase = 'FAILED';
                throw new Error('invalid raw transaction');
            }

            if (finished || settled || violation || phase !== expected) {
                fail();
            }

            checkCandidateBuiltins();
        };

        const finishRequest = (encodedHead: Uint8Array) => {
            const frame = encodeTargetServiceRequest({
                sourceCommand,
                virtualProtocol,
                basicBranch,
                requestObjectByte,
                uin: targetUin,
                head: encodedHead,
                busi,
                targetTeaKey: teaKey,
            });
            owned.push(frame);

            if (candidateMode) {
                candidateLive('BUILDING');
            }

            requestFrame = copy(frame, owned);

            if (candidateMode) {
                candidateLive('BUILDING');
            }

            enter('BUILDING', 'BUILT');
            return { frame, context: null };
        };

        // This remains synchronous, including its throws, for the original API.
        const buildPrepared = (identity: Sso12RawIdentity) => {
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
                return finishRequest(patched);
            } catch (error) {
                phase = 'FAILED';
                throw error;
            }
        };

        const buildWithCandidate = (identity: Sso12RawIdentity) => {
            // A repeated or late call throws before creating a rejected Promise.
            enter('NEW', 'BUILDING');
            const task = (async () => {
                let borrowedCommand: Uint8Array | undefined;
                let borrowedBody: Uint8Array | undefined;

                try {
                    identitySnapshot = snapshotIdentity(identity);
                    candidateLive('BUILDING');
                    borrowedCommand = copy(candidateHead!.requestCommand, owned);
                    borrowedBody = copy(bodyInput, owned);
                    candidateLive('BUILDING');
                    const value = await buildCandidate!({
                        transportUin: identitySnapshot.uin,
                        targetUin,
                        sequence: identitySnapshot.sequence,
                        requestCommand: borrowedCommand,
                        rawBody: borrowedBody,
                    });
                    // Check before inspecting the returned record or allocating an output copy.
                    candidateLive('BUILDING');
                    const outputRecord = exactRecord(value, ['status', 'output']);

                    if (outputRecord.status !== 0) {
                        throw new TypeError();
                    }

                    // The returned bytes remain callback-owned; only our copy is wiped.
                    const output = copy(outputRecord.output, owned, 0x300);

                    if (output.length !== 0x300) {
                        throw new TypeError();
                    }

                    checkCandidateBuiltins();
                    const slots = decodeTargetMsfSignOutput(0, output);
                    owned.push(slots.at00, slots.at18, slots.at30);
                    checkCandidateBuiltins();
                    const reserved = encodeTargetSso12ReserveFromNativeSlots(reserveBase!, slots);
                    owned.push(reserved);
                    checkCandidateBuiltins();
                    const actualHead = encodeTargetSso12Head({
                        ...candidateHead!,
                        sequence: identitySnapshot.sequence,
                        reserved,
                    });
                    owned.push(actualHead);
                    checkFrameSize(actualHead.length);
                    candidateLive('BUILDING');
                    return finishRequest(actualHead);
                } catch {
                    phase = 'FAILED';
                    // Do not expose caller-controlled exceptions to the transport.
                    throw new Error('invalid raw transaction');
                } finally {
                    // Also repeat cleanup after a late callback settles following outer cleanup.
                    clear(borrowedCommand);
                    clear(borrowedBody);
                }
            })();

            // Observe both outcomes without changing the original Promise or its result.
            void promiseThen.call(task, observeCandidateTask, observeCandidateTask);
            return task;
        };

        rawStarted = true;
        const result = await client.transactRaw({
            timeoutMs: remaining,
            signal: transportSignal,
            buildRequest: candidateMode ? buildWithCandidate : buildPrepared,
            verifyCandidate: async (candidate, _context, identity) => {
                enter('BUILT', 'VERIFYING');
                candidateObserved = true;
                let requestCopy: Uint8Array | undefined;
                let responseCopy: Uint8Array | undefined;

                try {
                    checkIdentity(identity, 'VERIFYING');

                    if (candidateMode) {
                        candidateLive('VERIFYING');
                    }

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

                    if (candidateMode) {
                        candidateLive('VERIFYING');
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

                    if (candidateMode) {
                        candidateLive('CONSUMING');
                    }

                    const frame = copy(candidate, owned);

                    if (
                        !verifiedFrame ||
                        (candidateMode
                            ? !candidateFramesEqual(frame, verifiedFrame)
                            : frame.length !== verifiedFrame.length ||
                              !frame.every((byte, index) => byte === verifiedFrame![index]))
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

                    if (candidateMode) {
                        candidateLive('CONSUMING');
                    }

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
                writeState === 'written' &&
                (!candidateMode ||
                    ((transactionSignal === undefined || !aborted.call(transactionSignal)) &&
                        candidateNow() < started + timeout)) &&
                !violation &&
                isConsumed()
            ) {
                phase = 'COMMITTED';
                const candidate = staged;
                staged = undefined;
                stagedBuffers = [];
                return {
                    kind: 'response',
                    value: candidate,
                    sequence: candidateMode ? identitySnapshot!.sequence : sequence,
                    writeState,
                };
            }
        }

        return { kind: 'failure', code: 'target-transaction-failed', writeState: 'unknown' };
    } catch {
        return rawStarted
            ? { kind: 'failure', code: 'target-transaction-failed', writeState: 'unknown' }
            : { kind: 'failure', code: 'target-input-invalid', writeState: 'not-written' };
    } finally {
        finished = true;

        // Avoid a possibly replaced Array iterator during best-effort cleanup.
        for (let index = 0; index < stagedBuffers.length; index++) {
            clear(stagedBuffers[index]);
        }

        for (let index = 0; index < owned.length; index++) {
            clear(owned[index]);
        }
    }
}
