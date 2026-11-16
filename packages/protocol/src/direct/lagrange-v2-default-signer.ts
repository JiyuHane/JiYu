import { isProxy } from 'node:util/types';
import type { SsoSignature, SsoSigningRequest } from './sso-reserve';

// Contract facts only: LagrangeDev/LagrangeV2, commit 7011cdf87368cc0fb77273c1508e779a52328165,
// Lagrange.Core/Common/BotSignProvider.cs (upstream authors retain their rights).
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Common/BotSignProvider.cs#L575-L617
// This independent adapter supplies neither a signing algorithm nor transport effects.
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_UIN = '9007199254740991';

export interface LagrangeV2DefaultRequest {
    readonly cmd: string;
    readonly seq: number;
    readonly src: string;
}

/** The injected function owns all effects and Promise/thenable assimilation. */
export type LagrangeV2DefaultTransport = (request: LagrangeV2DefaultRequest) => Promise<unknown>;

export interface LagrangeV2DefaultSignerOptions {
    uin: string;
    transport: LagrangeV2DefaultTransport;
}

export type LagrangeV2DefaultErrorStage = 'configuration' | 'request' | 'transport' | 'response';

/** Diagnostics never include external exceptions or response content. */
export class LagrangeV2DefaultSignerError extends Error {
    readonly stage: LagrangeV2DefaultErrorStage;

    constructor(stage: LagrangeV2DefaultErrorStage) {
        super(`Lagrange V2 default signer ${stage} failed`);
        this.name = 'LagrangeV2DefaultSignerError';
        this.stage = stage;
    }
}

// Inspect every own property, including unknown and symbol keys, without invoking
// accessors. Proxies and non-plain prototypes are outside this local contract.
function dataProperties(input: unknown): PropertyDescriptorMap {
    if (typeof input !== 'object' || input === null || isProxy(input)) {
        throw new TypeError();
    }

    const prototype = Object.getPrototypeOf(input) as unknown;

    if (prototype !== null && prototype !== Object.prototype) {
        throw new TypeError();
    }

    const properties = Object.getOwnPropertyDescriptors(input);

    for (const key of Reflect.ownKeys(properties)) {
        const descriptor = Reflect.get(properties, key) as PropertyDescriptor;

        if (!Object.hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }
    }

    return properties;
}

function ownValue(properties: PropertyDescriptorMap, name: string): unknown {
    if (!Object.hasOwn(properties, name)) {
        throw new TypeError();
    }

    return properties[name]!.value as unknown;
}

function validateAccount(value: unknown): asserts value is string {
    if (
        typeof value !== 'string' ||
        !/^[1-9][0-9]{0,15}$/.test(value) ||
        (value.length === MAX_SAFE_UIN.length && value > MAX_SAFE_UIN)
    ) {
        throw new TypeError();
    }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const typedArrayFill = Uint8Array.prototype.fill;

/** Copy an ordinary live byte view, rejecting shared, detached and proxy storage. */
function copyBody(value: unknown): Uint8Array {
    if (
        isProxy(value) ||
        !ArrayBuffer.isView(value) ||
        typedArrayTag.call(value) !== 'Uint8Array'
    ) {
        throw new TypeError();
    }

    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = Object.getPrototypeOf(current) as object | null;
    }

    const buffer = typedArrayBuffer.call(value) as ArrayBuffer;
    arrayBufferLength.call(buffer);
    typedArrayValues.call(value);
    const length = typedArrayLength.call(value) as number;
    const offset = typedArrayOffset.call(value) as number;

    if (length > MAX_BODY_BYTES) {
        throw new RangeError();
    }

    return Uint8Array.from(new Uint8Array(buffer, offset, length));
}

function decodeField(value: unknown, required: boolean): Uint8Array {
    if (
        typeof value !== 'string' ||
        value.length > MAX_METADATA_BYTES * 2 ||
        (required && value.length === 0) ||
        value.length % 2 !== 0 ||
        !/^[0-9a-fA-F]*$/.test(value)
    ) {
        throw new TypeError();
    }

    return Uint8Array.from(Buffer.from(value, 'hex'));
}

/**
 * Bind the local DTO adapter to one account. Each valid request calls the injected
 * transport once, after snapshotting its inputs. The caller may connect that
 * transport to a real service; actual peer and connection behavior belong entirely
 * to the injected function, not this adapter. No endpoint, networking, fallback,
 * command policy or signing algorithm is provided or inferred here.
 *
 * Request bytes must stay stable until synchronously copied. Shared, detached and
 * proxy-backed views are rejected; resizable ordinary ArrayBuffers are accepted
 * only while their view remains valid during the copy. The private body copy is
 * wiped after conversion, but immutable hex strings and caller-owned bytes are not.
 * Transport Promise resolution may read a returned thenable's `then` before the
 * response can be inspected; subsequent DTO inspection rejects accessors and proxies.
 */
export function createLagrangeV2DefaultSigner(
    options: LagrangeV2DefaultSignerOptions,
): (request: SsoSigningRequest) => Promise<SsoSignature> {
    let uin: string;
    let transport: LagrangeV2DefaultTransport;

    try {
        const properties = dataProperties(options);
        const account = ownValue(properties, 'uin');
        const callback = ownValue(properties, 'transport');
        validateAccount(account);

        if (typeof callback !== 'function' || isProxy(callback)) {
            throw new TypeError();
        }

        uin = account;
        transport = callback as LagrangeV2DefaultTransport;
    } catch {
        throw new LagrangeV2DefaultSignerError('configuration');
    }

    return async (request: SsoSigningRequest): Promise<SsoSignature> => {
        let payload: LagrangeV2DefaultRequest;

        try {
            const properties = dataProperties(request);
            const account = ownValue(properties, 'uin');
            const command = ownValue(properties, 'command');
            const sequence = ownValue(properties, 'sequence');
            const body = ownValue(properties, 'body');
            validateAccount(account);

            if (
                account !== uin ||
                typeof command !== 'string' ||
                command.length === 0 ||
                Buffer.byteLength(command, 'utf8') > MAX_METADATA_BYTES ||
                typeof sequence !== 'number' ||
                !Number.isInteger(sequence) ||
                sequence < 0 ||
                sequence > 0xffffffff ||
                Object.is(sequence, -0)
            ) {
                throw new TypeError();
            }

            const snapshot = copyBody(body);
            let src: string;

            try {
                src = Buffer.from(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength)
                    .toString('hex')
                    .toUpperCase();
            } finally {
                typedArrayFill.call(snapshot, 0);
            }

            payload = Object.freeze({ cmd: command, seq: sequence | 0, src });
        } catch {
            throw new LagrangeV2DefaultSignerError('request');
        }

        let response: unknown;

        try {
            response = await transport(payload);
        } catch {
            throw new LagrangeV2DefaultSignerError('transport');
        }

        try {
            const root = dataProperties(response);
            const value = dataProperties(ownValue(root, 'value'));
            const sign = decodeField(ownValue(value, 'sign'), true);
            const token = decodeField(ownValue(value, 'token'), false);
            const extra = decodeField(ownValue(value, 'extra'), false);
            return { sign, token, extra };
        } catch {
            throw new LagrangeV2DefaultSignerError('response');
        }
    };
}
