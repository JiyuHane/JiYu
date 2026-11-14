import { isProxy } from 'node:util/types';
import type { SsoSignature, SsoSigningRequest } from './sso-reserve';

// Contract reference only: LagrangeDev/LagrangeV2, commit 7011cdf87368cc0fb77273c1508e779a52328165,
// Lagrange.Milky/Utility/Signer.cs (upstream authors retain their rights).
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Milky/Utility/Signer.cs#L572-L660
// This independent adapter implements no signing, network transport or command policy.
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_SAFE_UIN = '9007199254740991';

export interface LagrangeV2MilkyRequest {
    readonly uin: number;
    readonly command: string;
    readonly seq: number;
    readonly body: string;
    readonly guid: string;
    readonly qua: string;
}

/** The caller owns transport effects and Promise/thenable assimilation. */
export type LagrangeV2MilkyTransport = (request: LagrangeV2MilkyRequest) => Promise<unknown>;

export interface LagrangeV2MilkySignerOptions {
    uin: string;
    guid: Uint8Array;
    qua: string;
    transport: LagrangeV2MilkyTransport;
}

export type LagrangeV2MilkyErrorStage = 'configuration' | 'request' | 'transport' | 'response';

/** Fixed diagnostics deliberately exclude external exceptions and response text. */
export class LagrangeV2MilkySignerError extends Error {
    readonly stage: LagrangeV2MilkyErrorStage;

    constructor(stage: LagrangeV2MilkyErrorStage) {
        super(`Lagrange V2 Milky signer ${stage} failed`);
        this.name = 'LagrangeV2MilkySignerError';
        this.stage = stage;
    }
}

// These constraints are local restrictions, not claims about upstream acceptance.
// DTOs must be plain data objects, including unknown own fields. Descriptor
// inspection itself invokes no accessor; prior Promise assimilation may read then.
function plainData(value: unknown): PropertyDescriptorMap {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError();
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    if (prototype !== null && prototype !== Object.prototype) {
        throw new TypeError();
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;

        if (!Object.hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }
    }

    return descriptors;
}

function field(data: PropertyDescriptorMap, name: string): unknown {
    if (!Object.hasOwn(data, name)) {
        throw new TypeError();
    }

    return data[name]!.value as unknown;
}

function account(value: unknown): asserts value is string {
    if (
        typeof value !== 'string' ||
        !/^[1-9][0-9]{0,15}$/.test(value) ||
        (value.length === MAX_SAFE_UIN.length && value > MAX_SAFE_UIN)
    ) {
        throw new TypeError();
    }
}

function text(value: unknown, allowEmpty: boolean): asserts value is string {
    if (
        typeof value !== 'string' ||
        (!allowEmpty && value.length === 0) ||
        Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
    ) {
        throw new TypeError();
    }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedValues = Uint8Array.prototype.values;

/** Copy an ordinary live view, rejecting proxies, shared or detached storage. */
function snapshotBytes(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || typedTag.call(value) !== 'Uint8Array') {
        throw new TypeError();
    }

    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = Object.getPrototypeOf(current) as object | null;
    }

    const backing = typedBuffer.call(value) as ArrayBuffer;
    arrayBufferLength.call(backing); // SharedArrayBuffer is not an ArrayBuffer.
    typedValues.call(value); // A detached or out-of-bounds view is invalid.
    const length = typedLength.call(value) as number;
    const offset = typedOffset.call(value) as number;

    if (length > max) {
        throw new RangeError();
    }

    return Uint8Array.from(new Uint8Array(backing, offset, length));
}

function decodeHex(value: unknown, nonempty: boolean): Uint8Array {
    if (
        typeof value !== 'string' ||
        value.length > MAX_SIGNATURE_BYTES * 2 ||
        (nonempty && value.length === 0) ||
        value.length % 2 !== 0 ||
        !/^[0-9a-fA-F]*$/.test(value)
    ) {
        throw new TypeError();
    }

    return Uint8Array.from(Buffer.from(value, 'hex'));
}

/**
 * Bind a pure transport-contract adapter to one account and one explicit profile.
 * Request and option bytes must remain stable until synchronously snapshotted.
 * No live transport, endpoint, authorization, signing implementation, command
 * classification, or evidence of interoperability is supplied by this module.
 */
export function createLagrangeV2MilkySigner(
    options: LagrangeV2MilkySignerOptions,
): (request: SsoSigningRequest) => Promise<SsoSignature> {
    let uin: string;
    let guid: string;
    let qua: string;
    let transport: LagrangeV2MilkyTransport;

    try {
        const data = plainData(options);
        const accountValue = field(data, 'uin');
        const guidValue = field(data, 'guid');
        const quaValue = field(data, 'qua');
        const transportValue = field(data, 'transport');
        account(accountValue);
        text(quaValue, false);

        if (typeof transportValue !== 'function' || isProxy(transportValue)) {
            throw new TypeError();
        }

        const guidBytes = snapshotBytes(guidValue, 16);

        if (guidBytes.length !== 16) {
            throw new TypeError();
        }

        uin = accountValue;
        qua = quaValue;
        guid = Buffer.from(guidBytes).toString('hex');
        transport = transportValue as LagrangeV2MilkyTransport;
    } catch {
        throw new LagrangeV2MilkySignerError('configuration');
    }

    return async (request: SsoSigningRequest): Promise<SsoSignature> => {
        let payload: LagrangeV2MilkyRequest;

        try {
            const data = plainData(request);
            const requestUin = field(data, 'uin');
            const command = field(data, 'command');
            const sequence = field(data, 'sequence');
            const body = field(data, 'body');
            account(requestUin);
            text(command, false);

            if (
                requestUin !== uin ||
                typeof sequence !== 'number' ||
                !Number.isInteger(sequence) ||
                sequence < 0 ||
                sequence > 0xffffffff ||
                Object.is(sequence, -0)
            ) {
                throw new TypeError();
            }

            const bodyBytes = snapshotBytes(body, MAX_BODY_BYTES);
            payload = Object.freeze({
                uin: Number(uin),
                command,
                seq: sequence > 0x7fffffff ? sequence - 0x100000000 : sequence,
                body: Buffer.from(bodyBytes).toString('hex'),
                guid,
                qua,
            });
        } catch {
            throw new LagrangeV2MilkySignerError('request');
        }

        let response: unknown;

        try {
            // Promise resolution can read a returned object's then before validation.
            response = await transport(payload);
        } catch {
            throw new LagrangeV2MilkySignerError('transport');
        }

        try {
            const data = plainData(response);
            const code = field(data, 'code');
            const message = field(data, 'message');
            const value = field(data, 'value');

            if (
                typeof code !== 'number' ||
                !Number.isInteger(code) ||
                Object.is(code, -0) ||
                code < 0 ||
                code > 0x7fffffff ||
                code !== 0
            ) {
                throw new TypeError();
            }

            if (message !== null) {
                text(message, true);
            }

            const fields = plainData(value);
            const sign = decodeHex(field(fields, 'sec_sign'), true);
            const token = decodeHex(field(fields, 'sec_token'), false);
            const extra = decodeHex(field(fields, 'sec_extra'), false);
            return { sign, token, extra };
        } catch {
            throw new LagrangeV2MilkySignerError('response');
        }
    };
}
