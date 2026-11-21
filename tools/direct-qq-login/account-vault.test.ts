import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
    openAccountVault,
    AccountVaultError,
    ACCOUNT_VAULT_MAX_PAYLOAD_BYTES,
    type AccountVault,
    type VaultBinding,
    type VaultGuard,
} from './account-vault';

// In-memory POSIX fault model, real Node crypto. These tests run on Windows too;
// real permissions/flock/process restart are tested separately on Linux.
interface NodeEntry {
    kind: 'file' | 'dir' | 'link' | 'fifo';
    bytes: Buffer;
    mode: number;
    uid: number;
    ino: number;
    nlink: number;
    time: number;
    lock?: number;
    size?: number;
}
interface OpenEntry {
    name: string;
    node: NodeEntry;
    closed: boolean;
}
const sim = vi.hoisted(() => ({
    platform: 'linux',
    nodes: new Map<string, NodeEntry>(),
    handles: new Map<number, OpenEntry>(),
    nextInode: 1,
    nextFd: 10,
    clock: 1,
    shortWrite: Number.MAX_SAFE_INTEGER,
    shortRead: Number.MAX_SAFE_INTEGER,
    helperCode: undefined as number | undefined,
    cryptoFault: undefined as 'random' | 'short-random' | 'cipher' | 'final' | undefined,
    derivedKeys: [] as Buffer[],
    decryptedParts: [] as Buffer[],
    randomValues: [] as Buffer[],
    operations: [] as { op: string; name: string }[],
    onOperation: undefined as ((op: string, name: string) => void | Promise<void>) | undefined,
}));
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return {
        ...actual,
        randomBytes(size: number) {
            if (sim.cryptoFault === 'random') {
                throw new Error('synthetic crypto failure');
            }

            const value = actual.randomBytes(sim.cryptoFault === 'short-random' ? size - 1 : size);
            sim.randomValues.push(value);
            return value;
        },
        createCipheriv(...args: Parameters<typeof actual.createCipheriv>) {
            if (Buffer.isBuffer(args[1])) {
                sim.derivedKeys.push(args[1]);
            }

            if (sim.cryptoFault === 'cipher') {
                throw new Error('synthetic crypto failure');
            }

            return actual.createCipheriv(...args);
        },
        createDecipheriv(...args: Parameters<typeof actual.createDecipheriv>) {
            if (Buffer.isBuffer(args[1])) {
                sim.derivedKeys.push(args[1]);
            }

            const decipher = actual.createDecipheriv(...args);
            const update = decipher.update.bind(decipher);
            const final = decipher.final.bind(decipher);
            decipher.update = ((...values: Parameters<typeof update>) => {
                const output = update(...values);

                if (Buffer.isBuffer(output)) {
                    sim.decryptedParts.push(output);
                }

                return output;
            }) as typeof decipher.update;
            decipher.final = ((...values: Parameters<typeof final>) => {
                if (sim.cryptoFault === 'final') {
                    throw new Error('synthetic final failure');
                }

                return final(...values);
            }) as typeof decipher.final;
            return decipher;
        },
    };
});
vi.mock('node:os', () => ({ platform: () => sim.platform, userInfo: () => ({ uid: 1000 }) }));
vi.mock('node:fs', () => ({
    constants: {
        O_RDONLY: 0,
        O_WRONLY: 1,
        O_RDWR: 2,
        O_CREAT: 64,
        O_EXCL: 128,
        O_NOFOLLOW: 131072,
        O_NONBLOCK: 2048,
        O_DIRECTORY: 65536,
    },
}));
vi.mock('node:fs/promises', () => {
    const error = (code: string) =>
        Object.assign(new Error('synthetic private filesystem error'), { code });
    const stat = (node: NodeEntry) => ({
        mode: node.mode,
        uid: node.uid,
        ino: node.ino,
        dev: 1,
        nlink: node.nlink,
        size: node.size ?? node.bytes.length,
        mtimeMs: node.time,
        ctimeMs: node.time,
        isDirectory: () => node.kind === 'dir',
        isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'link',
    });

    const op = async (operation: string, name: string) => {
        sim.operations.push({ op: operation, name });
        await sim.onOperation?.(operation, name);
    };

    const get = (name: string) => {
        const node = sim.nodes.get(name);

        if (!node) {
            throw error('ENOENT');
        }

        return node;
    };

    const anchoredName = (name: string) => {
        const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(name);

        if (!match) {
            return name;
        }

        const directory = sim.handles.get(Number(match[1]));

        if (!directory || directory.closed || directory.node.kind !== 'dir') {
            throw error('EBADF');
        }

        if (sim.nodes.get(directory.name) !== directory.node) {
            throw error('ESTALE');
        }

        sim.operations.push({ op: 'fd-relative', name });
        return `${directory.name}/${match[2]}`;
    };

    return {
        lstat: async (name: string) => {
            name = anchoredName(name);
            await op('lstat', name);
            return stat(get(name));
        },
        mkdir: async (name: string, options: { mode: number }) => {
            await op('mkdir', name);

            if (sim.nodes.has(name)) {
                throw error('EEXIST');
            }

            sim.nodes.set(name, {
                kind: 'dir',
                bytes: Buffer.alloc(0),
                mode: options.mode,
                uid: 1000,
                ino: sim.nextInode++,
                nlink: 2,
                time: sim.clock++,
            });
        },
        open: async (name: string, flags: number, mode?: number) => {
            name = anchoredName(name);
            await op('open', name);
            let node = sim.nodes.get(name);

            if ((flags & 64) !== 0) {
                if (node && (flags & 128) !== 0) {
                    throw error('EEXIST');
                }

                if (!node) {
                    node = {
                        kind: 'file',
                        bytes: Buffer.alloc(0),
                        mode: mode ?? 0o644,
                        uid: 1000,
                        ino: sim.nextInode++,
                        nlink: 1,
                        time: sim.clock++,
                    };
                    sim.nodes.set(name, node);
                }
            }

            if (!node) {
                throw error('ENOENT');
            }

            if (node.kind === 'link' && (flags & 131072) !== 0) {
                throw error('ELOOP');
            }

            if ((flags & 65536) !== 0 && node.kind !== 'dir') {
                throw error('ENOTDIR');
            }

            const fd = sim.nextFd++;
            const entry: OpenEntry = { name, node, closed: false };
            sim.handles.set(fd, entry);

            const active = () => {
                if (entry.closed) {
                    throw error('EBADF');
                }
            };

            return {
                fd,
                stat: async () => {
                    active();
                    await op('fstat', name);
                    return stat(entry.node);
                },
                read: async (target: Buffer, offset: number, length: number, position: number) => {
                    active();
                    await op('read', name);
                    const count = Math.max(
                        0,
                        Math.min(length, sim.shortRead, entry.node.bytes.length - position),
                    );
                    entry.node.bytes.copy(target, offset, position, position + count);
                    return { bytesRead: count, buffer: target };
                },
                write: async (source: Buffer, offset: number, length: number, position: number) => {
                    active();
                    await op('write', name);
                    const count = Math.min(length, sim.shortWrite);
                    const next = Buffer.alloc(Math.max(entry.node.bytes.length, position + count));
                    entry.node.bytes.copy(next);
                    source.copy(next, position, offset, offset + count);
                    entry.node.bytes = next;
                    entry.node.time = sim.clock++;
                    return { bytesWritten: count, buffer: source };
                },
                sync: async () => {
                    active();
                    await op('sync', name);
                },
                close: async () => {
                    await op('close', name);
                    entry.closed = true;

                    if (entry.node.lock === fd) {
                        delete entry.node.lock;
                    }
                },
            };
        },
        readdir: async (name: string) => {
            await op('readdir', name);
            return [...sim.nodes.keys()]
                .filter(
                    (key) =>
                        key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes('/'),
                )
                .map((key) => key.slice(name.length + 1));
        },
        rename: async (from: string, to: string) => {
            await op('rename', from);
            const node = get(from);
            sim.nodes.set(to, node);
            sim.nodes.delete(from);
        },
        unlink: async (name: string) => {
            name = anchoredName(name);
            await op('unlink', name);
            get(name);
            sim.nodes.delete(name);
        },
    };
});
vi.mock('node:child_process', async () => {
    const { EventEmitter } = await import('node:events');
    return {
        spawn: (command: string, args: string[], options: { stdio: unknown[]; shell: boolean }) => {
            expect(command).toBe('/usr/bin/flock');
            expect(args).toEqual(['-n', '-E', '75', '3']);
            expect(options.shell).toBe(false);
            expect(options.stdio.slice(0, 3)).toEqual(['ignore', 'ignore', 'ignore']);
            const child = new EventEmitter();
            const fd = options.stdio[3] as number;
            const entry = sim.handles.get(fd)!;
            queueMicrotask(() => {
                const code = sim.helperCode ?? (entry.node.lock === undefined ? 0 : 75);

                if (code === 0) {
                    entry.node.lock = fd;
                }

                child.emit('close', code);
            });
            return Object.assign(child, { kill: () => true });
        },
    };
});

const roots = { vaultRoot: '/home/lab/vault', keyRoot: '/home/lab/keys', slotId: 'a'.repeat(32) };
const file = `${roots.vaultRoot}/${roots.slotId}.vault`;
const masterFile = `${roots.keyRoot}/master.key`;
const marker = Buffer.from('synthetic-private-ticket-only-in-memory');
const owners: AccountVault[] = [];
const binding = (): VaultBinding => ({
    uin: '123456789',
    profileDigest: Buffer.alloc(32, 0x21),
    deviceDigest: Buffer.alloc(32, 0x32),
});
const guard = (controller = new AbortController()): VaultGuard => ({
    signal: controller.signal,
    isCurrent: () => true,
});

const openVault = async (initialize = true, slotId = roots.slotId) => {
    const owner = await openAccountVault({ ...roots, slotId, initialize });
    owners.push(owner);
    return owner;
};

const exception = (code = 'EIO') => Object.assign(new Error('synthetic fault'), { code });
const contents = () => Buffer.from(sim.nodes.get(file)!.bytes);
const tempNames = () => [...sim.nodes.keys()].filter((key) => key.includes('/.tmp-'));

function insert(name: string, kind: NodeEntry['kind'] = 'dir', mode = 0o700, uid = 1000) {
    const node: NodeEntry = {
        kind,
        mode,
        uid,
        bytes: Buffer.alloc(0),
        ino: sim.nextInode++,
        nlink: kind === 'dir' ? 2 : 1,
        time: sim.clock++,
    };
    sim.nodes.set(name, node);
    return node;
}

beforeEach(() => {
    sim.nodes.clear();
    sim.handles.clear();
    sim.operations.length = 0;
    sim.platform = 'linux';
    sim.nextInode = 1;
    sim.nextFd = 10;
    sim.clock = 1;
    sim.shortWrite = Number.MAX_SAFE_INTEGER;
    sim.shortRead = Number.MAX_SAFE_INTEGER;
    sim.helperCode = undefined;
    sim.cryptoFault = undefined;
    sim.derivedKeys.length = 0;
    sim.decryptedParts.length = 0;
    sim.randomValues.length = 0;
    sim.onOperation = undefined;
    insert('/', 'dir', 0o755, 0);
    insert('/home', 'dir', 0o755, 0);
    insert('/home/lab');
});
afterEach(async () => {
    sim.onOperation = undefined;
    await Promise.all(owners.splice(0).map((owner) => owner.close()));
    vi.restoreAllMocks();
});

describe('account vault explicit entry and binary storage', () => {
    it('fails on non-Linux before reading options or filesystem', async () => {
        sim.platform = 'win32';
        const getter = vi.fn(() => {
            throw new Error('must not run');
        });
        await expect(
            openAccountVault(Object.defineProperty({}, 'vaultRoot', { get: getter }) as never),
        ).rejects.toMatchObject({ code: 'platform-unsupported' });
        expect(getter).not.toHaveBeenCalled();
        expect(sim.operations).toEqual([]);
    });
    it.each([
        { vaultRoot: 'relative' },
        { vaultRoot: '/home/lab/../vault' },
        { vaultRoot: roots.keyRoot },
        { keyRoot: `${roots.vaultRoot}/keys` },
        { slotId: '../' },
        { initialize: undefined },
    ])('rejects bad explicit config before effects %j', async (patch) => {
        await expect(
            openAccountVault({ ...roots, initialize: true, ...patch } as never),
        ).rejects.toMatchObject({ code: 'invalid-input' });
        expect(sim.operations).toEqual([]);
    });
    it('creates separate private master and metadata only when initialized', async () => {
        await openVault();
        expect(sim.nodes.get(roots.vaultRoot)?.mode).toBe(0o700);
        expect(sim.nodes.get(roots.keyRoot)?.mode).toBe(0o700);
        expect(sim.nodes.get(masterFile)?.mode).toBe(0o600);
        expect(sim.nodes.get(masterFile)?.bytes.length).toBe(64);
        expect(sim.nodes.get(`${roots.vaultRoot}/.vault.id`)?.bytes.length).toBe(32);
        expect(sim.nodes.has(file)).toBe(false);
    });
    it('round-trips opaque bytes, wipes borrowed payload and keeps state after close/reopen', async () => {
        const owner = await openVault();
        expect(
            await owner.read(binding(), () => {
                throw new Error();
            }),
        ).toEqual({ kind: 'missing' });
        const revision = await owner.save(binding(), marker, null, guard());
        expect(revision.generation).toBe(1n);
        expect(revision.recordHash).toMatch(/^[a-f0-9]{64}$/);
        expect(contents().includes(marker)).toBe(false);
        let borrowed: Uint8Array | undefined;
        const result = await owner.read(binding(), (bytes, actual) => {
            borrowed = bytes;
            expect(actual).toEqual(revision);
            return Buffer.from(bytes);
        });
        expect(result).toMatchObject({ kind: 'present', value: marker, revision });
        expect(borrowed).toEqual(Buffer.alloc(marker.length));
        const before = contents();
        await owner.close();
        const reopened = await openVault(false);
        expect(await reopened.read(binding(), (bytes) => Buffer.from(bytes))).toMatchObject({
            value: marker,
        });
        expect(contents()).toEqual(before);
    });
    it('copies binding and payload before first await, including a subview', async () => {
        const owner = await openVault();
        const current = binding();
        const backing = Buffer.from([9, 1, 2, 3, 9]);
        const promise = owner.save(current, backing.subarray(1, 4), null, guard());
        backing.fill(0);
        current.profileDigest.fill(0);
        current.deviceDigest.fill(0);
        await promise;
        expect(await owner.read(binding(), (bytes) => Array.from(bytes))).toMatchObject({
            value: [1, 2, 3],
        });
    });
    it('uses fresh salt and nonce for consecutive equal payloads', async () => {
        const owner = await openVault();
        const first = await owner.save(binding(), marker, null, guard());
        const before = contents();
        const second = await owner.save(binding(), marker, first, guard());
        const after = contents();
        expect(second.generation).toBe(2n);
        expect(after.subarray(116, 148)).not.toEqual(before.subarray(116, 148));
        expect(after.subarray(148, 160)).not.toEqual(before.subarray(148, 160));
    });
    it.each([
        Buffer.alloc(0),
        Buffer.alloc(ACCOUNT_VAULT_MAX_PAYLOAD_BYTES + 1),
        new Uint8Array(new SharedArrayBuffer(4)),
    ])('rejects empty/oversize/shared payload before effects', async (payload) => {
        const owner = await openVault();
        sim.operations.length = 0;
        await expect(owner.save(binding(), payload, null, guard())).rejects.toMatchObject({
            code: 'invalid-input',
        });
        expect(sim.operations).toEqual([]);
    });
    it('accepts the exact payload cap', async () => {
        const owner = await openVault();
        await owner.save(
            binding(),
            Buffer.alloc(ACCOUNT_VAULT_MAX_PAYLOAD_BYTES, 7),
            null,
            guard(),
        );
        expect(await owner.read(binding(), (bytes) => bytes.length)).toMatchObject({
            value: ACCOUNT_VAULT_MAX_PAYLOAD_BYTES,
        });
    });
    it.each(['0', '01', '4294967296', '-1', '1e3'])('validates UIN %s', async (uin) => {
        const owner = await openVault();
        await expect(
            owner.save({ ...binding(), uin }, marker, null, guard()),
        ).rejects.toMatchObject({ code: 'invalid-input' });
    });
    it('does not invoke accessor inputs or proxy traps', async () => {
        const owner = await openVault();
        const getter = vi.fn(() => {
            throw new Error();
        });
        const value = Object.defineProperty(binding(), 'uin', { get: getter });
        await expect(owner.save(value, marker, null, guard())).rejects.toMatchObject({
            code: 'invalid-input',
        });
        expect(getter).not.toHaveBeenCalled();
        const trap = vi.fn(() => {
            throw new Error();
        });
        await expect(
            owner.save(new Proxy(binding(), { get: trap }), marker, null, guard()),
        ).rejects.toMatchObject({ code: 'invalid-input' });
        expect(trap).not.toHaveBeenCalled();
    });
});

describe('authenticated parsing and private paths', () => {
    it.each([0, 8, 9, 10, 12, 20, 52, 68, 84, 116, 148, 160, 164, 180])(
        'does not call consume after tamper at offset %i',
        async (offset) => {
            const owner = await openVault();
            await owner.save(binding(), marker, null, guard());
            sim.nodes.get(file)!.bytes[offset] ^= 0x40;
            const callback = vi.fn();
            await expect(owner.read(binding(), callback)).rejects.toBeInstanceOf(AccountVaultError);
            expect(callback).not.toHaveBeenCalled();
            const tampered = contents();
            await expect(owner.save(binding(), marker, null, guard())).rejects.toBeInstanceOf(
                AccountVaultError,
            );
            expect(contents()).toEqual(tampered);
        },
    );
    it.each(['uin', 'profileDigest', 'deviceDigest'] as const)('binds %s', async (field) => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        const wrong = { ...binding(), [field]: field === 'uin' ? '9' : Buffer.alloc(32, 0x99) };
        await expect(owner.read(wrong, () => 1)).rejects.toMatchObject({
            code: 'binding-mismatch',
        });
    });
    it('binds slot and vault identity', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        const original = sim.nodes.get(file)!;
        await owner.close();
        const other = await openVault(false, 'b'.repeat(32));
        sim.nodes.set(`${roots.vaultRoot}/${'b'.repeat(32)}.vault`, {
            ...original,
            bytes: Buffer.from(original.bytes),
        });
        await expect(other.read(binding(), () => 1)).rejects.toMatchObject({
            code: 'binding-mismatch',
        });
    });
    it.each(['link', 'fifo'] as const)('blocks %s files without reading them', async (kind) => {
        const owner = await openVault();
        insert(file, kind, 0o600);
        sim.operations.length = 0;
        await expect(owner.read(binding(), () => 1)).rejects.toMatchObject({ code: 'path-policy' });
        expect(sim.operations.some((op) => op.op === 'read' && op.name === file)).toBe(false);
    });
    it.each([{ mode: 0o644 }, { mode: 0o700 }, { uid: 1001 }, { nlink: 2 }])(
        'blocks unsafe files %j',
        async (patch) => {
            const owner = await openVault();
            await owner.save(binding(), marker, null, guard());
            Object.assign(sim.nodes.get(file)!, patch);
            await expect(owner.read(binding(), () => 1)).rejects.toMatchObject({
                code: 'path-policy',
            });
        },
    );
    it.each([
        { name: '/home/lab', mode: 0o777 },
        { name: roots.vaultRoot, mode: 0o755 },
        { name: roots.keyRoot, mode: 0o755 },
    ])('blocks unsafe ancestors and roots %j', async ({ name, mode }) => {
        const node = sim.nodes.get(name) ?? insert(name);
        node.mode = mode;
        await expect(openVault()).rejects.toMatchObject({ code: 'path-policy' });
    });
    it('blocks parent symlinks', async () => {
        sim.nodes.get('/home/lab')!.kind = 'link';
        await expect(openVault()).rejects.toMatchObject({ code: 'path-policy' });
    });
    it('detects inode replacement between lstat and open', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());

        sim.onOperation = (op, name) => {
            if (op === 'open' && name === file) {
                sim.nodes.set(file, { ...sim.nodes.get(file)!, ino: sim.nextInode++ });
            }
        };

        await expect(owner.read(binding(), () => 1)).rejects.toMatchObject({ code: 'path-policy' });
    });
    it('bounds a file that grows after stat', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        let changed = false;

        sim.onOperation = (op, name) => {
            if (!changed && op === 'read' && name === file) {
                changed = true;
                sim.nodes.get(file)!.bytes = Buffer.alloc(ACCOUNT_VAULT_MAX_PAYLOAD_BYTES + 4096);
            }
        };

        await expect(owner.read(binding(), () => 1)).rejects.toMatchObject({ code: 'path-policy' });
    });
    it('does not read an already oversize sparse file', async () => {
        const owner = await openVault();
        insert(file, 'file', 0o600).size = Number.MAX_SAFE_INTEGER;
        sim.operations.length = 0;
        await expect(owner.read(binding(), () => 1)).rejects.toMatchObject({
            code: 'format-invalid',
        });
        expect(sim.operations.some((op) => op.op === 'open' && op.name === file)).toBe(false);
    });
    it.each(['missing', 'short', 'changed', 'readable'] as const)(
        'does not reset %s master',
        async (kind) => {
            const owner = await openVault();
            await owner.save(binding(), marker, null, guard());
            const original = contents();

            if (kind === 'missing') {
                sim.nodes.delete(masterFile);
            }

            if (kind === 'short') {
                sim.nodes.get(masterFile)!.bytes = Buffer.alloc(3);
            }

            if (kind === 'changed') {
                sim.nodes.get(masterFile)!.bytes[40] ^= 1;
            }

            if (kind === 'readable') {
                sim.nodes.get(masterFile)!.mode = 0o644;
            }

            await expect(owner.read(binding(), () => 1)).rejects.toBeInstanceOf(AccountVaultError);
            await owner.close();

            if (kind !== 'changed') {
                await expect(openVault(true)).rejects.toBeInstanceOf(AccountVaultError);
            } else {
                const reopened = await openVault(true);
                await expect(reopened.read(binding(), () => 1)).rejects.toMatchObject({
                    code: 'auth-failed',
                });
            }

            expect(contents()).toEqual(original);
        },
    );
});

describe('CAS, cancellation and synchronous ownership', () => {
    it('rejects stale expected revisions without overwriting', async () => {
        const owner = await openVault();
        const first = await owner.save(binding(), marker, null, guard());
        const second = await owner.save(binding(), Buffer.from([1]), first, guard());
        const before = contents();
        await expect(owner.save(binding(), marker, first, guard())).rejects.toMatchObject({
            code: 'revision-conflict',
        });
        await expect(owner.save(binding(), marker, null, guard())).rejects.toMatchObject({
            code: 'revision-conflict',
        });
        expect(contents()).toEqual(before);
        expect(second.generation).toBe(2n);
    });
    it('serializes equal-revision saves so exactly one wins', async () => {
        const owner = await openVault();
        const first = owner.save(binding(), Buffer.from([1]), null, guard());
        const second = owner.save(binding(), Buffer.from([2]), null, guard());
        const results = await Promise.allSettled([first, second]);
        expect(results[0].status).toBe('fulfilled');
        expect(results[1]).toMatchObject({
            status: 'rejected',
            reason: { code: 'revision-conflict' },
        });
    });
    it('rejects aborted and stale guards before storage IO', async () => {
        const owner = await openVault();
        sim.operations.length = 0;
        const controller = new AbortController();
        controller.abort();
        await expect(owner.save(binding(), marker, null, guard(controller))).rejects.toMatchObject({
            code: 'cancelled',
        });
        await expect(
            owner.save(binding(), marker, null, { ...guard(), isCurrent: () => false }),
        ).rejects.toMatchObject({ code: 'stale' });
        expect(sim.operations).toEqual([]);
    });
    it('cleans temp and preserves old record if cancelled at temp sync', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());
        const before = contents();
        const controller = new AbortController();

        sim.onOperation = (op, name) => {
            if (op === 'sync' && name.includes('/.tmp-')) {
                controller.abort();
            }
        };

        await expect(
            owner.save(binding(), Buffer.from([8]), revision, guard(controller)),
        ).rejects.toMatchObject({ code: 'cancelled' });
        expect(contents()).toEqual(before);
        expect(tempNames()).toEqual([]);
    });
    it('runs the guard again after a callback closes the owner', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        let borrowed: Uint8Array | undefined;
        await expect(
            owner.read(binding(), (bytes) => {
                borrowed = bytes;
                void owner.close();
                return 4;
            }),
        ).rejects.toMatchObject({ code: 'closed' });
        expect(borrowed).toEqual(Buffer.alloc(marker.length));
    });
    it('wipes borrowed buffers on callback throw and rejects asynchronous consumers', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        let borrowed: Uint8Array | undefined;
        await expect(
            owner.read(binding(), (bytes) => {
                borrowed = bytes;
                throw exception();
            }),
        ).rejects.toMatchObject({ code: 'io' });
        expect(borrowed).toEqual(Buffer.alloc(marker.length));
        await expect(owner.read(binding(), async () => 3)).rejects.toMatchObject({
            code: 'invalid-input',
        });
        await expect(owner.read(binding(), () => ({ then() {} }))).rejects.toMatchObject({
            code: 'invalid-input',
        });
    });
    it('returns an authenticated tombstone without delivering old payload', async () => {
        const owner = await openVault();
        const first = await owner.save(binding(), marker, null, guard());
        const revoked = await owner.revoke(binding(), first, guard());
        const callback = vi.fn();
        expect(await owner.read(binding(), callback)).toEqual({
            kind: 'revoked',
            revision: revoked,
        });
        expect(callback).not.toHaveBeenCalled();
        await expect(owner.save(binding(), marker, first, guard())).rejects.toMatchObject({
            code: 'revision-conflict',
        });
        await owner.close();
        const reopened = await openVault(false);
        expect(await reopened.read(binding(), callback)).toEqual({
            kind: 'revoked',
            revision: revoked,
        });
    });
    it('does not accept reentrant saves from borrowed callbacks', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        let nested: Promise<unknown> | undefined;
        await owner.read(binding(), (_bytes, revision) => {
            nested = owner.save(binding(), marker, revision, guard());
        });
        await expect(nested).rejects.toMatchObject({ code: 'busy' });
    });
    it('releases a simulated fd lock only on close, not helper exit', async () => {
        const owner = await openVault();
        await expect(openVault()).rejects.toMatchObject({ code: 'locked' });
        await owner.close();
        await expect(openVault(false)).resolves.toBeDefined();
    });
    it('fails if the flock helper is unavailable', async () => {
        sim.helperCode = 127;
        await expect(openVault()).rejects.toMatchObject({ code: 'lock-unavailable' });
        expect([...sim.handles.values()].every((handle) => handle.closed)).toBe(true);
    });
});

describe('crypto cleanup and terminal fences', () => {
    it('exposes a method-only facade, never private keys through serialization', async () => {
        const owner = await openVault();
        expect(Object.isFrozen(owner)).toBe(true);
        expect(Object.keys(owner).sort()).toEqual([
            'close',
            'invalidate',
            'read',
            'revoke',
            'save',
        ]);
        expect(JSON.stringify(owner)).toBe('{}');
    });
    it('wipes every derived key and intermediate decrypted block after success', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        await owner.read(binding(), (bytes) => bytes.length);
        expect(sim.derivedKeys.length).toBeGreaterThan(2);
        expect(sim.decryptedParts.length).toBeGreaterThan(0);

        for (const bytes of [...sim.derivedKeys, ...sim.decryptedParts]) {
            expect(bytes).toEqual(Buffer.alloc(bytes.length));
        }
    });
    it.each(['random', 'short-random', 'cipher'] as const)(
        'fails closed on %s without installing a file',
        async (failure) => {
            const owner = await openVault();
            sim.cryptoFault = failure;
            await expect(owner.save(binding(), marker, null, guard())).rejects.toMatchObject({
                code: 'crypto-failed',
            });
            expect(sim.nodes.has(file)).toBe(false);
            expect(tempNames()).toEqual([]);

            for (const bytes of sim.derivedKeys) {
                expect(bytes).toEqual(Buffer.alloc(bytes.length));
            }

            if (failure === 'short-random') {
                const bytes = sim.randomValues[sim.randomValues.length - 1];
                expect(bytes).toEqual(Buffer.alloc(bytes.length));
            }
        },
    );
    it('wipes unauthenticated update output when final fails', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        sim.derivedKeys.length = 0;
        sim.decryptedParts.length = 0;
        sim.cryptoFault = 'final';
        const callback = vi.fn();
        await expect(owner.read(binding(), callback)).rejects.toMatchObject({
            code: 'auth-failed',
        });
        expect(callback).not.toHaveBeenCalled();
        expect(sim.decryptedParts.length).toBe(1);

        for (const bytes of [...sim.derivedKeys, ...sim.decryptedParts]) {
            expect(bytes).toEqual(Buffer.alloc(bytes.length));
        }
    });
    it('detects a key change during payload read before calling the consumer', async () => {
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        let changed = false;

        sim.onOperation = (op, name) => {
            if (!changed && op === 'read' && name === file) {
                changed = true;
                sim.nodes.get(masterFile)!.bytes[63] ^= 1;
            }
        };

        const callback = vi.fn();
        await expect(owner.read(binding(), callback)).rejects.toMatchObject({
            code: 'key-unavailable',
        });
        expect(callback).not.toHaveBeenCalled();

        for (const bytes of sim.decryptedParts) {
            expect(bytes).toEqual(Buffer.alloc(bytes.length));
        }
    });
    it('does not accept a true-returning guard that aborts reentrantly', async () => {
        const owner = await openVault();
        const controller = new AbortController();
        await expect(
            owner.save(binding(), marker, null, {
                signal: controller.signal,
                isCurrent() {
                    controller.abort();
                    return true;
                },
            }),
        ).rejects.toMatchObject({ code: 'cancelled' });
        expect(sim.nodes.has(file)).toBe(false);
    });
    it('bounds queued owned snapshots', async () => {
        const owner = await openVault();
        const pending = [
            owner.save(binding(), marker, null, guard()),
            owner.save(binding(), marker, null, guard()),
            owner.save(binding(), marker, null, guard()),
        ];
        const results = await Promise.allSettled(pending);
        expect(results[0].status).toBe('fulfilled');
        expect(results[1]).toMatchObject({
            status: 'rejected',
            reason: { code: 'revision-conflict' },
        });
        expect(results[2]).toMatchObject({ status: 'rejected', reason: { code: 'busy' } });
    });
    it('does not reinitialize a partial immutable-key publication', async () => {
        let failed = false;

        sim.onOperation = (op, name) => {
            if (!failed && op === 'write' && name === masterFile) {
                failed = true;
                throw exception();
            }
        };

        await expect(openVault()).rejects.toMatchObject({ code: 'io' });
        const priorId = Buffer.from(sim.nodes.get(`${roots.vaultRoot}/.vault.id`)!.bytes);
        sim.onOperation = undefined;
        await expect(openVault()).rejects.toMatchObject({ code: 'key-unavailable' });
        expect(sim.nodes.get(`${roots.vaultRoot}/.vault.id`)!.bytes).toEqual(priorId);
        expect(sim.nodes.get(masterFile)!.bytes.length).toBe(0);
    });
});

describe('in-flight ownership fences', () => {
    it('invalidates a delayed save before a durable revoke', async () => {
        const owner = await openVault();
        const first = await owner.save(binding(), marker, null, guard());
        let entered!: () => void;
        let release!: () => void;
        const atWrite = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = false;

        sim.onOperation = async (op, name) => {
            if (!held && op === 'write' && name.includes('/.tmp-')) {
                held = true;
                entered();
                await blocked;
            }
        };

        const save = owner.save(binding(), Buffer.from([3]), first, guard());
        const settledSave = save.then(
            () => 'saved',
            (error: AccountVaultError) => error.code,
        );
        await atWrite;
        const revoke = owner.revoke(binding(), first, guard());
        release();
        expect(await settledSave).toBe('stale');
        const revoked = await revoke;
        expect(await owner.read(binding(), () => null)).toEqual({
            kind: 'revoked',
            revision: revoked,
        });
        expect(tempNames()).toEqual([]);
    });
    it('closes delayed and queued writes without resurrecting state', async () => {
        const owner = await openVault();
        let entered!: () => void;
        let release!: () => void;
        const atWrite = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = false;

        sim.onOperation = async (op, name) => {
            if (!held && op === 'write' && name.includes('/.tmp-')) {
                held = true;
                entered();
                await blocked;
            }
        };

        const save = owner.save(binding(), marker, null, guard());
        const queued = owner.save(binding(), marker, null, guard());
        const settled = Promise.allSettled([save, queued]);
        await atWrite;
        const closed = owner.close();
        release();
        expect((await settled).map((value) => value.status)).toEqual(['rejected', 'rejected']);
        await closed;
        expect(sim.nodes.has(file)).toBe(false);
        expect(tempNames()).toEqual([]);
        const reopened = await openVault(false);
        expect(await reopened.read(binding(), () => null)).toEqual({ kind: 'missing' });
    });
});

describe('strict CAS record invalidation', () => {
    it('unlinks exactly the retained revision through its directory fd, syncs, and reopens missing', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());
        const names = [...sim.nodes.keys()].filter((name) => name !== file);
        sim.operations.length = 0;
        await owner.invalidate!(binding(), revision, guard());
        expect(sim.nodes.has(file)).toBe(false);
        expect([...sim.nodes.keys()]).toEqual(names);
        const removed = sim.operations.findIndex(
            (entry) => entry.op === 'unlink' && entry.name === file,
        );
        expect(removed).toBeGreaterThan(0);
        expect(sim.operations.slice(removed + 1)).toContainEqual({
            op: 'sync',
            name: roots.vaultRoot,
        });
        expect(
            sim.operations.some(
                (entry) =>
                    entry.op === 'fd-relative' && entry.name.endsWith(`/${roots.slotId}.vault`),
            ),
        ).toBe(true);
        await owner.close();
        const next = await openVault(false);
        expect(await next.read(binding(), () => null)).toEqual({ kind: 'missing' });
        await expect(next.invalidate!(binding(), revision, guard())).rejects.toMatchObject({
            code: 'revision-conflict',
        });

        for (const bytes of sim.decryptedParts) {
            expect(bytes).toEqual(Buffer.alloc(bytes.length));
        }
    });
    it('rejects a missing expected revision and a missing guard before IO', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());
        sim.operations.length = 0;
        await expect(owner.invalidate!(binding(), null as never, guard())).rejects.toMatchObject({
            code: 'invalid-input',
        });
        await expect(
            owner.invalidate!(binding(), revision, undefined as never),
        ).rejects.toMatchObject({ code: 'invalid-input' });
        expect(sim.operations).toEqual([]);
    });
    it('never deletes a newer generation or an equal-generation different ciphertext', async () => {
        const owner = await openVault();
        const first = await owner.save(binding(), marker, null, guard());
        const second = await owner.save(binding(), Buffer.from([5]), first, guard());
        const saved = contents();
        await expect(owner.invalidate!(binding(), first, guard())).rejects.toMatchObject({
            code: 'revision-conflict',
        });
        await expect(
            owner.invalidate!(binding(), { ...second, recordHash: '0'.repeat(64) }, guard()),
        ).rejects.toMatchObject({ code: 'revision-conflict' });
        expect(contents()).toEqual(saved);
    });
    it.each(['binding', 'ciphertext', 'symlink', 'hardlink', 'mode', 'lock'] as const)(
        'retains the slot when %s authentication or ownership has changed',
        async (change) => {
            const owner = await openVault();
            const revision = await owner.save(binding(), marker, null, guard());
            const input = binding();

            if (change === 'binding') {
                input.deviceDigest[0] ^= 1;
            }

            if (change === 'ciphertext') {
                sim.nodes.get(file)!.bytes[175] ^= 1;
            }

            if (change === 'symlink') {
                sim.nodes.get(file)!.kind = 'link';
            }

            if (change === 'hardlink') {
                sim.nodes.get(file)!.nlink = 2;
            }

            if (change === 'mode') {
                sim.nodes.get(file)!.mode = 0o644;
            }

            if (change === 'lock') {
                const lockName = `${roots.vaultRoot}/.vault.lock`;
                sim.nodes.set(lockName, { ...sim.nodes.get(lockName)!, ino: sim.nextInode++ });
            }

            sim.operations.length = 0;
            await expect(owner.invalidate!(input, revision, guard())).rejects.toBeInstanceOf(
                AccountVaultError,
            );
            expect(sim.nodes.has(file)).toBe(true);
            expect(sim.operations.some((entry) => entry.op === 'unlink')).toBe(false);
        },
    );
    it('rechecks the immutable master after the final record authentication before unlink', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());
        let reads = 0;

        sim.onOperation = (op, name) => {
            if (op === 'read' && name === file && ++reads === 3) {
                sim.nodes.get(masterFile)!.bytes[63] ^= 1;
            }
        };

        await expect(owner.invalidate!(binding(), revision, guard())).rejects.toMatchObject({
            code: 'key-unavailable',
        });
        expect(sim.nodes.has(file)).toBe(true);
        expect(sim.operations.some((entry) => entry.op === 'unlink' && entry.name === file)).toBe(
            false,
        );
    });
    it('detects record replacement between authentication and final named-fd check', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());
        let opened = 0;

        sim.onOperation = (op, name) => {
            if (op === 'open' && name === file && ++opened === 3) {
                const current = sim.nodes.get(file)!;
                sim.nodes.set(file, {
                    ...current,
                    bytes: Buffer.from(current.bytes),
                    ino: sim.nextInode++,
                });
            }
        };

        await expect(owner.invalidate!(binding(), revision, guard())).rejects.toMatchObject({
            code: 'path-policy',
        });
        expect(sim.nodes.has(file)).toBe(true);
        expect(sim.operations.some((entry) => entry.op === 'unlink' && entry.name === file)).toBe(
            false,
        );
    });
    it.each(['abort', 'stale', 'throw', 'close'] as const)(
        'retains the record when the guard chooses %s before unlink',
        async (effect) => {
            const owner = await openVault();
            const revision = await owner.save(binding(), marker, null, guard());
            const abort = new AbortController();
            await expect(
                owner.invalidate!(binding(), revision, {
                    signal: abort.signal,
                    isCurrent() {
                        if (effect === 'abort') {
                            abort.abort();
                        }

                        if (effect === 'close') {
                            void owner.close();
                        }

                        if (effect === 'throw') {
                            throw new Error('private guard');
                        }

                        return effect !== 'stale';
                    },
                }),
            ).rejects.toMatchObject({
                code: {
                    abort: 'cancelled',
                    stale: 'stale',
                    throw: 'guard-failed',
                    close: 'closed',
                }[effect],
            });
            expect(sim.nodes.has(file)).toBe(true);
        },
    );
    it.each(['unlink', 'sync', 'close', 'abort', 'owner-close'] as const)(
        'reports commit uncertainty for %s after dispatch without silent retry',
        async (effect) => {
            const owner = await openVault();
            const revision = await owner.save(binding(), marker, null, guard());
            const abort = new AbortController();
            let dispatched = false;
            let injected = false;

            sim.onOperation = (op, name) => {
                if (op === 'unlink' && name === file) {
                    dispatched = true;

                    if (effect === 'abort') {
                        abort.abort();
                    }

                    if (effect === 'owner-close') {
                        void owner.close();
                    }
                }

                if (
                    !injected &&
                    dispatched &&
                    ((effect === 'unlink' && op === 'unlink') ||
                        (effect === 'sync' && op === 'sync' && name === roots.vaultRoot) ||
                        (effect === 'close' && op === 'close' && name === file))
                ) {
                    injected = true;
                    throw exception();
                }
            };

            await expect(
                owner.invalidate!(binding(), revision, {
                    signal: abort.signal,
                    isCurrent: () => true,
                }),
            ).rejects.toMatchObject({ code: 'commit-uncertain' });
            expect(sim.nodes.has(file)).toBe(effect === 'unlink');
            expect(
                sim.operations.filter((entry) => entry.op === 'unlink' && entry.name === file),
            ).toHaveLength(1);
        },
    );
    it('cancels a delayed old save before removing its exact predecessor', async () => {
        const owner = await openVault();
        const first = await owner.save(binding(), marker, null, guard());
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = false;

        sim.onOperation = async (op, name) => {
            if (!held && op === 'write' && name.includes('/.tmp-')) {
                held = true;
                enter();
                await gate;
            }
        };

        const saving = owner.save(binding(), Buffer.from([8]), first, guard()).then(
            () => 'saved',
            (error: AccountVaultError) => error.code,
        );
        await entered;
        const invalidation = owner.invalidate!(binding(), first, guard());
        release();
        expect(await saving).toBe('stale');
        await invalidation;
        expect(sim.nodes.has(file)).toBe(false);
        expect(tempNames()).toEqual([]);
    });
    it('drains a dispatched unlink before close releases its flock and directory handles', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        sim.onOperation = async (op, name) => {
            if (op === 'unlink' && name === file) {
                enter();
                await gate;
            }
        };

        const pending = owner.invalidate!(binding(), revision, guard()).catch(
            (error: AccountVaultError) => error.code,
        );
        await entered;
        let closed = false;
        const closing = owner.close().then(() => {
            closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        release();
        expect(await pending).toBe('commit-uncertain');
        await closing;
        expect([...sim.handles.values()].every((entry) => entry.closed)).toBe(true);
        expect(sim.nodes.has(file)).toBe(false);
    });
});

describe('write durability and failure boundaries', () => {
    it('handles short reads and short writes without truncation', async () => {
        sim.shortRead = 7;
        sim.shortWrite = 5;
        const owner = await openVault();
        await owner.save(binding(), marker, null, guard());
        expect(await owner.read(binding(), (bytes) => Buffer.from(bytes))).toMatchObject({
            value: marker,
        });
    });
    it.each(['open', 'write', 'sync', 'close', 'rename'] as const)(
        'preserves current on one-shot %s failure before rename',
        async (operation) => {
            const owner = await openVault();
            const revision = await owner.save(binding(), marker, null, guard());
            const before = contents();
            let failed = false;

            sim.onOperation = (op, name) => {
                if (!failed && op === operation && name.includes('/.tmp-')) {
                    failed = true;
                    throw exception();
                }
            };

            await expect(
                owner.save(binding(), Buffer.from([4]), revision, guard()),
            ).rejects.toMatchObject({ code: 'io' });
            expect(failed).toBe(true);
            expect(contents()).toEqual(before);
            expect(tempNames()).toEqual([]);
        },
    );
    it('reports commit uncertainty, without rollback, after rename and failed directory sync', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());
        const before = contents();
        let renamed = false;

        sim.onOperation = (op, name) => {
            if (op === 'rename') {
                renamed = true;
            }

            if (renamed && op === 'sync' && name === roots.vaultRoot) {
                throw exception();
            }
        };

        await expect(
            owner.save(binding(), Buffer.from([4]), revision, guard()),
        ).rejects.toMatchObject({ code: 'commit-uncertain' });
        expect(contents()).not.toEqual(before);
        sim.onOperation = undefined;
        expect(await owner.read(binding(), (bytes) => Array.from(bytes))).toMatchObject({
            value: [4],
        });
    });
    it('keeps an installed record but reports uncertainty if closed during rename', async () => {
        const owner = await openVault();
        const revision = await owner.save(binding(), marker, null, guard());

        sim.onOperation = (op) => {
            if (op === 'rename') {
                void owner.close();
            }
        };

        await expect(
            owner.save(binding(), Buffer.from([5]), revision, guard()),
        ).rejects.toMatchObject({ code: 'commit-uncertain' });
        sim.onOperation = undefined;
        await owner.close();
        const reopened = await openVault(false);
        expect(await reopened.read(binding(), (bytes) => Array.from(bytes))).toMatchObject({
            value: [5],
        });
    });
    it('does not leave plaintext markers in files or diagnostics on IO failures', async () => {
        const owner = await openVault();

        sim.onOperation = (op, name) => {
            if (op === 'write' && name.includes('/.tmp-')) {
                throw new Error(marker.toString());
            }
        };

        let failure: unknown;

        try {
            await owner.save(binding(), marker, null, guard());
        } catch (error) {
            failure = error;
        }

        expect(String(failure)).not.toContain(marker.toString());

        for (const node of sim.nodes.values()) {
            expect(node.bytes.includes(marker)).toBe(false);
        }

        expect(JSON.stringify(sim.operations)).not.toContain(marker.toString());
    });
});
