import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { encodeTargetWtInitialTwoNodesCandidate as encode } from '../../src/direct/target-wt-initial-two-nodes-candidate';
import { deriveTargetWtTgtgtKeyCandidate } from '../../src/direct/target-wt-tgtgt-key-candidate';
import { selectTargetWtTgtgtStateCandidate } from '../../src/direct/target-wt-tgtgt-state-candidate';
import type { TargetWtTgtgtPlainInput } from '../../src/direct/target-wt-tgtgt-plain-candidate';

type Fields = Omit<TargetWtTgtgtPlainInput, 'raw7'>;
type Parts = [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
const bytes = (value: string) => Buffer.from(value, 'hex');
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const word = 0x0123456789abcdefn;
const source = () => Uint8Array.from({ length: 16 }, (_, i) => i);
const local = () => Uint8Array.from({ length: 16 }, (_, i) => i);

const random = (size: number) => {
    const result = new Uint8Array(size);
    result[0] = 0xf8;
    return result;
};

const fields = (): Fields => ({
    arg3: 0x11223344,
    field04: 0x55667788,
    field08: 0x99aabbcc,
    field0c: 0xddeeff00,
    field50: 0x0123456789abcdefn,
    arg4: 0x10203040,
    field14: 0x50607080,
    field18: 0x91,
    raw5: bytes('a1a2a3'),
    field19: 0xc1,
    raw20: bytes('d1d2d3d4'),
    field10: 0x12345678,
    field00: 0x9abcdef0,
    tail38: bytes('e1e2e3'),
});
const parts = (): Parts => [
    bytes('016e000144'),
    bytes('0147000b112233440001760002ccdd'),
    bytes('0128001200000000000000000000014c0002aabb0000'),
    bytes('0124000c000102030405060708090a0b'),
];

// Synthetic fixed vectors: standalone Python hashlib and independently written
// 16-cycle TEA with two feedback chains; the test invokes the real encoder.
const plainHex =
    '0004112233445566778899aabbccddeeff000123456789abcdef1020304050607080' +
    '91a1a2a3000102030405060708090a0b0c0d0e0f00000000c1d1d2d3d4' +
    '123456789abcdef00003e1e2e3';
const keyHex = 'bfb2ad3f64569d86ddd86477fcf67880';
const cipher0106 =
    'e76572be7dfb4e47246e688ecb4f600b35c6735181fb452a5f9bccdad0974509' +
    'dd08ed9ea76b26d53389f4eea9dbb811afc9a0de2c654d91b0e2aad6ab316925' +
    'c141f9a04749fdb2f611f1cb7e81e8526b96b169f611d806';
const cipher0144 =
    '955abf5506096bacac66692532a868cf9a458f0e4e1550f29969d3780269e28c' +
    '901f9640f813df993361ec495f4aecbbd7fd0ce9b7c5b05dd6bc3d261f9a2abb' +
    '06b497ce0a6cf78a';
const failure = /^target WT initial two nodes candidate failed$/;

function verifyNodes(result: { node0106: Uint8Array; node0144: Uint8Array }) {
    expect(hex(result.node0106)).toBe('01060058' + cipher0106);
    expect(hex(result.node0144)).toBe('01440048' + cipher0144);
    const plaintext = qqTeaDecrypt(result.node0106.subarray(4), bytes(keyHex));
    expect(hex(plaintext)).toBe(plainHex);
    expect(plaintext.subarray(38, 54)).toEqual(local()); // raw7 immediately follows raw5
    const inner = qqTeaDecrypt(result.node0144.subarray(4), local());
    expect(hex(inner)).toBe('0004' + parts().map(hex).join(''));
    expect(new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint16(0)).toBe(4);
    let offset = 2;

    for (const fragment of parts()) {
        expect(hex(inner.subarray(offset, offset + fragment.length))).toBe(hex(fragment));
        offset += fragment.length;
    }

    expect(offset).toBe(inner.length);
}

describe('offline synthetic initial WT two-node candidate', () => {
    it('matches independent fixed ciphertexts, decrypts raw7 and the four opaque parts in order', () => {
        const events: string[] = [];
        const first = vi.fn((n: number) => {
            events.push(`tgtgt:${n}`);
            return random(n);
        });
        const second = vi.fn((n: number) => {
            events.push(`inner:${n}`);
            return random(n);
        });
        const f = fields();
        const s = source();
        const l = local();
        const p = parts();
        expect(hex(deriveTargetWtTgtgtKeyCandidate(s, word))).toBe(keyHex);
        expect(hex(l)).not.toBe(keyHex);
        verifyNodes(encode(f, s, word, l, p, first, second));
        expect(events).toEqual(['tgtgt:5', 'inner:5']);
        expect(f).toEqual(fields());
        expect(s).toEqual(source());
        expect(l).toEqual(local());
        expect(p).toEqual(parts());
    });

    it('keeps the selected field word separate from a zero derivation word', () => {
        const selected = selectTargetWtTgtgtStateCandidate(1, word, 0n, bytes('cafe'));
        const f: Fields = {
            ...fields(),
            field00: selected.field00,
            field14: selected.field14,
            field18: selected.field18,
            field19: selected.field19,
            field50: selected.field50,
            tail38: selected.tail38,
        };
        expect(selected.field50).toBe(word);
        expect(selected.derivationWord).toBe(0n);
        const zeroWordKey = deriveTargetWtTgtgtKeyCandidate(source(), selected.derivationWord);
        expect(hex(zeroWordKey)).not.toBe(hex(deriveTargetWtTgtgtKeyCandidate(source(), word)));
        const result = encode(
            f,
            source(),
            selected.derivationWord,
            local(),
            parts(),
            random,
            random,
        );
        const plain = qqTeaDecrypt(result.node0106.subarray(4), zeroWordKey);
        const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
        expect(view.getBigUint64(18)).toBe(word);
        expect(hex(plain.subarray(-4))).toBe('0002cafe');
        expect(hex(qqTeaDecrypt(result.node0144.subarray(4), local()))).toBe(
            '0004' + parts().map(hex).join(''),
        );
    });

    it('snapshots both paths before the first callback mutates all caller objects', () => {
        const f = fields();
        const s = source();
        const l = local();
        const p = parts();
        const events: string[] = [];
        const first = vi.fn((n: number) => {
            events.push('tgtgt');
            s.fill(0xff);
            l.fill(0xff);
            f.raw5.fill(0xff);
            f.raw20.fill(0xff);
            f.tail38.fill(0xff);
            f.arg3 = 0;
            f.field50 = 0n;

            for (const part of p) {
                part.fill(0xff);
            }

            p[0] = new Uint8Array();
            return random(n);
        });
        const second = vi.fn((n: number) => {
            events.push('inner');
            return random(n);
        });
        verifyNodes(encode(f, s, word, l, p, first, second));
        expect(events).toEqual(['tgtgt', 'inner']);
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(l.every((value) => value === 0xff)).toBe(true);
    });

    it('rejects invalid fields, views, key, tuple and callbacks before either random callback', () => {
        const detached = new Uint8Array(16);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const accessor = fields();
        const getter = vi.fn(() => 1);
        Object.defineProperty(accessor, 'arg3', { get: getter });
        const sparse = parts();
        delete (sparse as unknown as Array<Uint8Array | undefined>)[2];
        const invalid: Array<[unknown, unknown, unknown, unknown, unknown, unknown, unknown]> = [
            [null, source(), word, local(), parts(), random, random],
            [{ ...fields(), raw7: local() }, source(), word, local(), parts(), random, random],
            [accessor, source(), word, local(), parts(), random, random],
            [{ ...fields(), field18: 256 }, source(), word, local(), parts(), random, random],
            [
                { ...fields(), tail38: new Uint8Array(65536) },
                source(),
                word,
                local(),
                parts(),
                random,
                random,
            ],
            [fields(), new Uint8Array(25), word, local(), parts(), random, random],
            [fields(), source(), -1n, local(), parts(), random, random],
            [fields(), source(), 1n << 64n, local(), parts(), random, random],
            [fields(), source(), word, new Uint8Array(15), parts(), random, random],
            [fields(), source(), word, detached, parts(), random, random],
            [
                fields(),
                source(),
                word,
                new Uint8Array(new SharedArrayBuffer(16)),
                parts(),
                random,
                random,
            ],
            [fields(), source(), word, local(), sparse, random, random],
            [fields(), source(), word, local(), [...parts(), new Uint8Array()], random, random],
            [
                fields(),
                source(),
                word,
                local(),
                [new Uint16Array(1), ...parts().slice(1)],
                random,
                random,
            ],
            [fields(), source(), word, local(), parts(), null, random],
            [fields(), source(), word, local(), parts(), random, null],
        ];

        for (const [f, s, w, l, p, r1, r2] of invalid) {
            const first = vi.fn(random);
            const second = vi.fn(random);
            expect(() =>
                encode(
                    f as Fields,
                    s as Uint8Array,
                    w as bigint,
                    l as Uint8Array,
                    p as Parts,
                    r1 === random ? first : (r1 as typeof random),
                    r2 === random ? second : (r2 as typeof random),
                ),
            ).toThrowError(failure);
            expect(first).not.toHaveBeenCalled();
            expect(second).not.toHaveBeenCalled();
        }

        expect(getter).not.toHaveBeenCalled();
    });

    it.each(['plain', 'inner'] as const)(
        'enforces the ciphertext node bound for %s before randomness',
        (which) => {
            for (const length of [65518, 65519]) {
                const f = fields();
                const p = parts();

                if (which === 'plain') {
                    f.tail38 = new Uint8Array(length - 73);
                } else {
                    p.splice(
                        0,
                        4,
                        new Uint8Array(length - 2),
                        new Uint8Array(),
                        new Uint8Array(),
                        new Uint8Array(),
                    );
                }

                const first = vi.fn(random);
                const second = vi.fn(random);
                const call = () => encode(f, source(), word, local(), p, first, second);

                if (length === 65518) {
                    const result = call();
                    const node = which === 'plain' ? result.node0106 : result.node0144;
                    expect(node.length).toBe(65532); // four-byte node header + 65528-byte ciphertext
                    expect(first).toHaveBeenCalledOnce();
                    expect(second).toHaveBeenCalledOnce();
                } else {
                    expect(() => call()).toThrowError(failure);
                    expect(first).not.toHaveBeenCalled();
                    expect(second).not.toHaveBeenCalled();
                }
            }
        },
    );

    it.each(['first throws', 'first invalid', 'second throws', 'second invalid'] as const)(
        'normalizes %s, preserves ordering and returns no partial result',
        (stage) => {
            const events: string[] = [];
            const callback = (name: 'first' | 'second') =>
                vi.fn((n: number) => {
                    events.push(name);

                    if (stage === `${name} throws`) {
                        throw new Error('private synthetic detail');
                    }

                    if (stage === `${name} invalid`) {
                        return new Uint8Array(n - 1);
                    }

                    return random(n);
                });
            const first = callback('first');
            const second = callback('second');
            let returned: ReturnType<typeof encode> | undefined;
            expect(() => {
                returned = encode(fields(), source(), word, local(), parts(), first, second);
            }).toThrowError(failure);
            expect(returned).toBeUndefined();
            expect(events).toEqual(stage.startsWith('first') ? ['first'] : ['first', 'second']);
        },
    );

    it.each(['success', 'preflight', 'first', 'second', 'node'] as const)(
        'clears owned snapshots and intermediates after %s',
        async (stage) => {
            vi.resetModules();
            const owned: Uint8Array[] = [];
            let firstNode: Uint8Array | undefined;
            vi.doMock('../../src/direct/target-wt-tgtgt-plain-candidate', async (original) => {
                const actual =
                    await original<
                        typeof import('../../src/direct/target-wt-tgtgt-plain-candidate')
                    >();
                return {
                    ...actual,
                    encodeTargetWtTgtgtPlainCandidate: (input: TargetWtTgtgtPlainInput) => {
                        owned.push(input.raw7);
                        const value = actual.encodeTargetWtTgtgtPlainCandidate(input);
                        owned.push(value);
                        return value;
                    },
                };
            });
            vi.doMock('../../src/direct/target-wt-inner-writer-candidate', async (original) => {
                const actual =
                    await original<
                        typeof import('../../src/direct/target-wt-inner-writer-candidate')
                    >();
                return {
                    ...actual,
                    encodeTargetWtInnerWriterCandidate: (...args: Parts) => {
                        const value = actual.encodeTargetWtInnerWriterCandidate(...args);
                        owned.push(value);
                        return value;
                    },
                };
            });
            vi.doMock('../../src/direct/target-wt-tgtgt-key-candidate', async (original) => {
                const actual =
                    await original<
                        typeof import('../../src/direct/target-wt-tgtgt-key-candidate')
                    >();
                return {
                    ...actual,
                    deriveTargetWtTgtgtKeyCandidate: (s: Uint8Array, w: bigint) => {
                        const value = actual.deriveTargetWtTgtgtKeyCandidate(s, w);
                        owned.push(value);
                        return value;
                    },
                };
            });
            vi.doMock('../../src/direct/qq-tea', async (original) => {
                const actual = await original<typeof import('../../src/direct/qq-tea')>();
                return {
                    ...actual,
                    qqTeaEncrypt: (p: Uint8Array, k: Uint8Array, r: typeof random) => {
                        const value = actual.qqTeaEncrypt(p, k, r);
                        owned.push(value);
                        return value;
                    },
                };
            });
            vi.doMock('../../src/direct/target-wt-login-node', async (original) => {
                const actual =
                    await original<typeof import('../../src/direct/target-wt-login-node')>();
                return {
                    ...actual,
                    encodeTargetWtLoginNode0106: (value: Uint8Array) => {
                        firstNode = actual.encodeTargetWtLoginNode0106(value);
                        return firstNode;
                    },
                    encodeTargetWtLoginNode0144: (value: Uint8Array) => {
                        if (stage === 'node') {
                            throw new Error('synthetic node failure');
                        }

                        return actual.encodeTargetWtLoginNode0144(value);
                    },
                };
            });
            const f = fields();
            const s = source();
            const l = local();
            const p = parts();
            const callbacks: string[] = [];

            const callback = (name: 'first' | 'second') => (n: number) => {
                callbacks.push(name);

                if (stage === name) {
                    throw new Error('synthetic random failure');
                }

                return random(n);
            };

            let output: ReturnType<typeof encode> | undefined;

            try {
                const isolated =
                    await import('../../src/direct/target-wt-initial-two-nodes-candidate');
                const run = () =>
                    isolated.encodeTargetWtInitialTwoNodesCandidate(
                        f,
                        stage === 'preflight' ? new Uint8Array(25) : s,
                        word,
                        l,
                        p,
                        callback('first'),
                        callback('second'),
                    );

                if (stage === 'success') {
                    output = run();
                } else {
                    expect(run).toThrowError(failure);
                }
            } finally {
                vi.doUnmock('../../src/direct/target-wt-tgtgt-plain-candidate');
                vi.doUnmock('../../src/direct/target-wt-inner-writer-candidate');
                vi.doUnmock('../../src/direct/target-wt-tgtgt-key-candidate');
                vi.doUnmock('../../src/direct/qq-tea');
                vi.doUnmock('../../src/direct/target-wt-login-node');
                vi.resetModules();
            }

            expect(owned.length).toBeGreaterThanOrEqual(stage === 'preflight' ? 2 : 4);

            for (const item of owned) {
                expect(item.every((value) => value === 0)).toBe(true);
            }

            expect(callbacks).toEqual(
                stage === 'preflight' ? [] : stage === 'first' ? ['first'] : ['first', 'second'],
            );
            expect(f).toEqual(fields());
            expect(s).toEqual(source());
            expect(l).toEqual(local());
            expect(p).toEqual(parts());

            if (stage === 'node') {
                expect(firstNode).toBeDefined();
                expect(firstNode!.every((value) => value === 0)).toBe(true);
            }

            if (output) {
                verifyNodes(output);
            }
        },
    );
});
