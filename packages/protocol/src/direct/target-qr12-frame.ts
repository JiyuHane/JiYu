import {
    encodeTargetQr31Frame,
    MAX_TARGET_QR31_FRAME_BODY_BYTES,
    MAX_TARGET_QR31_FRAME_BYTES,
} from './target-qr31-frame';

/** Local limits, not limits established for the native target. */
export const MAX_TARGET_QR12_FRAME_BYTES = MAX_TARGET_QR31_FRAME_BYTES;
export const MAX_TARGET_QR12_FRAME_BODY_BYTES = MAX_TARGET_QR31_FRAME_BODY_BYTES;

const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;
const command = Uint8Array.of(0, 0x12);

/**
 * Encode the selected zero-initialized QR12 caller's inner frame. For the two
 * inspected callers only, its envelope matches QR31 except for the command.
 * The body is supplied already encoded; its schema and downstream transport,
 * signing and authentication are not established here. The inherited local
 * length limit rejects totals above 65535, unlike the native low-16-bit write.
 * Cleanup of private bytes is best effort. The returned frame is caller-owned.
 */
export function encodeTargetQr12Frame(body: Uint8Array): Uint8Array {
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        output = encodeTargetQr31Frame(body);
        set.call(output, command, 3);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR12 frame construction failed');
    } finally {
        if (!complete && output) {
            try {
                fill.call(output, 0);
            } catch {
                // Best effort: do not replace the fixed construction error.
            }
        }
    }
}
