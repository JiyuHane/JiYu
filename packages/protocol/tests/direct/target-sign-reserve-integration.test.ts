import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import type { TargetSso12ReserveMessage } from '@snowluma/proto-defs/target-sso12-reserve';
import { protobuf_decode } from '@snowluma/proton';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { targetSignPresenceMaskCandidate as presence } from '../../src/direct/target-sign-presence-candidate';
import { assembleTargetSignStructureCandidate as assemble } from '../../src/direct/target-sign-structure-candidate';
import { extractTargetSignStructureResultCandidate as extract } from '../../src/direct/target-sign-structure-result-candidate';
import {
    decodeTargetMsfSignOutput as decode,
    encodeTargetSso12ReserveFromNativeSlots as encodeSlots,
    encodeTargetSso12Reserve as encodeFields,
} from '../../src/direct/target-sso12-reserve';

// Cross-check existing implementations rather than inventing another encoder.
// Every byte and status below is synthetic. Agreement between these local models
// does not establish native object identity, a signature, or an accepted QQ frame.
const VECTORS = [
    [0, ''],
    [1, 'c201030a0155'],
    [2, 'c20103120166'],
    [3, 'c201060a0155120166'],
    [4, 'c201031a0177'],
    [5, 'c201060a01551a0177'],
    [6, 'c201061201661a0177'],
    [7, 'c201090a01551201661a0177'],
] as const;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function blocked(): never {
    throw new Error('unexpected effect');
}

beforeEach(() => {
    guards = [
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
    const fetch = vi.fn(blocked);
    const webSocket = vi.fn(blocked);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', webSocket);
    guards.push(fetch, webSocket);
    syncBuiltinESMExports();
});

afterEach(() => {
    try {
        for (const guard of guards) {
            expect(guard.mock.calls).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        syncBuiltinESMExports();
        guards = [];
    }
});

function compareProjections(structure: Uint8Array) {
    const named = extract(structure);
    const native = decode(0, structure);
    expect(named.token).toEqual(native.at00);
    expect(named.extra).toEqual(native.at18);
    expect(named.sign).toEqual(native.at30);

    const wire = encodeSlots({}, native);
    expect(wire).toEqual(
        encodeFields({
            field24: { field1: named.sign, field2: named.token, field3: named.extra },
        }),
    );
    const parsed = protobuf_decode<TargetSso12ReserveMessage>(wire);
    expect(parsed.field24?.field1 ?? new Uint8Array()).toEqual(named.sign);
    expect(parsed.field24?.field2 ?? new Uint8Array()).toEqual(named.token);
    expect(parsed.field24?.field3 ?? new Uint8Array()).toEqual(named.extra);
    return { named, native, wire, parsed };
}

describe('synthetic sign-layout and reserve cross-validation', () => {
    it.each(VECTORS)(
        'preserves the slot permutation and fixed wire vector for mask %i',
        (mask, expected) => {
            const sign = mask & 1 ? Uint8Array.of(0x55) : new Uint8Array();
            const token = mask & 2 ? Uint8Array.of(0x66) : new Uint8Array();
            const extra = mask & 4 ? Uint8Array.of(0x77) : new Uint8Array();
            const structure = assemble({ sign, token, extra });
            const before = Uint8Array.from(structure);
            const { named, wire } = compareProjections(structure);

            expect(hex(wire)).toBe(expected);
            expect(presence(named.sign, named.token, named.extra, 0)).toBe(mask);
            expect(structure).toEqual(before);
        },
    );

    it.each([
        [127, '7f', '8303'],
        [128, '8001', '8903'],
        [255, 'ff01', '8606'],
    ] as const)(
        'crosses the length varint boundary with %i opaque bytes per slot',
        (length, innerLength, outerLength) => {
            const sign = new Uint8Array(length); // Nonempty zero bytes still count as present.
            const token = new Uint8Array(length).fill(0x66);
            const extra = new Uint8Array(length).fill(0x77);
            const { named, wire } = compareProjections(assemble({ sign, token, extra }));

            expect(hex(wire)).toBe(
                `c201${outerLength}0a${innerLength}${'00'.repeat(length)}` +
                    `12${innerLength}${'66'.repeat(length)}1a${innerLength}${'77'.repeat(length)}`,
            );
            expect(presence(named.sign, named.token, named.extra, 0)).toBe(7);
        },
    );

    it('ignores dirty unused slot bytes and respects a nonzero view offset', () => {
        const backing = new Uint8Array(0x320).fill(0xa5);
        const structure = backing.subarray(0x10, 0x310);
        structure[0xff] = 1;
        structure[0x1ff] = 0;
        structure[0x2ff] = 1;
        structure[0] = 0x66;
        structure[0x200] = 0x55;
        const before = Uint8Array.from(backing);
        const { named, wire } = compareProjections(structure);

        expect(hex(wire)).toBe('c201060a0155120166');
        expect(presence(named.sign, named.token, named.extra, 0)).toBe(3);
        expect(backing).toEqual(before);
    });

    it('returns separately owned projections and wire bytes across the whole composition', () => {
        const structure = assemble({
            sign: Uint8Array.of(0x55),
            token: Uint8Array.of(0x66),
            extra: Uint8Array.of(0x77),
        });
        const { named, native, wire } = compareProjections(structure);
        const outputs = [
            named.sign,
            named.token,
            named.extra,
            native.at00,
            native.at18,
            native.at30,
            wire,
        ];
        expect(new Set(outputs.map((bytes) => bytes.buffer)).size).toBe(outputs.length);

        for (const output of outputs) {
            expect(output.buffer).not.toBe(structure.buffer);
        }

        structure.fill(0);
        named.sign.fill(0);
        named.token.fill(0);
        named.extra.fill(0);
        expect(hex(native.at30)).toBe('55');
        expect(hex(native.at00)).toBe('66');
        expect(hex(native.at18)).toBe('77');
        native.at00.fill(0);
        native.at18.fill(0);
        native.at30.fill(0);
        expect(hex(wire)).toBe(VECTORS[7][1]);
    });

    it('does not equate a caller-supplied initial mask with encoded field presence', () => {
        const structure = new Uint8Array(0x300);
        const { named, native, wire } = compareProjections(structure);
        expect(presence(named.sign, named.token, named.extra, 0xff)).toBe(0xff);
        expect(wire).toHaveLength(0);
        expect(hex(encodeSlots({ field26: 0 }, native))).toBe('d00100');
    });

    it.each([1, -1, NaN])(
        'rejects synthetic unsuccessful status %s before reserve encoding',
        (status) => {
            const structure = new Uint8Array(0x300);
            const encode = vi.fn(encodeSlots);
            expect(() => encode({}, decode(status, structure))).toThrow(
                'target msf sign output decoding failed',
            );
            expect(encode).not.toHaveBeenCalled();
        },
    );
});
