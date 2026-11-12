import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectTargetResponseBusinessSkip as select } from '../../src/direct/target-sso12-lookup';
import { decodeTargetSso12ResponseHead } from '../../src/direct/target-sso12-response-head';
import { transformTargetResponse } from '../../src/direct/target-response-transform';

const cap = 16 * 1024 * 1024;
const failure = 'target sso12 lookup failed';
const bytes = (...values: number[]) => Uint8Array.of(...values);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('local target response skip lookup', () => {
    it('compares exact bytes, including empty, zero, high bytes and duplicates', () => {
        expect(select(bytes(), [], 8)).toEqual({ matched: false, skip: 0 });
        expect(select(bytes(), [bytes()], 8)).toEqual({ matched: true, skip: 4 });
        expect(select(bytes(0, 255, 128), [bytes(0, 255), bytes(0, 255, 128)], 8)).toEqual({
            matched: true,
            skip: 4,
        });
        expect(select(bytes(0, 255), [bytes(0, 254), bytes(0, 255, 0)], 8)).toEqual({
            matched: false,
            skip: 0,
        });
        expect(select(bytes(1), [bytes(1), bytes(1)], 8)).toEqual({ matched: true, skip: 4 });
        expect(select(Buffer.from([1, 2]), [bytes(1, 2)], 8)).toEqual({ matched: true, skip: 4 });
    });

    it('selects four at five bytes without claiming a valid wrapper', () => {
        for (const n of [0, 3, 4, 5, 6, 7, 8]) {
            expect(select(bytes(1), [bytes(1)], n)).toEqual({
                matched: true,
                skip: n >= 5 ? 4 : 0,
            });
            expect(select(bytes(1), [bytes(2)], n)).toEqual({ matched: false, skip: 0 });
        }
    });

    it('validates remaining, count and cumulative duplicate-inclusive budgets', () => {
        for (const n of [
            -1,
            0.1,
            NaN,
            Infinity,
            cap + 1,
            Number.MAX_SAFE_INTEGER + 1,
            '5',
            undefined,
            null,
        ]) {
            expect(() => select(bytes(), [], n as number)).toThrow(failure);
        }

        expect(select(bytes(), [], cap)).toEqual({ matched: false, skip: 0 });
        expect(
            select(
                bytes(),
                Array.from({ length: 4096 }, () => bytes()),
                0,
            ).matched,
        ).toBe(true);
        expect(() =>
            select(
                bytes(),
                Array.from({ length: 4097 }, () => bytes()),
                0,
            ),
        ).toThrow(failure);
        const half = new Uint8Array(cap / 2);
        half[0] = 31;
        expect(select(bytes(), [half, half], 0)).toEqual({ matched: false, skip: 0 });
        expect(() => select(bytes(1), [half, half], 0)).toThrow(failure);
        expect(() => select(new Uint8Array(cap + 1), [], 0)).toThrow(failure);
    });

    it('validates all entries before permitting a match', () => {
        expect(() => select(bytes(1), [bytes(1), null as unknown as Uint8Array], 8)).toThrow(
            failure,
        );
        const list = [bytes(1), bytes(2)];
        Object.defineProperty(list, '1', {
            get: () => {
                throw new Error('SECRET');
            },
        });
        expect(() => select(bytes(1), list, 8)).toThrow(failure);
    });

    it('rejects holes, own accessors, proxies and array-likes without invoking traps', () => {
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('SECRET');
        };

        const hole = new Array<Uint8Array>(1);
        const accessor: Uint8Array[] = [];
        Object.defineProperty(accessor, '0', { get: bad });
        const proxy = new Proxy([bytes(1)], {
            get: bad,
            getPrototypeOf: bad,
            getOwnPropertyDescriptor: bad,
        });
        const revoked = Proxy.revocable([], {});
        revoked.revoke();
        const proxyProto: Uint8Array[] = [];
        Object.setPrototypeOf(
            proxyProto,
            new Proxy(Array.prototype, { get: bad, getPrototypeOf: bad }),
        );
        const fake = Object.create(Array.prototype) as Uint8Array[];

        for (const value of [hole, accessor, proxy, revoked.proxy, proxyProto, fake, {}, null]) {
            expect(() => select(bytes(), value as Uint8Array[], 0)).toThrow(failure);
        }

        const ownExtra = [bytes(1)];
        Object.defineProperty(ownExtra, 'extra', { get: bad });
        Object.defineProperty(ownExtra, Symbol.iterator, { get: bad });
        const proto = Object.create(Array.prototype) as object;
        Object.defineProperty(proto, '0', { get: bad });
        Object.setPrototypeOf(ownExtra, proto);
        expect(select(bytes(1), ownExtra, 8)).toEqual({ matched: true, skip: 4 });
        expect(calls).toBe(0);
    });

    it('accepts foreign arrays and views, subviews and shadowed accessors', () => {
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('SECRET');
        };

        const foreign = runInNewContext(
            '[new Uint8Array([99, 0, 255, 1]).subarray(1, 3)]',
        ) as Uint8Array[];
        const key = bytes(0, 255);

        for (const name of [
            'buffer',
            'byteLength',
            'byteOffset',
            'length',
            Symbol.toStringTag,
            Symbol.iterator,
        ]) {
            Object.defineProperty(key, name, { get: bad });
            Object.defineProperty(foreign[0], name, { get: bad });
        }

        expect(select(key, foreign, 5)).toEqual({ matched: true, skip: 4 });
        expect(calls).toBe(0);
    });

    it('rejects proxy, shared, detached, OOB and other views without callbacks', () => {
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('SECRET');
        };

        const ordinary = bytes(1);
        const proxy = new Proxy(ordinary, { get: bad, getPrototypeOf: bad });
        const proxyProto = bytes(1);
        Object.setPrototypeOf(
            proxyProto,
            new Proxy(Uint8Array.prototype, { get: bad, getPrototypeOf: bad }),
        );
        const detached = bytes(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(2, { maxByteLength: 4 });
        const oob = new Uint8Array(rab, 1, 1);
        rab.resize(0);
        const deep = bytes(1);
        let proto: object | null = null;

        for (let i = 0; i < 256; i++) {
            proto = Object.create(proto) as object;
        }

        Object.setPrototypeOf(deep, proto);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(1))',
        ) as Uint8Array;
        const invalid = [
            proxy,
            proxyProto,
            detached,
            oob,
            deep,
            foreignShared,
            new Uint8Array(new SharedArrayBuffer(1)),
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            null,
            {},
        ];

        for (const value of invalid) {
            expect(() => select(value as Uint8Array, [], 8)).toThrow(failure);
            expect(() => select(bytes(1), [bytes(1), value as Uint8Array], 8)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('leaves input bytes and ownership unchanged after success and late failure', () => {
        const key = bytes(1, 2);
        const candidate = bytes(1, 2);
        const beforeKey = key.slice();
        const beforeCandidate = candidate.slice();
        expect(select(key, [candidate], 8)).toEqual({ matched: true, skip: 4 });
        expect(() => select(key, [candidate, null as unknown as Uint8Array], 8)).toThrow(failure);
        expect(key).toEqual(beforeKey);
        expect(candidate).toEqual(beforeCandidate);
    });

    it('keeps caller bytes intact when the constructor is replaced after module load', () => {
        const Native = Uint8Array;
        const key = bytes(7, 8);
        const item = bytes(7, 8);
        let calls = 0;
        vi.stubGlobal(
            'Uint8Array',
            new Proxy(Native, {
                construct(target, args) {
                    calls++;
                    return typeof args[0] === 'number'
                        ? key
                        : Reflect.construct(target, args, target);
                },
            }),
        );
        let result: ReturnType<typeof select> | undefined;
        let error: unknown;

        try {
            result = select(key, [item], 8);

            try {
                select(key, [item, null as unknown as Uint8Array], 8);
            } catch (caught) {
                error = caught;
            }
        } finally {
            vi.unstubAllGlobals();
        }

        expect(result).toEqual({ matched: true, skip: 4 });
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(failure);
        expect(calls).toBe(0);
        expect(key).toEqual(bytes(7, 8));
        expect(item).toEqual(bytes(7, 8));
    });

    it('cleans every owned snapshot on success and failure', async () => {
        vi.resetModules();
        const Native = Uint8Array;
        const allocations: Uint8Array[] = [];
        const key = bytes(7, 8);
        const item = bytes(7, 8);
        vi.stubGlobal(
            'Uint8Array',
            new Proxy(Native, {
                construct(target, args) {
                    const value = Reflect.construct(target, args, target) as Uint8Array;

                    if (typeof args[0] === 'number') {
                        allocations.push(value);
                    }

                    return value;
                },
            }),
        );
        const isolated = await import('../../src/direct/target-sso12-lookup');
        vi.unstubAllGlobals();
        expect(isolated.selectTargetResponseBusinessSkip(key, [item], 8).matched).toBe(true);
        expect(() =>
            isolated.selectTargetResponseBusinessSkip(
                key,
                [item, null as unknown as Uint8Array],
                8,
            ),
        ).toThrow(failure);
        expect(allocations).toHaveLength(4);
        expect(allocations.every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(key).toEqual(bytes(7, 8));
        expect(item).toEqual(bytes(7, 8));
    });

    it('continues wiping other snapshots after an individual wipe throws', async () => {
        vi.resetModules();
        const original = Uint8Array.prototype.fill;
        const cleaned: Uint8Array[] = [];
        let first = true;
        vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value: number,
            start?: number,
            end?: number,
        ) {
            cleaned.push(this);

            if (first) {
                first = false;
                throw new Error('SECRET');
            }

            return original.call(this, value, start, end);
        });
        const isolated = await import('../../src/direct/target-sso12-lookup');
        const key = bytes(7);
        const item = bytes(7);
        expect(isolated.selectTargetResponseBusinessSkip(key, [item, item], 8)).toEqual({
            matched: true,
            skip: 4,
        });
        vi.restoreAllMocks();
        expect(cleaned).toHaveLength(3);
        expect(cleaned[1]).toEqual(bytes(0));
        expect(cleaned[2]).toEqual(bytes(0));
        expect(key).toEqual(bytes(7));
        expect(item).toEqual(bytes(7));
    });

    it('composes with the real transform at post-head boundary sizes', () => {
        const headLength = 37;

        const make = (remaining: number) => {
            const input = new Uint8Array(headLength + remaining);
            const view = new DataView(input.buffer);
            view.setUint32(0, headLength);
            view.setUint32(12, 5);
            input[16] = 1;
            view.setUint32(17, 5);
            input[21] = 2;
            view.setUint32(22, 5);
            input[26] = 3;
            view.setUint32(31, 6);

            if (remaining >= 4) {
                view.setUint32(headLength, 4);
            }

            if (remaining >= 8) {
                view.setUint32(headLength + 4, 4);
            }

            return input;
        };

        for (const remaining of [4, 5, 6, 7, 8]) {
            const input = make(remaining);
            const head = decodeTargetSso12ResponseHead(input);
            const { skip } = select(head.field2, [bytes(2)], input.length - head.nextOffset);
            expect(skip).toBe(remaining >= 5 ? 4 : 0);

            if (remaining >= 5 && remaining <= 7) {
                expect(() => transformTargetResponse(input, skip, 'reject', 0)).toThrow(
                    'target response transform failed',
                );
            } else {
                expect(transformTargetResponse(input, skip, 'reject', 0).body).toEqual(bytes());
            }
        }
    });
});
