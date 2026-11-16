import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store is imported only after these per-fork guards are installed. None of
// the fixtures start a transport, account, native addon, plugin, or QQ process.
const v11 = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('../../src/api-handler', () => ({
    ApiHandler: class {
        constructor() {
            v11.constructed++;
            throw new Error('unexpected v11 API construction');
        }
    },
}));

type StoreModule = typeof import('../../src/v12/uploaded-data-store');
type Store = InstanceType<StoreModule['V12UploadedDataStore']>;
type Options = ConstructorParameters<StoreModule['V12UploadedDataStore']>[0];

const FILE_BYTES = 256 * 1024;
const TOTAL_BYTES = 4 * 1024 * 1024;
const TTL = 10 * 60 * 1000;
let api: StoreModule;
let stores: Store[];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let guards: Array<{ mock: { calls: unknown[] } }>;

function blocked(): never {
    throw new Error('unexpected external operation in memory fixture');
}

beforeEach(async () => {
    stores = [];
    v11.constructed = 0;
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
    api = await import('../../src/v12/uploaded-data-store');
});

afterEach(() => {
    let closeFailures = 0;

    try {
        for (const store of stores) {
            try {
                store.close();
            } catch {
                closeFailures++;
            }
        }
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const v11Calls = v11.constructed;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        expect(closeFailures).toBe(0);
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(calls).toEqual(calls.map(() => 0));
        expect(v11Calls).toBe(0);
    }
});

// Synthetic, deterministic Uint8Arrays exercise the public injection contract;
// production entropy is deliberately not replaced with a Buffer-only fixture.
function sequence(seed = 1): (length: number) => Uint8Array {
    let serial = seed;

    return (length) => {
        const value = new Uint8Array(length);
        const n = serial++;

        if (length >= 4) {
            new DataView(value.buffer).setUint32(0, n);
        }

        return value;
    };
}

function createStore(options: Options = {}): Store {
    const store = new api.V12UploadedDataStore({
        now: () => 1_000_000,
        randomBytes: sequence(),
        ...options,
    });
    stores.push(store);
    return store;
}

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function uploaded(store: Store, name: string, data: string, sha?: string): string {
    const result = store.upload(name, data, sha);

    if (result.kind !== 'ok') {
        throw new Error(`expected a successful synthetic upload, got ${result.kind}`);
    }

    return result.fileId;
}

function expectStored(store: Store, id: string, name: string, bytes: Uint8Array): void {
    const result = store.get(id);
    expect(result.kind).toBe('ok');

    if (result.kind === 'ok') {
        // Boolean comparisons avoid placing synthetic file IDs or payloads in
        // assertion messages; no real account or secret is used by this test.
        expect(result.name === name).toBe(true);
        expect(result.data === b64(bytes)).toBe(true);
        expect(result.sha256 === digest(bytes)).toBe(true);
    }
}

function uploadUnknown(store: Store, name: unknown, data: unknown, sha?: unknown) {
    return store.upload(name as string, data as string, sha as string | undefined);
}

describe('v12 uploaded data store (isolated in-memory fixtures)', () => {
    it('round-trips an empty name and body, non-ASCII names and arbitrary binary bytes', () => {
        const store = createStore();
        const empty = new Uint8Array();
        const bytes = new Uint8Array([0, 255, 128, 1, 2, 3, 10, 13, 47, 92, 127]);
        const idEmpty = uploaded(store, '', '');
        const idBinary = uploaded(store, '非ASCII/🪶.bin', b64(bytes));
        expectStored(store, idEmpty, '', empty);
        expectStored(store, idBinary, '非ASCII/🪶.bin', bytes);
        expect(idEmpty !== idBinary).toBe(true);
    });

    it('performs upload, get and close without filesystem access', () => {
        const store = createStore();
        const promises = fs.promises;
        const fileGuards = [
            vi.spyOn(fs, 'openSync').mockImplementation(blocked),
            vi.spyOn(fs, 'readFileSync').mockImplementation(blocked),
            vi.spyOn(fs, 'writeFileSync').mockImplementation(blocked),
            vi.spyOn(fs, 'createReadStream').mockImplementation(blocked),
            vi.spyOn(fs, 'createWriteStream').mockImplementation(blocked),
            vi.spyOn(promises, 'open').mockImplementation(blocked),
            vi.spyOn(promises, 'readFile').mockImplementation(blocked),
            vi.spyOn(promises, 'writeFile').mockImplementation(blocked),
        ];
        let fileCalls: number[] = [];
        let uploadResult: ReturnType<Store['upload']> | undefined;
        let readResult: ReturnType<Store['get']> | undefined;
        let closeResult: unknown;

        try {
            uploadResult = store.upload('memory-only', 'AA==');

            if (uploadResult.kind === 'ok') {
                readResult = store.get(uploadResult.fileId);
            }

            closeResult = store.close();
        } finally {
            fileCalls = fileGuards.map((guard) => guard.mock.calls.length);

            for (const guard of fileGuards) {
                guard.mockRestore();
            }
        }

        expect(uploadResult?.kind).toBe('ok');
        expect(readResult?.kind).toBe('ok');
        expect(closeResult).toBeUndefined();
        expect(fileCalls).toEqual(fileCalls.map(() => 0));
    });

    it('generates prefixed canonical base64url identifiers from 32-byte Uint8Array draws', () => {
        const random = vi.fn(sequence());
        const store = createStore({ randomBytes: random });
        const bytes = new Uint8Array([0, 255, 128]);
        const first = uploaded(store, 'same', b64(bytes));
        const second = uploaded(store, 'same', b64(bytes));
        expect(first !== second).toBe(true);
        expect(random.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(random.mock.calls.every(([size]) => size === 32)).toBe(true);

        for (const id of [first, second]) {
            expect(id.startsWith(api.V12_UPLOAD_TOKEN_PREFIX)).toBe(true);
            expect(api.isV12UploadToken(id)).toBe(true);
            const suffix = id.slice(api.V12_UPLOAD_TOKEN_PREFIX.length);
            expect(/^[A-Za-z0-9_-]{43}$/.test(suffix)).toBe(true);
            const decoded = Buffer.from(suffix, 'base64url');
            expect(decoded.length).toBe(32);
            expect(decoded.toString('base64url') === suffix).toBe(true);
            expectStored(store, id, 'same', bytes);
        }
    });

    it('classifies only string prefixes, leaving malformed prefixed tokens for get to reject', () => {
        const store = createStore();
        const id = uploaded(store, 'name', 'AA==');
        const prefix = api.V12_UPLOAD_TOKEN_PREFIX;
        const trap = vi.fn(() => {
            throw new Error('unexpected object inspection');
        });
        const object = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });

        for (const value of [id, prefix, `${prefix}bad!`]) {
            expect(api.isV12UploadToken(value)).toBe(true);
        }

        for (const value of ['', 'v11-file-id', null, undefined, 1, object]) {
            expect(api.isV12UploadToken(value as string)).toBe(false);
        }

        for (const invalid of [null, undefined, 1, object]) {
            expect(store.get(invalid as string)).toEqual({ kind: 'not_found' });
        }

        expect(trap).not.toHaveBeenCalled();

        for (const malformed of [
            '',
            'foreign-file-id',
            prefix,
            `${prefix}!`,
            `${prefix}${'A'.repeat(42)}`,
            `${prefix}${'A'.repeat(44)}`,
            `${prefix}${'A'.repeat(42)}B`,
            `${prefix}${'A'.repeat(42)}=`,
            `${prefix}${'A'.repeat(42)}/`,
        ]) {
            expect(store.get(malformed)).toEqual({ kind: 'not_found' });
        }

        expectStored(store, id, 'name', new Uint8Array([0]));
    });

    it('enforces the name limit in UTF-16 code units and rejects non-string fields', () => {
        const store = createStore();
        const ascii = 'a'.repeat(4096);
        const astral = '🪶'.repeat(2048);
        const oneByte = new Uint8Array([0x41]);
        const first = uploaded(store, ascii, b64(oneByte));
        const second = uploaded(store, astral, b64(oneByte));
        expectStored(store, first, ascii, oneByte);
        expectStored(store, second, astral, oneByte);
        expect(store.upload(`${ascii}a`, 'QQ==')).toEqual({ kind: 'invalid' });
        expect(store.upload(`${astral}a`, 'QQ==')).toEqual({ kind: 'invalid' });

        for (const name of [null, undefined, 0, true, {}, new String('x')]) {
            expect(uploadUnknown(store, name, 'QQ==')).toEqual({ kind: 'invalid' });
        }

        for (const data of [null, undefined, 0, true, {}, new Uint8Array([1])]) {
            expect(uploadUnknown(store, 'name', data)).toEqual({ kind: 'invalid' });
        }
    });

    it('accepts canonical padded Base64 and rejects malformed or non-zero pad bits', () => {
        const store = createStore();

        for (const bytes of [
            new Uint8Array([0]),
            new Uint8Array([0, 0]),
            new Uint8Array([0, 0, 0]),
        ]) {
            const id = uploaded(store, 'canonical', b64(bytes));
            expectStored(store, id, 'canonical', bytes);
        }

        const malformed = [
            'A',
            'AA',
            'AA=',
            'AAA',
            'AAA==',
            'A===',
            'AAAA=',
            '=AAA',
            'AA=A',
            'AA==AA==',
            ' AA==',
            'AA== ',
            'AA==\n',
            'A A=',
            '@@==',
            '-_==',
            'AB==', // The low four unused bits must be zero.
            'AAB=', // The low two unused bits must be zero.
        ];

        for (const data of malformed) {
            expect(store.upload('name', data)).toEqual({ kind: 'invalid' });
        }
    });

    it('accepts exactly 256 KiB and rejects a larger decoded body without evicting the first', () => {
        const store = createStore();
        const maximum = new Uint8Array(FILE_BYTES);
        maximum[0] = 0xff;
        maximum[maximum.length - 1] = 0x81;
        const id = uploaded(store, 'maximum', b64(maximum));
        const oversized = new Uint8Array(FILE_BYTES + 1);
        expect(store.upload('too-large', b64(oversized))).toEqual({ kind: 'invalid' });
        expectStored(store, id, 'maximum', maximum);
    });

    it('checks optional SHA-256 against the bytes and requires canonical lowercase hex', () => {
        const store = createStore();
        const bytes = new Uint8Array([0, 255, 32, 42, 128]);
        const sha = digest(bytes);
        const implicit = uploaded(store, 'without-sha', b64(bytes));
        const explicit = uploaded(store, 'with-sha', b64(bytes), sha);
        expectStored(store, implicit, 'without-sha', bytes);
        expectStored(store, explicit, 'with-sha', bytes);

        for (const invalid of [
            '',
            sha.toUpperCase(),
            ` ${sha}`,
            `${sha} `,
            sha.slice(1),
            `${sha}0`,
            `${'g'}${sha.slice(1)}`,
            '0'.repeat(64),
            null,
            123,
            {},
        ]) {
            expect(uploadUnknown(store, 'bad-sha', b64(bytes), invalid)).toEqual({
                kind: 'invalid',
            });
        }

        expectStored(store, explicit, 'with-sha', bytes);
    });

    it('keeps stores independent and treats foreign, malformed, and closed IDs as distinct outcomes', () => {
        const first = createStore({ randomBytes: sequence(1) });
        const second = createStore({ randomBytes: sequence(100) });
        const payloadA = new Uint8Array([1]);
        const payloadB = new Uint8Array([2]);
        const idA = uploaded(first, 'a', b64(payloadA));
        const idB = uploaded(second, 'b', b64(payloadB));
        expect(first.get(idB)).toEqual({ kind: 'not_found' });
        expect(second.get(idA)).toEqual({ kind: 'not_found' });
        expect(first.get('not-an-upload-id')).toEqual({ kind: 'not_found' });
        expectStored(first, idA, 'a', payloadA);
        expectStored(second, idB, 'b', payloadB);
        expect(first.close()).toBeUndefined();
        expect(first.close()).toBeUndefined();
        expect(first.get(idA)).toEqual({ kind: 'unavailable' });
        expect(first.get('not-an-upload-id')).toEqual({ kind: 'unavailable' });
        expect(first.upload('after-close', '')).toEqual({ kind: 'unavailable' });
        expectStored(second, idB, 'b', payloadB);
        const idC = uploaded(second, 'c', '');
        expectStored(second, idC, 'c', new Uint8Array());
    });

    it('rejects the 33rd entry without evicting any of the first 32', () => {
        const store = createStore();
        const ids: string[] = [];

        for (let index = 0; index < 32; index++) {
            ids.push(uploaded(store, `entry-${index}`, ''));
        }

        expect(store.upload('overflow', '')).toEqual({ kind: 'capacity' });

        for (let index = 0; index < ids.length; index++) {
            expectStored(store, ids[index], `entry-${index}`, new Uint8Array());
        }
    });

    it('enforces the 4 MiB aggregate byte limit without evicting, counting decoded bytes', () => {
        const store = createStore();
        const chunk = new Uint8Array(FILE_BYTES);
        chunk[0] = 77;
        const body = b64(chunk);
        const ids: string[] = [];
        expect(TOTAL_BYTES / FILE_BYTES).toBe(16);

        for (let index = 0; index < 15; index++) {
            ids.push(uploaded(store, `chunk-${index}`, body));
        }

        const almost = new Uint8Array(FILE_BYTES - 1);
        const almostId = uploaded(store, 'almost', b64(almost));
        const finalId = uploaded(store, 'last-byte', 'AA==');
        expect(store.upload('overflow', 'AA==')).toEqual({ kind: 'capacity' });
        expectStored(store, ids[0], 'chunk-0', chunk);
        expectStored(store, ids[14], 'chunk-14', chunk);
        expectStored(store, almostId, 'almost', almost);
        expectStored(store, finalId, 'last-byte', new Uint8Array([0]));
        const emptyId = uploaded(store, 'empty-still-fits', '');
        expectStored(store, emptyId, 'empty-still-fits', new Uint8Array());
    });

    it('expires exactly at ten minutes, does not renew on reads, and keeps newer entries', () => {
        let now = 1_000_000;
        const store = createStore({ now: () => now });
        const id = uploaded(store, 'old', 'AA==');
        now++;
        const newer = uploaded(store, 'new', 'AQ==');
        now = 1_000_000 + TTL - 1;
        expectStored(store, id, 'old', new Uint8Array([0]));
        now++;
        expect(store.get(id)).toEqual({ kind: 'not_found' });
        expectStored(store, newer, 'new', new Uint8Array([1]));
        now += 2;
        expect(store.get(newer)).toEqual({ kind: 'not_found' });
    });

    it('keeps the default monotonic clock independent of wall-clock jumps', () => {
        vi.useFakeTimers({ toFake: ['Date'] });

        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const store = createStore({ now: undefined });
            const id = uploaded(store, 'default-clock', 'AA==');
            vi.setSystemTime(new Date('2050-01-01T00:00:00.000Z'));
            expectStored(store, id, 'default-clock', new Uint8Array([0]));
            vi.setSystemTime(new Date('2000-01-01T00:00:00.000Z'));
            expectStored(store, id, 'default-clock', new Uint8Array([0]));
        } finally {
            vi.useRealTimers();
        }
    });

    it('lazily reclaims both entry and byte capacity when expired', () => {
        let now = 1_000_000;
        const store = createStore({ now: () => now });
        const chunk = new Uint8Array(FILE_BYTES);
        const ids: string[] = [];

        for (let index = 0; index < 16; index++) {
            ids.push(uploaded(store, `full-${index}`, b64(chunk)));
        }

        expect(store.upload('blocked', 'AA==')).toEqual({ kind: 'capacity' });
        now += TTL;
        const fresh = uploaded(store, 'fresh', b64(chunk));
        expect(store.get(ids[0])).toEqual({ kind: 'not_found' });
        expectStored(store, fresh, 'fresh', chunk);

        const countStore = createStore({ now: () => now });
        const oldIds: string[] = [];

        for (let index = 0; index < 32; index++) {
            oldIds.push(uploaded(countStore, `old-${index}`, ''));
        }

        expect(countStore.upload('blocked', '')).toEqual({ kind: 'capacity' });
        now += TTL + 1;
        const newId = uploaded(countStore, 'new', '');
        expect(countStore.get(oldIds[0])).toEqual({ kind: 'not_found' });
        expectStored(countStore, newId, 'new', new Uint8Array());
    });

    it.each(['rollback', 'nan', 'infinity', 'throw'] as const)(
        'fails closed on a %s clock during get and upload',
        (mode) => {
            let now = 1_000_000;
            let throws = false;
            const store = createStore({
                now: () => {
                    if (throws) {
                        throw new Error('synthetic clock fault');
                    }

                    return now;
                },
            });
            const id = uploaded(store, 'before-clock-fault', 'AA==');

            if (mode === 'rollback') {
                now--;
            } else if (mode === 'nan') {
                now = NaN;
            } else if (mode === 'infinity') {
                now = Infinity;
            } else {
                throws = true;
            }

            expect(store.get(id)).toEqual({ kind: 'unavailable' });
            expect(store.upload('during-clock-fault', 'AQ==')).toEqual({ kind: 'unavailable' });
        },
    );

    it.each(['throw', 'short', 'long', 'wrong-type', 'shared'] as const)(
        'returns unavailable for a %s random source without altering an existing entry',
        (mode) => {
            const good = sequence();
            let fail = false;
            const store = createStore({
                randomBytes: (size) => {
                    if (!fail) {
                        return good(size);
                    }

                    if (mode === 'throw') {
                        throw new Error('synthetic entropy fault');
                    }

                    if (mode === 'short') {
                        return new Uint8Array(size - 1);
                    }

                    if (mode === 'long') {
                        return new Uint8Array(size + 1);
                    }

                    if (mode === 'wrong-type') {
                        return new Array(size).fill(0) as unknown as Uint8Array;
                    }

                    return new Uint8Array(new SharedArrayBuffer(size));
                },
            });
            const id = uploaded(store, 'retained', 'AA==');
            fail = true;
            expect(store.upload('rejected', 'AQ==')).toEqual({ kind: 'unavailable' });
            expectStored(store, id, 'retained', new Uint8Array([0]));
        },
    );

    it('stops after four colliding identifier draws and retains the existing file', () => {
        const fixed = vi.fn((size: number) => new Uint8Array(size));
        const store = createStore({ randomBytes: fixed });
        const id = uploaded(store, 'original', 'AA==');
        const before = fixed.mock.calls.length;
        expect(store.upload('collision', 'AQ==')).toEqual({ kind: 'unavailable' });
        expect(fixed.mock.calls.length - before).toBe(4);
        expectStored(store, id, 'original', new Uint8Array([0]));
    });

    it.each(['upload', 'get'] as const)(
        'rejects synchronous nested upload/get from the clock during an outer %s',
        (outer) => {
            let store!: Store;
            let id = '';
            let armed = false;
            let nestedUpload: unknown;
            let nestedGet: unknown;
            store = createStore({
                now: () => {
                    if (armed) {
                        armed = false;
                        nestedUpload = store.upload('nested', 'AQ==');
                        nestedGet = store.get(id);
                    }

                    return 1_000_000;
                },
            });
            id = uploaded(store, 'existing', 'AA==');
            armed = true;

            if (outer === 'upload') {
                const next = uploaded(store, 'outer', 'Ag==');
                expectStored(store, next, 'outer', new Uint8Array([2]));
            } else {
                expectStored(store, id, 'existing', new Uint8Array([0]));
            }

            expect(nestedUpload).toEqual({ kind: 'unavailable' });
            expect(nestedGet).toEqual({ kind: 'unavailable' });
            expectStored(store, id, 'existing', new Uint8Array([0]));
        },
    );

    it('rejects synchronous nested upload/get from the random source', () => {
        let store!: Store;
        let id = '';
        let armed = false;
        let nestedUpload: unknown;
        let nestedGet: unknown;
        const next = sequence();
        store = createStore({
            randomBytes: (size) => {
                if (armed) {
                    armed = false;
                    nestedUpload = store.upload('nested', 'AQ==');
                    nestedGet = store.get(id);
                }

                return next(size);
            },
        });
        id = uploaded(store, 'existing', 'AA==');
        armed = true;
        const outer = uploaded(store, 'outer', 'Ag==');
        expect(nestedUpload).toEqual({ kind: 'unavailable' });
        expect(nestedGet).toEqual({ kind: 'unavailable' });
        expectStored(store, id, 'existing', new Uint8Array([0]));
        expectStored(store, outer, 'outer', new Uint8Array([2]));
    });

    it('honors optional commit/read guards, including false and thrown outcomes', () => {
        const store = createStore();
        const allowUpload = vi.fn(() => true);
        const allowRead = vi.fn(() => true);
        const denied = () => false;

        const fail = () => {
            throw new Error('synthetic guard failure');
        };

        const result = store.upload('guarded', 'AA==', undefined, allowUpload);
        expect(result.kind).toBe('ok');

        if (result.kind !== 'ok') {
            throw new Error('expected guarded upload to succeed');
        }

        const id = result.fileId;
        const read = store.get(id, allowRead);
        expect(read.kind).toBe('ok');
        expect(allowUpload).toHaveBeenCalled();
        expect(allowRead).toHaveBeenCalled();
        expect(store.upload('denied', 'AQ==', undefined, denied)).toEqual({ kind: 'unavailable' });
        expect(store.upload('throws', 'AQ==', undefined, fail)).toEqual({ kind: 'unavailable' });
        expect(store.get(id, denied)).toEqual({ kind: 'unavailable' });
        expect(store.get(id, fail)).toEqual({ kind: 'unavailable' });
        expectStored(store, id, 'guarded', new Uint8Array([0]));

        // A rejected guard must not leave an entry occupying capacity.
        for (let index = 0; index < 31; index++) {
            uploaded(store, `remaining-${index}`, '');
        }

        expect(store.upload('full', '')).toEqual({ kind: 'capacity' });
    });

    it.each(['upload', 'get'] as const)(
        'rejects nested upload/get inside the %s guard without affecting the outer operation',
        (outer) => {
            const store = createStore();
            const existing = uploaded(store, 'existing', 'AA==');
            let nestedUpload: unknown;
            let nestedGet: unknown;

            const guard = () => {
                nestedUpload = store.upload('nested', 'AQ==');
                nestedGet = store.get(existing);
                return true;
            };

            const result =
                outer === 'upload'
                    ? store.upload('outer', 'Ag==', undefined, guard)
                    : store.get(existing, guard);
            expect(result.kind).toBe('ok');
            expect(nestedUpload).toEqual({ kind: 'unavailable' });
            expect(nestedGet).toEqual({ kind: 'unavailable' });
            expectStored(store, existing, 'existing', new Uint8Array([0]));
        },
    );

    it.each(['upload', 'get'] as const)(
        'keeps the store closed when the %s guard closes it before returning true',
        (outer) => {
            const store = createStore();
            const existing = uploaded(store, 'existing', 'AA==');
            let calls = 0;

            const guard = () => {
                calls++;
                store.close();
                return true;
            };

            const result =
                outer === 'upload'
                    ? store.upload('outer', 'AQ==', undefined, guard)
                    : store.get(existing, guard);
            expect(calls).toBeGreaterThan(0);
            expect(result).toEqual({ kind: 'unavailable' });
            expect(store.get(existing)).toEqual({ kind: 'unavailable' });
            expect(store.upload('after-close', '')).toEqual({ kind: 'unavailable' });
        },
    );

    it('preserves caller-owned Uint8Array random-source fixtures', () => {
        const source = new Uint8Array(32);

        for (let index = 0; index < source.length; index++) {
            source[index] = index + 1;
        }

        const original = new Uint8Array(source);
        const store = createStore({ randomBytes: () => source });
        const id = uploaded(store, 'owned-by-caller', 'AQ==');
        expectStored(store, id, 'owned-by-caller', new Uint8Array([1]));
        expect(source.every((value, index) => value === original[index])).toBe(true);
        store.close();
        expect(source.every((value, index) => value === original[index])).toBe(true);
    });

    it('seals immediately and continues best-effort zero filling after one cleanup fault', async () => {
        const originalFill = Uint8Array.prototype.fill;
        const attempted = new Set<Uint8Array>();
        const wiped = new Set<Uint8Array>();
        const ids: string[] = [];
        let store!: Store;
        let result: unknown;
        let armed = false;
        let injected = false;
        const arraySpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            ...args: unknown[]
        ) {
            if (armed && args[0] === 0) {
                attempted.add(this);

                if (!injected) {
                    injected = true;
                    throw new Error('synthetic zero-fill failure');
                }
            }

            const output = Reflect.apply(originalFill, this, args) as Uint8Array;

            if (armed && args[0] === 0) {
                wiped.add(this);
            }

            return output;
        } as typeof Uint8Array.prototype.fill);

        try {
            // Install the observer before evaluating the module: a captured
            // intrinsic remains independent of later prototype modifications.
            vi.resetModules();
            const fresh = await import('../../src/v12/uploaded-data-store');
            store = new fresh.V12UploadedDataStore({
                now: () => 1_000_000,
                randomBytes: sequence(),
            });
            stores.push(store);

            for (const size of [17, 23, 29]) {
                const bytes = new Uint8Array(size);
                bytes.fill(size);
                ids.push(uploaded(store, `wipe-${size}`, b64(bytes)));
            }

            armed = true;
            result = store.close();
        } finally {
            armed = false;
            arraySpy.mockRestore();
            vi.resetModules();
        }

        expect(result).toBeUndefined();
        expect(injected).toBe(true);
        expect(attempted.size).toBeGreaterThanOrEqual(3);
        expect(wiped.size).toBeGreaterThanOrEqual(2);
        expect([...wiped].every((value) => value.every((byte) => byte === 0))).toBe(true);

        for (const id of ids) {
            expect(store.get(id)).toEqual({ kind: 'unavailable' });
        }
    });

    it.each(['upload-clock', 'get-clock', 'upload-random'] as const)(
        'does not commit or return stored data when close is reentered via %s',
        (where) => {
            let store!: Store;
            let armed = false;
            const next = sequence();
            store = createStore({
                now: () => {
                    if (armed && where !== 'upload-random') {
                        armed = false;
                        store.close();
                    }

                    return 1_000_000;
                },
                randomBytes: (size) => {
                    if (armed && where === 'upload-random') {
                        armed = false;
                        store.close();
                    }

                    return next(size);
                },
            });
            const existing = uploaded(store, 'existing', 'AA==');
            armed = true;
            const result =
                where === 'get-clock' ? store.get(existing) : store.upload('outer', 'AQ==');
            expect(result).toEqual({ kind: 'unavailable' });
            expect(armed).toBe(false);
            expect(store.get(existing)).toEqual({ kind: 'unavailable' });
            expect(store.upload('after-close', '')).toEqual({ kind: 'unavailable' });
        },
    );
});
