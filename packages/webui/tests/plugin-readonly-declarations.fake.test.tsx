import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigBuilder } from '../../onebot/src/plugin-host/config-builder';
import type { JsonValue } from '../../onebot/src/types';
import {
    configTicketAfterClose,
    createConfigModeGuard,
    createConfigTicketGuard,
    dispatchConfigTicket,
    dispatchEditableConfigConfirmation,
    PluginPlainTextView,
} from '../src/components/settings/plugins-panel';
import type { PluginConfigField, PluginDisplaySidecar } from '../src/lib/api/types';
import {
    parseConfigEnvelope,
    parseConfigView,
    type PluginConfigReadOnlyRow,
} from '../src/lib/plugin-index';

// Block transports even during module initialization. No plugin host, account,
// route, listener, socket, or configuration service is constructed here.
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
        // A thrown transport call must not accidentally satisfy a rejection test.
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.WebSocket).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
});

const generation = '123e4567-e89b-42d3-a456-426614174000';
const nextGeneration = '123e4567-e89b-42d3-a456-426614174001';
const dangerousText = '<img src=x onerror="alert(1)"><style>body{display:none}</style>&';
const dangerousDescription = 'Description <iframe src="javascript:alert(1)"></iframe> & text';
const dangerousOption = '<svg onload="alert(1)">option</svg>';
const texts = [
    dangerousText,
    'divider after boolean',
    'divider after number',
    'divider after select',
    'tail text',
];
const options = [
    { label: 'string one', value: '1' },
    { label: 'number one', value: 1 },
    { label: 'empty string', value: '' },
    { label: dangerousOption, value: '<option-value>' },
];

// This copier is used only for synthetic data made in this file. It is not the
// production host copier and does not execute or inspect a plugin.
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

const expectedFields: PluginConfigField[] = [
    {
        key: 'enabled',
        label: 'Enabled label',
        type: 'boolean',
        description: 'Enabled description',
        default: false,
        reactive: false,
        hidden: false,
    },
    {
        key: 'message<key>',
        label: 'Message label',
        type: 'string',
        description: dangerousDescription,
        default: '',
        reactive: false,
    },
    {
        key: 'longText',
        label: 'Long text label',
        type: 'text',
        description: 'Long text description',
        default: 'declared text',
        reactive: false,
    },
    {
        key: 'count',
        label: 'Count label',
        type: 'number',
        description: 'Count description',
        default: 0,
        reactive: false,
    },
    {
        key: 'numberChoice',
        label: 'Number choice label',
        type: 'select',
        description: 'Number choice description',
        default: 1,
        options,
        reactive: false,
    },
    {
        key: 'stringChoice',
        label: 'String choice label',
        type: 'select',
        description: 'String choice description',
        default: '1',
        options,
        reactive: false,
    },
    {
        key: 'multiple',
        label: 'Multiple choice label',
        type: 'multi-select',
        description: 'Multiple choice description',
        default: [1, '1', ''],
        options,
        reactive: false,
    },
];

const expectedRows: PluginConfigReadOnlyRow[] = [
    { kind: 'plainText', text: texts[0] },
    { kind: 'field', field: expectedFields[0] },
    { kind: 'plainText', text: texts[1] },
    { kind: 'field', field: expectedFields[1] },
    { kind: 'field', field: expectedFields[2] },
    { kind: 'field', field: expectedFields[3] },
    { kind: 'plainText', text: texts[2] },
    { kind: 'field', field: expectedFields[4] },
    { kind: 'plainText', text: texts[3] },
    { kind: 'field', field: expectedFields[5] },
    { kind: 'field', field: expectedFields[6] },
    { kind: 'plainText', text: texts[4] },
];

interface FakeEnvelope {
    status: 'ok';
    processResources: 'unknown';
    source: 'schema' | 'ui';
    generation: string;
    fields: Array<Record<string, unknown>>;
    displaySidecar: PluginDisplaySidecar;
}

function fixture(source: FakeEnvelope['source'] = 'schema') {
    const { builder, getDisplayKind } = builderFixture();
    const schema = builder.combine(
        builder.plainText(texts[0]),
        {
            ...builder.boolean('enabled', 'Enabled label', false, 'Enabled description', false),
            hidden: false,
        },
        builder.plainText(texts[1]),
        builder.text('message<key>', 'Message label', '', dangerousDescription, false),
        {
            key: 'longText',
            label: 'Long text label',
            type: 'text',
            description: 'Long text description',
            default: 'declared text',
            reactive: false,
        },
        builder.number('count', 'Count label', 0, 'Count description', false),
        builder.plainText(texts[2]),
        builder.select(
            'numberChoice',
            'Number choice label',
            options,
            1,
            'Number choice description',
            false,
        ),
        builder.plainText(texts[3]),
        builder.select(
            'stringChoice',
            'String choice label',
            options,
            '1',
            'String choice description',
            false,
        ),
        builder.multiSelect(
            'multiple',
            'Multiple choice label',
            options,
            [1, '1', ''],
            'Multiple choice description',
            false,
        ),
        builder.plainText(texts[4]),
    );
    // The builder's origin markers produce the synthetic sidecar before its
    // JSON serialization. Reverse entries to prove source order wins over marker order.
    const entries = schema.flatMap((field, index) =>
        getDisplayKind(field) === 'plainText' ? [{ index, kind: 'plainText' as const }] : [],
    );
    const wire = JSON.parse(
        JSON.stringify({
            status: 'ok',
            processResources: 'unknown',
            source,
            generation,
            fields: schema,
            displaySidecar: {
                version: 1,
                generation,
                source,
                snapshot: schema,
                entries: [...entries].reverse(),
            },
        }),
    ) as FakeEnvelope;
    return { schema, entries, wire };
}

function parseWire(wire: FakeEnvelope) {
    // The response decoder itself performs the sidecar generation/source check.
    const decoded = parseConfigEnvelope(wire, 'schema') as {
        fields: unknown[];
        displaySidecar: PluginDisplaySidecar;
        generation: string;
    };
    return { decoded, view: parseConfigView(decoded.fields, decoded.displaySidecar) };
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#x27;');
}

function visibleHtmlText(html: string): string {
    // All fixture markup is escaped by React. Removing actual tags also removes
    // React's optional text-node comments without decoding the escaped payload.
    return html.replace(/<[^>]*>/g, '');
}

function fieldSection(visible: string, field: PluginConfigField): string {
    const start = visible.indexOf(`字段名称：${escapeHtml(field.label)}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = visible.indexOf('字段名称：', start + 1);
    return visible.slice(start, next < 0 ? undefined : next);
}

function expectNoEditableMarkup(html: string) {
    expect(html).not.toMatch(/<(?:input|textarea|select|option|button|form|a|details|summary)\b/i);
    expect(html).not.toMatch(/<(?:img|svg|iframe|script|style)\b/i);
    expect(html).not.toMatch(/<[^>]+\s+on[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:contenteditable|tabindex)\s*=/i);
}

function parseUnknownSidecar(fields: unknown, sidecar: unknown) {
    // Invalid fixtures deliberately cross the decoded-data boundary.
    return parseConfigView(fields, sidecar as PluginDisplaySidecar);
}

describe('read-only mixed declarations from synthetic sidecars', () => {
    it.each(['schema', 'ui'] as const)(
        'retains every declaration and source order for a decoded %s response without mutating input',
        (source) => {
            const { schema, entries, wire } = fixture(source);
            const frozenBefore = structuredClone(schema);
            const wireBefore = structuredClone(wire);
            expect(Object.isFrozen(schema)).toBe(true);
            expect(Object.isFrozen(wire.fields)).toBe(false);
            expect(wire.fields).not.toBe(wire.displaySidecar.snapshot);
            expect(entries.map((entry) => entry.index)).toEqual([0, 2, 6, 8, 11]);
            expect(wire.displaySidecar.entries.map((entry) => entry.index)).toEqual([
                11, 8, 6, 2, 0,
            ]);
            expect(wire.displaySidecar.snapshot).toEqual(wire.fields);

            const { decoded, view } = parseWire(wire);
            expect(decoded.generation).toBe(generation);
            expect(view.readOnly).toBe(true);
            expect(view.fields).toEqual(expectedFields);
            expect(view.displayTexts).toEqual(texts);
            expect(view.readonlyRows).toEqual(expectedRows);
            expect(view.fields[0].default).toBe(false);
            expect(view.fields[1].default).toBe('');
            expect(view.fields[3].default).toBe(0);
            expect(view.fields[4].default).toBe(1);
            expect(view.fields[5].default).toBe('1');
            expect(view.fields[6].default).toEqual([1, '1', '']);
            expect(typeof view.fields[4].options?.[0].value).toBe('string');
            expect(typeof view.fields[4].options?.[1].value).toBe('number');
            expect(schema).toEqual(frozenBefore);
            expect(wire).toEqual(wireBefore);
        },
    );

    it('renders ordered metadata with escaped payloads and no edit controls or I/O', () => {
        const { schema, wire } = fixture();
        const schemaBefore = structuredClone(schema);
        const wireBefore = structuredClone(wire);
        const { view } = parseWire(wire);
        const html = renderToStaticMarkup(
            <PluginPlainTextView texts={view.displayTexts} rows={view.readonlyRows} />,
        );
        const visible = visibleHtmlText(html);
        const anchors = expectedRows.map((row) =>
            row.kind === 'plainText'
                ? escapeHtml(row.text)
                : `字段名称：${escapeHtml(row.field.label)}`,
        );
        let previous = -1;

        for (const anchor of anchors) {
            const position = visible.indexOf(anchor, previous + 1);
            expect(position, `missing or out-of-order row: ${anchor}`).toBeGreaterThan(previous);
            previous = position;
        }

        for (const field of expectedFields) {
            const section = fieldSection(visible, field);
            expect(section).toContain(`配置键：${escapeHtml(field.key)}`);
            expect(section).toContain(`字段类型：${field.type}`);
            expect(section).toContain(`描述：${escapeHtml(field.description ?? '')}`);
            const declaredDefault = JSON.stringify(field.default);
            expect(declaredDefault).toBeDefined();
            expect(section).toContain(`声明的默认值：${escapeHtml(declaredDefault ?? '')}`);

            if (field.options) {
                let optionPosition = -1;

                for (const option of field.options) {
                    const declaration =
                        `${escapeHtml(option.label)}（值：` +
                        `${escapeHtml(JSON.stringify(option.value))}）`;
                    const position = section.indexOf(declaration, optionPosition + 1);
                    expect(
                        position,
                        `missing or out-of-order option: ${option.label}`,
                    ).toBeGreaterThan(optionPosition);
                    optionPosition = position;
                }
            }
        }

        expect(fieldSection(visible, expectedFields[0])).toContain('声明的默认值：false');
        expect(fieldSection(visible, expectedFields[1])).toContain('声明的默认值：&quot;&quot;');
        expect(fieldSection(visible, expectedFields[3])).toContain('声明的默认值：0');
        expect(fieldSection(visible, expectedFields[4])).toContain('声明的默认值：1');
        expect(fieldSection(visible, expectedFields[5])).toContain('声明的默认值：&quot;1&quot;');
        expect(fieldSection(visible, expectedFields[6])).toContain(
            '声明的默认值：[1,&quot;1&quot;,&quot;&quot;]',
        );
        expect(visible).toContain(escapeHtml(dangerousText));
        expect(visible).toContain(escapeHtml(dangerousDescription));
        expect(visible).toContain(escapeHtml(dangerousOption));
        expect(visible).toContain(escapeHtml('message<key>'));
        expect(visible).toContain(escapeHtml(JSON.stringify('<option-value>')));
        expect(visible).toContain('并非当前配置');

        for (const text of texts) {
            expect(visible.split(escapeHtml(text))).toHaveLength(2);
        }

        expectNoEditableMarkup(html);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.WebSocket).not.toHaveBeenCalled();
        expect(schema).toEqual(schemaBefore);
        expect(wire).toEqual(wireBefore);
        // SSR does not fire browser events or establish live dialog behavior.
    });

    it('keeps parsed readonly field metadata independent of later source mutation and accessors', () => {
        const { wire } = fixture();
        const { view } = parseWire(wire);
        const rows = view.readonlyRows;
        expect(rows).toEqual(expectedRows);

        if (!rows) {
            throw new Error('missing readonly rows');
        }

        expect(Object.isFrozen(rows)).toBe(true);
        expect(rows.every((row) => Object.isFrozen(row))).toBe(true);
        const selectRow = rows.find(
            (row) => row.kind === 'field' && row.field.key === 'numberChoice',
        );
        expect(selectRow?.kind).toBe('field');

        if (selectRow?.kind !== 'field') {
            throw new Error('missing select declaration');
        }

        expect(selectRow.field).not.toBe(wire.fields[7]);
        expect(selectRow.field.options).not.toBe(wire.fields[7].options);

        for (const row of rows) {
            if (row.kind === 'field') {
                expect(Object.isFrozen(row.field)).toBe(true);

                if (row.field.options) {
                    expect(Object.isFrozen(row.field.options)).toBe(true);
                    expect(row.field.options.every((option) => Object.isFrozen(option))).toBe(true);
                }

                if (Array.isArray(row.field.default)) {
                    expect(Object.isFrozen(row.field.default)).toBe(true);
                }
            }
        }

        const scalarDefaultGetter = vi.fn(() => 'source getter ran');
        const optionValueGetter = vi.fn(() => 'source getter ran');
        const optionElementGetter = vi.fn();
        const optionsGetter = vi.fn();
        const sourceBoolean = wire.fields[1];
        const sourceString = wire.fields[3];
        const sourceSelect = wire.fields[7];
        const sourceOptions = sourceSelect.options as Array<{
            label: string;
            value: string | number;
        }>;
        sourceBoolean.label = 'mutated boolean label';
        sourceBoolean.default = true;
        sourceString.label = 'mutated string label';
        Object.defineProperty(sourceString, 'default', {
            enumerable: true,
            configurable: true,
            get: scalarDefaultGetter,
        });
        sourceSelect.label = 'mutated select label';
        sourceSelect.default = '1';
        sourceOptions.reverse();
        sourceOptions[0].label = 'mutated option label';
        const poisonedOption = sourceOptions[1];
        Object.defineProperty(poisonedOption, 'value', {
            enumerable: true,
            configurable: true,
            get: optionValueGetter,
        });
        optionElementGetter.mockReturnValue(poisonedOption);
        Object.defineProperty(sourceOptions, '1', {
            enumerable: true,
            configurable: true,
            get: optionElementGetter,
        });
        optionsGetter.mockReturnValue(sourceOptions);
        Object.defineProperty(sourceSelect, 'options', {
            enumerable: true,
            configurable: true,
            get: optionsGetter,
        });

        // The legacy fields array may retain its prior reference behavior. Only
        // readonlyRows is the detached declaration snapshot under test.
        expect(rows).toEqual(expectedRows);
        const html = renderToStaticMarkup(
            <PluginPlainTextView texts={view.displayTexts} rows={rows} />,
        );
        const visible = visibleHtmlText(html);
        expect(fieldSection(visible, expectedFields[0])).toContain('声明的默认值：false');
        expect(fieldSection(visible, expectedFields[1])).toContain('声明的默认值：&quot;&quot;');
        expect(fieldSection(visible, expectedFields[4])).toContain('声明的默认值：1');
        expect(fieldSection(visible, expectedFields[4])).toContain('string one');
        expect(visible).not.toContain('mutated');
        expect(scalarDefaultGetter).not.toHaveBeenCalled();
        expect(optionValueGetter).not.toHaveBeenCalled();
        expect(optionElementGetter).not.toHaveBeenCalled();
        expect(optionsGetter).not.toHaveBeenCalled();
        expectNoEditableMarkup(html);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.WebSocket).not.toHaveBeenCalled();
    });

    it('does not invent default metadata when a declaration omits it', () => {
        const { wire } = fixture();
        delete wire.fields[3].default;
        delete wire.fields[10].default;
        wire.displaySidecar.snapshot = structuredClone(wire.fields);
        const { view } = parseWire(wire);
        const html = renderToStaticMarkup(
            <PluginPlainTextView texts={view.displayTexts} rows={view.readonlyRows} />,
        );
        const visible = visibleHtmlText(html);
        expect(fieldSection(visible, expectedFields[1])).not.toContain('声明的默认值：');
        expect(fieldSection(visible, expectedFields[6])).not.toContain('声明的默认值：');
        expect(fieldSection(visible, expectedFields[0])).toContain('声明的默认值：false');
        expect(fieldSection(visible, expectedFields[3])).toContain('声明的默认值：0');
        expectNoEditableMarkup(html);
    });

    it('keeps read and write tickets and stale generations away from fake I/O', () => {
        const { view } = parseWire(fixture().wire);
        const guard = createConfigModeGuard();
        const tickets = createConfigTicketGuard();
        const getConfig = vi.fn();
        const setConfig = vi.fn();
        const positiveControl = vi.fn();

        guard.open('editable', generation);
        const previous = guard.capture();
        expect(
            dispatchEditableConfigConfirmation(guard, previous, generation, positiveControl),
        ).toBe(true);
        const oldWrite = tickets.issue('write', previous, guard.revision());
        guard.open(view.readOnly ? 'display' : 'editable', generation);
        expect(guard.capture()).toBeNull();
        expect(dispatchEditableConfigConfirmation(guard, previous, generation, setConfig)).toBe(
            false,
        );
        expect(
            dispatchEditableConfigConfirmation(guard, guard.capture(), generation, setConfig),
        ).toBe(false);
        expect(dispatchConfigTicket(tickets, guard, oldWrite, 'write', generation, setConfig)).toBe(
            false,
        );
        const read = tickets.issue('read', guard.capture(), guard.revision());
        expect(dispatchConfigTicket(tickets, guard, read, 'read', generation, getConfig)).toBe(
            false,
        );
        const write = tickets.issue('write', guard.capture(), guard.revision());
        expect(dispatchConfigTicket(tickets, guard, write, 'write', generation, setConfig)).toBe(
            false,
        );

        guard.open('editable', nextGeneration);
        const current = guard.capture();
        expect(dispatchEditableConfigConfirmation(guard, previous, nextGeneration, setConfig)).toBe(
            false,
        );
        expect(dispatchEditableConfigConfirmation(guard, current, generation, setConfig)).toBe(
            false,
        );
        expect(
            dispatchConfigTicket(tickets, guard, write, 'write', nextGeneration, setConfig),
        ).toBe(false);
        expect(positiveControl).toHaveBeenCalledOnce();
        expect(getConfig).not.toHaveBeenCalled();
        expect(setConfig).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.WebSocket).not.toHaveBeenCalled();
    });

    it('closes only the captured confirmation state without disturbing a newer ticket', () => {
        const mode = createConfigModeGuard();
        const tickets = createConfigTicketGuard();
        const getConfig = vi.fn();
        const setConfig = vi.fn();
        mode.open('editable', generation);
        const binding = mode.capture();

        const invalidated = tickets.issue('write', binding, mode.revision());
        tickets.invalidate();
        expect(tickets.close(invalidated)).toBe(false);
        expect(configTicketAfterClose(invalidated, invalidated)).toBeNull();
        expect(
            dispatchConfigTicket(tickets, mode, invalidated, 'write', generation, setConfig),
        ).toBe(false);

        const older = tickets.issue('write', binding, mode.revision());
        const newer = tickets.issue('read', binding, mode.revision());
        expect(tickets.close(older)).toBe(false);
        expect(configTicketAfterClose(newer, older)).toBe(newer);
        expect(tickets.isCurrent(newer, 'read')).toBe(true);

        expect(tickets.close(newer)).toBe(true);
        expect(configTicketAfterClose(newer, newer)).toBeNull();
        expect(dispatchConfigTicket(tickets, mode, newer, 'read', generation, getConfig)).toBe(
            false,
        );
        const currentWrite = tickets.issue('write', binding, mode.revision());
        expect(tickets.close(currentWrite)).toBe(true);
        expect(configTicketAfterClose(currentWrite, currentWrite)).toBeNull();
        expect(
            dispatchConfigTicket(tickets, mode, currentWrite, 'write', generation, setConfig),
        ).toBe(false);
        expect(getConfig).not.toHaveBeenCalled();
        expect(setConfig).not.toHaveBeenCalled();
        // This exercises synchronous ticket and state helpers, not DOM events.
    });

    it('rejects malformed markers and sidecar envelopes before producing a view', () => {
        const { wire } = fixture();
        const sidecar = wire.displaySidecar;
        const marker = sidecar.entries[0];
        const badSidecars: Array<[string, unknown]> = [
            ['null', null],
            ['unknown version', { ...sidecar, version: 2 }],
            [
                'missing version',
                {
                    generation,
                    source: 'schema',
                    snapshot: sidecar.snapshot,
                    entries: sidecar.entries,
                },
            ],
            ['invalid generation', { ...sidecar, generation: 'invalid' }],
            ['invalid source', { ...sidecar, source: 'none' }],
            ['extra property', { ...sidecar, extra: true }],
            ['no markers', { ...sidecar, entries: [] }],
            ['unmarked plainText', { ...sidecar, entries: sidecar.entries.slice(1) }],
            ['duplicate marker', { ...sidecar, entries: [...sidecar.entries, marker] }],
            ['negative index', { ...sidecar, entries: [{ index: -1, kind: 'plainText' }] }],
            ['fractional index', { ...sidecar, entries: [{ index: 0.5, kind: 'plainText' }] }],
            [
                'out of range index',
                { ...sidecar, entries: [{ index: wire.fields.length, kind: 'plainText' }] },
            ],
            ['unknown marker kind', { ...sidecar, entries: [{ index: 0, kind: 'html' }] }],
            [
                'extra marker property',
                { ...sidecar, entries: [{ index: 0, kind: 'plainText', extra: true }] },
            ],
            [
                'marker points to a field',
                { ...sidecar, entries: [...sidecar.entries, { index: 1, kind: 'plainText' }] },
            ],
        ];

        for (const [name, candidate] of badSidecars) {
            expect(() => parseUnknownSidecar(wire.fields, candidate), name).toThrow();
        }

        for (const candidate of [
            { ...sidecar, generation: nextGeneration },
            { ...sidecar, source: 'ui' },
        ]) {
            expect(() =>
                parseConfigEnvelope({ ...wire, displaySidecar: candidate }, 'schema'),
            ).toThrow();
        }

        const getter = vi.fn(() => 1);
        const accessor = Object.defineProperty({ ...sidecar }, 'version', {
            enumerable: true,
            get: getter,
        });
        expect(() => parseUnknownSidecar(wire.fields, accessor)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it('rejects changed full snapshots, including nested option and default metadata', () => {
        const changes: Array<[string, (snapshot: Array<Record<string, unknown>>) => void]> = [
            [
                'display text',
                (snapshot) => {
                    snapshot[0].default = 'changed text';
                },
            ],
            [
                'field label',
                (snapshot) => {
                    snapshot[1].label = 'changed label';
                },
            ],
            [
                'field key',
                (snapshot) => {
                    snapshot[3].key = 'different';
                },
            ],
            [
                'false default',
                (snapshot) => {
                    snapshot[1].default = true;
                },
            ],
            [
                'zero default',
                (snapshot) => {
                    snapshot[5].default = 1;
                },
            ],
            [
                'string versus number default',
                (snapshot) => {
                    snapshot[7].default = '1';
                },
            ],
            [
                'option label',
                (snapshot) => {
                    (snapshot[7].options as Array<{ label: string }>)[0].label = 'changed';
                },
            ],
            [
                'option value type',
                (snapshot) => {
                    (snapshot[7].options as Array<{ value: unknown }>)[0].value = 1;
                },
            ],
            [
                'multi-select default order',
                (snapshot) => {
                    (snapshot[10].default as unknown[]).reverse();
                },
            ],
            [
                'field order',
                (snapshot) => {
                    [snapshot[1], snapshot[3]] = [snapshot[3], snapshot[1]];
                },
            ],
            [
                'missing final field',
                (snapshot) => {
                    snapshot.pop();
                },
            ],
        ];

        for (const [name, change] of changes) {
            const { wire } = fixture();
            const snapshot = wire.displaySidecar.snapshot as Array<Record<string, unknown>>;
            change(snapshot);
            expect(() => parseWire(wire), name).toThrow();
        }

        const { wire } = fixture();
        wire.fields[1].default = true;
        expect(() => parseWire(wire)).toThrow();
    });

    it('rejects dynamic, hidden, duplicate and falsely marked fields even when snapshots match', () => {
        const changes: Array<
            [
                string,
                (fields: Array<Record<string, unknown>>, sidecar: PluginDisplaySidecar) => void,
            ]
        > = [
            [
                'reactive field',
                (fields) => {
                    fields[1].reactive = true;
                },
            ],
            [
                'hidden field',
                (fields) => {
                    fields[3].hidden = true;
                },
            ],
            [
                'dynamic options',
                (fields) => {
                    fields[7].options = () => options;
                },
            ],
            [
                'unknown field property',
                (fields) => {
                    fields[5].unknown = false;
                },
            ],
            [
                'duplicate field key',
                (fields) => {
                    fields[3].key = fields[1].key;
                },
            ],
            [
                'duplicate marked/plain key',
                (fields) => {
                    fields[0].key = fields[1].key;
                },
            ],
            [
                'duplicate option value',
                (fields) => {
                    (fields[7].options as Array<{ value: unknown }>)[1].value = '1';
                },
            ],
            [
                'plain marker with html type',
                (fields) => {
                    fields[0].type = 'html';
                },
            ],
            [
                'plain marker with a label',
                (fields) => {
                    fields[0].label = 'not plainText';
                },
            ],
            [
                'plain marker with hidden flag',
                (fields) => {
                    fields[0].hidden = false;
                },
            ],
            [
                'plain marker without default',
                (fields) => {
                    delete fields[0].default;
                },
            ],
            [
                'ordinary field falsely marked',
                (_fields, sidecar) => {
                    sidecar.entries.push({ index: 3, kind: 'plainText' });
                },
            ],
        ];

        for (const [name, change] of changes) {
            const { wire } = fixture();
            change(wire.fields, wire.displaySidecar);

            // Functions are intentionally non-JSON and cannot be structured-cloned.
            // The two sides share this one invalid value, so rejection also covers
            // the snapshot comparator rather than relying on a content mismatch.
            if (name === 'dynamic options') {
                const snapshot = wire.displaySidecar.snapshot as Array<Record<string, unknown>>;
                snapshot[7].options = wire.fields[7].options;
            } else {
                wire.displaySidecar.snapshot = structuredClone(wire.fields);
            }

            expect(() => parseUnknownSidecar(wire.fields, wire.displaySidecar), name).toThrow();
        }

        const { wire } = fixture();
        const getter = vi.fn(() => false);
        Object.defineProperty(wire.fields[1], 'hidden', { enumerable: true, get: getter });
        expect(() => parseUnknownSidecar(wire.fields, wire.displaySidecar)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it('renders a pure plainText sidecar identically to the legacy texts-only view', () => {
        const { builder, getDisplayKind } = builderFixture();
        const plainSchema = builder.combine(
            builder.plainText('first plain text'),
            builder.plainText(dangerousText),
            builder.plainText(''),
        );
        const entries = plainSchema.flatMap((field, index) =>
            getDisplayKind(field) === 'plainText' ? [{ index, kind: 'plainText' as const }] : [],
        );
        const wire = JSON.parse(
            JSON.stringify({
                status: 'ok',
                processResources: 'unknown',
                generation,
                source: 'schema',
                fields: plainSchema,
                displaySidecar: {
                    version: 1,
                    generation,
                    source: 'schema',
                    snapshot: plainSchema,
                    entries,
                },
            }),
        ) as FakeEnvelope;
        const before = structuredClone(wire);
        const { view } = parseWire(wire);
        expect(view.readOnly).toBe(true);
        expect(view.fields).toEqual([]);
        expect(view.displayTexts).toEqual(['first plain text', dangerousText, '']);
        expect(view.readonlyRows).toEqual([
            { kind: 'plainText', text: 'first plain text' },
            { kind: 'plainText', text: dangerousText },
            { kind: 'plainText', text: '' },
        ]);
        const withRows = renderToStaticMarkup(
            <PluginPlainTextView texts={view.displayTexts} rows={view.readonlyRows} />,
        );
        const oldTextsOnly = renderToStaticMarkup(
            <PluginPlainTextView texts={view.displayTexts} />,
        );
        expect(withRows).toBe(oldTextsOnly);
        expectNoEditableMarkup(withRows);
        expect(wire).toEqual(before);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.WebSocket).not.toHaveBeenCalled();
    });

    it('preserves ordinary schemas and the existing texts-only SSR contract', () => {
        const { builder } = builderFixture();
        const schema = JSON.parse(
            JSON.stringify(builder.combine(builder.boolean('enabled', 'Enabled', false))),
        ) as unknown[];
        const before = structuredClone(schema);
        const legacy = parseConfigView(schema);
        expect(legacy.readOnly).toBe(false);
        expect(legacy.fields).toEqual([
            { key: 'enabled', label: 'Enabled', type: 'boolean', default: false },
        ]);
        expect(legacy.displayTexts).toEqual([]);
        expect(legacy.readonlyRows).toBeUndefined();
        expect(schema).toEqual(before);

        const legacyTexts = ['first plain text', dangerousText, 'last plain text'];
        const html = renderToStaticMarkup(<PluginPlainTextView texts={legacyTexts} />);
        const explicitUndefined = renderToStaticMarkup(
            <PluginPlainTextView texts={legacyTexts} rows={undefined} />,
        );
        const visible = visibleHtmlText(html);
        expect(html).toBe(explicitUndefined);
        expect(html.match(/<p\b/g)).toHaveLength(legacyTexts.length + 1);
        expect(visible.indexOf('first plain text')).toBeLessThan(
            visible.indexOf(escapeHtml(dangerousText)),
        );
        expect(visible.indexOf(escapeHtml(dangerousText))).toBeLessThan(
            visible.indexOf('last plain text'),
        );
        expect(visible).toContain('配置未读取');
        expectNoEditableMarkup(html);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(globalThis.WebSocket).not.toHaveBeenCalled();
    });
});
