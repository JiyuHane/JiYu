import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { deriveTargetMachineGuidDigestCandidate } from '../../src/direct/target-machine-guid-digest-candidate';
import { encodeTargetWtLoginNode0124 } from '../../src/direct/target-wt-node-0124-candidate';
import { encodeTargetWtLoginNode0128 } from '../../src/direct/target-wt-node-0128-candidate';
import { encodeTargetWtLoginNode0147 } from '../../src/direct/target-wt-node-0147-candidate';
import { encodeTargetWtInnerEncryptedCandidate } from '../../src/direct/target-wt-inner-encrypted-candidate';
import {
    encodeTargetWtLoginNode0144,
    encodeTargetWtLoginNode016e,
} from '../../src/direct/target-wt-login-node';
import {
    encodeTargetWtLoginOrder,
    type TargetWtLoginNode,
    type TargetWtLoginOpaqueNode,
} from '../../src/direct/target-wt-login-order';

type Parts = [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
const bytes = (value: string): Uint8Array => Buffer.from(value, 'hex');
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

// Synthetic fragments and the independently calculated TEA fixture from
// wt-login-request.test.ts. The final 0124-looking fragment is opaque and is
// not asserted to satisfy the target 0124 writer. No runtime or server
// equivalence is implied.
const fragmentHex = [
    '016e000144',
    '0147000b112233440001760002ccdd',
    '0128001200000000000000000000014c0002aabb0000',
    '0124000c000102030405060708090a0b',
] as const;
const cipherHex =
    '955abf5506096bacac66692532a868cf9a458f0e4e1550f29969d3780269e28c' +
    '901f9640f813df993361ec495f4aecbbd7fd0ce9b7c5b05dd6bc3d261f9a2abb' +
    '06b497ce0a6cf78a';
const nodeHex = '01440048' + cipherHex;
const requiredHex = [
    '01060002dead',
    nodeHex,
    '0116000a00010203040506070800',
    '014200050000000170',
    '01450002aabb',
    '001800160000000000050000000000001f410102030400000000',
    '0141000f00000007556e6b6e6f776e00000000',
    '017700080100000000000173',
    '0191000100',
] as const;
const requiredTags = [0x106, 0x144, 0x116, 0x142, 0x145, 0x018, 0x141, 0x177, 0x191];
const optionalHex = [
    '01000016000000000005112233445566778800001234090a0b0c',
    '0107000600010d000001',
    '03180000',
    '016a0002beef',
    '0166000105',
    '0521000d0000001300076261736963696d',
] as const;
const expectedHex = requiredHex.join('') + optionalHex.join('');

function parts(): Parts {
    const fragments = fragmentHex.map(bytes) as Parts;
    fragments[0] = encodeTargetWtLoginNode016e(Uint8Array.of(0x44));
    fragments[1] = encodeTargetWtLoginNode0147({
        word: 0x11223344,
        first: Uint8Array.of(0x76),
        second: Uint8Array.of(0xcc, 0xdd),
    });
    fragments[2] = encodeTargetWtLoginNode0128({
        prefix: new Uint8Array(9),
        first: Uint8Array.of(0x4c),
        second: Uint8Array.of(0xaa, 0xbb),
    });
    return fragments;
}

function key(): Uint8Array {
    return bytes('000102030405060708090a0b0c0d0e0f');
}

function random(size: number): Uint8Array {
    const value = new Uint8Array(size);
    value[0] = 0xf8;
    return value;
}

function required(node: Uint8Array): TargetWtLoginOpaqueNode[] {
    return requiredTags
        .map((tag, index) => ({
            tag,
            kind: 'opaque',
            bytes: tag === 0x144 ? node : bytes(requiredHex[index]),
        }))
        .reverse();
}

function optional(): TargetWtLoginNode[] {
    return [
        { tag: 0x521, kind: 'opaque', bytes: bytes(optionalHex[5]) },
        { tag: 0x166, kind: 'opaque', bytes: bytes(optionalHex[4]) },
        { tag: 0x16a, kind: 'raw', bytes: bytes('beef') },
        { tag: 0x318, kind: 'raw', bytes: new Uint8Array() },
        { tag: 0x107, kind: 'opaque', bytes: bytes(optionalHex[1]) },
        { tag: 0x100, kind: 'opaque', bytes: bytes(optionalHex[0]) },
    ];
}

function stages() {
    return {
        encrypted: vi.fn(encodeTargetWtInnerEncryptedCandidate),
        node: vi.fn(encodeTargetWtLoginNode0144),
        order: vi.fn(encodeTargetWtLoginOrder),
    };
}

describe('offline 0144 encrypted candidate through ordered writers', () => {
    it('places a synthetic processed-input digest in the 0128 vector', () => {
        const digest = deriveTargetMachineGuidDigestCandidate(bytes('616263'), bytes('646566'));
        expect(hex(digest)).toBe('e80b5017098950fc58aad83c8c14978e');
        const node = encodeTargetWtLoginNode0128({
            prefix: new Uint8Array(9),
            first: bytes('4c696e7578'),
            second: digest,
        });
        expect(hex(node)).toBe(
            '01280024' + '00'.repeat(9) + '00054c696e75780010e80b5017098950fc58aad83c8c14978e0000',
        );
    });

    it('combines four modeled nodes using synthetic Linux and default 0124 fields', () => {
        const empty = new Uint8Array();
        const first = encodeTargetWtLoginNode016e(Uint8Array.of(0x44));
        const second = encodeTargetWtLoginNode0147({
            word: 0x11223344,
            first: Uint8Array.of(0x76),
            second: Uint8Array.of(0xcc, 0xdd),
        });
        const third = encodeTargetWtLoginNode0128({
            prefix: new Uint8Array(9),
            first: bytes('4c696e7578'),
            second: bytes('000102030405060708090a0b0c0d0e0f'),
        });
        const last = encodeTargetWtLoginNode0124({
            first: empty,
            second: empty,
            word: 0,
            third: empty,
            fourth: empty,
        });
        expect(hex(first)).toBe('016e000144');
        expect(hex(second)).toBe('0147000b112233440001760002ccdd');
        expect(hex(third)).toBe(
            '01280024' +
                '00'.repeat(9) +
                '00054c696e7578' +
                '0010000102030405060708090a0b0c0d0e0f0000',
        );
        expect(hex(last)).toBe('0124000c' + '00'.repeat(12));
        const input: Parts = [first, second, third, last];
        const secret = key();
        const cipher = encodeTargetWtInnerEncryptedCandidate(input, secret, random);
        const plain = qqTeaDecrypt(cipher, secret);
        expect(hex(plain)).toBe(
            '0004016e0001440147000b112233440001760002ccdd01280024' +
                '00'.repeat(9) +
                '00054c696e75780010000102030405060708090a0b0c0d0e0f00000124000c' +
                '00'.repeat(12),
        );
        const node = encodeTargetWtLoginNode0144(cipher);
        const ordered = encodeTargetWtLoginOrder(required(node), optional());
        expect(
            hex(ordered.subarray(requiredHex[0].length / 2, requiredHex[0].length / 2 + 2)),
        ).toBe('0144');
    });

    it('matches the independent 01440048 cipher and the complete fixture order', () => {
        const input = parts();
        const inputKey = key();
        const randomSource = vi.fn(random);
        const encrypted = encodeTargetWtInnerEncryptedCandidate(input, inputKey, randomSource);
        const node = encodeTargetWtLoginNode0144(encrypted);
        const output = encodeTargetWtLoginOrder(required(node), optional());

        expect(randomSource).toHaveBeenCalledOnce();
        expect(randomSource).toHaveBeenCalledWith(5);
        expect(hex(encrypted)).toBe(cipherHex);
        expect(hex(node)).toBe(nodeHex);
        expect(hex(output)).toBe(expectedHex);
        const beforeNode = requiredHex[0].length / 2;
        expect(hex(output.subarray(0, beforeNode))).toBe(requiredHex[0]);
        expect(hex(output.subarray(beforeNode, beforeNode + node.length))).toBe(nodeHex);
        expect(hex(output.subarray(beforeNode + node.length))).toBe(
            requiredHex.slice(2).join('') + optionalHex.join(''),
        );
    });

    it('snapshots parts and key before randomness and isolates every returned layer', () => {
        const input = parts();
        const inputKey = key();
        let prefix: Uint8Array | undefined;
        const encrypted = encodeTargetWtInnerEncryptedCandidate(input, inputKey, (size) => {
            input.forEach((fragment) => fragment.fill(0));
            inputKey.fill(0);
            prefix = random(size);
            return prefix;
        });
        expect(hex(encrypted)).toBe(cipherHex);
        const node = encodeTargetWtLoginNode0144(encrypted);
        const mandatory = required(node);
        const extras = optional();
        const output = encodeTargetWtLoginOrder(mandatory, extras);

        encrypted.fill(0);
        expect(hex(node)).toBe(nodeHex);
        mandatory.forEach(({ bytes: value }) => value.fill(0));
        extras.forEach(({ bytes: value }) => value.fill(0));
        prefix!.fill(0);
        expect(hex(output)).toBe(expectedHex);
        output.fill(0xff);
        expect(input.every((fragment) => fragment.every((value) => value === 0))).toBe(true);
        expect(inputKey.every((value) => value === 0)).toBe(true);
        expect(node.every((value) => value === 0)).toBe(true);
        expect(prefix!.every((value) => value === 0)).toBe(true);
    });

    it('stops before the node and order stages for each invalid writer fragment or key', () => {
        for (let index = 0; index < 4; index++) {
            const input = parts();
            input[index] = null as unknown as Uint8Array;
            const call = stages();
            const randomSource = vi.fn(random);
            let result: Uint8Array | undefined;
            expect(() => {
                const cipher = call.encrypted(input, key(), randomSource);
                result = call.order(required(call.node(cipher)), optional());
            }).toThrow('target WT inner encrypted candidate failed');
            expect(result).toBeUndefined();
            expect(randomSource).not.toHaveBeenCalled();
            expect(call.node).not.toHaveBeenCalled();
            expect(call.order).not.toHaveBeenCalled();
        }

        for (const invalidKey of [new Uint8Array(15), new Uint8Array(17)]) {
            const call = stages();
            const randomSource = vi.fn(random);
            let result: Uint8Array | undefined;
            expect(() => {
                const cipher = call.encrypted(parts(), invalidKey, randomSource);
                result = call.order(required(call.node(cipher)), optional());
            }).toThrow('target WT inner encrypted candidate failed');
            expect(result).toBeUndefined();
            expect(randomSource).not.toHaveBeenCalled();
            expect(call.node).not.toHaveBeenCalled();
            expect(call.order).not.toHaveBeenCalled();
        }
    });

    it('stops without an output for a throwing or malformed random source', () => {
        for (const source of [
            () => {
                throw new Error('synthetic random failure');
            },
            (size: number) => new Uint8Array(size - 1),
        ]) {
            const call = stages();
            const randomSource = vi.fn(source);
            const input = parts();
            const inputKey = key();
            let result: Uint8Array | undefined;
            expect(() => {
                const cipher = call.encrypted(input, inputKey, randomSource);
                result = call.order(required(call.node(cipher)), optional());
            }).toThrow('target WT inner encrypted candidate failed');
            expect(result).toBeUndefined();
            expect(randomSource).toHaveBeenCalledOnce();
            expect(call.node).not.toHaveBeenCalled();
            expect(call.order).not.toHaveBeenCalled();
            expect(input.map(hex)).toEqual([...fragmentHex]);
            expect(hex(inputKey)).toBe('000102030405060708090a0b0c0d0e0f');
        }
    });

    it('rejects a real 65536-byte ciphertext at the 0144 boundary without ordering', () => {
        // 65519 plaintext bytes including the writer count encrypt to 65536;
        // this exercises the boundary without encrypting a 16 MiB input.
        const input: Parts = [
            new Uint8Array(65517),
            new Uint8Array(),
            new Uint8Array(),
            new Uint8Array(),
        ];
        const call = stages();
        let result: Uint8Array | undefined;
        let cipher: Uint8Array | undefined;
        expect(() => {
            cipher = call.encrypted(input, key(), random);
            result = call.order(required(call.node(cipher)), optional());
        }).toThrow('target WT login node encoding failed');
        expect(cipher).toHaveLength(65536);
        expect(call.node).toHaveBeenCalledOnce();
        expect(call.order).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
    });

    it('does not return a partial order when any mandatory node is missing or invalid', () => {
        for (const tag of requiredTags) {
            for (const mode of ['missing', 'invalid'] as const) {
                const call = stages();
                let result: Uint8Array | undefined;
                expect(() => {
                    const cipher = call.encrypted(parts(), key(), random);
                    const node = call.node(cipher);
                    const entries = required(node);
                    const index = entries.findIndex((entry) => entry.tag === tag);

                    if (mode === 'missing') {
                        entries.splice(index, 1);
                    } else {
                        entries[index].bytes = null as unknown as Uint8Array;
                    }

                    result = call.order(entries, optional());
                }).toThrow('target WT login ordered encoding failed');
                expect(result).toBeUndefined();
                expect(call.encrypted).toHaveBeenCalledOnce();
                expect(call.node).toHaveBeenCalledOnce();
                expect(call.order).toHaveBeenCalledOnce();
            }
        }
    });
});
