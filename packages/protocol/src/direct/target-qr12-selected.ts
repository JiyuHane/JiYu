import { extractTargetQr12Response, type TargetQr12Response } from './target-qr12-response';

export type TargetQr12SelectedField = { kind: 'absent' } | { kind: 'present'; bytes: Uint8Array };

export interface TargetQr12Selected {
    field18: TargetQr12SelectedField;
    field19: TargetQr12SelectedField;
    field1e: TargetQr12SelectedField;
    field65: TargetQr12SelectedField;
    field3f: TargetQr12SelectedField;
}

const Bytes = Uint8Array;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Every allocation is cleaned independently and only best effort.
        }
    }
}

/**
 * Extract five raw fields from a locally strict QR12 response slice at status
 * zero. Duplicate tags use their last value, including a final empty value.
 * Unselected tags are not interpreted: the target's factory or child decoders
 * may reject them or other data. This does not implement complete native decode,
 * interpret status as login success, verify identity/signatures, authenticate,
 * or establish server behavior. Temporary copies are cleared best effort;
 * JavaScript and runtime copies can remain. Returned bytes belong to the caller.
 */
export function extractTargetQr12Selected(input: Uint8Array): TargetQr12Selected {
    let parsed: TargetQr12Response | undefined;
    let output18: Uint8Array | undefined;
    let output19: Uint8Array | undefined;
    let output1e: Uint8Array | undefined;
    let output65: Uint8Array | undefined;
    let output3f: Uint8Array | undefined;
    let complete = false;

    try {
        parsed = extractTargetQr12Response(input);

        if (parsed.statusByte !== 0) {
            throw new RangeError();
        }

        let last18: Uint8Array | undefined;
        let last19: Uint8Array | undefined;
        let last1e: Uint8Array | undefined;
        let last65: Uint8Array | undefined;
        let last3f: Uint8Array | undefined;

        for (let i = 0; i < parsed.entries.length; i++) {
            const entry = parsed.entries[i];

            if (entry.tag === 0x18) {
                last18 = entry.value;
            } else if (entry.tag === 0x19) {
                last19 = entry.value;
            } else if (entry.tag === 0x1e) {
                last1e = entry.value;
            } else if (entry.tag === 0x65) {
                last65 = entry.value;
            } else if (entry.tag === 0x3f) {
                last3f = entry.value;
            }
        }

        // Assign each allocation before copying, so even a copy failure can wipe it.
        if (last18 !== undefined) {
            output18 = new Bytes(last18.length);
            set.call(output18, last18);
        }

        if (last19 !== undefined) {
            output19 = new Bytes(last19.length);
            set.call(output19, last19);
        }

        if (last1e !== undefined) {
            output1e = new Bytes(last1e.length);
            set.call(output1e, last1e);
        }

        if (last65 !== undefined) {
            output65 = new Bytes(last65.length);
            set.call(output65, last65);
        }

        if (last3f !== undefined) {
            output3f = new Bytes(last3f.length);
            set.call(output3f, last3f);
        }

        const result: TargetQr12Selected = {
            field18:
                output18 === undefined ? { kind: 'absent' } : { kind: 'present', bytes: output18 },
            field19:
                output19 === undefined ? { kind: 'absent' } : { kind: 'present', bytes: output19 },
            field1e:
                output1e === undefined ? { kind: 'absent' } : { kind: 'present', bytes: output1e },
            field65:
                output65 === undefined ? { kind: 'absent' } : { kind: 'present', bytes: output65 },
            field3f:
                output3f === undefined ? { kind: 'absent' } : { kind: 'present', bytes: output3f },
        };
        complete = true;
        return result;
    } catch {
        throw new Error('target QR12 selected fields extraction failed');
    } finally {
        if (parsed) {
            clear(parsed.first.raw);

            if (parsed.first.nativeProjection.kind === 'assigned') {
                clear(parsed.first.nativeProjection.bytes);
            }

            for (let i = 0; i < parsed.entries.length; i++) {
                clear(parsed.entries[i].value);
            }
        }

        if (!complete) {
            clear(output18);
            clear(output19);
            clear(output1e);
            clear(output65);
            clear(output3f);
        }
    }
}
