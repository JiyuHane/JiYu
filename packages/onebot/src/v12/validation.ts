import { isProxy } from 'node:util/types';
import type { V12Self } from './types';

/** Snapshot JSON-shaped input without evaluating accessors or Proxy traps.
 * Callers must catch failures. Limits also apply to in-process callers. */
export function snapshotRequest(value: unknown): unknown {
    const ancestors = new WeakSet<object>();
    let nodes = 0;

    function visit(current: unknown, depth: number): unknown {
        nodes += 1;

        if (nodes > 8192 || depth > 32) {
            throw new Error('request limit exceeded');
        }

        if (current === null || typeof current === 'boolean') {
            return current;
        }

        if (typeof current === 'string') {
            if (current.length > 1048576) {
                throw new Error('request limit exceeded');
            }

            return current;
        }

        if (typeof current === 'number' && Number.isFinite(current)) {
            return current;
        }

        if (typeof current !== 'object' || isProxy(current) || ancestors.has(current)) {
            throw new Error('invalid request value');
        }

        const array = Array.isArray(current);
        const prototype = Object.getPrototypeOf(current);

        if (
            array
                ? prototype !== Array.prototype
                : prototype !== Object.prototype && prototype !== null
        ) {
            throw new Error('invalid request object');
        }

        const keys = Reflect.ownKeys(current);

        if (keys.length > (array ? 4097 : 4096)) {
            throw new Error('request limit exceeded');
        }

        let output: unknown[] | Record<string, unknown>;

        if (array) {
            const length = Object.getOwnPropertyDescriptor(current, 'length');

            if (
                !length ||
                !('value' in length) ||
                !Number.isSafeInteger(length.value) ||
                length.value > 4096
            ) {
                throw new Error('invalid request array');
            }

            output = new Array(length.value);
        } else {
            output = Object.create(null) as Record<string, unknown>;
        }

        ancestors.add(current);
        let elements = 0;

        for (const key of keys) {
            if (typeof key !== 'string' || key.length > 512) {
                throw new Error('invalid request key');
            }

            if (array && key === 'length') {
                continue;
            }

            const descriptor = Object.getOwnPropertyDescriptor(current, key);

            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                throw new Error('invalid request property');
            }

            if (array) {
                if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (output as unknown[]).length) {
                    throw new Error('invalid request array');
                }

                (output as unknown[])[Number(key)] = visit(descriptor.value, depth + 1);
                elements += 1;
            } else {
                (output as Record<string, unknown>)[key] = visit(descriptor.value, depth + 1);
            }
        }

        if (array && elements !== (output as unknown[]).length) {
            throw new Error('invalid request array');
        }

        ancestors.delete(current);
        return output;
    }

    return visit(value, 0);
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSelf(value: unknown): value is V12Self {
    return (
        isObject(value) &&
        typeof value.platform === 'string' &&
        value.platform.length > 0 &&
        typeof value.user_id === 'string' &&
        value.user_id.length > 0
    );
}

/** Require canonical positive decimal form to prevent numeric aliases or rounding. */
export function parseAccountId(value: unknown): number | null {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        return null;
    }

    const number = Number(value);
    return Number.isSafeInteger(number) && String(number) === value ? number : null;
}

/** IDs owned by the existing V11 message store are nonzero signed int32s. */
export function parseMessageId(value: unknown): number | null {
    if (typeof value !== 'string' || !/^-?[1-9][0-9]*$/.test(value)) {
        return null;
    }

    const number = Number(value);
    return Number.isInteger(number) &&
        number >= -2147483648 &&
        number <= 2147483647 &&
        String(number) === value
        ? number
        : null;
}

export function fromV11AccountId(value: unknown): string | null {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        return String(value);
    }

    if (typeof value === 'string' && parseAccountId(value) !== null) {
        return value;
    }

    return null;
}

export function fromV11MessageId(value: unknown): string | null {
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        const stringValue = String(value);
        return parseMessageId(stringValue) === null ? null : stringValue;
    }

    return typeof value === 'string' && parseMessageId(value) !== null ? value : null;
}
