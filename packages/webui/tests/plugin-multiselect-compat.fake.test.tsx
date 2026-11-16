import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigBuilder } from '../../onebot/src/plugin-host/config-builder';
import type { JsonValue } from '../../onebot/src/types';
import {
    applyConfigDraftField,
    configConfirmationText,
    configDraftToValue,
    configValueToDraft,
    createConfigModeGuard,
    dispatchEditableConfigConfirmation,
    PluginMultiSelectControl,
    PluginPlainTextView,
    updateMultiSelectTokens,
} from '../src/components/settings/plugins-panel';
import type { PluginConfigValue } from '../src/lib/api/types';
import { parseConfigFields, parseConfigValue, parseConfigView } from '../src/lib/plugin-index';

// Hoisted guards also cover module initialization; each test restubs after teardown.
vi.hoisted(() => {
    vi.stubGlobal('fetch', () => {
        throw new Error('unexpected fetch');
    });
    vi.stubGlobal('WebSocket', function BlockedWebSocket() {
        throw new Error('unexpected WebSocket');
    });
});

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw new Error('unexpected fetch');
        }),
    );
    vi.stubGlobal(
        'WebSocket',
        vi.fn(() => {
            throw new Error('unexpected WebSocket');
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// Only ordinary, trusted fixtures go through this synthetic copier. This is not
// the production copier, PluginHost, plugin execution, or a Proxy detector.
function builderFixture() {
    return createConfigBuilder({
        copySchema(input, onTopLevelItem) {
            const copy = structuredClone(input) as JsonValue;

            if (Array.isArray(input) && Array.isArray(copy)) {
                input.forEach((item, index) => onTopLevelItem?.(item, copy[index], index));
            }

            return copy;
        },
        invalid() {
            throw new Error('invalid builder input');
        },
        unsupported(feature) {
            throw new Error(`unsupported builder feature: ${feature}`);
        },
    }).builder;
}

const choices = [
    { label: 'string one', value: '1' },
    { label: 'number one', value: 1 },
    { label: 'empty string', value: '' },
];

function multiSchema(defaultValue: (string | number)[] = [1, '1']) {
    const builder = builderFixture();
    return builder.combine(
        builder.multiSelect('selection', 'Selection', choices, defaultValue, 'Description', false),
    );
}

function multiFields() {
    return parseConfigFields(multiSchema());
}

function rawMulti(options: unknown = choices) {
    return { key: 'selection', label: 'Selection', type: 'multi-select', options };
}

// Invalid cases deliberately cross the typed boundary; no runtime cast changes data.
function asDraft(value: Record<string, unknown>): Parameters<typeof configDraftToValue>[1] {
    return value as Parameters<typeof configDraftToValue>[1];
}

// Ordinary arrays only: holes, accessors, non-enumerable elements and extra keys
// are outside the JSON-array contract. None of the accessors should be invoked.
function malformedArrays<T>(item: T) {
    const getter = vi.fn(() => item);
    const hole = new Array<T>(1);
    const accessor = new Array<T>(1);
    Object.defineProperty(accessor, '0', { enumerable: true, configurable: true, get: getter });
    const nonEnumerable = [item];
    Object.defineProperty(nonEnumerable, '0', { value: item, enumerable: false });
    const extra = [item];
    Object.defineProperty(extra, 'extra', { value: true, enumerable: true });
    const hiddenExtra = [item];
    Object.defineProperty(hiddenExtra, 'extra', { value: true, enumerable: false });
    const symbolExtra = [item];
    Object.defineProperty(symbolExtra, Symbol('extra'), { value: true });
    const customPrototype = [item];
    Object.setPrototypeOf(customPrototype, null);
    return {
        getter,
        arrays: [hole, accessor, nonEnumerable, extra, hiddenExtra, symbolExtra, customPrototype],
    };
}

describe('static multi-select compatibility (data only)', () => {
    it('round-trips builder schema, mixed scalars and ordered index-token arrays', () => {
        const builder = builderFixture();
        const schema = builder.combine(
            builder.multiSelect('selection', 'Selection', choices, [1, '1'], 'Description', false),
            builder.select('single', 'Single', choices, '1'),
            builder.text('message', 'Message', 'default'),
            builder.number('count', 'Count', 4),
            builder.boolean('enabled', 'Enabled', true),
        );
        const fields = parseConfigFields(schema);
        expect(fields[0]).toMatchObject({
            type: 'multi-select',
            options: choices,
            default: [1, '1'],
            reactive: false,
        });

        const current: PluginConfigValue = {
            selection: ['', '1'],
            single: 1,
            message: '',
            count: 0,
            enabled: false,
        };
        const parsed = parseConfigValue(fields, current);
        expect(parsed).toEqual(current);
        const draft = configValueToDraft(fields, parsed);
        expect(draft).toEqual({
            selection: ['i:2', 'i:0'],
            single: 'i:1',
            message: '',
            count: '0',
            enabled: false,
        });
        expect(configDraftToValue(fields, draft)).toEqual(current);
        expect(current.selection).toEqual(['', '1']);
    });

    it('preserves empty selection, order and number/string identities in both directions', () => {
        const fields = multiFields();
        const cases: Array<[(string | number)[], string[]]> = [
            [[], []],
            [
                ['', '1'],
                ['i:2', 'i:0'],
            ],
            [
                [1, '1', ''],
                ['i:1', 'i:0', 'i:2'],
            ],
            [
                ['1', 1],
                ['i:0', 'i:1'],
            ],
            [[1], ['i:1']],
            [[''], ['i:2']],
        ];

        for (const [selection, tokens] of cases) {
            const original = [...selection];
            const parsed = parseConfigValue(fields, { selection });
            expect(parsed).toEqual({ selection: original });
            const draft = configValueToDraft(fields, parsed);
            expect(draft).toEqual({ selection: tokens });
            const restored = configDraftToValue(fields, draft);
            expect(restored).toEqual({ selection: original });
            expect(selection).toEqual(original);
        }

        expect(configDraftToValue(fields, asDraft({ selection: ['i:1', 'i:0'] }))).toEqual({
            selection: [1, '1'],
        });
        const strings = parseConfigFields([rawMulti([{ label: 'string', value: '1' }])]);
        const numbers = parseConfigFields([rawMulti([{ label: 'number', value: 1 }])]);
        expect(() => parseConfigValue(strings, { selection: [1] })).toThrow();
        expect(() => parseConfigValue(numbers, { selection: ['1'] })).toThrow();
    });

    it('admits one through 256 unique options and preserves all 256 in caller order', () => {
        const builder = builderFixture();
        const one = builder.combine(builder.multiSelect('selection', 'Selection', [choices[2]]));
        expect(parseConfigValue(parseConfigFields(one), { selection: [''] })).toEqual({
            selection: [''],
        });

        const options = Array.from({ length: 256 }, (_, value) => ({ label: `L${value}`, value }));
        const fields = parseConfigFields(
            builder.combine(builder.multiSelect('selection', 'Selection', options)),
        );
        const selection = Array.from({ length: 256 }, (_, index) => 255 - index);
        const tokens = selection.map((index) => `i:${index}`);
        const draft = configValueToDraft(fields, parseConfigValue(fields, { selection }));
        expect(draft).toEqual({ selection: tokens });
        expect(configDraftToValue(fields, draft)).toEqual({ selection });
        expect(() => parseConfigValue(fields, { selection: [...selection, 0] })).toThrow();

        expect(() => parseConfigFields([rawMulti([])])).toThrow();
        const tooMany = Array.from({ length: 257 }, (_, value) => ({ label: `L${value}`, value }));
        expect(() => parseConfigFields([rawMulti(tooMany)])).toThrow();
        expect(() => builder.multiSelect('selection', 'Selection', tooMany)).toThrow();
    });

    it('maps mixed option types and duplicate values at the 256-option boundary', () => {
        const builder = builderFixture();
        const options: Array<{ label: string; value: string | number }> = Array.from(
            { length: 256 },
            (_, value) => ({ label: `L${value}`, value }),
        );
        options[0].value = 1;
        options[1].value = '1';
        options[128].value = '';
        const fields = parseConfigFields(
            builder.combine(builder.multiSelect('selection', 'Selection', options)),
        );
        expect(configValueToDraft(fields, { selection: [255, '', 1, '1'] })).toEqual({
            selection: ['i:255', 'i:128', 'i:0', 'i:1'],
        });
        expect(configValueToDraft(fields, { selection: ['1', 1] })).toEqual({
            selection: ['i:1', 'i:0'],
        });
        expect(() => configValueToDraft(fields, { selection: [1, 1] })).toThrow();
        expect(() => configValueToDraft(fields, { selection: ['1', '1'] })).toThrow();
        expect(() => configValueToDraft(fields, { selection: [true] })).toThrow();
    });

    it('admits frozen builder and decoded JSON schemas but rejects non-JSON outer arrays', () => {
        const builder = builderFixture();
        const schema = builder.combine(builder.multiSelect('selection', 'Selection', choices));
        const decoded = JSON.parse(JSON.stringify(schema)) as unknown[];
        expect(() => parseConfigFields(schema)).not.toThrow();
        expect(() => parseConfigFields(decoded)).not.toThrow();

        const malformed = malformedArrays(decoded[0]);
        const iterator = vi.fn(() => {
            throw new Error('custom schema iterator was invoked');
        });
        const customIterator = [decoded[0]];
        Object.defineProperty(customIterator, Symbol.iterator, { value: iterator });

        for (const fields of [...malformed.arrays, customIterator]) {
            expect(() => parseConfigFields(fields)).toThrow();
        }

        expect(malformed.getter).not.toHaveBeenCalled();
        expect(iterator).not.toHaveBeenCalled();
    });

    it('keeps a frozen multi-select snapshot when the source arrays and options change', () => {
        const builder = builderFixture();
        // Model the mutable ordinary objects produced by decoding the HTTP JSON response.
        const raw = JSON.parse(
            JSON.stringify(
                builder.combine(builder.multiSelect('selection', 'Selection', choices, [1, '1'])),
            ),
        ) as Array<{
            key: string;
            options: Array<{ label: string; value: string | number }>;
            default: (string | number)[];
        }>;
        const source = raw[0];
        const options = source.options;
        const declaredDefault = source.default;
        const fields = parseConfigFields(raw);
        expect(Object.isFrozen(fields[0].options)).toBe(true);
        expect(fields[0].options?.every((option) => Object.isFrozen(option))).toBe(true);
        expect(Object.isFrozen(fields[0].default)).toBe(true);

        const optionGetter = vi.fn(() => 'changed');
        const arrayGetter = vi.fn(() => ({ label: 'changed', value: 'changed' }));
        const defaultGetter = vi.fn(() => 'changed');
        const sourceKeyGetter = vi.fn(() => 'changed');
        const sourceOptionsGetter = vi.fn(() => options);
        const sourceDefaultGetter = vi.fn(() => declaredDefault);
        options.reverse();
        options[0].label = 'changed';
        Object.defineProperty(options[1], 'value', { enumerable: true, get: optionGetter });
        Object.defineProperty(options, '2', { enumerable: true, get: arrayGetter });
        declaredDefault.reverse();
        declaredDefault[0] = 'changed';
        Object.defineProperty(declaredDefault, '1', { enumerable: true, get: defaultGetter });
        source.key = 'changed';
        Object.defineProperty(source, 'key', { enumerable: true, get: sourceKeyGetter });
        Object.defineProperty(source, 'options', { enumerable: true, get: sourceOptionsGetter });
        Object.defineProperty(source, 'default', { enumerable: true, get: sourceDefaultGetter });

        expect(fields[0].key).toBe('selection');
        expect(fields[0].options).toEqual(choices);
        expect(fields[0].default).toEqual([1, '1']);
        const current = { selection: ['', '1', 1] };
        expect(parseConfigValue(fields, current)).toEqual(current);
        const draft = configValueToDraft(fields, current);
        expect(draft).toEqual({ selection: ['i:2', 'i:0', 'i:1'] });
        expect(configDraftToValue(fields, draft)).toEqual(current);
        expect(optionGetter).not.toHaveBeenCalled();
        expect(arrayGetter).not.toHaveBeenCalled();
        expect(defaultGetter).not.toHaveBeenCalled();
        expect(sourceKeyGetter).not.toHaveBeenCalled();
        expect(sourceOptionsGetter).not.toHaveBeenCalled();
        expect(sourceDefaultGetter).not.toHaveBeenCalled();
    });

    it('rejects duplicate exact option values while preserving typed equality', () => {
        expect(() => parseConfigFields([rawMulti(choices)])).not.toThrow();

        for (const value of ['', '1', 1, 0]) {
            expect(() =>
                parseConfigFields([
                    rawMulti([
                        { label: 'A', value },
                        { label: 'B', value },
                    ]),
                ]),
            ).toThrow();
        }

        for (const options of [
            [{ label: '', value: 1 }],
            [{ label: 'A', value: true }],
            [{ label: 'A' }],
            [{ label: 'A', value: 1, extra: true }],
            [{ label: 'A', value: -0 }],
            [{ label: 'A', value: Infinity }],
            [{ label: 'A', value: Number.MAX_SAFE_INTEGER + 1 }],
            'dynamic options',
            () => choices,
        ]) {
            expect(() => parseConfigFields([rawMulti(options)])).toThrow();
        }
    });

    it('preserves valid scalar boundaries and does not conflate negative zero with zero', () => {
        const longest = 'v'.repeat(16384);
        const fields = parseConfigFields([
            rawMulti([
                { label: 'zero', value: 0 },
                { label: 'fraction', value: 0.5 },
                { label: 'safe integer', value: Number.MAX_SAFE_INTEGER },
                { label: 'L'.repeat(256), value: longest },
            ]),
        ]);
        const selection = [longest, Number.MAX_SAFE_INTEGER, 0.5, 0];
        const draft = configValueToDraft(fields, { selection });
        expect(draft).toEqual({ selection: ['i:3', 'i:2', 'i:1', 'i:0'] });
        expect(configDraftToValue(fields, draft)).toEqual({ selection });
        expect(() => parseConfigValue(fields, { selection: [-0] })).toThrow();
        expect(() =>
            parseConfigFields([rawMulti([{ label: 'L', value: 'v'.repeat(16385) }])]),
        ).toThrow();
        expect(() =>
            parseConfigFields([rawMulti([{ label: 'L'.repeat(257), value: 'v' }])]),
        ).toThrow();
    });

    it('rejects unknown, duplicate, malformed and wrong-typed current values without a setter', () => {
        const fields = multiFields();
        const setter = vi.fn();
        const malformed = malformedArrays('1');
        const getter = vi.fn(() => ['1']);
        const getterRecord = Object.defineProperty({}, 'selection', {
            enumerable: true,
            get: getter,
        });
        const invalid = [
            {},
            { selection: [], extra: true },
            { selection: '1' },
            { selection: null },
            { selection: ['missing'] },
            { selection: ['1', '1'] },
            { selection: [1, 1] },
            { selection: [true] },
            { selection: [undefined] },
            { selection: [NaN] },
            { selection: [Infinity] },
            { selection: [-0] },
            { selection: [Number.MAX_SAFE_INTEGER + 1] },
            ...malformed.arrays.map((selection) => ({ selection })),
            getterRecord,
        ];

        for (const current of invalid) {
            expect(() => parseConfigValue(fields, current)).toThrow();
            expect(() => {
                const draft = configValueToDraft(fields, current);
                setter(configDraftToValue(fields, draft));
            }).toThrow();
        }

        expect(malformed.getter).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        expect(setter).not.toHaveBeenCalled();
    });

    it('rejects malformed, duplicate and out-of-bounds draft tokens before a setter', () => {
        const fields = multiFields();
        const setter = vi.fn();
        const malformed = malformedArrays('i:0');
        const draftGetter = vi.fn(() => ['i:0']);
        const getterRecord = Object.defineProperty({}, 'selection', {
            enumerable: true,
            get: draftGetter,
        });
        const invalid: unknown[] = [
            'i:0',
            null,
            [''],
            ['0'],
            ['i:'],
            ['i:-1'],
            ['i:+1'],
            ['i:00'],
            ['i:3'],
            ['i:1.0'],
            ['i:1x'],
            ['i:9007199254740993'],
            ['i:0\n'],
            ['i:1\r\n'],
            ['i:0\u2028'],
            ['i:0\u2029'],
            ['i:0', 'i:0'],
            ['i:2', 'i:1', 'i:2'],
            Array.from({ length: 257 }, () => 'i:0'),
            [0],
            [true],
            [null],
            ...malformed.arrays,
        ];

        for (const selection of invalid) {
            expect(() => setter(configDraftToValue(fields, asDraft({ selection })))).toThrow();
        }

        expect(() => configDraftToValue(fields, asDraft({}))).toThrow();
        expect(() => configDraftToValue(fields, asDraft({ selection: [], extra: true }))).toThrow();
        expect(() => configDraftToValue(fields, asDraft(getterRecord))).toThrow();
        expect(malformed.getter).not.toHaveBeenCalled();
        expect(draftGetter).not.toHaveBeenCalled();
        expect(setter).not.toHaveBeenCalled();
    });

    it('requires exact plain draft records without invoking scalar getters', () => {
        const builder = builderFixture();
        const fields = parseConfigFields(
            builder.combine(
                builder.multiSelect('selection', 'Selection', choices),
                builder.text('message', 'Message'),
                builder.number('count', 'Count'),
                builder.boolean('enabled', 'Enabled'),
                builder.select('single', 'Single', choices),
            ),
        );
        const valid = {
            selection: ['i:2', 'i:0'],
            message: '',
            count: '0',
            enabled: false,
            single: 'i:1',
        };
        const expected = { selection: ['', '1'], message: '', count: 0, enabled: false, single: 1 };
        const nullPrototype = Object.assign(Object.create(null), valid);
        expect(configDraftToValue(fields, nullPrototype)).toEqual(expected);
        expect(configValueToDraft(fields, Object.assign(Object.create(null), expected))).toEqual(
            valid,
        );

        const scalarGetter = vi.fn(() => 'should-not-run');
        const getterRecord = Object.defineProperty({ ...valid }, 'message', {
            enumerable: true,
            get: scalarGetter,
        });
        const currentGetter = vi.fn(() => 'should-not-run');
        const currentRecord = Object.defineProperty({ ...expected }, 'message', {
            enumerable: true,
            get: currentGetter,
        });
        const hiddenExtra = Object.defineProperty({ ...valid }, 'extra', {
            value: true,
            enumerable: false,
        });
        const symbolExtra = Object.defineProperty({ ...valid }, Symbol('extra'), { value: true });
        const nonEnumerableField = { ...valid };
        Object.defineProperty(nonEnumerableField, 'message', { value: '', enumerable: false });
        const customPrototype = Object.assign(Object.create({ inherited: true }), valid);

        for (const draft of [
            getterRecord,
            hiddenExtra,
            symbolExtra,
            nonEnumerableField,
            customPrototype,
            { ...valid, extra: true },
        ]) {
            expect(() => configDraftToValue(fields, asDraft(draft))).toThrow();
        }

        expect(() =>
            configDraftToValue(fields, null as unknown as Parameters<typeof configDraftToValue>[1]),
        ).toThrow();
        expect(() =>
            configDraftToValue(
                [fields[0], fields[0]],
                asDraft({ selection: [], extra: 'not a declared field' }),
            ),
        ).toThrow();
        expect(() => configValueToDraft(fields, currentRecord)).toThrow();
        expect(scalarGetter).not.toHaveBeenCalled();
        expect(currentGetter).not.toHaveBeenCalled();
    });

    it('treats default as metadata, never as a missing, empty or invalid current selection', () => {
        const fields = parseConfigFields(multiSchema(['outside-options', 1, 1]));
        expect(fields[0].default).toEqual(['outside-options', 1, 1]);
        expect(parseConfigValue(fields, { selection: [] })).toEqual({ selection: [] });
        expect(configValueToDraft(fields, { selection: [] })).toEqual({ selection: [] });
        expect(configDraftToValue(fields, asDraft({ selection: [] }))).toEqual({ selection: [] });

        const setter = vi.fn();

        for (const current of [{}, { selection: ['outside-options'] }, { selection: [1, 1] }]) {
            expect(() => parseConfigValue(fields, current)).toThrow();
            expect(() => {
                const draft = configValueToDraft(fields, current);
                setter(configDraftToValue(fields, draft));
            }).toThrow();
        }

        expect(() => configDraftToValue(fields, asDraft({}))).toThrow();
        expect(setter).not.toHaveBeenCalled();
    });

    it('rejects non-JSON array descriptors in options, defaults and values without running getters', () => {
        const badOptions = malformedArrays(choices[0]);
        const badDefaults = malformedArrays('1');
        const badValues = malformedArrays('1');
        const optionValueGetter = vi.fn(() => '1');
        const option = Object.defineProperty({ label: 'A' }, 'value', {
            enumerable: true,
            get: optionValueGetter,
        });
        const fields = multiFields();

        for (const options of badOptions.arrays) {
            expect(() => parseConfigFields([rawMulti(options)])).toThrow();
        }

        expect(() => parseConfigFields([rawMulti([option])])).toThrow();

        for (const defaultValue of [
            ...badDefaults.arrays,
            '1',
            [true],
            [undefined],
            [NaN],
            [Infinity],
            [-0],
            [Number.MAX_SAFE_INTEGER + 1],
            ['v'.repeat(16385)],
            Array.from({ length: 257 }, () => '1'),
        ]) {
            expect(() => parseConfigFields([{ ...rawMulti(), default: defaultValue }])).toThrow();
        }

        for (const selection of badValues.arrays) {
            expect(() => parseConfigValue(fields, { selection })).toThrow();
        }

        expect(badOptions.getter).not.toHaveBeenCalled();
        expect(badDefaults.getter).not.toHaveBeenCalled();
        expect(badValues.getter).not.toHaveBeenCalled();
        expect(optionValueGetter).not.toHaveBeenCalled();
    });

    it('accepts explicitly false static flags and rejects dynamic field semantics', () => {
        const base = rawMulti();
        expect(() =>
            parseConfigFields([{ ...base, reactive: false, hidden: false }]),
        ).not.toThrow();

        for (const extra of [
            { reactive: true },
            { hidden: true },
            { reactive: undefined },
            { hidden: undefined },
            { reactive: () => false },
            { hidden: () => false },
            { options: () => choices },
            { unknown: false },
        ]) {
            expect(() => parseConfigFields([{ ...base, ...extra }])).toThrow();
        }

        const getter = vi.fn(() => false);
        const dynamic = Object.defineProperty({ ...base }, 'hidden', {
            enumerable: true,
            get: getter,
        });
        expect(() => parseConfigFields([dynamic])).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it('updates selections in caller order through the actual pure toggle helper', () => {
        const [field] = multiFields();
        const existing = ['i:2', 'i:0'];
        const added = updateMultiSelectTokens(field, existing, 'i:1', true);
        expect(added).toEqual(['i:2', 'i:0', 'i:1']);
        expect(configDraftToValue([field], asDraft({ selection: added }))).toEqual({
            selection: ['', '1', 1],
        });
        expect(updateMultiSelectTokens(field, existing, 'i:2', false)).toEqual(['i:0']);
        expect(existing).toEqual(['i:2', 'i:0']);
        expect(updateMultiSelectTokens(field, [], 'i:0', false)).toEqual([]);
        expect(updateMultiSelectTokens(field, ['i:0'], 'i:0', true)).toEqual(['i:0']);
        expect(() => updateMultiSelectTokens(field, ['i:0', 'i:0'], 'i:1', true)).toThrow();
        expect(() => updateMultiSelectTokens(field, [], 'i:3', true)).toThrow();
    });

    it('applies consecutive opposite intents for the same token to the latest pure state', () => {
        const [field] = multiFields();
        const empty: string[] = [];
        const added = updateMultiSelectTokens(field, empty, 'i:0', true);
        const removed = updateMultiSelectTokens(field, added, 'i:0', false);
        expect(added).toEqual(['i:0']);
        expect(removed).toEqual([]);
        expect(empty).toEqual([]);

        const selected = ['i:0'];
        const unchecked = updateMultiSelectTokens(field, selected, 'i:0', false);
        const checkedAgain = updateMultiSelectTokens(field, unchecked, 'i:0', true);
        expect(unchecked).toEqual([]);
        expect(checkedAgain).toEqual(['i:0']);
        expect(selected).toEqual(['i:0']);
        // This models sequential pure helper calls, not React batching or DOM events.
    });

    it('composes pure multi-select and scalar draft updates in either order', () => {
        type PreviousDraft = Parameters<typeof applyConfigDraftField>[0];
        const [field] = multiFields();
        const originalTokens = ['i:2', 'i:0'];
        const original: NonNullable<PreviousDraft> = {
            selection: originalTokens,
            message: 'before',
            count: '0',
            enabled: false,
            single: 'i:0',
        };
        const snapshot = { ...original, selection: [...originalTokens] };

        const applyMulti = (previous: PreviousDraft): PreviousDraft => {
            if (previous === null) {
                return null;
            }

            return {
                ...previous,
                selection: updateMultiSelectTokens(field, previous.selection, 'i:1', true),
            };
        };

        const changes: Array<[string, string | boolean]> = [
            ['message', 'after'],
            ['count', '17'],
            ['enabled', true],
            ['single', 'i:1'],
        ];

        expect(applyMulti(null)).toBeNull();

        for (const [key, value] of changes) {
            const applyScalar = (previous: PreviousDraft) =>
                applyConfigDraftField(previous, key, value);
            const scalarFirst = applyScalar(original);
            const multiFirst = applyMulti(original);
            expect(applyScalar(null)).toBeNull();
            expect(scalarFirst).not.toBe(original);
            expect(scalarFirst?.selection).toBe(originalTokens);
            expect(multiFirst).not.toBe(original);
            expect(multiFirst?.selection).not.toBe(originalTokens);
            const expected = {
                ...snapshot,
                [key]: value,
                selection: ['i:2', 'i:0', 'i:1'],
            };
            expect(applyScalar(multiFirst)).toEqual(expected);
            expect(applyMulti(scalarFirst)).toEqual(expected);
            expect(original).toEqual(snapshot);
            expect(original.selection).toBe(originalTokens);
            expect(originalTokens).toEqual(['i:2', 'i:0']);
        }

        const applyAllScalars = (previous: PreviousDraft): PreviousDraft => {
            let current = previous;

            for (const [key, value] of changes) {
                current = applyConfigDraftField(current, key, value);
            }

            return current;
        };

        const allExpected = {
            selection: ['i:2', 'i:0', 'i:1'],
            message: 'after',
            count: '17',
            enabled: true,
            single: 'i:1',
        };
        expect(applyAllScalars(applyMulti(original))).toEqual(allExpected);
        expect(applyMulti(applyAllScalars(original))).toEqual(allExpected);
        expect(applyAllScalars(null)).toBeNull();
        expect(original).toEqual(snapshot);
        expect(original.selection).toBe(originalTokens);

        // Only synchronous pure-state composition is exercised, not React batching or DOM events.
    });

    it('statically renders the actual multi-select control with escaped labels', () => {
        const builder = builderFixture();
        const fields = parseConfigFields(
            builder.combine(
                builder.multiSelect('selection', 'Selection', [
                    { label: '<img src=x onerror=alert(1)>', value: '1' },
                    { label: 'number one', value: 1 },
                    { label: 'empty string', value: '' },
                ]),
            ),
        );
        const onChange = vi.fn();
        const html = renderToStaticMarkup(
            <PluginMultiSelectControl
                field={fields[0]}
                tokens={['i:2', 'i:0']}
                disabled={true}
                onChange={onChange}
            />,
        );
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
        const inputs = html.match(/<input\b[^>]*>/g) ?? [];
        expect(inputs).toHaveLength(3);
        expect(inputs.map((input) => input.includes('checked'))).toEqual([true, false, true]);
        expect(inputs.every((input) => input.includes('disabled'))).toBe(true);
        const invalidHtml = renderToStaticMarkup(
            <PluginMultiSelectControl
                field={fields[0]}
                tokens={['i:0', 'i:0']}
                disabled={false}
                onChange={onChange}
            />,
        );
        expect(invalidHtml).toContain('role="alert"');
        expect(invalidHtml).not.toContain('<input');
        expect(onChange).not.toHaveBeenCalled();
        // This is SSR only: it does not fire events or claim browser DOM behavior.
    });

    it('describes the three configuration confirmations without hiding draft replacement', () => {
        expect(configConfirmationText('schema')).toBe(
            '读取字段将清空当前未提交的配置；此操作可能执行插件代码，插件拥有当前进程完整权限。',
        );
        expect(configConfirmationText('read')).toBe(
            '读取将替换当前未提交的配置；此操作可能执行插件代码，插件拥有当前进程完整权限。',
        );
        expect(configConfirmationText('write')).toBe(
            '将整体提交当前配置，可能覆盖插件或后台的并发修改；持久化由插件决定。',
        );
    });

    it('keeps the synthetic plainText sidecar read-only and stale generations from the fake setter', () => {
        const builder = builderFixture();
        const schema = builder.combine(
            builder.multiSelect('selection', 'Selection', choices, ['1']),
            builder.plainText('<img src=x onerror=alert(1)>'),
        );
        const generation = '123e4567-e89b-42d3-a456-426614174000';
        const nextGeneration = '123e4567-e89b-42d3-a456-426614174001';
        const view = parseConfigView(schema, {
            version: 1,
            generation,
            source: 'schema',
            snapshot: schema,
            entries: [{ index: 1, kind: 'plainText' }],
        });
        expect(view.readOnly).toBe(true);
        expect(view.fields).toMatchObject([{ key: 'selection', type: 'multi-select' }]);
        expect(view.displayTexts).toEqual(['<img src=x onerror=alert(1)>']);
        const reordered = [
            builder.multiSelect(
                'selection',
                'Selection',
                [choices[1], choices[0], choices[2]],
                ['1'],
            ),
            schema[1],
        ];
        expect(() =>
            parseConfigView(schema, {
                version: 1,
                generation,
                source: 'schema',
                snapshot: reordered,
                entries: [{ index: 1, kind: 'plainText' }],
            }),
        ).toThrow();

        // Static SSR verifies text escaping, not user interaction or DOM changes.
        const html = renderToStaticMarkup(<PluginPlainTextView texts={view.displayTexts} />);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<button');
        expect(html).not.toContain('<input');

        const guard = createConfigModeGuard();
        const setter = vi.fn();
        const value = configDraftToValue(view.fields, asDraft({ selection: ['i:2', 'i:0'] }));
        const write = () => setter(value);
        guard.open('editable', generation);
        const old = guard.capture();
        expect(dispatchEditableConfigConfirmation(guard, old, nextGeneration, write)).toBe(false);
        guard.open('editable', nextGeneration);
        expect(dispatchEditableConfigConfirmation(guard, old, nextGeneration, write)).toBe(false);
        guard.open('display', generation);
        expect(dispatchEditableConfigConfirmation(guard, old, generation, write)).toBe(false);
        expect(dispatchEditableConfigConfirmation(guard, guard.capture(), generation, write)).toBe(
            false,
        );
        expect(setter).not.toHaveBeenCalled();
    });
});
