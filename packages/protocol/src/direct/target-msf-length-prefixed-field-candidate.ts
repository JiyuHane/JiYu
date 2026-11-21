import { isProxy, isUint8Array } from 'node:util/types';

const PREFIX_BYTES = 4;
// Local policy: the prefix is written through a u32 big-endian store, so the
// self-including total (`payload.length + 4`) must stay inside u32. The target
// computes this total with 32-bit arithmetic, so the admissible payload length
// is bounded by `0xffffffff - 4`.
const MAX_PAYLOAD_BYTES = 0xffffffff - PREFIX_BYTES;
const ERROR = 'target MSF length-prefixed field candidate failed';

// Capture intrinsics without consulting properties, iterators, constructors, or
// species on inputs. All reads go through these captured getters and methods.
const Bytes = Uint8Array;
const View = DataView;
const apply = Reflect.apply;
const typedPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const setUint32 = View.prototype.setUint32;

/**
 * Produce a stable, same-realm view over the genuine backing of `input` without
 * touching any of its instance properties, iterators, or accessors. Rejects
 * proxies, detached or out-of-bounds views, and shared backing stores. The byte
 * length is enforced against the local u32 ceiling: a payload longer than
 * `MAX_PAYLOAD_BYTES` would make the self-including total overflow u32 and is
 * rejected here.
 */
function payloadView(input: Uint8Array): { view: Uint8Array; length: number } {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new TypeError();
    }

    apply(values, input, []); // Reject detached and out-of-bounds views.
    const buffer = apply(getBuffer, input, []) as ArrayBuffer;
    apply(getBufferLength, buffer, []); // Reject shared backing, including cross-realm SAB.
    const offset = apply(getOffset, input, []) as number;
    const length = apply(getLength, input, []) as number;

    if (length > MAX_PAYLOAD_BYTES) {
        throw new RangeError();
    }

    return { view: new Bytes(buffer, offset, length), length };
}

function clear(bytes: Uint8Array | undefined): void {
    if (bytes !== undefined) {
        try {
            apply(fill, bytes, [0]);
        } catch {
            // Every owned allocation receives a separate best-effort attempt.
        }
    }
}

/**
 * Offline conditional model of the `0x3551410` length-prefixed field framing
 * observed in the Linux QQ `wrapper.node` `security_sign_manager`. This is a
 * byte-layout model of the copies seen at that site, not a framer of real MSF
 * traffic: it implements no signature or session algorithm, assigns no business
 * meaning to the field, proves no target runtime value, and establishes no real
 * QQ interoperability or complete packet. The caller supplies the field body,
 * and this function reproduces only the observed prefix-plus-body copy.
 *
 * Target behavior modeled: the function takes a `{begin, end}` buffer span,
 * computes `len = end - begin`, and emits `len + 4` as a four-byte big-endian
 * prefix (at `0x35a9100` the total is written one byte at a time via
 * `sar 0x18` / `shr 0x10` / `shr 8` / low byte, high byte first), then appends
 * the body bytes unchanged (at `0x29a1b70`). The emitted prefix value therefore
 * includes its own four bytes: `output = BE32(payload.length + 4) || payload`,
 * i.e. the MSF/SSO "length-self-inclusive" field framing. The u32 prefix width
 * and its 32-bit arithmetic are the local policy modeled here.
 *
 * Layout: bytes `0x00..0x03` hold `payload.length + 4` big-endian (most
 * significant byte first); bytes `0x04..` hold the payload body verbatim. The
 * output byte length is exactly `4 + payload.length`.
 *
 * `payload` must be a genuine, attached, in-bounds, nonshared `Uint8Array`;
 * subviews, Buffer instances, and cross-realm instances are accepted, and the
 * input is read only through captured intrinsics
 * (`Object.getOwnPropertyDescriptor` `buffer`/`byteLength`/`byteOffset` getters,
 * the `ArrayBuffer.prototype.byteLength` getter, and
 * `Uint8Array.prototype.values`/`set`/`fill` via `Reflect.apply`). Input
 * instance properties, iterators, and accessors are never consulted. The source
 * must remain stable during its synchronous snapshot, and the built-in
 * intrinsics must be intact at module import.
 *
 * `payload.length` is bounded by `0xffffffff - 4` so the self-including total
 * fits in the big-endian u32 prefix; a longer payload fails with the fixed
 * error. The payload is snapshotted whole into a private buffer before the
 * output is assembled (synchronous snapshot stability), the prefix is written
 * with `DataView.setUint32(0, total, false)`, and the snapshot is copied to
 * offset `4`. The returned `Uint8Array` has storage independent of all callers.
 * All failures use the same input-free error; the private snapshot and any
 * partial result are cleared best effort, without a guarantee of complete
 * memory erasure in JavaScript.
 */
export function encodeTargetMsfLengthPrefixedFieldCandidate(payload: Uint8Array): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    let complete = false;

    try {
        const source = payloadView(payload);

        // Snapshot the body first so the prefix total and the appended bytes are
        // taken from one stable image, immune to concurrent mutation.
        snapshot = new Bytes(source.length);
        apply(set, snapshot, [source.view]);

        // Self-including total: the prefix value counts its own four bytes. It is
        // bounded above so it never overflows the u32 big-endian store.
        const total = source.length + PREFIX_BYTES;

        // Assemble into freshly owned storage; the output is independent of all
        // callers. The DataView wraps the result's own backing buffer so the
        // big-endian prefix is written with a single u32 store.
        result = new Bytes(PREFIX_BYTES + source.length);
        const header = new View(apply(getBuffer, result, []) as ArrayBuffer);
        apply(setUint32, header, [0, total, false]);
        apply(set, result, [snapshot, PREFIX_BYTES]);

        complete = true;
        return result;
    } catch {
        throw new Error(ERROR);
    } finally {
        if (!complete) {
            clear(result);
        }

        clear(snapshot);
    }
}
