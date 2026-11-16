import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createConfigBuilder,
    type PluginConfigItem,
} from '../../onebot/src/plugin-host/config-builder';
import type { JsonValue } from '../../onebot/src/types';
import {
    configDraftToValue,
    configValueToDraft,
    PluginConfigPlaceholderHint,
    PluginConfigTextControl,
    PluginMultiSelectControl,
    PluginPlainTextView,
} from '../src/components/settings/plugins-panel';
import { DropdownSelect } from '../src/components/ui/dropdown-select';
import type { PluginDisplaySidecar } from '../src/lib/api/types';
import {
    parseConfigEnvelope,
    parseConfigFields,
    parseConfigValue,
    parseConfigView,
} from '../src/lib/plugin-index';

// Block transports even while imports initialize; these tests never create a host,
// execute a plugin, or construct an account, route, listener, or socket.
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
    try {
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.WebSocket).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
});

const generation = '123e4567-e89b-42d3-a456-426614174000';
const nextGeneration = '123e4567-e89b-42d3-a456-426614174001';
const dangerous = '<img src=x onerror="alert(1)"> & \'quoted\' <script>alert(2)</script>';
const options = [
    { label: 'string one', value: '1' },
    { label: 'number one', value: 1 },
    { label: 'empty', value: '' },
];

// Only trusted, ordinary synthetic data is passed through this copier. It is not
// the production host copier or a Proxy detector; it must never see accessor fixtures.
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
    });
}

function declarations(): PluginConfigItem[] {
    return [
        {
            key: 'message',
            label: 'Message',
            type: 'string',
            default: 'declared',
            placeholder: dangerous,
        },
        { key: 'notes', label: 'Notes', type: 'text', default: 'declared text', placeholder: '' },
        { key: 'count', label: 'Count', type: 'number', default: 37, placeholder: '42' },
        {
            key: 'enabled',
            label: 'Enabled',
            type: 'boolean',
            default: true,
            placeholder: 'boolean hint',
        },
        {
            key: 'choice',
            label: 'Choice',
            type: 'select',
            options,
            default: '1',
            placeholder: 'select hint',
        },
        {
            key: 'selection',
            label: 'Selection',
            type: 'multi-select',
            options,
            default: [1, '1'],
            placeholder: 'multi hint',
        },
    ];
}

function schema() {
    return builderFixture().builder.combine(...declarations());
}

function mutableSchema(): Array<Record<string, unknown>> {
    return JSON.parse(JSON.stringify(schema())) as Array<Record<string, unknown>>;
}

interface FakeEnvelope {
    status: 'ok';
    processResources: 'unknown';
    source: 'schema' | 'ui';
    generation: string;
    fields: Array<Record<string, unknown>>;
    displaySidecar: PluginDisplaySidecar;
}

function sidecarFixture(source: FakeEnvelope['source'] = 'schema'): FakeEnvelope {
    const { builder, getDisplayKind } = builderFixture();
    const fields = declarations();
    const combined = builder.combine(
        builder.plainText('before'),
        ...fields.slice(0, 2),
        builder.plainText('between'),
        ...fields.slice(2),
        builder.plainText('after'),
    );
    const entries = combined.flatMap((field, index) =>
        getDisplayKind(field) === 'plainText' ? [{ index, kind: 'plainText' as const }] : [],
    );
    return JSON.parse(
        JSON.stringify({
            status: 'ok',
            processResources: 'unknown',
            source,
            generation,
            fields: combined,
            displaySidecar: {
                version: 1,
                generation,
                source,
                snapshot: combined,
                entries: entries.reverse(),
            },
        }),
    ) as FakeEnvelope;
}

function parseWire(wire: FakeEnvelope) {
    const decoded = parseConfigEnvelope(wire, 'schema') as {
        fields: unknown;
        displaySidecar: PluginDisplaySidecar;
        generation: string;
    };
    return parseConfigView(decoded.fields, decoded.displaySidecar);
}

function escapeHtml(value: string) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#x27;');
}

function visibleHtmlText(html: string) {
    return html.replace(/<[^>]*>/g, '');
}

function fieldSection(visible: string, label: string) {
    const start = visible.indexOf(`字段名称：${escapeHtml(label)}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = visible.indexOf('字段名称：', start + 1);
    return visible.slice(start, next < 0 ? undefined : next);
}

describe('static plugin placeholders (synthetic data only)', () => {
    it('accepts handmade builder.combine declarations and mutable decoded JSON for all six types', () => {
        const built = schema();
        const wire = mutableSchema();
        const before = structuredClone(wire);
        expect(Object.isFrozen(built)).toBe(true);
        expect(built.every(Object.isFrozen)).toBe(true);
        expect(Object.isFrozen(wire)).toBe(false);
        expect(wire.every((field) => !Object.isFrozen(field))).toBe(true);
        expect(parseConfigFields(built)).toEqual(declarations());
        expect(parseConfigFields(wire)).toEqual(declarations());
        expect(wire).toEqual(before);

        const [multi] = parseConfigFields([wire[5]]);
        expect(Object.isFrozen(multi)).toBe(true);
        expect(Object.isFrozen(multi.options)).toBe(true);
        expect(multi.options?.every(Object.isFrozen)).toBe(true);
        expect(Object.isFrozen(multi.default)).toBe(true);
    });

    it('preserves absent versus explicitly empty hints for every type and older schemas', () => {
        for (const field of declarations()) {
            const absent = { ...field };
            delete absent.placeholder;
            const empty = { ...field, placeholder: '' };
            const [oldField, emptyField] = parseConfigFields([
                absent,
                { ...empty, key: `${field.key}-empty` },
            ]);
            expect(Object.hasOwn(oldField, 'placeholder')).toBe(false);
            expect(Object.hasOwn(emptyField, 'placeholder')).toBe(true);
            expect(emptyField.placeholder).toBe('');
            expect(Object.hasOwn(oldField, 'default')).toBe(true);
        }

        const old = [
            { key: 'message', label: 'Message', type: 'string' },
            { key: 'enabled', label: 'Enabled', type: 'boolean' },
        ];
        const view = parseConfigView(old);
        expect(view.readOnly).toBe(false);
        expect(view.fields).toEqual(old);
        expect(view.readonlyRows).toBeUndefined();
        expect(
            configDraftToValue(
                view.fields,
                configValueToDraft(view.fields, {
                    message: '',
                    enabled: false,
                }),
            ),
        ).toEqual({ message: '', enabled: false });
    });

    it('round-trips ready current values without substituting hints or declared defaults', () => {
        const source = mutableSchema();
        const sourceBefore = structuredClone(source);
        const fields = parseConfigFields(source);
        const current = {
            message: '',
            notes: 'actual text',
            count: 0,
            enabled: false,
            choice: 1,
            selection: ['', '1'],
        };
        const currentBefore = structuredClone(current);
        const parsed = parseConfigValue(fields, current);
        const draft = configValueToDraft(fields, parsed);
        expect(draft).toEqual({
            message: '',
            notes: 'actual text',
            count: '0',
            enabled: false,
            choice: 'i:1',
            selection: ['i:2', 'i:0'],
        });
        expect(configDraftToValue(fields, draft)).toEqual(current);
        expect(current).toEqual(currentBefore);
        expect(source).toEqual(sourceBefore);
        expect(Object.hasOwn(parsed, 'placeholder')).toBe(false);

        const setter = vi.fn();

        for (const invalid of [
            { notes: '', count: 0, enabled: false, choice: '1', selection: [] },
            { ...current, placeholder: 'metadata is not a value' },
        ]) {
            expect(() =>
                setter(configDraftToValue(fields, configValueToDraft(fields, invalid))),
            ).toThrow();
        }

        expect(setter).not.toHaveBeenCalled();
    });

    it('allows an actual configuration key named placeholder without confusing it with metadata', () => {
        const field: PluginConfigItem = {
            key: 'placeholder',
            label: 'Real key',
            type: 'string',
            default: 'declared default',
            placeholder: 'only a hint',
        };
        const fields = parseConfigFields(builderFixture().builder.combine(field));
        expect(parseConfigValue(fields, { placeholder: '' })).toEqual({ placeholder: '' });
        expect(
            configDraftToValue(fields, configValueToDraft(fields, { placeholder: 'actual' })),
        ).toEqual({
            placeholder: 'actual',
        });
        expect(() => parseConfigValue(fields, {})).toThrow();
    });

    it('counts the 1024 limit as UTF-16 code units, not Unicode code points', () => {
        const valid = ['a'.repeat(1024), '😀'.repeat(512), `${'a'.repeat(1022)}😀`, ''];
        const invalid = [
            'a'.repeat(1025),
            '😀'.repeat(513),
            `${'😀'.repeat(512)}a`,
            `${'a'.repeat(1023)}😀`,
        ];
        expect('😀'.length).toBe(2);

        for (const original of declarations()) {
            for (const placeholder of valid) {
                const field = { ...original, placeholder };
                expect(parseConfigFields([field])[0].placeholder).toBe(placeholder);
                expect(
                    parseConfigFields(builderFixture().builder.combine(field))[0].placeholder,
                ).toBe(placeholder);
            }

            for (const placeholder of invalid) {
                const field = { ...original, placeholder };
                expect(() => parseConfigFields([field])).toThrow();
                expect(() => builderFixture().builder.combine(field)).toThrow();
            }
        }
    });

    it('rejects explicit non-string placeholders, including undefined, without interpreting them', () => {
        const invalid: unknown[] = [null, undefined, 0, 1, false, {}, [], () => 'hint'];

        for (const original of declarations()) {
            for (const placeholder of invalid) {
                expect(() => parseConfigFields([{ ...original, placeholder }])).toThrow();
            }
        }

        // Only inert synthetic JSON-compatible values go through the fake copier.
        for (const placeholder of [null, 0, false, {}, []]) {
            const field = { ...declarations()[0], placeholder } as unknown as PluginConfigItem;
            expect(() => builderFixture().builder.combine(field)).toThrow();
        }
    });

    it('rejects accessor and non-enumerable placeholder properties without running the getter', () => {
        for (const original of declarations()) {
            const getter = vi.fn(() => 'must not run');
            const accessor = { ...original };
            Object.defineProperty(accessor, 'placeholder', {
                enumerable: true,
                configurable: true,
                get: getter,
            });
            const hidden = { ...original };
            Object.defineProperty(hidden, 'placeholder', { value: 'hint', enumerable: false });
            expect(() => parseConfigFields([accessor])).toThrow();
            expect(() => parseConfigFields([hidden])).toThrow();
            expect(getter).not.toHaveBeenCalled();
        }
    });

    it('observes rejecting reflective Proxy traps without claiming that proxies are detectable', () => {
        const trap = vi.fn(() => {
            throw new Error('fixture ownKeys trap');
        });
        const proxied = new Proxy({ ...declarations()[0] }, { ownKeys: trap });
        expect(() => parseConfigFields([proxied])).toThrow();
        expect(trap).toHaveBeenCalled();
        const arrayTrap = vi.fn(() => {
            throw new Error('fixture array reflection trap');
        });
        const proxiedArray = new Proxy([declarations()[0]], { getPrototypeOf: arrayTrap });
        expect(() => parseConfigFields(proxiedArray)).toThrow();
        expect(arrayTrap).toHaveBeenCalled();
        // Reflection can invoke Proxy traps; this checks only these throwing traps.
    });

    it('ignores an inherited placeholder without invoking its getter', () => {
        const getter = vi.fn(() => 'inherited hint');
        const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'placeholder');
        Object.defineProperty(Object.prototype, 'placeholder', { configurable: true, get: getter });
        let hasOwnHint: boolean | undefined;
        let current: unknown;

        try {
            const raw = [{ key: 'message', label: 'Message', type: 'string' }];
            const [field] = parseConfigFields(raw);
            hasOwnHint = Object.hasOwn(field, 'placeholder');
            current = parseConfigValue([field], { message: '' });
        } finally {
            if (previous) {
                Object.defineProperty(Object.prototype, 'placeholder', previous);
            } else {
                delete (Object.prototype as { placeholder?: unknown }).placeholder;
            }
        }

        expect(hasOwnHint).toBe(false);
        expect(current).toEqual({ message: '' });
        expect(getter).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'copies own placeholders without invoking inherited accessors (setter present: %s)',
        (withSetter) => {
            // Prepare ordinary synthetic inputs before temporarily polluting the prototype.
            // No React rendering or expectations run until the original descriptor is restored.
            const raw = mutableSchema();
            const wire = sidecarFixture();
            const expected = declarations();
            const getter = vi.fn(() => 'inherited getter');
            const setter = vi.fn();
            const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'placeholder');
            const descriptor: PropertyDescriptor = { configurable: true, get: getter };

            if (withSetter) {
                descriptor.set = setter;
            }

            let fields: ReturnType<typeof parseConfigFields> | undefined;
            let view: ReturnType<typeof parseWire> | undefined;
            Object.defineProperty(Object.prototype, 'placeholder', descriptor);

            try {
                fields = parseConfigFields(raw);
                view = parseWire(wire);
            } finally {
                if (previous) {
                    Object.defineProperty(Object.prototype, 'placeholder', previous);
                } else {
                    delete (Object.prototype as { placeholder?: unknown }).placeholder;
                }
            }

            expect(getter).not.toHaveBeenCalled();
            expect(setter).not.toHaveBeenCalled();

            if (!fields || !view?.readonlyRows) {
                throw new Error('missing parsed schema or readonly rows');
            }

            const multi = fields[5];
            expect(multi.type).toBe('multi-select');
            expect(Object.getOwnPropertyDescriptor(multi, 'placeholder')).toMatchObject({
                value: 'multi hint',
                enumerable: true,
                writable: false,
                configurable: false,
            });
            expect(Object.isFrozen(multi)).toBe(true);
            expect(Object.isFrozen(multi.options)).toBe(true);
            expect(Object.isFrozen(multi.default)).toBe(true);
            expect(view.displayTexts).toEqual(['before', 'between', 'after']);
            expect(Object.isFrozen(view.readonlyRows)).toBe(true);

            let index = 0;

            for (const row of view.readonlyRows) {
                expect(Object.isFrozen(row)).toBe(true);

                if (row.kind === 'field') {
                    expect(row.field.key).toBe(expected[index].key);
                    expect(Object.isFrozen(row.field)).toBe(true);
                    expect(Object.getOwnPropertyDescriptor(row.field, 'placeholder')).toMatchObject(
                        {
                            value: expected[index].placeholder,
                            enumerable: true,
                            writable: false,
                            configurable: false,
                        },
                    );
                    index++;
                }
            }

            expect(index).toBe(6);
        },
    );

    it.each(['schema', 'ui'] as const)(
        'preserves ordered readonly declarations for %s and freezes an independent snapshot',
        (source) => {
            const wire = sidecarFixture(source);
            const view = parseWire(wire);
            const rows = view.readonlyRows;

            if (!rows) {
                throw new Error('missing readonly rows');
            }

            expect(view.readOnly).toBe(true);
            expect(view.displayTexts).toEqual(['before', 'between', 'after']);
            expect(
                rows.map((row) =>
                    row.kind === 'plainText' ? `text:${row.text}` : `field:${row.field.key}`,
                ),
            ).toEqual([
                'text:before',
                'field:message',
                'field:notes',
                'text:between',
                'field:count',
                'field:enabled',
                'field:choice',
                'field:selection',
                'text:after',
            ]);
            expect(Object.isFrozen(rows)).toBe(true);
            expect(rows.every(Object.isFrozen)).toBe(true);
            const frozenBefore = structuredClone(rows);

            for (const row of rows) {
                if (row.kind === 'field') {
                    expect(Object.isFrozen(row.field)).toBe(true);

                    if (row.field.options) {
                        expect(Object.isFrozen(row.field.options)).toBe(true);
                        expect(row.field.options.every(Object.isFrozen)).toBe(true);
                    }

                    if (Array.isArray(row.field.default)) {
                        expect(Object.isFrozen(row.field.default)).toBe(true);
                    }
                }
            }

            const message = wire.fields[1];
            const multi = wire.fields[7];
            const hintGetter = vi.fn(() => 'poisoned hint');
            const optionsGetter = vi.fn(() => []);
            Object.defineProperty(message, 'placeholder', {
                enumerable: true,
                configurable: true,
                get: hintGetter,
            });
            Object.defineProperty(multi, 'placeholder', {
                enumerable: true,
                configurable: true,
                get: hintGetter,
            });
            Object.defineProperty(multi, 'options', {
                enumerable: true,
                configurable: true,
                get: optionsGetter,
            });
            expect(rows).toEqual(frozenBefore);
            const html = renderToStaticMarkup(
                <PluginPlainTextView texts={view.displayTexts} rows={rows} />,
            );
            const visible = visibleHtmlText(html);

            for (const field of declarations()) {
                const section = fieldSection(visible, field.label);
                const placeholder = field.placeholder;

                if (typeof placeholder !== 'string') {
                    throw new Error('fixture placeholder is missing');
                }

                expect(section).toContain(`提示：${escapeHtml(JSON.stringify(placeholder))}`);
            }

            expect(fieldSection(visible, 'Notes')).toContain('提示：&quot;&quot;');
            expect(html).not.toContain('<img');
            expect(html).not.toContain('<script');
            expect(html).not.toMatch(/<(?:input|textarea|select|button|form)\b/i);
            expect(hintGetter).not.toHaveBeenCalled();
            expect(optionsGetter).not.toHaveBeenCalled();
        },
    );

    it('distinguishes missing and empty placeholder metadata in readonly SSR', () => {
        const wire = sidecarFixture();
        delete wire.fields[4].placeholder;
        wire.displaySidecar.snapshot = structuredClone(wire.fields);
        const view = parseWire(wire);
        const html = renderToStaticMarkup(
            <PluginPlainTextView texts={view.displayTexts} rows={view.readonlyRows} />,
        );
        const visible = visibleHtmlText(html);
        expect(fieldSection(visible, 'Notes')).toContain('提示：&quot;&quot;');
        expect(fieldSection(visible, 'Count')).not.toContain('提示：');
        expect(fieldSection(visible, 'Enabled')).toContain('提示：&quot;boolean hint&quot;');
    });

    it('rejects corrupted generation, source, and placeholder-bearing snapshots', () => {
        for (const mutate of [
            (wire: FakeEnvelope) => {
                wire.displaySidecar.generation = nextGeneration;
            },
            (wire: FakeEnvelope) => {
                wire.displaySidecar.source = 'ui';
            },
            (wire: FakeEnvelope) => {
                (wire.displaySidecar.snapshot[1] as Record<string, unknown>).placeholder =
                    'changed';
            },
            (wire: FakeEnvelope) => {
                delete (wire.displaySidecar.snapshot[1] as Record<string, unknown>).placeholder;
            },
            (wire: FakeEnvelope) => {
                wire.fields[1].placeholder = 'changed';
            },
            (wire: FakeEnvelope) => {
                wire.displaySidecar.snapshot.reverse();
            },
        ]) {
            const wire = sidecarFixture();
            mutate(wire);
            expect(() => parseWire(wire)).toThrow();
        }

        const wire = sidecarFixture();
        wire.generation = 'not-a-generation';
        expect(() => parseWire(wire)).toThrow();
        const read = {
            status: 'ok',
            processResources: 'unknown',
            generation,
            source: 'plugin',
            value: { message: 'actual' },
        };
        expect(() => parseConfigEnvelope(read, 'read', nextGeneration)).toThrow();
        expect(parseConfigEnvelope(read, 'read', generation)).toEqual({
            source: 'plugin',
            value: { message: 'actual' },
            generation,
        });
    });

    it('rejects placeholder accessors in either side of a readonly snapshot without running them', () => {
        for (const target of ['fields', 'snapshot'] as const) {
            const wire = sidecarFixture();
            const getter = vi.fn(() => 'getter must not run');
            const fields = target === 'fields' ? wire.fields : wire.displaySidecar.snapshot;
            Object.defineProperty(fields[1] as object, 'placeholder', {
                enumerable: true,
                configurable: true,
                get: getter,
            });
            expect(() => parseWire(wire)).toThrow();
            expect(getter).not.toHaveBeenCalled();
        }
    });

    it('rejects placeholder on a marked plainText item even when both snapshots match', () => {
        const wire = sidecarFixture();
        wire.fields[0].placeholder = 'extra field';
        wire.displaySidecar.snapshot = structuredClone(wire.fields);
        expect(() => parseWire(wire)).toThrow();
    });

    it('keeps html, reactive, hidden and dynamic semantics rejected with a placeholder', () => {
        const base = declarations()[0];

        for (const extra of [
            { type: 'html' },
            { reactive: true },
            { hidden: true },
            { reactive: () => false },
            { hidden: () => false },
            { placeholder: () => 'dynamic' },
        ]) {
            expect(() => parseConfigFields([{ ...base, ...extra }])).toThrow();
        }

        expect(() =>
            parseConfigFields([{ ...base, reactive: false, hidden: false }]),
        ).not.toThrow();
    });
});

describe('placeholder presentation in exported production controls (SSR only)', () => {
    it('passes escaped native placeholder attributes to string, number and textarea controls', () => {
        const raw = declarations()
            .slice(0, 3)
            .map((field) => ({ ...field, placeholder: dangerous }));
        const fields = parseConfigFields(raw);
        const onChange = vi.fn();
        const values = ['current & "quoted"', 'body & <text>', '0'];

        for (let index = 0; index < fields.length; index++) {
            const html = renderToStaticMarkup(
                <PluginConfigTextControl
                    field={fields[index]}
                    value={values[index]}
                    disabled={false}
                    onChange={onChange}
                />,
            );
            const tag = html.match(/<(?:input|textarea)\b[^>]*>/)?.[0];
            expect(tag).toBeDefined();
            expect(tag).toContain(`placeholder="${escapeHtml(dangerous)}"`);
            expect(html).not.toContain('<img');
            expect(html).not.toContain('<script');

            if (fields[index].type === 'text') {
                expect(tag).toMatch(/^<textarea\b/);
                expect(html).toContain(`>${escapeHtml(values[index])}</textarea>`);
            } else {
                expect(tag).toMatch(/^<input\b/);
                expect(tag).toContain(`value="${escapeHtml(values[index])}"`);

                if (fields[index].type === 'number') {
                    expect(tag).toMatch(/inputmode="decimal"/i);
                }
            }
        }

        const emptyHint = parseConfigFields([{ ...declarations()[0], placeholder: '' }])[0];
        const noHint = { ...declarations()[0] };
        delete noHint.placeholder;
        const absent = parseConfigFields([noHint])[0];
        const emptyHtml = renderToStaticMarkup(
            <PluginConfigTextControl
                field={emptyHint}
                value=""
                disabled={true}
                onChange={onChange}
            />,
        );
        const absentHtml = renderToStaticMarkup(
            <PluginConfigTextControl
                field={absent}
                value=""
                disabled={false}
                onChange={onChange}
            />,
        );
        expect(emptyHtml).toContain('placeholder=""');
        expect(emptyHtml).toMatch(/\bdisabled(?:="")?/);
        expect(absentHtml).not.toContain(' placeholder=');
        expect(onChange).not.toHaveBeenCalled();
        // SSR asserts markup only; browser visibility when a value is nonempty is not inferred.
    });

    it('renders selectable and checkbox hints as escaped static JSON text, not configuration values', () => {
        const raw = declarations();
        raw[3].placeholder = dangerous;
        raw[4].placeholder = dangerous;
        raw[5].placeholder = dangerous;
        raw[4].options = [
            { label: dangerous, value: '1' },
            { label: 'number', value: 1 },
        ];
        raw[5].options = [
            { label: dangerous, value: '1' },
            { label: 'number', value: 1 },
        ];
        const fields = parseConfigFields(raw);
        const onChange = vi.fn();
        const html = renderToStaticMarkup(
            <>
                <PluginConfigPlaceholderHint placeholder={fields[3].placeholder} />
                <PluginConfigPlaceholderHint placeholder={fields[4].placeholder} />
                <DropdownSelect
                    ariaLabel={fields[4].label}
                    value="i:0"
                    options={(fields[4].options ?? []).map((option, index) => ({
                        label: option.label,
                        value: `i:${index}`,
                    }))}
                    onChange={onChange}
                />
                <PluginConfigPlaceholderHint placeholder={fields[5].placeholder} />
                <PluginMultiSelectControl
                    field={fields[5]}
                    tokens={['i:1']}
                    disabled={false}
                    onChange={onChange}
                />
            </>,
        );
        const visible = visibleHtmlText(html);
        expect(visible.split(escapeHtml(JSON.stringify(dangerous)))).toHaveLength(4);
        expect(visible).toContain(escapeHtml(dangerous));
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script');
        const checkboxes = html.match(/<input\b[^>]*>/g) ?? [];
        expect(checkboxes).toHaveLength(2);
        expect(checkboxes.map((input) => input.includes('checked'))).toEqual([false, true]);
        expect(checkboxes.every((input) => !input.includes(' placeholder='))).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
        expect(renderToStaticMarkup(<PluginConfigPlaceholderHint />)).toBe('');
        expect(
            visibleHtmlText(renderToStaticMarkup(<PluginConfigPlaceholderHint placeholder="" />)),
        ).toContain('提示：&quot;&quot;');
        // This combines real exported controls, but does not mount the dialog or fire events.
    });

    it('does not invoke a placeholder getter installed after editable-field parsing', () => {
        const raw = mutableSchema();
        const [field] = parseConfigFields(raw);
        const getter = vi.fn(() => 'poisoned hint');
        Object.defineProperty(raw[0], 'placeholder', {
            enumerable: true,
            configurable: true,
            get: getter,
        });
        const onChange = vi.fn();
        const html = renderToStaticMarkup(
            <PluginConfigTextControl
                field={field}
                value="current"
                disabled={false}
                onChange={onChange}
            />,
        );
        expect(html).not.toContain(' placeholder=');
        expect(getter).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does not render an inherited placeholder as a native attribute', () => {
        const [field] = parseConfigFields([{ key: 'message', label: 'Message', type: 'string' }]);
        const onChange = vi.fn();
        const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'placeholder');
        Object.defineProperty(Object.prototype, 'placeholder', {
            configurable: true,
            writable: true,
            value: 'INHERITED_HINT_MUST_NOT_RENDER',
        });
        let html: string;

        try {
            html = renderToStaticMarkup(
                <PluginConfigTextControl
                    field={field}
                    value=""
                    disabled={false}
                    onChange={onChange}
                />,
            );
        } finally {
            if (previous) {
                Object.defineProperty(Object.prototype, 'placeholder', previous);
            } else {
                delete (Object.prototype as { placeholder?: unknown }).placeholder;
            }
        }

        expect(html).not.toContain('INHERITED_HINT_MUST_NOT_RENDER');
        expect(html).not.toContain(' placeholder=');
        expect(onChange).not.toHaveBeenCalled();
    });
});
