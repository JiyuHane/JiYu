import { isProxy, isUint8Array } from 'node:util/types';

const STRUCTURE_BYTES = 0x300;
const MAX_SLOT_BYTES = 0xff;
const TOKEN_OFFSET = 0x000;
const TOKEN_LENGTH_OFFSET = 0x0ff;
const EXTRA_OFFSET = 0x100;
const EXTRA_LENGTH_OFFSET = 0x1ff;
const SIGN_OFFSET = 0x200;
const SIGN_LENGTH_OFFSET = 0x2ff;
const ERROR = 'target sign structure candidate failed';

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
const fill = Bytes.prototype.fill;

/**
 * Produce a stable, same-realm view over the genuine backing of `input` without
 * touching any of its instance properties, iterators, or accessors. Rejects
 * proxies, detached or out-of-bounds views, and shared backing stores. The slot
 * data region spans `0x100 - 1` bytes because the final byte of the slot holds
 * the length, so a length above `MAX_SLOT_BYTES` cannot be represented and is
 * rejected here.
 */
function slotView(input: Uint8Array): { view: Uint8Array; length: number } {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new TypeError();
    }

    apply(values, input, []); // Reject detached and out-of-bounds views.
    const buffer = apply(getBuffer, input, []) as ArrayBuffer;
    apply(getBufferLength, buffer, []); // Reject shared backing, including cross-realm SAB.
    const offset = apply(getOffset, input, []) as number;
    const length = apply(getLength, input, []) as number;

    if (length > MAX_SLOT_BYTES) {
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
 * Offline conditional model of the final 0x300-byte structure assembly observed
 * in the Linux QQ `wrapper.node` signature orchestrator at 0x68562d0. This is a
 * layout model of the copies seen at that site, not a signer: the three slot
 * contents are supplied by the caller, and this function implements no signature
 * algorithm, proves no target runtime value, and establishes no real QQ
 * interoperability or SSO semantics. The target performs `memcpy` for each slot
 * body and writes the low byte of each length at `+0xNN`; the low-byte-only
 * length and the `0xff` capacity ceiling are the local policy modeled here.
 *
 * Layout: `token` is copied to `+0x00` with its length low byte at `+0xff`;
 * `extra` is copied to `+0x100` with its length low byte at `+0x1ff`; `sign` is
 * copied to `+0x200` with its length low byte at `+0x2ff`. Every other byte is
 * zero. Each slot body holds at most `0xff` (255) bytes, because only the length
 * low byte is retained and the slot interval is `0x100`; any input longer than
 * `0xff` fails with the fixed error.
 *
 * Each of `token`, `extra`, and `sign` must be a genuine, attached, in-bounds,
 * nonshared `Uint8Array`; subviews, Buffer instances, and cross-realm instances
 * are accepted, and the inputs are read only through captured intrinsics
 * (`Object.getOwnPropertyDescriptor` `buffer`/`byteLength`/`byteOffset` getters,
 * the `ArrayBuffer.prototype.byteLength` getter, and
 * `Uint8Array.prototype.values`/`set`/`fill` via `Reflect.apply`). Input
 * instance properties, iterators, and accessors are never consulted. The sources
 * must remain stable during their synchronous snapshots, and the built-in
 * intrinsics must be intact at module import. The returned 0x300-byte
 * `Uint8Array` has storage independent of all callers. All failures use the same
 * input-free error; private snapshots and failed results are cleared best
 * effort, without a guarantee of complete memory erasure in JavaScript.
 */
export function assembleTargetSignStructureCandidate(input: {
    token: Uint8Array;
    extra: Uint8Array;
    sign: Uint8Array;
}): Uint8Array {
    let tokenSnapshot: Uint8Array | undefined;
    let extraSnapshot: Uint8Array | undefined;
    let signSnapshot: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    let complete = false;

    try {
        const token = slotView(input.token);
        const extra = slotView(input.extra);
        const sign = slotView(input.sign);

        // Snapshot each source so later reads are immune to concurrent mutation.
        tokenSnapshot = new Bytes(token.length);
        apply(set, tokenSnapshot, [token.view]);
        extraSnapshot = new Bytes(extra.length);
        apply(set, extraSnapshot, [extra.view]);
        signSnapshot = new Bytes(sign.length);
        apply(set, signSnapshot, [sign.view]);

        result = new Bytes(STRUCTURE_BYTES);

        for (let index = 0; index < token.length; index++) {
            result[TOKEN_OFFSET + index] = tokenSnapshot[index];
        }

        for (let index = 0; index < extra.length; index++) {
            result[EXTRA_OFFSET + index] = extraSnapshot[index];
        }

        for (let index = 0; index < sign.length; index++) {
            result[SIGN_OFFSET + index] = signSnapshot[index];
        }

        result[TOKEN_LENGTH_OFFSET] = token.length & 0xff;
        result[EXTRA_LENGTH_OFFSET] = extra.length & 0xff;
        result[SIGN_LENGTH_OFFSET] = sign.length & 0xff;

        complete = true;
        return result;
    } catch {
        throw new Error(ERROR);
    } finally {
        if (!complete) {
            clear(result);
        }

        clear(tokenSnapshot);
        clear(extraSnapshot);
        clear(signSnapshot);
    }
}
