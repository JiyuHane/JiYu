import { isProxy, isUint8Array } from 'node:util/types';

const STRUCTURE_BYTES = 0x300;
const MAX_SLOT_BYTES = 0xff;
const TOKEN_OFFSET = 0x000;
const TOKEN_LENGTH_OFFSET = 0x0ff;
const EXTRA_OFFSET = 0x100;
const EXTRA_LENGTH_OFFSET = 0x1ff;
const SIGN_OFFSET = 0x200;
const SIGN_LENGTH_OFFSET = 0x2ff;
const ERROR = 'target sign structure result candidate failed';

// Capture intrinsics without consulting properties, iterators, constructors, or
// species on inputs. All reads go through these captured getters and methods.
const Bytes = Uint8Array;
const apply = Reflect.apply;
const typedPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const subarray = Bytes.prototype.subarray;
const fill = Bytes.prototype.fill;

/**
 * Produce a stable, same-realm view over the genuine backing of `input` without
 * touching any of its instance properties, iterators, or accessors. Rejects
 * proxies, detached or out-of-bounds views, shared backing stores, and any view
 * whose byte length is not exactly the full `0x300` structure size. The length
 * check here is the consumer-side counterpart to the producer's per-slot ceiling:
 * the whole fixed-size structure must be present before the three slots can be
 * read back out of it.
 */
function structureView(input: Uint8Array): Uint8Array {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new TypeError();
    }

    apply(values, input, []); // Reject detached and out-of-bounds views.
    const buffer = apply(getBuffer, input, []) as ArrayBuffer;
    apply(getBufferLength, buffer, []); // Reject shared backing, including cross-realm SAB.
    const offset = apply(getOffset, input, []) as number;
    const length = apply(getLength, input, []) as number;

    if (length !== STRUCTURE_BYTES) {
        throw new RangeError();
    }

    return new Bytes(buffer, offset, length);
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
 * Offline conditional model of the success-branch result backfill observed in
 * the Linux QQ `wrapper.node` `MSFSecuritySignCallback`, where a completed
 * 0x300-byte signature structure is decomposed into three `std::string` result
 * fields (`token`/`extra`/`sign`). This is a layout model of the copies seen at
 * that site, not a signer or verifier: it implements no signature algorithm,
 * proves no real signature bytes, decodes no cryptographic meaning of the three
 * segments, and establishes no real QQ interoperability or SSO semantics. It is
 * purely the consumer-side inverse of `assembleTargetSignStructureCandidate` and
 * together with it forms a round-trip over the modeled layout.
 *
 * Target behavior modeled: on the success branch the callback reads each slot's
 * length low byte (`byte at +0xNN`, a value in `0..255`), copies that many bytes
 * from the slot start, and writes the three results into the result object at
 * `r14+0x00` (`token`), `r14+0x18` (`extra`), and `r14+0x30` (`sign`). The
 * low-byte-only length and the `0xff` slot-body capacity ceiling are the local
 * policy modeled here; no segment is interpreted beyond its raw bytes.
 *
 * Layout: `token` length is `structure[0xff]`, its body starts at `+0x00`;
 * `extra` length is `structure[0x1ff]`, its body starts at `+0x100`; `sign`
 * length is `structure[0x2ff]`, its body starts at `+0x200`. Each extracted
 * slot holds at most `0xff` (255) bytes because the length is a single low byte
 * and the slot interval is `0x100`; the copied region therefore always stays
 * inside its own slot.
 *
 * `structure` must be a genuine, attached, in-bounds, nonshared `Uint8Array`
 * whose byte length is exactly `0x300`; subviews, Buffer instances, and
 * cross-realm instances are accepted, and the input is read only through
 * captured intrinsics (`Object.getOwnPropertyDescriptor`
 * `buffer`/`byteLength`/`byteOffset` getters, the
 * `ArrayBuffer.prototype.byteLength` getter, and
 * `Uint8Array.prototype.values`/`set`/`subarray`/`fill` via `Reflect.apply`).
 * Input instance properties, iterators, and accessors are never consulted. The
 * source must remain stable during its synchronous snapshot, and the built-in
 * intrinsics must be intact at module import.
 *
 * A private snapshot copies the whole `0x300` structure before any slot is
 * extracted, so the three lengths and the three bodies are read from one stable
 * image (synchronous snapshot stability). The three returned `Uint8Array`s each
 * own independent storage; they never alias each other or the input. All
 * failures use the same input-free error; the private snapshot and any partial
 * results are cleared best effort, without a guarantee of complete memory
 * erasure in JavaScript.
 */
export function extractTargetSignStructureResultCandidate(structure: Uint8Array): {
    token: Uint8Array;
    extra: Uint8Array;
    sign: Uint8Array;
} {
    let snapshot: Uint8Array | undefined;
    let token: Uint8Array | undefined;
    let extra: Uint8Array | undefined;
    let sign: Uint8Array | undefined;
    let complete = false;

    try {
        const view = structureView(structure);

        // Snapshot the whole structure first so every subsequent length and body
        // read observes one stable image, immune to concurrent mutation.
        snapshot = new Bytes(STRUCTURE_BYTES);
        apply(set, snapshot, [view]);

        // Length low bytes are inherently 0..255, so they always satisfy the
        // 0xff slot-body ceiling; the copied region stays within its slot.
        const tokenLength = snapshot[TOKEN_LENGTH_OFFSET] & MAX_SLOT_BYTES;
        const extraLength = snapshot[EXTRA_LENGTH_OFFSET] & MAX_SLOT_BYTES;
        const signLength = snapshot[SIGN_LENGTH_OFFSET] & MAX_SLOT_BYTES;

        token = new Bytes(tokenLength);
        apply(set, token, [apply(subarray, snapshot, [TOKEN_OFFSET, TOKEN_OFFSET + tokenLength])]);

        extra = new Bytes(extraLength);
        apply(set, extra, [apply(subarray, snapshot, [EXTRA_OFFSET, EXTRA_OFFSET + extraLength])]);

        sign = new Bytes(signLength);
        apply(set, sign, [apply(subarray, snapshot, [SIGN_OFFSET, SIGN_OFFSET + signLength])]);

        complete = true;
        return { token, extra, sign };
    } catch {
        throw new Error(ERROR);
    } finally {
        if (!complete) {
            clear(token);
            clear(extra);
            clear(sign);
        }

        clear(snapshot);
    }
}
