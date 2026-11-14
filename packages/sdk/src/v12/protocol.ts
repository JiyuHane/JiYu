import type {
    OneBot12ActionRequest,
    OneBot12ActionResponse,
    OneBot12Event,
    OneBot12JsonObject,
    OneBot12JsonValue,
    OneBot12MessageSegment,
    OneBot12Self,
} from './types.js';

/** SDK resource limits, not limits prescribed by OneBot 12. */
export const ONEBOT12_JSON_MAX_BYTES = 4 * 1024 * 1024;
export const ONEBOT12_JSON_MAX_DEPTH = 64;
export const ONEBOT12_JSON_MAX_NODES = 100_000;

/** Copy and validate JSON values without invoking user-defined accessors or toJSON. */
function snapshot(value: unknown): OneBot12JsonValue {
    const active = new WeakSet<object>();
    let nodes = 0;
    let stringBytes = 0;
    const encoder = new TextEncoder();

    function countString(text: string): void {
        if (text.length > ONEBOT12_JSON_MAX_BYTES) {
            throw new TypeError('OneBot 12 JSON exceeds SDK byte limit');
        }

        stringBytes += encoder.encode(text).byteLength;

        if (stringBytes > ONEBOT12_JSON_MAX_BYTES) {
            throw new TypeError('OneBot 12 JSON exceeds SDK byte limit');
        }
    }

    function copy(input: unknown, depth: number): OneBot12JsonValue {
        if (++nodes > ONEBOT12_JSON_MAX_NODES || depth > ONEBOT12_JSON_MAX_DEPTH) {
            throw new TypeError('OneBot 12 JSON exceeds SDK structural limits');
        }

        if (typeof input === 'string') {
            countString(input);
            return input;
        }

        if (input === null || typeof input === 'boolean') {
            return input;
        }

        if (typeof input === 'number') {
            if (
                !Number.isFinite(input) ||
                (Number.isInteger(input) && !Number.isSafeInteger(input))
            ) {
                throw new TypeError('OneBot 12 JSON number is non-finite or an unsafe integer');
            }

            return input;
        }

        if (typeof input !== 'object' || active.has(input)) {
            throw new TypeError('OneBot 12 value is not acyclic JSON');
        }

        active.add(input);

        try {
            const array = Array.isArray(input);
            const prototype: unknown = Object.getPrototypeOf(input);

            if (
                array
                    ? prototype !== Array.prototype
                    : prototype !== Object.prototype && prototype !== null
            ) {
                throw new TypeError('OneBot 12 JSON requires plain objects and arrays');
            }

            const descriptors = Object.getOwnPropertyDescriptors(input);

            if (Object.getOwnPropertySymbols(input).length !== 0) {
                throw new TypeError('OneBot 12 JSON does not support symbol properties');
            }

            if (array) {
                const length = (descriptors.length as PropertyDescriptor).value as number;

                if (
                    length > ONEBOT12_JSON_MAX_NODES ||
                    Object.keys(descriptors).length !== length + 1
                ) {
                    throw new TypeError(
                        'OneBot 12 JSON arrays must be dense and have no extra properties',
                    );
                }

                const result: OneBot12JsonValue[] = [];

                for (let index = 0; index < length; index++) {
                    const descriptor = descriptors[String(index)];

                    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                        throw new TypeError('OneBot 12 JSON array contains an accessor or a hole');
                    }

                    result.push(copy(descriptor.value, depth + 1));
                }

                return result;
            }

            const result = Object.create(null) as OneBot12JsonObject;

            for (const [key, descriptor] of Object.entries(descriptors)) {
                countString(key);

                if (!descriptor.enumerable || !('value' in descriptor)) {
                    throw new TypeError(
                        'OneBot 12 JSON object contains an accessor or hidden property',
                    );
                }

                // defineProperty keeps an own __proto__ as data, without invoking the prototype setter.
                Object.defineProperty(result, key, {
                    value: copy(descriptor.value, depth + 1),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }

            return result;
        } finally {
            active.delete(input);
        }
    }

    return copy(value, 0);
}

function record(value: OneBot12JsonValue | undefined): value is OneBot12JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSelf(value: OneBot12JsonValue | undefined): value is OneBot12Self {
    return record(value) && typeof value.platform === 'string' && typeof value.user_id === 'string';
}

function validSegment(value: OneBot12JsonValue | undefined): value is OneBot12MessageSegment {
    return (
        record(value) &&
        typeof value.type === 'string' &&
        record(value.data) &&
        !Object.hasOwn(value.data, 'type')
    );
}

function validRequest(value: OneBot12JsonValue): value is OneBot12ActionRequest {
    return (
        record(value) &&
        typeof value.action === 'string' &&
        record(value.params) &&
        (!Object.hasOwn(value, 'echo') || typeof value.echo === 'string') &&
        (!Object.hasOwn(value, 'self') || validSelf(value.self))
    );
}

function validResponseShape(value: OneBot12JsonValue): value is OneBot12ActionResponse {
    return (
        record(value) &&
        (value.status === 'ok' || value.status === 'failed') &&
        typeof value.retcode === 'number' &&
        Number.isSafeInteger(value.retcode) &&
        Object.hasOwn(value, 'data') &&
        typeof value.message === 'string' &&
        (!Object.hasOwn(value, 'echo') || typeof value.echo === 'string')
    );
}

// SDK acceptance policy: an ok response must carry a zero retcode.
function validResponse(value: OneBot12JsonValue): value is OneBot12ActionResponse {
    return validResponseShape(value) && (value.status !== 'ok' || value.retcode === 0);
}

function validEvent(value: OneBot12JsonValue): value is OneBot12Event {
    if (
        !record(value) ||
        typeof value.id !== 'string' ||
        typeof value.time !== 'number' ||
        !Number.isFinite(value.time) ||
        typeof value.detail_type !== 'string' ||
        typeof value.sub_type !== 'string' ||
        !['meta', 'message', 'notice', 'request'].includes(value.type as string) ||
        (value.type !== 'meta' && !validSelf(value.self)) ||
        (value.type === 'meta' && Object.hasOwn(value, 'self') && !validSelf(value.self))
    ) {
        return false;
    }

    if (value.type === 'message' && ['private', 'group', 'channel'].includes(value.detail_type)) {
        if (
            typeof value.message_id !== 'string' ||
            typeof value.user_id !== 'string' ||
            typeof value.alt_message !== 'string' ||
            !Array.isArray(value.message) ||
            !value.message.every(validSegment)
        ) {
            return false;
        }

        if (value.detail_type === 'group' && typeof value.group_id !== 'string') {
            return false;
        }

        if (
            value.detail_type === 'channel' &&
            (typeof value.guild_id !== 'string' || typeof value.channel_id !== 'string')
        ) {
            return false;
        }
    }

    return true;
}

function parse<T extends OneBot12JsonValue>(
    value: unknown,
    validate: (candidate: OneBot12JsonValue) => candidate is T,
    name: string,
): T {
    let candidate: OneBot12JsonValue;

    try {
        candidate = snapshot(value);
    } catch {
        // A proxy can throw an arbitrary error containing sensitive application data.
        throw new TypeError('Invalid or oversized OneBot 12 JSON value');
    }

    if (!validate(candidate)) {
        throw new TypeError(`Invalid OneBot 12 ${name}`);
    }

    return candidate;
}

/** Object parsers validate a snapshot, but cannot recover precision lost during earlier JSON parsing. */
export function parseOneBot12ActionRequest(value: unknown): OneBot12ActionRequest {
    return parse(value, validRequest, 'action request');
}

/** Object input cannot recover precision already lost by an earlier JSON.parse. */
export function parseOneBot12ActionResponse(value: unknown): OneBot12ActionResponse {
    return parse(value, validResponse, 'action response');
}

export function parseOneBot12Event(value: unknown): OneBot12Event {
    return parse(value, validEvent, 'event');
}

export function parseOneBot12MessageSegment(value: unknown): OneBot12MessageSegment {
    return parse(value, validSegment, 'message segment');
}

/** Checks one snapshot only; use parseOneBot12* to obtain a validated owned value. */
function guard<T>(value: unknown, parser: (input: unknown) => T): boolean {
    try {
        parser(value);
        return true;
    } catch {
        return false;
    }
}

export function isOneBot12ActionRequest(value: unknown): boolean {
    return guard(value, parseOneBot12ActionRequest);
}

export function isOneBot12ActionResponse(value: unknown): boolean {
    return guard(value, parseOneBot12ActionResponse);
}

export function isOneBot12Event(value: unknown): boolean {
    return guard(value, parseOneBot12Event);
}

export function isOneBot12MessageSegment(value: unknown): boolean {
    return guard(value, parseOneBot12MessageSegment);
}

function checkSize(text: string): void {
    if (
        text.length > ONEBOT12_JSON_MAX_BYTES ||
        new TextEncoder().encode(text).byteLength > ONEBOT12_JSON_MAX_BYTES
    ) {
        throw new TypeError('OneBot 12 JSON exceeds SDK byte limit');
    }
}

/** Compare the exact decimal literal with its safe-integer JavaScript representation. */
function exactIntegerLiteral(source: string, value: number): boolean {
    if (source.length > 256 || !Number.isSafeInteger(value)) {
        return false;
    }

    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);

    if (!match) {
        return false;
    }

    const exponent = Number(match[4] ?? '0');

    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
        return false;
    }

    const fraction = match[3] ?? '';
    const coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
    const shift = exponent - fraction.length;

    if (shift >= 0) {
        return coefficient * 10n ** BigInt(shift) === BigInt(value);
    }

    const divisor = 10n ** BigInt(-shift);
    return coefficient % divisor === 0n && coefficient / divisor === BigInt(value);
}

/**
 * SDK number policy: up to 256 source characters, finite float64, no nonzero
 * underflow, and integer results must exactly equal a safe decimal integer.
 * Other fractions use ordinary IEEE-754 rounding, not exact decimal arithmetic.
 * This pre-scans the original JSON, including duplicate keys, and bounds nesting
 * before JSON.parse allocates the object. Syntax is then validated by JSON.parse.
 * It does not depend on the newer reviver context API.
 */
function checkNumberLiterals(text: string): void {
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    let index = 0;
    let depth = 0;

    while (index < text.length) {
        const ch = text[index];

        if (ch === '"') {
            index++;

            while (index < text.length) {
                if (text[index] === '\\') {
                    index += 2;
                } else if (text[index++] === '"') {
                    break;
                }
            }
        } else if (ch === '{' || ch === '[') {
            if (++depth > ONEBOT12_JSON_MAX_DEPTH) {
                throw new TypeError('OneBot 12 JSON exceeds SDK nesting limit');
            }

            index++;
        } else if (ch === '}' || ch === ']') {
            depth--;
            index++;
        } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
            number.lastIndex = index;
            const match = number.exec(text);

            if (!match) {
                throw new SyntaxError('Invalid OneBot 12 JSON');
            }

            const source = match[0];
            const value = Number(source);
            const mantissa = source.split(/[eE]/, 1)[0];
            const zeroLiteral = !/[1-9]/.test(mantissa);

            if (
                source.length > 256 ||
                !Number.isFinite(value) ||
                (value === 0 && !zeroLiteral) ||
                (Number.isInteger(value) && !zeroLiteral && !exactIntegerLiteral(source, value))
            ) {
                throw new TypeError('OneBot 12 JSON number exceeds SDK numeric precision policy');
            }

            index = number.lastIndex;
        } else {
            index++;
        }
    }
}

function decode(text: string): unknown {
    checkSize(text);
    checkNumberLiterals(text);
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        throw new SyntaxError('Invalid OneBot 12 JSON');
    }

    return value;
}

export function parseOneBot12ActionRequestJson(text: string): OneBot12ActionRequest {
    return parseOneBot12ActionRequest(decode(text));
}

/** @internal Classifies response shape only; never use to accept an action response. */
export function parseOneBot12ActionResponseShapeJson(text: string): OneBot12ActionResponse {
    return parse(decode(text), validResponseShape, 'action response');
}

/** Validates retcode's original JSON number before accepting the response. */
export function parseOneBot12ActionResponseJson(text: string): OneBot12ActionResponse {
    return parseOneBot12ActionResponse(decode(text));
}

export function parseOneBot12EventJson(text: string): OneBot12Event {
    return parseOneBot12Event(decode(text));
}

function encode<T extends OneBot12JsonValue>(
    value: unknown,
    parser: (input: unknown) => T,
): string {
    const candidate = parser(value);

    // Serialize the owned snapshot directly: inherited Array.prototype.toJSON must not run.
    function json(input: OneBot12JsonValue): string {
        if (Array.isArray(input)) {
            const items: string[] = [];

            for (let index = 0; index < input.length; index++) {
                items.push(json(input[index]));
            }

            return `[${items.join(',')}]`;
        }

        if (input !== null && typeof input === 'object') {
            return `{${Object.keys(input)
                .map((key) => `${JSON.stringify(key)}:${json(input[key] as OneBot12JsonValue)}`)
                .join(',')}}`;
        }

        // JSON.stringify erases the observable sign of zero; JSON itself supports -0.
        return Object.is(input, -0) ? '-0' : JSON.stringify(input);
    }

    const text = json(candidate);
    checkSize(text);
    return text;
}

export function serializeOneBot12ActionRequest(value: unknown): string {
    return encode(value, parseOneBot12ActionRequest);
}

export function serializeOneBot12ActionResponse(value: unknown): string {
    return encode(value, parseOneBot12ActionResponse);
}

export function serializeOneBot12Event(value: unknown): string {
    return encode(value, parseOneBot12Event);
}
