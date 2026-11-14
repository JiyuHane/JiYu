import { describe, expect, it } from 'vitest';
import {
    initializeMt19937StaticCandidate as initialize,
    stepMt19937StaticCandidate as step,
} from '../../src/experimental/mt19937-static-candidate';

// 5489's first ten are the published MT19937 reference sequence. Selected
// later values and the other synthetic seeds were obtained independently from
// NumPy 2.5.4 RandomState (MT19937), not by running the native target.
const reference = [
    {
        seed: 0,
        values: [2357136044, 2546248239, 1277481980, 3294341718, 631131020, 3791854820, 341544762],
    },
    {
        seed: 1,
        values: [
            1791095845, 4282876139, 2992811220, 1994202740, 3906854836, 2006116153, 1104314680,
        ],
    },
    {
        seed: 5489,
        values: [3499211612, 581869302, 3922754098, 2397746050, 2227348307, 4020325887, 4178893912],
    },
    {
        seed: 0x80000000,
        values: [652847386, 1439962116, 823619025, 984599521, 3482533866, 2283417207, 2355930816],
    },
    {
        seed: 0xffffffff,
        values: [419326371, 479346978, 990247775, 4246159479, 1222270187, 1027084080, 3860652269],
    },
];
const positions = [0, 1, 226, 227, 622, 623, 624];

describe('offline restricted MT19937 static candidate', () => {
    it('matches the published first ten outputs for synthetic seed 5489', () => {
        const expected = [
            3499211612, 581869302, 3890346734, 3586334585, 545404204, 4161255391, 3922919429,
            949333985, 2715962298, 1323567403,
        ];
        let state = initialize(5489);

        for (const value of expected) {
            const result = step(state);
            expect(result.value).toBe(value);
            state = result.state;
        }
    });

    it.each(reference)(
        'matches independent synthetic seed $seed through the first wrap',
        ({ seed, values }) => {
            let state = initialize(seed);
            let selected = 0;

            for (let index = 0; index <= 624; index++) {
                expect(state.index).toBe(index % 624);
                const result = step(state);

                if (index === positions[selected]) {
                    expect(result.value).toBe(values[selected]);
                    selected++;
                }

                state = result.state;
            }

            expect(selected).toBe(positions.length);
            expect(state.index).toBe(1);
        },
    );

    it.each([
        [0, 0],
        [1, 4275563133],
        [0x80000000, 3424137990],
        [0xffffffff, 1988610280],
    ])('accepts a caller-supplied synthetic state filled with %i', (word, expected) => {
        const result = step({ words: Array<number>(624).fill(word), index: 0 });
        expect(result.value).toBe(expected);
        expect(result.state.index).toBe(1);
    });

    it('copies input words and returns deeply immutable plain-value objects', () => {
        const words = Array<number>(624).fill(0);
        words[397] = 1;
        const input = { words, index: 0 };
        const snapshot = words.slice();
        const result = step(input);

        expect(words).toEqual(snapshot);
        expect(result.state.words).not.toBe(words);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.state)).toBe(true);
        expect(Object.isFrozen(result.state.words)).toBe(true);
        expect(Reflect.set(result.state.words, 0, 42)).toBe(false);
        expect(Reflect.set(result.state, 'index', 42)).toBe(false);
        words[397] = 123;
        expect(result.state.words[397]).toBe(1);
        expect(Object.isFrozen(initialize(0).words)).toBe(true);
    });

    it('rejects invalid synthetic seeds and model states without coercion', () => {
        for (const seed of [-1, 0x100000000, 0.5, NaN, Infinity, '1', null, undefined]) {
            expect(() => initialize(seed as number)).toThrow(
                'invalid synthetic MT candidate state',
            );
        }

        const valid = Array<number>(624).fill(0);

        for (const index of [-1, 624, 0.5, NaN, Infinity, '0', null, undefined]) {
            expect(() => step({ words: valid, index: index as number })).toThrow(
                'invalid synthetic MT candidate state',
            );
        }

        for (const word of [-1, 0x100000000, 0.5, NaN, Infinity, '0', null, undefined]) {
            const words = valid.slice() as unknown[];
            words[17] = word;
            expect(() => step({ words: words as number[], index: 0 })).toThrow(
                'invalid synthetic MT candidate state',
            );
        }

        expect(() => step({ words: valid.slice(1), index: 0 })).toThrow(
            'invalid synthetic MT candidate state',
        );
        expect(() => step({ words: [...valid, 0], index: 0 })).toThrow(
            'invalid synthetic MT candidate state',
        );
        expect(() => step({ words: new Array<number>(624), index: 0 })).toThrow(
            'invalid synthetic MT candidate state',
        );
        expect(() =>
            step({ words: new Uint32Array(624) as unknown as number[], index: 0 }),
        ).toThrow('invalid synthetic MT candidate state');
        expect(() => step(null as never)).toThrow('invalid synthetic MT candidate state');
    });
});
