import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropdownSelect } from '../src/components/ui/dropdown-select';
import { createConfigBuilder } from '../../onebot/src/plugin-host/config-builder';
import type { JsonValue } from '../../onebot/src/types';
import {
    configDraftToValue,
    configValueToDraft,
    createConfigModeGuard,
    dispatchEditableConfigConfirmation,
} from '../src/components/settings/plugins-panel';
import { parseConfigFields, parseConfigValue, parseConfigView } from '../src/lib/plugin-index';

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

// Exercise the real data-only builder with a deliberately narrow in-memory copier.
// This does not exercise PluginHost, its production copier, or plugin lifecycle.
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

function schema() {
    const builder = builderFixture();
    return builder.combine(
        builder.select('choice', 'Choice', choices, '1', 'description', false),
        builder.text('message', 'Message', 'default'),
        builder.number('count', 'Count', 4),
        builder.boolean('enabled', 'Enabled', true),
    );
}

describe('static select: real config builder to WebUI (memory only)', () => {
    it('preserves number, string and empty-string option identities alongside scalar rows', () => {
        const source = schema();
        const fields = parseConfigFields(source);
        expect(fields[0]).toMatchObject({ type: 'select', options: choices });

        for (const choice of ['1', 1, ''] as const) {
            const current = { choice, message: '', count: 0, enabled: false };
            const parsed = parseConfigValue(fields, current);
            expect(parsed).toEqual(current);
            expect(typeof parsed.choice).toBe(typeof choice);
        }

        expect(source[0].default).toBe('1');
    });

    it('round-trips selected values through distinct index tokens without changing their types', () => {
        const fields = parseConfigFields(schema());

        for (const [index, choice] of (['1', 1, ''] as const).entries()) {
            const current = { choice, message: '', count: 0, enabled: false };
            const draft = configValueToDraft(fields, parseConfigValue(fields, current));
            expect(draft).toEqual({
                choice: `i:${index}`,
                message: '',
                count: '0',
                enabled: false,
            });
            const output = configDraftToValue(fields, draft);
            expect(output).toEqual(current);
            expect(typeof output.choice).toBe(typeof choice);
        }
    });

    it('rejects malformed, out-of-range and unknown option tokens before a write callback', () => {
        const fields = parseConfigFields(schema());
        const write = vi.fn();

        for (const token of [
            '',
            '1',
            'i:',
            'i:-1',
            'i:00',
            'i:3',
            'i:1.0',
            'i:1x',
            'i:99999999999999999',
            'i:0\n',
            'i:1\r\n',
            'i:0\u2028',
            'i:0\u2029',
        ]) {
            expect(() => {
                const value = configDraftToValue(fields, {
                    choice: token,
                    message: '',
                    count: '0',
                    enabled: false,
                });
                write(value);
            }).toThrow();
        }

        expect(write).not.toHaveBeenCalled();
    });

    it('keeps empty option values and rejects every current value when there are no options', () => {
        const builder = builderFixture();
        const fields = parseConfigFields(builder.combine(builder.select('x', 'X', choices)));
        expect(parseConfigValue(fields, { x: '' })).toEqual({ x: '' });

        // The builder accepts an empty options array; either schema admission or
        // current-value validation must leave no selectable current value.
        const empty = builder.combine(builder.select('x', 'X', []));

        for (const value of ['', 0, '1']) {
            expect(() => parseConfigValue(parseConfigFields(empty), { x: value })).toThrow();
        }
    });

    it('rejects missing, unknown, unmatched and same-text wrong-typed current values', () => {
        const fields = parseConfigFields(schema());

        for (const current of [
            { message: '', count: 0, enabled: false },
            { choice: '1', message: '', count: 0, enabled: false, extra: 1 },
            { choice: 2, message: '', count: 0, enabled: false },
            { choice: 'missing', message: '', count: 0, enabled: false },
            { choice: null, message: '', count: 0, enabled: false },
        ]) {
            expect(() => parseConfigValue(fields, current)).toThrow();
        }

        const builder = builderFixture();
        const stringOnly = parseConfigFields(
            builder.combine(builder.select('x', 'X', [{ label: 'String', value: '1' }])),
        );
        expect(() => parseConfigValue(stringOnly, { x: 1 })).toThrow();
        const numberOnly = parseConfigFields(
            builder.combine(builder.select('x', 'X', [{ label: 'Number', value: 1 }])),
        );
        expect(() => parseConfigValue(numberOnly, { x: '1' })).toThrow();
    });

    it('does not synthesize or submit default values for absent current values', () => {
        const fields = parseConfigFields(schema());
        const setter = vi.fn();
        expect(() => parseConfigValue(fields, { message: '', count: 0, enabled: false })).toThrow();
        expect(() => {
            const draft = configValueToDraft(fields, { message: '', count: 0, enabled: false });
            setter(configDraftToValue(fields, draft));
        }).toThrow();
        expect(() =>
            configDraftToValue(fields, { message: '', count: '0', enabled: false }),
        ).toThrow();
        expect(setter).not.toHaveBeenCalled();
    });

    it('rejects duplicate exact option values but accepts numeric and string one together', () => {
        const builder = builderFixture();

        for (const value of ['', '1', 1, 0]) {
            const duplicated = builder.combine(
                builder.select('x', 'X', [
                    { label: 'A', value },
                    { label: 'B', value },
                ]),
            );
            expect(() => parseConfigFields(duplicated)).toThrow();
        }

        expect(() => parseConfigFields(schema())).not.toThrow();
    });

    it('enforces finite safe numbers and rejects negative zero in options and current values', () => {
        const builder = builderFixture();

        for (const value of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, 0.5]) {
            const fields = parseConfigFields(
                builder.combine(builder.select('x', 'X', [{ label: 'N', value }])),
            );
            expect(parseConfigValue(fields, { x: value })).toEqual({ x: value });
        }

        for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, -0]) {
            const generated = builder.combine(builder.select('x', 'X', [{ label: 'N', value }]));
            expect(() => parseConfigFields(generated)).toThrow();
        }

        for (const value of [NaN, Infinity, -Infinity]) {
            expect(() =>
                parseConfigFields([
                    { key: 'x', label: 'X', type: 'select', options: [{ label: 'N', value }] },
                ]),
            ).toThrow();
        }

        const fields = parseConfigFields(builder.combine(builder.select('x', 'X', choices)));

        for (const value of [NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => parseConfigValue(fields, { x: value })).toThrow();
        }

        const zero = parseConfigFields(
            builder.combine(builder.select('x', 'X', [{ label: 'Zero', value: 0 }])),
        );
        expect(parseConfigValue(zero, { x: 0 })).toEqual({ x: 0 });
        expect(() => parseConfigValue(zero, { x: -0 })).toThrow();
    });

    it('rejects oversized and malformed options without changing nonselect compatibility', () => {
        const builder = builderFixture();
        const atLimit = builder.combine(
            builder.select(
                'x',
                'X',
                Array.from({ length: 256 }, (_, value) => ({ label: `L${value}`, value })),
            ),
        );
        expect(() => parseConfigFields(atLimit)).not.toThrow();
        expect(() =>
            builder.select(
                'x',
                'X',
                Array.from({ length: 257 }, (_, value) => ({ label: `L${value}`, value })),
            ),
        ).toThrow();
        expect(() => builder.select('x', 'X', [{ label: 'L'.repeat(257), value: 1 }])).toThrow();
        expect(() =>
            builder.select('x', 'X', [{ label: 'L', value: 'v'.repeat(16385) }]),
        ).toThrow();
        const optionField = (options: unknown) => [
            { key: 'x', label: 'X', type: 'select', options },
        ];
        expect(() =>
            parseConfigFields(optionField([{ label: 'L'.repeat(256), value: 'v'.repeat(16384) }])),
        ).not.toThrow();
        expect(() => parseConfigFields(optionField([{ label: '', value: 'v' }]))).toThrow();
        expect(() =>
            parseConfigFields(optionField([{ label: 'L'.repeat(257), value: 'v' }])),
        ).toThrow();
        expect(() =>
            parseConfigFields(optionField([{ label: 'L', value: 'v'.repeat(16385) }])),
        ).toThrow();
        expect(() =>
            parseConfigFields(
                optionField(
                    Array.from({ length: 257 }, (_, value) => ({ label: `L${value}`, value })),
                ),
            ),
        ).toThrow();

        for (const options of [
            [{ label: 'A', value: true }],
            [{ label: 'A' }],
            [{ label: 'A', value: 1, extra: true }],
            'invalid',
        ]) {
            expect(() =>
                parseConfigFields([{ key: 'x', label: 'X', type: 'select', options }]),
            ).toThrow();
        }

        const fields = parseConfigFields([
            { key: 'oldText', label: 'Text', type: 'text' },
            { key: 'n', label: 'Number', type: 'number' },
            { key: 'b', label: 'Boolean', type: 'boolean' },
        ]);
        expect(configDraftToValue(fields, { oldText: '', n: '0', b: false })).toEqual({
            oldText: '',
            n: 0,
            b: false,
        });
    });

    it('admits an out-of-options default as data without using it for a missing or unmatched current value', () => {
        const builder = builderFixture();
        const generated = builder.combine(builder.select('x', 'X', choices, 'not-a-choice'));
        const fields = parseConfigFields(generated);
        expect(fields[0]).toHaveProperty('default', 'not-a-choice');
        expect(() => parseConfigValue(fields, {})).toThrow();
        expect(() => parseConfigValue(fields, { x: 'not-a-choice' })).toThrow();
    });

    it('escapes the selected option label in the shared dropdown SSR trigger', () => {
        const builder = builderFixture();
        const fields = parseConfigFields(
            builder.combine(
                builder.select('x', 'X', [
                    { label: '<img src=x onerror=alert(1)>', value: '1' },
                    { label: 'Number', value: 1 },
                ]),
            ),
        );
        const draft = configValueToDraft(fields, { x: '1' });
        // These are the actual DropdownSelect props used by the editor. This is
        // a shared-control SSR check, not a rendered editor or a DOM interaction.
        const html = renderToStaticMarkup(
            <DropdownSelect
                ariaLabel={fields[0].label}
                value={String(draft.x)}
                options={(fields[0].options ?? []).map((option, index) => ({
                    label: option.label,
                    value: `i:${index}`,
                }))}
                onChange={() => undefined}
            />,
        );
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
    });

    it('keeps select values behind generation binding and plainText read-only mode', () => {
        const builder = builderFixture();
        const fields = builder.combine(
            builder.select('choice', 'Choice', choices),
            builder.plainText('information'),
        );
        const generation = '123e4567-e89b-42d3-a456-426614174000';
        // Synthetic sidecar deliberately models the public envelope; no PluginHost is invoked.
        const view = parseConfigView(fields, {
            version: 1,
            generation,
            source: 'schema',
            snapshot: fields,
            entries: [{ index: 1, kind: 'plainText' }],
        });
        expect(view.readOnly).toBe(true);
        expect(view.fields).toMatchObject([{ key: 'choice', type: 'select' }]);
        expect(view.displayTexts).toEqual(['information']);
        const mode = createConfigModeGuard();
        const write = vi.fn();
        mode.open('editable', generation);
        const old = mode.capture();
        expect(
            dispatchEditableConfigConfirmation(
                mode,
                old,
                '123e4567-e89b-42d3-a456-426614174001',
                write,
            ),
        ).toBe(false);
        mode.open('display', generation);
        expect(dispatchEditableConfigConfirmation(mode, old, generation, write)).toBe(false);
        expect(dispatchEditableConfigConfirmation(mode, mode.capture(), generation, write)).toBe(
            false,
        );
        expect(write).not.toHaveBeenCalled();
    });

    it('rejects reactive, hidden and unknown select semantics', () => {
        const builder = builderFixture();
        const base = builder.select('x', 'X', choices);

        for (const extra of [{ reactive: true }, { hidden: true }, { unknown: true }]) {
            expect(() => parseConfigFields([{ ...base, ...extra }])).toThrow();
        }

        expect(() =>
            parseConfigFields([{ ...base, reactive: false, hidden: false }]),
        ).not.toThrow();
    });
});
