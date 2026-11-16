import { randomBytes } from 'node:crypto';
import type { DirectSsoReserve, DirectSsoSecureInfo } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_encode } from '@snowluma/proton';

// Field numbers follow a public reference, not a verified target-build capture.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoReserveFields.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoPacker.cs
const MAX_METADATA_FIELD_BYTES = 64 * 1024;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const Uint8ArrayConstructor = Uint8Array;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const typedArrayFill = Uint8Array.prototype.fill;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'resizable',
)?.get;

export interface SsoSigningRequest {
    uin: string;
    command: string;
    /** Unsigned 32-bit bit pattern of the SSO sequence. */
    sequence: number;
    body: Uint8Array;
}

export interface SsoSignature {
    sign: Uint8Array;
    token: Uint8Array;
    extra: Uint8Array;
}

export interface SsoReserveBuilderOptions {
    uin: string;
    uid?: string;
    /** The caller must decide which commands need a signature for its profile. */
    classifySigning: (command: string) => 'sign' | 'unsigned';
    /**
     * Caller-provided signer; no signing algorithm or remote service is built in.
     * Its request fields must remain own data properties with their original values,
     * and its private body copy must remain unchanged and attached at each check. This
     * strictly rejects lasting scalar changes; it does not establish what was signed or
     * detect changes restored before a check or made afterwards.
     */
    sign?: (request: SsoSigningRequest) => Promise<SsoSignature>;
    /** Caller-provided profile values; neither is automatically set for any platform. */
    msgType?: number;
    ntCoreVersion?: number;
    /** Optional test/profile override; default uses random bytes for every request. */
    createTraceParent?: () => string;
}

function validateString(
    value: unknown,
    name: string,
    allowEmpty: boolean,
): asserts value is string {
    if (
        typeof value !== 'string' ||
        (!allowEmpty && value.length === 0) ||
        Buffer.byteLength(value, 'utf8') > MAX_METADATA_FIELD_BYTES
    ) {
        throw new TypeError(`invalid ${name}`);
    }
}

function validateUint32(value: unknown, name: string): void {
    if (
        value !== undefined &&
        (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff)
    ) {
        throw new RangeError(`invalid ${name}`);
    }
}

function snapshotSignatureField(value: unknown, name: string, nonempty: boolean): Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError(`invalid signature ${name}`);
    }

    const length = typedArrayByteLength.call(value);

    if ((nonempty && length === 0) || length > MAX_METADATA_FIELD_BYTES) {
        throw new TypeError(`invalid signature ${name}`);
    }

    const snapshot = new Uint8ArrayConstructor(value);

    if ((nonempty && snapshot.byteLength === 0) || snapshot.byteLength > MAX_METADATA_FIELD_BYTES) {
        throw new TypeError(`invalid signature ${name}`);
    }

    return snapshot;
}

function assertSignerBodyUnchanged(
    body: Uint8Array,
    baseline: Uint8Array,
    expectedLength: number,
): void {
    try {
        // Intrinsics reject detached views, including a detached zero-length view.
        typedArrayValues.call(body);
        const storage = typedArrayBuffer.call(body) as ArrayBuffer;
        arrayBufferByteLength.call(storage); // Reject shared or invalid storage.

        if (
            arrayBufferResizable?.call(storage) ||
            typedArrayByteLength.call(body) !== expectedLength
        ) {
            throw new Error();
        }

        // Both arrays are locally allocated ordinary views, and no caller code runs
        // during this bounded comparison. Never consult shadowable body properties.
        for (let i = 0; i < expectedLength; i++) {
            if (body[i] !== baseline[i]) {
                throw new Error();
            }
        }
    } catch {
        throw new Error('signer input changed');
    }
}

function assertSignerRequestUnchanged(
    request: SsoSigningRequest,
    uin: string,
    command: string,
    sequence: number,
    body: Uint8Array,
    baseline: Uint8Array,
    expectedLength: number,
): void {
    const matches = (key: keyof SsoSigningRequest, expected: unknown): boolean => {
        const descriptor = getOwnPropertyDescriptor(request, key);
        return !!descriptor && hasOwn(descriptor, 'value') && descriptor.value === expected;
    };

    if (
        !matches('uin', uin) ||
        !matches('command', command) ||
        !matches('sequence', sequence) ||
        !matches('body', body)
    ) {
        throw new Error('signer input changed');
    }

    assertSignerBodyUnchanged(body, baseline, expectedLength);
}

function makeTraceParent(): string {
    const trace = randomBytes(24).toString('hex');
    return `01-${trace.slice(0, 32)}-${trace.slice(32)}-01`;
}

/**
 * Create an account-bound builder compatible with TcpPacketClient.buildReserved.
 * Signature classification is explicit and a missing/invalid required signature
 * fails rather than silently emitting an unsigned request. The signer sees a copy
 * of the command body and persistent mutations at callback completion are rejected.
 * Callers must retain the matching payload through encoding; concurrent changes to
 * the caller's input, including shared storage, are outside this local check.
 * This does not prove signature authenticity or detect restored or later changes.
 */
export function createSsoReserveBuilder(
    options: SsoReserveBuilderOptions,
): (request: SsoSigningRequest) => Promise<Uint8Array> {
    if (!options || typeof options !== 'object' || !/^[0-9]{1,20}$/.test(options.uin)) {
        throw new TypeError('invalid account');
    }

    if (typeof options.classifySigning !== 'function') {
        throw new TypeError('signature classification is required');
    }

    if (options.uid !== undefined) {
        validateString(options.uid, 'uid', true);
    }

    validateUint32(options.msgType, 'msgType');
    validateUint32(options.ntCoreVersion, 'ntCoreVersion');
    const { uin, uid, classifySigning, sign, msgType, ntCoreVersion } = options;
    const createTraceParent = options.createTraceParent ?? makeTraceParent;

    if (typeof createTraceParent !== 'function') {
        throw new TypeError('invalid trace generator');
    }

    return async (request: SsoSigningRequest): Promise<Uint8Array> => {
        if (!request || request.uin !== uin) {
            throw new Error('SSO reserve account mismatch');
        }

        const command = request.command;
        validateString(command, 'command', false);

        const sequence = request.sequence;

        if (sequence === undefined) {
            throw new RangeError('invalid sequence');
        }

        validateUint32(sequence, 'sequence');
        const inputBody = request.body;

        if (
            !(inputBody instanceof Uint8Array) ||
            typedArrayByteLength.call(inputBody) > MAX_REQUEST_BODY_BYTES
        ) {
            throw new TypeError('invalid SSO request body');
        }

        // Snapshot before invoking caller callbacks, including for unsigned requests.
        const body = new Uint8ArrayConstructor(inputBody);

        if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
            throw new TypeError('invalid SSO request body');
        }

        let signerWasCalled = false;

        try {
            const traceParent = createTraceParent();
            validateString(traceParent, 'trace parent', false);
            const disposition = classifySigning(command);
            let secureInfo: DirectSsoSecureInfo | undefined;

            if (disposition === 'sign') {
                if (typeof sign !== 'function') {
                    throw new Error('required SSO signer is missing');
                }

                const baseline = new Uint8ArrayConstructor(body);
                const expectedLength = typedArrayByteLength.call(baseline) as number;
                const signerRequest = { uin, command, sequence, body };

                try {
                    signerWasCalled = true;
                    const signature = await sign(signerRequest);

                    assertSignerRequestUnchanged(
                        signerRequest,
                        uin,
                        command,
                        sequence,
                        body,
                        baseline,
                        expectedLength,
                    );

                    if (!signature || typeof signature !== 'object') {
                        throw new TypeError('invalid SSO signature');
                    }

                    // Snapshot each field before reading the next caller-controlled property.
                    // A field may alias body, which remains available to the callback.
                    const signBytes = snapshotSignatureField(signature.sign, 'sign', true);
                    const token = snapshotSignatureField(signature.token, 'token', false);
                    const extra = snapshotSignatureField(signature.extra, 'extra', false);
                    // Signature field getters can run caller code after the first check.
                    assertSignerRequestUnchanged(
                        signerRequest,
                        uin,
                        command,
                        sequence,
                        body,
                        baseline,
                        expectedLength,
                    );
                    secureInfo = { sign: signBytes, token, extra };
                } finally {
                    typedArrayFill.call(baseline, 0);
                }
            } else if (disposition !== 'unsigned') {
                throw new Error('invalid signature classification');
            }

            const reserve: DirectSsoReserve = {
                traceParent,
                uid,
                msgType,
                secureInfo,
                ntCoreVersion,
            };
            return protobuf_encode<DirectSsoReserve>(reserve);
        } finally {
            // Existing callbacks may retain their input after returning.
            if (!signerWasCalled) {
                typedArrayFill.call(body, 0);
            }
        }
    };
}
