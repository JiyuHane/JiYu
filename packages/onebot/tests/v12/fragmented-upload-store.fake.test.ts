import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V12UploadedDataStore } from '../../src/v12/uploaded-data-store';

const DRAFT_PREFIX = 'jiyu-upload-draft:v1:';
const FILE_PREFIX = 'jiyu-upload:v1:';
const MAX_ENTRIES = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;
const START = 1_000_000;
const EMPTY = Buffer.alloc(0);
const BYTE = Buffer.from([0xff]);
const ENCODED_BYTE = BYTE.toString('base64');
const OK = { kind: 'ok' } as const;
const INVALID = { kind: 'invalid' } as const;
const INVALID_RANGE = { kind: 'invalid_range' } as const;
const UNAVAILABLE = { kind: 'unavailable' } as const;
const NOT_FOUND = { kind: 'not_found' } as const;
const CAPACITY = { kind: 'capacity' } as const;

type Store = V12UploadedDataStore;
type Options = NonNullable<ConstructorParameters<typeof V12UploadedDataStore>[0]>;
type Lease = () => boolean;
type Mutation = (lease: Lease) => { kind: string };

const stores: Store[] = [];

afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
});

function sequence(seed = 1) {
    let serial = seed;

    return (size: number): Buffer => {
        if (size !== 32) {
            throw new Error(`unexpected fixture entropy size: ${size}`);
        }

        const result = Buffer.alloc(32);
        result.writeUInt32BE(serial++);
        return result;
    };
}

function createStore(options: Options = {}, StoreClass = V12UploadedDataStore): Store {
    const store = new StoreClass({ now: () => START, randomBytes: sequence(), ...options });
    stores.push(store);
    return store;
}

function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function prepare(store: Store, name: string, size: number): string {
    const result = store.prepareFragments(name, size);

    if (result.kind !== 'ok') {
        throw new Error(`fixture prepare failed: ${result.kind}`);
    }

    expect(result).toStrictEqual({ kind: 'ok', draftId: result.draftId });
    expect(result.draftId.startsWith(DRAFT_PREFIX)).toBe(true);
    return result.draftId;
}

function transfer(store: Store, id: string, offset: number, bytes: Buffer): void {
    expect(store.transferFragment(id, offset, bytes.toString('base64'))).toStrictEqual(OK);
}

function finish(store: Store, id: string, bytes: Buffer): string {
    const result = store.finishFragments(id, sha256(bytes));

    if (result.kind !== 'ok') {
        throw new Error(`fixture finish failed: ${result.kind}`);
    }

    expect(result).toStrictEqual({ kind: 'ok', fileId: result.fileId });
    expect(result.fileId.startsWith(FILE_PREFIX)).toBe(true);
    return result.fileId;
}

function upload(store: Store, name: string, bytes: Buffer): string {
    const result = store.upload(name, bytes.toString('base64'));

    if (result.kind !== 'ok') {
        throw new Error(`fixture one-shot upload failed: ${result.kind}`);
    }

    return result.fileId;
}

function expectReadable(store: Store, id: string, name: string, bytes: Buffer): void {
    const digest = sha256(bytes);
    expect(store.get(id)).toStrictEqual({
        kind: 'ok',
        name,
        data: bytes.toString('base64'),
        sha256: digest,
    });
    expect(store.getMetadata(id)).toStrictEqual({
        kind: 'ok',
        name,
        totalSize: bytes.length,
        sha256: digest,
    });
}

function expectMissingFile(store: Store, id: string): void {
    expect(store.get(id)).toStrictEqual(NOT_FOUND);
    expect(store.getMetadata(id)).toStrictEqual(NOT_FOUND);
    expect(store.getChunk(id, 0, 0)).toStrictEqual(NOT_FOUND);
}

describe('V12 fragmented upload store (in-memory fixtures)', () => {
    it('publishes binary fragments only on finish and consumes the draft handle', () => {
        const store = createStore();
        const name = '片段-🪶.bin';
        const bytes = Buffer.from([0x00, 0xff, 0x80, 0xfb, 0x02, 0x7f, 0x0d]);
        const legacy = upload(store, 'one-shot', BYTE);
        const draft = prepare(store, name, bytes.length);
        expectMissingFile(store, draft);

        for (const [start, end] of [
            [0, 1],
            [1, 3],
            [3, 6],
            [6, 7],
        ]) {
            transfer(store, draft, start, bytes.subarray(start, end));
        }

        expectMissingFile(store, draft);
        const file = finish(store, draft, bytes);
        expectReadable(store, file, name, bytes);
        expect(store.getChunk(file, 1, 4)).toStrictEqual({
            kind: 'ok',
            data: bytes.subarray(1, 5).toString('base64'),
        });
        expectReadable(store, legacy, 'one-shot', BYTE);
        expect(store.getChunk(legacy, 0, 1)).toStrictEqual({ kind: 'ok', data: '/w==' });
        expect(store.transferFragment(draft, 0, ENCODED_BYTE)).toStrictEqual(NOT_FOUND);
        expect(store.finishFragments(draft, sha256(bytes))).toStrictEqual(NOT_FOUND);
        expect(store.transferFragment(file, 0, ENCODED_BYTE)).toStrictEqual(NOT_FOUND);
        expect(store.finishFragments(file, sha256(bytes))).toStrictEqual(NOT_FOUND);
    });

    it('finishes an empty file directly and canonicalizes a zero size', () => {
        const store = createStore();
        const file = finish(store, prepare(store, '', -0), EMPTY);
        expectReadable(store, file, '', EMPTY);
        expect(store.getChunk(file, 0, 0)).toStrictEqual({ kind: 'ok', data: '' });
    });

    it('validates preparation shape and accepts exactly 4096 UTF-16 units and 256 KiB', () => {
        const store = createStore();
        const name = '🪶'.repeat(2048);
        expect(store.prepareFragments(`${name}x`, 1)).toStrictEqual(INVALID);
        expect(store.prepareFragments(null as unknown as string, 1)).toStrictEqual(INVALID);

        for (const size of [
            -1,
            0.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            MAX_FILE_BYTES + 1,
        ]) {
            expect(store.prepareFragments(name, size)).toStrictEqual(INVALID);
        }

        const bytes = Buffer.alloc(MAX_FILE_BYTES, 0xa3);
        const draft = prepare(store, name, bytes.length);
        transfer(store, draft, -0, bytes);
        const file = finish(store, draft, bytes);
        expect(store.getMetadata(file)).toStrictEqual({
            kind: 'ok',
            name,
            totalSize: MAX_FILE_BYTES,
            sha256: sha256(bytes),
        });
        expect(store.getChunk(file, MAX_FILE_BYTES - 1, 1)).toStrictEqual({
            kind: 'ok',
            data: bytes.subarray(-1).toString('base64'),
        });
    });

    it('rejects noncanonical or empty chunks, skipped and repeated offsets, and overruns', () => {
        const store = createStore();
        const bytes = Buffer.from([0xff, 0x00, 0x80]);
        const draft = prepare(store, 'contiguous', bytes.length);
        const chunk = ENCODED_BYTE;
        expect(store.transferFragment(draft, 1, chunk)).toStrictEqual(INVALID_RANGE);

        const invalidData: unknown[] = ['', null, BYTE, 'AA', 'AA==\n', '_w==', 'AB==', 'AAB='];

        for (const data of invalidData) {
            expect(store.transferFragment(draft, 0, data as string)).toStrictEqual(INVALID);
        }

        transfer(store, draft, 0, bytes.subarray(0, 1));

        for (const offset of [-1, 0, 2, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(store.transferFragment(draft, offset, chunk)).toStrictEqual(INVALID_RANGE);
        }

        expect(store.transferFragment(draft, 1, bytes.toString('base64'))).toStrictEqual({
            kind: 'invalid_range',
        });
        transfer(store, draft, 1, bytes.subarray(1));
        expect(store.transferFragment(draft, bytes.length, chunk)).toStrictEqual(INVALID_RANGE);
        expectReadable(store, finish(store, draft, bytes), 'contiguous', bytes);
    });

    it('preserves the draft for retries after incomplete, malformed, and nonmatching digests', () => {
        const store = createStore();
        const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01]);
        const draft = prepare(store, 'digest', bytes.length);
        const digest = sha256(bytes);
        transfer(store, draft, 0, bytes.subarray(0, 1));
        expect(store.finishFragments(draft, digest)).toStrictEqual({ kind: 'incomplete' });
        transfer(store, draft, 1, bytes.subarray(1));

        const invalidDigests: unknown[] = [
            null,
            '',
            `F${digest.slice(1)}`,
            `${digest}\n`,
            sha256(bytes.subarray(1)),
        ];

        for (const invalid of invalidDigests) {
            expect(store.finishFragments(draft, invalid as string)).toStrictEqual(INVALID);
            expectMissingFile(store, draft);
        }

        expectReadable(store, finish(store, draft, bytes), 'digest', bytes);
    });

    it('keeps draft and file handles local to the issuing store', () => {
        const first = createStore({ randomBytes: sequence(1) });
        const other = createStore({ randomBytes: sequence(100) });
        const one = prepare(first, 'first', 1);
        const two = prepare(other, 'second', 1);
        expect(first.transferFragment(two, 0, ENCODED_BYTE)).toStrictEqual(NOT_FOUND);
        expect(other.transferFragment(one, 0, ENCODED_BYTE)).toStrictEqual(NOT_FOUND);
        transfer(first, one, 0, BYTE);
        transfer(other, two, 0, BYTE);
        expect(first.finishFragments(two, sha256(BYTE))).toStrictEqual(NOT_FOUND);
        expect(other.finishFragments(one, sha256(BYTE))).toStrictEqual(NOT_FOUND);
        expectMissingFile(other, finish(first, one, BYTE));
        expectMissingFile(first, finish(other, two, BYTE));
    });

    it('shares the 32-entry limit and finishes a draft in its reserved slot at capacity', () => {
        const store = createStore();
        const legacy = upload(store, 'legacy', EMPTY);
        const target = prepare(store, 'publish-at-capacity', 0);

        for (let index = 2; index < MAX_ENTRIES; index++) {
            prepare(store, `draft-${index}`, 0);
        }

        expect(store.prepareFragments('extra', 0)).toStrictEqual(CAPACITY);
        expect(store.upload('extra', '')).toStrictEqual(CAPACITY);
        const file = finish(store, target, EMPTY);
        expect(store.prepareFragments('extra', 0)).toStrictEqual(CAPACITY);
        expect(store.upload('extra', '')).toStrictEqual(CAPACITY);
        expectReadable(store, legacy, 'legacy', EMPTY);
        expectReadable(store, file, 'publish-at-capacity', EMPTY);
    });

    it('reserves declared raw bytes against the shared 4 MiB budget and reclaims expired quota', () => {
        let now = START;
        const store = createStore({ now: () => now });
        const full = Buffer.alloc(MAX_FILE_BYTES, 0x76);
        const legacy = upload(store, 'legacy', full);
        const expiredDraft = prepare(store, 'older-reservation', full.length);
        now++;

        for (let index = 2; index < MAX_TOTAL_BYTES / MAX_FILE_BYTES - 1; index++) {
            prepare(store, `reserved-${index}`, full.length);
        }

        const bytes = full.subarray(1);
        const target = prepare(store, 'uses-reservation', bytes.length);
        expect(store.prepareFragments('two-more', 2)).toStrictEqual(CAPACITY);
        const tail = upload(store, 'last-available-byte', BYTE);
        expect(store.prepareFragments('extra-byte', 1)).toStrictEqual(CAPACITY);
        expect(store.upload('extra-byte', ENCODED_BYTE)).toStrictEqual(CAPACITY);
        transfer(store, target, 0, bytes);
        const file = finish(store, target, bytes);
        expect(store.prepareFragments('extra-byte', 1)).toStrictEqual(CAPACITY);
        expect(store.upload('extra-byte', ENCODED_BYTE)).toStrictEqual(CAPACITY);
        prepare(store, 'zero-bytes-still-fit', 0);
        expectReadable(store, legacy, 'legacy', full);

        now = START + TTL_MS;
        expect(store.get(legacy)).toStrictEqual(NOT_FOUND);
        expect(store.transferFragment(expiredDraft, 0, ENCODED_BYTE)).toStrictEqual(NOT_FOUND);
        prepare(store, 'reclaimed-legacy', full.length);
        prepare(store, 'reclaimed-draft', full.length);
        expect(store.prepareFragments('extra-byte', 1)).toStrictEqual(CAPACITY);
        expectReadable(store, tail, 'last-available-byte', BYTE);
        expectReadable(store, file, 'uses-reservation', bytes);
    });

    it('uses the initial prepare clock sample for both pending and published data', () => {
        let now = START;
        let advanceAtDraw = false;
        const next = sequence();
        const store = createStore({
            now: () => now,
            randomBytes: (size) => {
                if (advanceAtDraw) {
                    now += 100;
                    advanceAtDraw = false;
                }

                return next(size);
            },
        });
        const abandoned = prepare(store, 'pending', 2);
        advanceAtDraw = true;
        const target = prepare(store, 'publish-near-expiry', 1);
        const newer = prepare(store, 'newer', 1);
        now = START + TTL_MS - 1;
        transfer(store, abandoned, 0, BYTE);
        transfer(store, target, 0, BYTE);
        const file = finish(store, target, BYTE);
        expectReadable(store, file, 'publish-near-expiry', BYTE);

        now++;
        expectMissingFile(store, file);
        expect(store.transferFragment(abandoned, 1, ENCODED_BYTE)).toStrictEqual(NOT_FOUND);
        expect(store.finishFragments(abandoned, sha256(Buffer.from([0xff, 0xff])))).toStrictEqual(
            NOT_FOUND,
        );
        transfer(store, newer, 0, BYTE);
        expectReadable(store, finish(store, newer, BYTE), 'newer', BYTE);
    });

    it('recovers from backward, non-finite, and throwing clocks without advancing the cursor', () => {
        let clock = () => START;
        const store = createStore({ now: () => clock() });
        const bytes = Buffer.from([0x00, 0xff]);
        const draft = prepare(store, 'clock-recovery', bytes.length);
        transfer(store, draft, 0, bytes.subarray(0, 1));

        const clockFaults = [
            () => START - 1,
            () => NaN,
            () => Infinity,
            () => {
                throw new Error('fixture clock fault');
            },
        ];

        for (const fault of clockFaults) {
            clock = fault;
            expect(store.prepareFragments('clock-fault', 0)).toStrictEqual(UNAVAILABLE);
            expect(store.transferFragment(draft, 1, ENCODED_BYTE)).toStrictEqual(UNAVAILABLE);
            expect(store.finishFragments(draft, sha256(bytes))).toStrictEqual(UNAVAILABLE);
        }

        clock = () => START;
        expect(store.finishFragments(draft, sha256(bytes))).toStrictEqual({ kind: 'incomplete' });
        transfer(store, draft, 1, BYTE);
        expectReadable(store, finish(store, draft, bytes), 'clock-recovery', bytes);
    });

    it('retains drafts and legacy files through RNG exceptions and bounded ID collisions', () => {
        const next = sequence();
        const fixed = next(32);
        const random = vi.fn(next).mockReturnValue(fixed);
        const store = createStore({ randomBytes: random });
        const legacy = upload(store, 'legacy', EMPTY);
        const draft = prepare(store, 'retry-entropy', 1);
        transfer(store, draft, 0, BYTE);
        random.mockClear();
        expect(store.prepareFragments('draft-id-collision', 0)).toStrictEqual(UNAVAILABLE);
        expect(store.finishFragments(draft, sha256(BYTE))).toStrictEqual(UNAVAILABLE);
        expect(random).toHaveBeenCalledTimes(8);

        random.mockImplementation(() => {
            throw new Error('fixture RNG fault');
        });
        expect(store.prepareFragments('entropy-fault', 0)).toStrictEqual(UNAVAILABLE);
        expect(store.finishFragments(draft, sha256(BYTE))).toStrictEqual(UNAVAILABLE);
        expectReadable(store, legacy, 'legacy', EMPTY);

        random.mockImplementation(next).mockReturnValueOnce(fixed);
        expectReadable(store, finish(store, draft, BYTE), 'retry-entropy', BYTE);
        prepare(store, 'entropy-recovered', 0);
    });

    it('checks the entry lease for each mutation before consulting the clock or RNG', () => {
        const now = vi.fn(() => START);
        const random = vi.fn(sequence());
        const store = createStore({ now, randomBytes: random });
        const pending = prepare(store, 'pending', 1);
        const ready = prepare(store, 'ready', 0);
        now.mockClear();
        random.mockClear();
        const actions: Mutation[] = [
            (lease) => store.prepareFragments('lease-entry', 1, lease),
            (lease) => store.transferFragment(pending, 0, ENCODED_BYTE, lease),
            (lease) => store.finishFragments(ready, sha256(EMPTY), lease),
        ];

        for (const action of actions) {
            const deny = vi.fn(() => false);
            const throws = vi.fn(() => {
                throw new Error('fixture entry lease fault');
            });
            expect(action(deny)).toStrictEqual(UNAVAILABLE);
            expect(action(throws)).toStrictEqual(UNAVAILABLE);
            expect(deny).toHaveBeenCalledTimes(1);
            expect(throws).toHaveBeenCalledTimes(1);
        }

        expect(now).not.toHaveBeenCalled();
        expect(random).not.toHaveBeenCalled();
        transfer(store, pending, 0, BYTE);
        expectReadable(store, finish(store, pending, BYTE), 'pending', BYTE);
        expectReadable(store, finish(store, ready, EMPTY), 'ready', EMPTY);
    });

    it.each(['denies', 'throws'] as const)(
        'rolls back each mutation when the commit lease %s after the entry lease allowed it',
        (mode) => {
            const trace: string[] = [];
            const next = sequence();
            let lastDraw: Buffer = Buffer.alloc(32);
            const store = createStore({
                now: () => {
                    trace.push('clock');
                    return START;
                },
                randomBytes: (size) => {
                    trace.push('entropy');
                    lastDraw = next(size);
                    return lastDraw;
                },
            });

            // Leave one slot and exactly one file's worth of bytes unreserved.
            for (let index = 0; index < MAX_ENTRIES - 1; index++) {
                const size = index < MAX_TOTAL_BYTES / MAX_FILE_BYTES - 1 ? MAX_FILE_BYTES : 0;
                prepare(store, `reservation-${index}`, size);
            }

            const expectCommitFailure = (action: Mutation, drawsId: boolean) => {
                trace.length = 0;
                const lease = vi
                    .fn(() => true)
                    .mockImplementationOnce(() => {
                        trace.push('entry');
                        return true;
                    })
                    .mockImplementationOnce(() => {
                        trace.push('commit');

                        if (mode === 'throws') {
                            throw new Error('fixture commit lease fault');
                        }

                        return false;
                    });
                expect(action(lease)).toStrictEqual(UNAVAILABLE);
                expect(lease).toHaveBeenCalledTimes(2);
                expect(trace).toStrictEqual(
                    drawsId
                        ? ['entry', 'clock', 'entropy', 'commit']
                        : ['entry', 'clock', 'commit'],
                );
            };

            const bytes = Buffer.alloc(MAX_FILE_BYTES, 0xff);
            const digest = sha256(bytes);
            expectCommitFailure(
                (lease) => store.prepareFragments('denied', bytes.length, lease),
                true,
            );
            const draft = prepare(store, 'retry-after-lease', bytes.length);
            transfer(store, draft, 0, BYTE);
            const remainder = bytes.subarray(1);
            expectCommitFailure(
                (lease) => store.transferFragment(draft, 1, remainder.toString('base64'), lease),
                false,
            );
            expect(store.finishFragments(draft, digest)).toStrictEqual({ kind: 'incomplete' });
            transfer(store, draft, 1, remainder);
            expectCommitFailure((lease) => store.finishFragments(draft, digest, lease), true);
            expectMissingFile(store, FILE_PREFIX + lastDraw.toString('base64url'));
            expectMissingFile(store, draft);
            expectReadable(store, finish(store, draft, bytes), 'retry-after-lease', bytes);
            expect(store.prepareFragments('extra-slot', 0)).toStrictEqual(CAPACITY);
        },
    );

    it.each([
        ['clock', 'nested mutations and reads'],
        ['random', 'nested mutations and reads'],
        ['lease', 'nested mutations and reads'],
        ['clock', 'close'],
        ['random', 'close'],
        ['lease', 'close'],
    ] as const)('handles %s reentry with %s during finish', (seam, effect) => {
        let onHook: (() => void) | undefined;

        const fire = () => {
            const hook = onHook;
            onHook = undefined;
            hook?.();
        };

        const next = sequence();
        const store = createStore({
            now: () => {
                if (seam === 'clock') {
                    fire();
                }

                return START;
            },
            randomBytes: (size) => {
                if (seam === 'random') {
                    fire();
                }

                return next(size);
            },
        });
        const legacy = upload(store, 'legacy', EMPTY);
        const ready = prepare(store, 'outer', 0);
        const pending = prepare(store, 'pending', 1);
        const emptyDigest = sha256(EMPTY);
        const nested: Array<{ kind: string }> = [];
        const callback = vi.fn(() => {
            if (effect === 'close') {
                store.close();
                return;
            }

            nested.push(
                store.get(legacy),
                store.getMetadata(legacy),
                store.getChunk(legacy, 0, 0),
                store.upload('nested-full', ''),
                store.prepareFragments('nested-draft', 0),
                store.transferFragment(pending, 0, ENCODED_BYTE),
                store.finishFragments(ready, emptyDigest),
            );
        });
        onHook = callback;
        const lease = vi
            .fn(() => {
                fire();
                return true;
            })
            .mockReturnValueOnce(true);
        const result = store.finishFragments(
            ready,
            emptyDigest,
            seam === 'lease' ? lease : undefined,
        );
        expect(callback).toHaveBeenCalledTimes(1);

        if (effect === 'close') {
            expect(result).toStrictEqual(UNAVAILABLE);
            store.close();
            expect(store.get(legacy)).toStrictEqual(UNAVAILABLE);
            expect(store.getMetadata(legacy)).toStrictEqual(UNAVAILABLE);
            expect(store.getChunk(legacy, 0, 0)).toStrictEqual(UNAVAILABLE);
            expect(store.upload('closed', '')).toStrictEqual(UNAVAILABLE);
            expect(store.prepareFragments('closed', 0)).toStrictEqual(UNAVAILABLE);
            expect(store.transferFragment(pending, 0, ENCODED_BYTE)).toStrictEqual(UNAVAILABLE);
            expect(store.finishFragments(ready, emptyDigest)).toStrictEqual(UNAVAILABLE);
            return;
        }

        expect(nested).toStrictEqual(Array.from({ length: 7 }, () => UNAVAILABLE));

        if (result.kind !== 'ok') {
            throw new Error(`fixture finish after reentry failed: ${result.kind}`);
        }

        expectReadable(store, result.fileId, 'outer', EMPTY);
        expectReadable(store, legacy, 'legacy', EMPTY);
        transfer(store, pending, 0, BYTE);
    });

    it('wipes expired drafts on a read and all remaining payloads on close', async () => {
        let now = START;
        let observe = false;
        const markers = [17, 23, 29, 31];
        const wiped = new Set<number>();
        const fill = Uint8Array.prototype.fill;
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            ...args: Parameters<typeof fill>
        ) {
            const marker = this.length;
            const watched =
                observe &&
                args[0] === 0 &&
                markers.includes(marker) &&
                this.every((byte) => byte === marker);
            const result = Reflect.apply(fill, this, args) as Uint8Array;

            if (watched && this.every((byte) => byte === 0)) {
                wiped.add(marker);
            }

            return result;
        });

        try {
            // The store captures the zero-fill intrinsic on import. Observe only
            // tagged fixture bytes and continue to invoke the real intrinsic.
            vi.resetModules();
            const { V12UploadedDataStore: FreshStore } =
                await import('../../src/v12/uploaded-data-store');
            const store = createStore({ now: () => now }, FreshStore);

            const stage = (length: number) => {
                const bytes = Buffer.alloc(length, length);
                const id = prepare(store, `wipe-${length}`, length);
                transfer(store, id, 0, bytes);
                return { id, bytes };
            };

            const expired = stage(17);
            now++;
            const pending = stage(23);
            const staged = stage(29);
            const file = finish(store, staged.id, staged.bytes);
            const legacy = upload(store, 'legacy', Buffer.alloc(31, 31));
            now = START + TTL_MS;

            observe = true;
            const read = store.get(expired.id);
            observe = false;
            expect(read).toStrictEqual(NOT_FOUND);
            expect(wiped).toStrictEqual(new Set([17]));

            observe = true;
            store.close();
            observe = false;
            expect(wiped).toStrictEqual(new Set(markers));
            expect(store.get(file)).toStrictEqual(UNAVAILABLE);
            expect(store.get(legacy)).toStrictEqual(UNAVAILABLE);
            expect(store.finishFragments(pending.id, sha256(pending.bytes))).toStrictEqual(
                UNAVAILABLE,
            );
        } finally {
            observe = false;
            spy.mockRestore();
            vi.resetModules();
        }
    });
});
