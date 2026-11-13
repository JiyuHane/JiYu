import { afterEach, describe, expect, it, vi } from 'vitest';
import * as selectedModule from '../../src/direct/target-qr12-selected';
import * as nodeModule from '../../src/direct/target-wt-login-node';
import type { TargetQr12Selected } from '../../src/direct/target-qr12-selected';

// Synthetic connection of two statically observed local nodes only. Native tag
// factories, other fields, the actual WT login tree, signatures, server behavior
// and authentication remain unverified. No traffic or account data is used.
const header = '00034100421122334400010203040506070899aabbcc';

function clearSelected(value: TargetQr12Selected | undefined): void {
    if (!value) {
        return;
    }

    for (const field of [
        value.field18,
        value.field19,
        value.field1e,
        value.field65,
        value.field3f,
    ]) {
        if (field.kind === 'present') {
            field.bytes.fill(0);
        }
    }
}

afterEach(() => vi.restoreAllMocks());

describe('synthetic QR12 selected fields to WT login nodes', () => {
    it('routes distinct last raw 19 and 65 values through the real node encoders', () => {
        const input = Buffer.from(
            header + '000500190001aa00650002beef7777000200010019000300ff80006500048000feff',
            'hex',
        );
        const before = Buffer.from(input);
        let selected: TargetQr12Selected | undefined;
        let node016a: Uint8Array | undefined;
        let node0318: Uint8Array | undefined;

        try {
            const selectedSpy = vi.spyOn(selectedModule, 'extractTargetQr12Selected');
            const firstSpy = vi.spyOn(nodeModule, 'encodeTargetWtLoginNode016a');
            const secondSpy = vi.spyOn(nodeModule, 'encodeTargetWtLoginNode0318');
            selected = selectedModule.extractTargetQr12Selected(input);
            expect(selected.field19).toEqual({
                kind: 'present',
                bytes: Uint8Array.of(0, 0xff, 0x80),
            });
            expect(selected.field65).toEqual({
                kind: 'present',
                bytes: Uint8Array.of(0x80, 0, 0xfe, 0xff),
            });

            if (selected.field19.kind !== 'present' || selected.field65.kind !== 'present') {
                throw new Error('missing selected synthetic field');
            }

            node016a = nodeModule.encodeTargetWtLoginNode016a(selected.field19.bytes);
            node0318 = nodeModule.encodeTargetWtLoginNode0318(selected.field65.bytes);
            expect(node016a).toEqual(Uint8Array.of(0x01, 0x6a, 0, 3, 0, 0xff, 0x80));
            expect(node0318).toEqual(Uint8Array.of(0x03, 0x18, 0, 4, 0x80, 0, 0xfe, 0xff));
            expect(selectedSpy).toHaveBeenCalledOnce();
            expect(firstSpy).toHaveBeenCalledOnce();
            expect(secondSpy).toHaveBeenCalledOnce();
            expect(input).toEqual(before);
            expect(
                new Set([
                    input.buffer,
                    selected.field19.bytes.buffer,
                    selected.field65.bytes.buffer,
                    node016a.buffer,
                    node0318.buffer,
                ]).size,
            ).toBe(5);
            node016a[4] = 0x55;
            expect(selected.field19.bytes).toEqual(Uint8Array.of(0, 0xff, 0x80));
            expect(node0318).toEqual(Uint8Array.of(3, 0x18, 0, 4, 0x80, 0, 0xfe, 0xff));
            expect(input).toEqual(before);
            selected.field65.bytes.fill(0);
            expect(node0318).toEqual(Uint8Array.of(3, 0x18, 0, 4, 0x80, 0, 0xfe, 0xff));
            input.fill(0);
            expect(node016a).toEqual(Uint8Array.of(1, 0x6a, 0, 3, 0x55, 0xff, 0x80));
        } finally {
            clearSelected(selected);
            node016a?.fill(0);
            node0318?.fill(0);
            input.fill(0);
            before.fill(0);
        }
    });

    it('encodes last empty occurrences as present four-byte nodes', () => {
        const input = Buffer.from(header + '000400190001aa00650001bb0019000000650000', 'hex');
        let selected: TargetQr12Selected | undefined;
        let first: Uint8Array | undefined;
        let second: Uint8Array | undefined;

        try {
            selected = selectedModule.extractTargetQr12Selected(input);
            expect(selected.field19).toEqual({ kind: 'present', bytes: new Uint8Array() });
            expect(selected.field65).toEqual({ kind: 'present', bytes: new Uint8Array() });

            if (selected.field19.kind !== 'present' || selected.field65.kind !== 'present') {
                throw new Error('missing selected synthetic field');
            }

            first = nodeModule.encodeTargetWtLoginNode016a(selected.field19.bytes);
            second = nodeModule.encodeTargetWtLoginNode0318(selected.field65.bytes);
            expect(first).toEqual(Uint8Array.of(0x01, 0x6a, 0, 0));
            expect(second).toEqual(Uint8Array.of(0x03, 0x18, 0, 0));
        } finally {
            clearSelected(selected);
            first?.fill(0);
            second?.fill(0);
            input.fill(0);
        }
    });

    it('leaves absent fields absent and does not call either encoder', () => {
        const input = Buffer.from(header + '000177770001ff', 'hex');
        let selected: TargetQr12Selected | undefined;

        try {
            const firstSpy = vi.spyOn(nodeModule, 'encodeTargetWtLoginNode016a');
            const secondSpy = vi.spyOn(nodeModule, 'encodeTargetWtLoginNode0318');
            selected = selectedModule.extractTargetQr12Selected(input);
            expect(selected.field19).toEqual({ kind: 'absent' });
            expect(selected.field65).toEqual({ kind: 'absent' });
            expect(firstSpy).not.toHaveBeenCalled();
            expect(secondSpy).not.toHaveBeenCalled();
        } finally {
            clearSelected(selected);
            input.fill(0);
        }
    });

    it('rejects a nonzero status without invoking the node encoders', () => {
        const input = Buffer.from(header + '000200190001aa00650001bb', 'hex');
        input[9] = 1;

        try {
            const firstSpy = vi.spyOn(nodeModule, 'encodeTargetWtLoginNode016a');
            const secondSpy = vi.spyOn(nodeModule, 'encodeTargetWtLoginNode0318');
            expect(() => selectedModule.extractTargetQr12Selected(input)).toThrow(
                'target QR12 selected fields extraction failed',
            );
            expect(firstSpy).not.toHaveBeenCalled();
            expect(secondSpy).not.toHaveBeenCalled();
        } finally {
            input.fill(0);
        }
    });
});
