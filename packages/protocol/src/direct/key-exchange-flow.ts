import { isProxy } from 'node:util/types';
import { buildKeyExchange, decryptKeyExchangeBytes } from './key-exchange';
import {
    decodeKeyExchangeResponse,
    decodeKeyExchangeResponseSecret,
    encodeKeyExchangeRequest,
    encodeKeyExchangeRequestBuf,
} from './key-exchange-protobuf';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';

// This composition follows a public reference, not a verified QQ build or server capture.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/KeyExchangeService.cs
export const KEY_EXCHANGE_COMMAND = 'trpc.login.ecdh.EcdhService.SsoKeyExchange';

function wipeKeyExchangeBytes(bytes: Uint8Array | undefined): void {
    try {
        bytes?.fill(0);
    } catch {
        // Best-effort only; Proton and the runtime may retain other copies.
    }
}

export interface KeyExchangeFlowInput {
    uin: string;
    guid: Uint8Array;
    version: string;
    subAppId: number;
    /** Optional inner SSO A2; absent defaults to empty, independent of outer D2. */
    a2?: Uint8Array;
    reserved: Uint8Array;
    sequence: number;
    serverPublicKey: Uint8Array;
    verifyKey: Uint8Array;
    timestamp: number;
    /** Must authenticate the response key and any proof using caller-owned trust. */
    verifyServerResponse: (response: {
        publicKey: Uint8Array;
        field2?: Uint8Array;
        secret: Uint8Array;
        requestPublicKey: Uint8Array;
        uin: string;
        sequence: number;
    }) => boolean;
}

export interface KeyExchangeFlowResult {
    sessionKey: Uint8Array;
    sessionTicket: Uint8Array;
    expiration?: number;
}

/**
 * Construct one frame and consume at most one response attempt, including failures.
 * The observed reference does not authenticate the response public key here;
 * the caller must supply a verifier. GCM alone does not establish server identity.
 */
export function createKeyExchangeFlow(input: KeyExchangeFlowInput): {
    request: Uint8Array;
    complete: (response: Uint8Array) => KeyExchangeFlowResult;
    cancel: () => void;
} {
    if (typeof input !== 'object' || input === null) {
        throw new TypeError('key exchange input must be an object');
    }

    if (typeof input.uin !== 'string' || !/^[0-9]{1,20}$/.test(input.uin)) {
        throw new Error('invalid service UIN');
    }

    if (!(input.guid instanceof Uint8Array) || input.guid.length === 0) {
        throw new TypeError('guid must be nonempty bytes');
    }

    const a2 = input.a2;

    if (a2 !== undefined && !(a2 instanceof Uint8Array)) {
        throw new TypeError('a2 must be bytes');
    }

    if (!(input.reserved instanceof Uint8Array)) {
        throw new TypeError('reserved must be bytes');
    }

    if (typeof input.version !== 'string' || input.version.length === 0) {
        throw new TypeError('version must be a nonempty string');
    }

    if (typeof input.verifyServerResponse !== 'function') {
        throw new TypeError('server response verifier is required');
    }

    if (!Number.isInteger(input.subAppId) || input.subAppId < 0 || input.subAppId > 0x7fffffff) {
        throw new RangeError('subAppId must fit in nonnegative signed 32 bits');
    }

    if (
        !Number.isInteger(input.sequence) ||
        input.sequence < -0x80000000 ||
        input.sequence > 0x7fffffff
    ) {
        throw new RangeError('sequence must fit in signed 32 bits');
    }

    const uin = input.uin;
    const sequence = input.sequence;
    const verifyServerResponse = input.verifyServerResponse;
    const secret = encodeKeyExchangeRequestBuf({ uin, guid: input.guid });
    let exchange: ReturnType<typeof buildKeyExchange>;

    try {
        exchange = buildKeyExchange(
            secret,
            input.serverPublicKey,
            input.verifyKey,
            input.timestamp,
        );
    } finally {
        wipeKeyExchangeBytes(secret);
    }

    // The request-side ECDH result is no longer needed after constructing the fields.
    exchange.sharedSecret.fill(0);
    const body = encodeKeyExchangeRequest({
        publicKey: exchange.publicKey,
        type: 1,
        secret: exchange.secret,
        timestamp: BigInt(exchange.timestamp),
        verifyHash: exchange.verifyHash,
    });
    const sso = encodeSso12Request({
        sequence,
        subAppId: input.subAppId,
        a2: a2 ?? new Uint8Array(),
        command: KEY_EXCHANGE_COMMAND,
        guid: input.guid,
        version: input.version,
        reserved: input.reserved,
        body,
    });
    const request = encodeServiceRequest({
        protocol: 12,
        encryption: { type: 'zero' },
        d2: new Uint8Array(),
        uin,
        body: sso,
    });
    let derive: typeof exchange.deriveResponseSecret | undefined = exchange.deriveResponseSecret;
    const requestPublicKey = Uint8Array.from(exchange.publicKey);

    return responseFlow(request, uin, sequence, verifyServerResponse, requestPublicKey, derive);
}

export interface KeyExchangeFlow {
    request: Uint8Array;
    complete: (response: Uint8Array) => KeyExchangeFlowResult;
    cancel: () => void;
}

function responseFlow(
    request: Uint8Array,
    uin: string,
    sequence: number,
    verifyServerResponse: KeyExchangeFlowInput['verifyServerResponse'],
    requestPublicKey: Uint8Array,
    derive: ReturnType<typeof buildKeyExchange>['deriveResponseSecret'] | undefined,
): KeyExchangeFlow {
    return {
        request,
        cancel(): void {
            derive = undefined;
        },
        complete(response: Uint8Array): KeyExchangeFlowResult {
            const deriveOnce = derive;
            derive = undefined;

            if (!deriveOnce) {
                throw new Error('key exchange response already consumed');
            }

            if (!(response instanceof Uint8Array)) {
                throw new TypeError('response must be bytes');
            }

            const frame = decodeServiceResponse(response);

            if (frame.protocol !== 12 || frame.encryption !== 'zero') {
                throw new Error('unexpected key exchange service frame');
            }

            if (frame.uin !== uin) {
                throw new Error('key exchange account mismatch');
            }

            const parsed = decodeSsoResponse(frame.body);

            if (parsed.sequence !== sequence) {
                throw new Error('key exchange sequence mismatch');
            }

            if (parsed.command !== KEY_EXCHANGE_COMMAND) {
                throw new Error('key exchange command mismatch');
            }

            if (parsed.retCode !== 0) {
                throw new Error(`key exchange server error: ${parsed.retCode}`);
            }

            const payload = decodeKeyExchangeResponse(parsed.body);

            // The codec validates both required byte fields before returning.
            if (!payload.publicKey || !payload.secret) {
                throw new Error('missing key exchange response fields');
            }

            const verified = verifyServerResponse({
                publicKey: Uint8Array.from(payload.publicKey),
                field2: payload.field2 && Uint8Array.from(payload.field2),
                secret: Uint8Array.from(payload.secret),
                requestPublicKey: Uint8Array.from(requestPublicKey),
                uin,
                sequence,
            });

            if (verified !== true) {
                throw new Error('key exchange server verification failed');
            }

            const responseKey = deriveOnce(payload.publicKey);

            let plaintext: Uint8Array | undefined;
            let sessionKey: Uint8Array | undefined;
            let sessionTicket: Uint8Array | undefined;
            let committed = false;

            try {
                let result: KeyExchangeFlowResult;

                try {
                    plaintext = decryptKeyExchangeBytes(payload.secret, responseKey);
                    const decoded = decodeKeyExchangeResponseSecret(plaintext);
                    sessionKey = decoded.sessionKey;
                    sessionTicket = decoded.sessionTicket;

                    if (!sessionKey?.length || !sessionTicket?.length) {
                        throw new Error('missing key exchange session key or ticket');
                    }

                    result = {
                        sessionKey,
                        sessionTicket,
                        expiration: decoded.expiration,
                    };
                } finally {
                    wipeKeyExchangeBytes(plaintext);
                    responseKey.fill(0);
                }

                committed = true;
                return result;
            } finally {
                if (!committed) {
                    wipeKeyExchangeBytes(sessionKey);
                    wipeKeyExchangeBytes(sessionTicket);
                }
            }
        },
    };
}

const preparedMaxBytes = 16 * 1024 * 1024;
const preparedTypedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const preparedBuffer = Object.getOwnPropertyDescriptor(preparedTypedPrototype, 'buffer')!.get!;
const preparedLength = Object.getOwnPropertyDescriptor(preparedTypedPrototype, 'byteLength')!.get!;
const preparedOffset = Object.getOwnPropertyDescriptor(preparedTypedPrototype, 'byteOffset')!.get!;
const preparedTag = Object.getOwnPropertyDescriptor(
    preparedTypedPrototype,
    Symbol.toStringTag,
)!.get!;
const preparedArrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const preparedResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const preparedValues = Uint8Array.prototype.values;
const preparedFill = Uint8Array.prototype.fill;
const preparedSet = Uint8Array.prototype.set;
const preparedOwnKeys = Reflect.ownKeys;
const preparedGetPrototype = Object.getPrototypeOf;
const preparedDescriptors = Object.getOwnPropertyDescriptors;
const preparedHasOwn = Object.hasOwn;
const preparedIsView = ArrayBuffer.isView;
const PreparedBytes = Uint8Array;

function wipePrepared(bytes: Uint8Array | undefined): void {
    try {
        if (bytes !== undefined) {
            preparedFill.call(bytes, 0);
        }
    } catch {
        // Detached storage and copies held by the runtime are outside this cleanup.
    }
}

function preparedSnapshot(value: unknown, max: number, name: string): Uint8Array {
    if (isProxy(value) || !preparedIsView(value) || preparedTag.call(value) !== 'Uint8Array') {
        throw new TypeError(`${name} must be ordinary bytes`);
    }

    let prototype: object | null = value;

    for (let depth = 0; prototype !== null; depth++) {
        if (depth >= 256 || isProxy(prototype)) {
            throw new TypeError(`${name} has an invalid prototype`);
        }

        prototype = preparedGetPrototype(prototype) as object | null;
    }

    const buffer = preparedBuffer.call(value) as ArrayBuffer;
    preparedArrayBufferLength.call(buffer); // Also rejects shared storage.
    preparedValues.call(value); // Detects detached and out-of-bounds empty views.

    if (preparedResizable?.call(buffer)) {
        throw new TypeError(`${name} must have fixed storage`);
    }

    const length = preparedLength.call(value) as number;
    const offset = preparedOffset.call(value) as number;

    if (length > max) {
        throw new RangeError(`${name} exceeds size limit`);
    }

    const copy = new PreparedBytes(length);
    preparedSet.call(copy, new PreparedBytes(buffer, offset, length));
    return copy;
}

export interface PreparedKeyExchangeFlow {
    /** Borrowed until finish or cancel; do not mutate, return or transfer its storage. */
    readonly body: Uint8Array;
    finish: (reserved: Uint8Array) => KeyExchangeFlow;
    cancel: () => void;
}

/**
 * Prepare exactly one request body without signing or transport. The caller may
 * process the borrowed body asynchronously, but must not mutate or transfer it.
 * Finish compares its current bytes with a private copy, not what a signer used;
 * mutation followed by restoration and signing another copy are not detectable.
 * Finish and cancel clear the borrowed body and owned copies on a best-effort basis.
 * Releasing the derivation closure does not guarantee private-key erasure.
 * The verifier is caller policy, not independently established server identity;
 * returned session key and ticket are caller-owned and require caller cleanup.
 */
export function prepareKeyExchangeFlow(
    input: Omit<KeyExchangeFlowInput, 'reserved'>,
): PreparedKeyExchangeFlow {
    if (typeof input !== 'object' || input === null || isProxy(input)) {
        throw new TypeError('key exchange input must be a plain object');
    }

    const prototype = preparedGetPrototype(input);

    if (prototype !== null && prototype !== Object.prototype) {
        throw new TypeError('key exchange input must be a plain object');
    }

    const descriptors = preparedDescriptors(input);
    const allowed = [
        'uin',
        'guid',
        'version',
        'subAppId',
        'a2',
        'sequence',
        'serverPublicKey',
        'verifyKey',
        'timestamp',
        'verifyServerResponse',
    ];

    for (const key of preparedOwnKeys(descriptors)) {
        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !preparedHasOwn(descriptors[key]!, 'value')
        ) {
            throw new TypeError('invalid key exchange input property');
        }
    }

    const field = (name: string): unknown =>
        preparedHasOwn(descriptors, name) ? (descriptors[name]!.value as unknown) : undefined;
    const uin = field('uin');
    const version = field('version');
    const subAppId = field('subAppId');
    const sequence = field('sequence');
    const timestamp = field('timestamp');
    const verifier = field('verifyServerResponse');

    if (typeof uin !== 'string' || !/^[0-9]{1,20}$/.test(uin)) {
        throw new Error('invalid service UIN');
    }

    if (
        typeof version !== 'string' ||
        version.length === 0 ||
        Buffer.byteLength(version, 'utf8') > 0xffff - 2
    ) {
        throw new TypeError('version must fit the SSO field');
    }

    if (typeof verifier !== 'function' || isProxy(verifier)) {
        throw new TypeError('server response verifier is required');
    }

    if (
        typeof subAppId !== 'number' ||
        !Number.isInteger(subAppId) ||
        subAppId < 0 ||
        subAppId > 0x7fffffff
    ) {
        throw new RangeError('subAppId must fit in nonnegative signed 32 bits');
    }

    if (
        typeof sequence !== 'number' ||
        !Number.isInteger(sequence) ||
        sequence < -0x80000000 ||
        sequence > 0x7fffffff
    ) {
        throw new RangeError('sequence must fit in signed 32 bits');
    }

    if (
        typeof timestamp !== 'number' ||
        !Number.isInteger(timestamp) ||
        timestamp < 0 ||
        timestamp > 0xffffffff
    ) {
        throw new RangeError('timestamp must be a uint32');
    }

    let guid: Uint8Array | undefined;
    let a2: Uint8Array | undefined;
    let serverKey: Uint8Array | undefined;
    let verifyKey: Uint8Array | undefined;
    let secret: Uint8Array | undefined;
    let privateBody: Uint8Array | undefined;
    let publicBody: Uint8Array | undefined;
    let exchange: ReturnType<typeof buildKeyExchange> | undefined;
    let handedOff = false;

    try {
        guid = preparedSnapshot(field('guid'), preparedMaxBytes, 'guid');

        if (guid.length === 0) {
            throw new TypeError('guid must be nonempty bytes');
        }

        const a2Value = field('a2');
        a2 =
            a2Value === undefined
                ? new PreparedBytes(0)
                : preparedSnapshot(a2Value, preparedMaxBytes, 'a2');
        serverKey = preparedSnapshot(field('serverPublicKey'), 65, 'serverPublicKey');
        verifyKey = preparedSnapshot(field('verifyKey'), 32, 'verifyKey');

        if (
            guid.length * 3 + a2.length + Buffer.byteLength(version, 'utf8') + 512 >
            preparedMaxBytes
        ) {
            throw new RangeError('key exchange request exceeds size limit');
        }

        secret = encodeKeyExchangeRequestBuf({ uin, guid });
        exchange = buildKeyExchange(secret, serverKey, verifyKey, timestamp);
        wipePrepared(exchange.sharedSecret);
        privateBody = encodeKeyExchangeRequest({
            publicKey: exchange.publicKey,
            type: 1,
            secret: exchange.secret,
            timestamp: BigInt(exchange.timestamp),
            verifyHash: exchange.verifyHash,
        });
        publicBody = new PreparedBytes(privateBody.length);
        preparedSet.call(publicBody, privateBody);
        const result = preparedFlow(
            uin,
            version,
            subAppId,
            sequence,
            verifier as KeyExchangeFlowInput['verifyServerResponse'],
            guid,
            a2,
            privateBody,
            publicBody,
            exchange.publicKey,
            exchange.deriveResponseSecret,
        );
        handedOff = true;
        return result;
    } finally {
        wipePrepared(secret);
        wipePrepared(serverKey);
        wipePrepared(verifyKey);

        if (exchange) {
            wipePrepared(exchange.sharedSecret);
            wipePrepared(exchange.secret);
            wipePrepared(exchange.verifyHash);
        }

        if (!handedOff) {
            wipePrepared(guid);
            wipePrepared(a2);
            wipePrepared(privateBody);
            wipePrepared(publicBody);
            wipePrepared(exchange?.publicKey);
        }
    }
}

function preparedFlow(
    uin: string,
    version: string,
    subAppId: number,
    sequence: number,
    verify: KeyExchangeFlowInput['verifyServerResponse'] | undefined,
    guid: Uint8Array,
    a2: Uint8Array,
    privateBody: Uint8Array,
    publicBody: Uint8Array,
    publicKey: Uint8Array,
    derive: ReturnType<typeof buildKeyExchange>['deriveResponseSecret'] | undefined,
): PreparedKeyExchangeFlow {
    let state: 'prepared' | 'finishing' | 'done' = 'prepared';
    let cancelled = false;
    const requestPublicKey = new PreparedBytes(publicKey.length);
    preparedSet.call(requestPublicKey, publicKey);
    wipePrepared(publicKey);

    const clear = (): void => {
        wipePrepared(guid);
        wipePrepared(a2);
        wipePrepared(privateBody);
        wipePrepared(publicBody);
    };

    const unchanged = (): boolean => {
        try {
            preparedValues.call(publicBody);

            if (preparedLength.call(publicBody) !== privateBody.length) {
                return false;
            }

            for (let i = 0; i < privateBody.length; i++) {
                if (publicBody[i] !== privateBody[i]) {
                    return false;
                }
            }

            return true;
        } catch {
            return false;
        }
    };

    return Object.freeze({
        body: publicBody,
        cancel(): void {
            cancelled = true;

            if (state === 'prepared') {
                state = 'done';
                derive = undefined;
                verify = undefined;
                clear();
                wipePrepared(requestPublicKey);
            } else if (state === 'finishing') {
                // End the external borrow immediately; defer private cleanup until
                // the synchronous encoder returns and the finish finally runs.
                wipePrepared(publicBody);
            }
        },
        finish(reservedInput: Uint8Array): KeyExchangeFlow {
            if (state !== 'prepared') {
                throw new Error('key exchange preparation already consumed');
            }

            state = 'finishing';
            let reserved: Uint8Array | undefined;
            let sso: Uint8Array | undefined;
            let request: Uint8Array | undefined;
            let committed = false;

            try {
                reserved = preparedSnapshot(reservedInput, preparedMaxBytes, 'reserved');

                if (cancelled || !unchanged()) {
                    throw new Error('key exchange preparation cancelled or body changed');
                }

                sso = encodeSso12Request({
                    sequence,
                    subAppId,
                    a2,
                    command: KEY_EXCHANGE_COMMAND,
                    guid,
                    version,
                    reserved,
                    body: privateBody,
                });
                request = encodeServiceRequest({
                    protocol: 12,
                    encryption: { type: 'zero' },
                    d2: new PreparedBytes(0),
                    uin,
                    body: sso,
                });

                if (cancelled || !unchanged() || !derive || !verify) {
                    throw new Error('key exchange preparation cancelled or body changed');
                }

                const deriveOnce = derive;
                derive = undefined;
                let responseStarted = false;
                let responseCancelled = false;
                const internal = responseFlow(
                    request,
                    uin,
                    sequence,
                    (response) => {
                        if (!verify || responseCancelled) {
                            return false;
                        }

                        const accepted = verify(response);
                        return !responseCancelled && accepted;
                    },
                    requestPublicKey,
                    deriveOnce,
                );
                const flow: KeyExchangeFlow = {
                    request,
                    cancel(): void {
                        responseCancelled = true;
                        verify = undefined;
                        internal.cancel();
                        wipePrepared(requestPublicKey);
                    },
                    complete(response: Uint8Array): KeyExchangeFlowResult {
                        // A recursive complete must not run the outer call's cleanup.
                        if (responseStarted) {
                            throw new Error('key exchange response already consumed');
                        }

                        responseStarted = true;

                        try {
                            const result = internal.complete(response);

                            if (responseCancelled) {
                                wipePrepared(result.sessionKey);
                                wipePrepared(result.sessionTicket);
                                throw new Error('key exchange response cancelled');
                            }

                            return result;
                        } finally {
                            verify = undefined;
                            wipePrepared(requestPublicKey);
                        }
                    },
                };

                if (cancelled || !unchanged()) {
                    internal.cancel();
                    throw new Error('key exchange preparation cancelled or body changed');
                }

                committed = true;
                return flow;
            } finally {
                state = 'done';
                derive = undefined;
                wipePrepared(reserved);
                wipePrepared(sso);
                clear();

                if (!committed) {
                    verify = undefined;
                    wipePrepared(requestPublicKey);
                    wipePrepared(request);
                }
            }
        },
    });
}
