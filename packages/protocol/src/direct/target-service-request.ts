import { isProxy } from 'node:util/types';
import { qqTeaEncrypt } from './qq-tea';

// Local resource policy, not a target protocol limit.
export const MAX_TARGET_SERVICE_REQUEST_BYTES = 16 * 1024 * 1024;

export type TargetSourceCommand = 'wtlogin64.trans_emp' | 'wtlogin64.login';

// The native test examines AL. Its higher bits and the virtual call's meaning
// are unknown; callers explicitly supply the observed byte and branch data.
export type TargetBasicBranch =
    | { virtualResultByte: number; kind: 'value'; value: number }
    | { virtualResultByte: 0; kind: 'span'; span: Uint8Array };

export interface TargetServiceRequest {
    sourceCommand: TargetSourceCommand;
    virtualProtocol: number;
    basicBranch: TargetBasicBranch;
    requestObjectByte: number;
    uin: string;
    head: Uint8Array;
    busi: Uint8Array;
    targetTeaKey: Uint8Array;
    randomSource?: (length: number) => Uint8Array;
}

class RequestInputError extends Error {}

function external<T>(operation: () => T): T {
    try {
        return operation();
    } catch {
        throw new Error('target service request construction failed');
    }
}

function uint(value: unknown, max: number, name: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new RequestInputError(`invalid ${name}`);
    }

    return value;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayFill = Uint8Array.prototype.fill;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const sharedBufferLength = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;

// Local policy: plain data records with own data properties only. Rejecting
// accessors and proxies makes snapshot acquisition free of user callbacks.
function captureRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new RequestInputError('invalid request record');
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        throw new RequestInputError('invalid request record');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const name of Reflect.ownKeys(descriptors)) {
        const descriptor: PropertyDescriptor = Reflect.get(descriptors, name);

        if (!('value' in descriptor)) {
            throw new RequestInputError('accessor properties are not supported');
        }

        if (typeof name === 'string') {
            snapshot[name] = descriptor.value;
        }
    }

    return snapshot;
}

function bytes(
    value: unknown,
    name: string,
    maximum: number,
    copies: Uint8Array[],
    exact = false,
): Uint8Array {
    if (!ArrayBuffer.isView(value) || typedArrayTag.call(value) !== 'Uint8Array') {
        throw new RequestInputError(`invalid ${name}`);
    }

    const backing: unknown = typedArrayBuffer.call(value);
    let shared = false;

    try {
        sharedBufferLength.call(backing);
        shared = true;
    } catch {
        // The intrinsic rejects ordinary ArrayBuffer instances.
    }

    if (shared) {
        throw new RequestInputError(`invalid ${name}`);
    }

    const length: number = typedArrayLength.call(value);

    if (exact && length !== maximum) {
        throw new RequestInputError(`invalid ${name}`);
    }

    if (length > maximum) {
        throw new RequestInputError('frame exceeds size limit');
    }

    const copy = new Uint8Array(value as Uint8Array);
    copies.push(copy);
    return copy;
}

/**
 * Partially evidenced offline reconstruction of the selected binary's static
 * request branch, not an assertion of runtime reachability or interoperability.
 * Both inclusive lengths include their own four-byte prefix. The first word is
 * the entire frame length, including itself. No target key is embedded here.
 */
export function encodeTargetServiceRequest(request: TargetServiceRequest): Uint8Array {
    const copies: Uint8Array[] = [];

    try {
        return encode(request, copies);
    } catch (error) {
        if (error instanceof RequestInputError) {
            // Never expose the private error instance to caller-controlled code.
            throw new Error(error.message);
        }

        // Getter, allocation, and callback failures may contain sensitive data.
        throw new Error('target service request construction failed');
    } finally {
        // Best effort only: the runtime, crypto primitive and external callbacks
        // may retain other copies outside this module's control.
        for (const copy of copies) {
            typedArrayFill.call(copy, 0);
        }
    }
}

function encode(request: TargetServiceRequest, copies: Uint8Array[]): Uint8Array {
    const fields = captureRecord(request);
    const branch = captureRecord(fields.basicBranch);
    const snapshot = {
        command: fields.sourceCommand,
        protocol: fields.virtualProtocol,
        objectByte: fields.requestObjectByte,
        uin: fields.uin,
        head: fields.head,
        busi: fields.busi,
        key: fields.targetTeaKey,
        randomSource: fields.randomSource,
        virtualResultByte: branch.virtualResultByte,
        kind: branch.kind,
        value: branch.value,
        span: branch.span,
    };
    const command = snapshot.command;

    if (command !== 'wtlogin64.trans_emp' && command !== 'wtlogin64.login') {
        throw new RequestInputError('unknown source command');
    }

    const protocol = uint(snapshot.protocol, 0xffffffff, 'virtual protocol');
    const objectByte = uint(snapshot.objectByte, 0xff, 'request object byte');
    const uin = snapshot.uin;

    if (
        typeof uin !== 'string' ||
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(uin)
    ) {
        throw new RequestInputError('invalid UIN string');
    }

    const uinLength = Buffer.byteLength(uin, 'utf8');

    // The minimum header is 18 bytes and even an empty plaintext needs 16
    // ciphertext bytes. Check each budget before copying caller-owned data.
    if (uinLength > MAX_TARGET_SERVICE_REQUEST_BYTES - 34) {
        throw new RequestInputError('frame exceeds size limit');
    }

    const virtualResultByte = uint(snapshot.virtualResultByte, 0xff, 'virtual result byte');
    const kind = snapshot.kind;
    let value = 0;
    let span: Uint8Array = new Uint8Array();

    if (virtualResultByte !== 0 && kind === 'value') {
        value = uint(snapshot.value, 0xffffffff, 'branch value');
    } else if (virtualResultByte === 0 && kind === 'span') {
        span = bytes(
            snapshot.span,
            'branch span',
            MAX_TARGET_SERVICE_REQUEST_BYTES - 34 - uinLength,
            copies,
        );
    } else {
        throw new RequestInputError('virtual result byte and branch disagree');
    }

    const headerLength = 4 + 4 + 1 + 4 + span.length + 1 + 4 + uinLength;
    const plainBudget = Math.floor((MAX_TARGET_SERVICE_REQUEST_BYTES - headerLength) / 8) * 8 - 10;
    const head = bytes(snapshot.head, 'head', plainBudget, copies);
    const busi = bytes(snapshot.busi, 'business bytes', plainBudget - head.length, copies);
    const key = bytes(snapshot.key, 'target TEA key', 16, copies, true);

    const randomSource = snapshot.randomSource;

    if (randomSource !== undefined && typeof randomSource !== 'function') {
        throw new RequestInputError('invalid random source');
    }

    const plainLength = head.length + busi.length;
    const cipherLength = Math.ceil((plainLength + 10) / 8) * 8;
    const totalLength = headerLength + cipherLength;

    if (totalLength > MAX_TARGET_SERVICE_REQUEST_BYTES) {
        throw new RequestInputError('frame exceeds size limit');
    }

    const frame = Buffer.alloc(totalLength);
    frame.writeUInt32BE(totalLength, 0);
    frame.writeUInt32BE(protocol, 4);
    frame[8] = 2; // Only the two supplied command names are statically classified.
    frame.writeUInt32BE(kind === 'value' ? value : span.length + 4, 9);
    frame.set(span, 13);
    const objectOffset = 13 + span.length;
    frame[objectOffset] = objectByte;
    frame.writeUInt32BE(uinLength + 4, objectOffset + 1);
    frame.write(uin, objectOffset + 5, uinLength, 'utf8');
    const plain = new Uint8Array(plainLength);
    copies.push(plain);
    plain.set(head);
    plain.set(busi, head.length);
    const ciphertext = qqTeaEncrypt(
        plain,
        key,
        randomSource === undefined
            ? undefined
            : (length) => external(() => randomSource(length) as Uint8Array),
    );
    frame.set(ciphertext, headerLength);
    return frame;
}
