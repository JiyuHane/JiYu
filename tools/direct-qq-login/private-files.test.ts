import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadExistingDeviceGuid } from './private-files';
import { DirectLoginError } from './errors';

interface Entry {
    kind: 'dir' | 'file' | 'link' | 'fifo';
    data: Buffer;
    children: Map<string, Entry>;
    mode: number;
    uid: number;
    ino: number;
    nlink: number;
    mtimeMs: number;
    size?: number;
}
interface Handle {
    name: string;
    node: Entry;
    closed: boolean;
}
interface Operation {
    op: string;
    name: string;
    fd?: number;
    flags?: number;
}
const sim = vi.hoisted(() => ({
    root: undefined as Entry | undefined,
    platform: 'linux',
    uid: 1000 as number | undefined,
    handles: new Map<number, Handle>(),
    nextFd: 10,
    operations: [] as Operation[],
    readBuffers: new Set<Buffer>(),
    parsed: [] as Buffer[],
    chunk: 1025,
    stopAt: Infinity,
    onOperation: undefined as ((event: Operation) => void | Promise<void>) | undefined,
}));
vi.mock('node:path', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:path')>();
    return { ...actual.posix, default: actual.posix };
});
vi.mock('node:fs', () => ({
    constants: {
        O_RDONLY: 0,
        O_WRONLY: 1,
        O_RDWR: 2,
        O_CREAT: 64,
        O_EXCL: 128,
        O_NONBLOCK: 2048,
        O_DIRECTORY: 65536,
        O_NOFOLLOW: 131072,
    },
}));
vi.mock('node:fs/promises', () => {
    const fail = (code: string): never => {
        throw Object.assign(new Error('synthetic private filesystem detail'), { code });
    };

    const operation = async (event: Operation) => {
        sim.operations.push(event);
        await sim.onOperation?.(event);
    };

    const resolve = (name: string) => {
        const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(name);
        let node = match ? sim.handles.get(Number(match[1]))?.node : sim.root;
        const parts = (match ? (match[2] ?? '') : name).split('/').filter(Boolean);

        for (const part of parts) {
            const current = node ?? fail('ENOENT');

            if (current.kind !== 'dir') {
                fail('ENOTDIR');
            }

            node = current.children.get(part);
        }

        return node ?? fail('ENOENT');
    };

    const displayName = (name: string) => {
        const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(name);

        if (!match) {
            return name;
        }

        const parent = sim.handles.get(Number(match[1]));
        return `${parent?.name === '/' ? '' : parent?.name}/${match[2] ?? ''}`;
    };

    const stat = (node: Entry) => {
        const kind = node.kind;
        return {
            mode: node.mode,
            uid: node.uid,
            ino: node.ino,
            dev: 1,
            nlink: node.nlink,
            size: node.size ?? node.data.length,
            mtimeMs: node.mtimeMs,
            isDirectory: () => kind === 'dir',
            isFile: () => kind === 'file',
            isSymbolicLink: () => kind === 'link',
        };
    };

    return {
        async lstat(name: string) {
            await operation({ op: 'lstat', name: displayName(name) });
            return stat(resolve(name));
        },
        async open(name: string, flags: number) {
            const logical = displayName(name);
            await operation({ op: 'open', name: logical, flags });

            if ((flags & (1 | 2 | 64 | 128)) !== 0) {
                fail('unexpected-write-open');
            }

            const node = resolve(name);

            if (node.kind === 'link' && (flags & 131072) !== 0) {
                fail('ELOOP');
            }

            if ((flags & 65536) !== 0 && node.kind !== 'dir') {
                fail('ENOTDIR');
            }

            const fd = sim.nextFd++;
            const entry: Handle = { name: logical, node, closed: false };
            sim.handles.set(fd, entry);
            return {
                fd,
                async stat() {
                    if (entry.closed) {
                        fail('EBADF');
                    }

                    await operation({ op: 'fstat', name: logical, fd });
                    return stat(entry.node);
                },
                async read(target: Buffer, offset: number, length: number, position: number) {
                    if (entry.closed) {
                        fail('EBADF');
                    }

                    sim.readBuffers.add(target);
                    await operation({ op: 'read', name: logical, fd });
                    const count = Math.max(
                        0,
                        Math.min(
                            length,
                            sim.chunk,
                            node.data.length - position,
                            sim.stopAt - position,
                        ),
                    );
                    node.data.copy(target, offset, position, position + count);
                    return { bytesRead: count, buffer: target };
                },
                async close() {
                    await operation({ op: 'close', name: logical, fd });
                    entry.closed = true;
                },
            };
        },
        async mkdir(name: string) {
            await operation({ op: 'mkdir', name });
            fail('unexpected-mkdir');
        },
        async writeFile(name: string) {
            await operation({ op: 'writeFile', name });
            fail('unexpected-write');
        },
        async readFile(name: string) {
            await operation({ op: 'readFile', name });
            fail('unexpected-unbounded-read');
        },
    };
});

const guid = '0123456789abcdef0123456789abcdef';
const fileName = '/trusted/profile/device.json';
let inode = 1;

function entry(kind: Entry['kind'], mode: number, uid = 1000): Entry {
    return {
        kind,
        mode,
        uid,
        ino: inode++,
        nlink: kind === 'dir' ? 2 : 1,
        mtimeMs: 1,
        data: Buffer.alloc(0),
        children: new Map(),
    };
}

let root: Entry;
let trusted: Entry;
let directory: Entry;
let file: Entry;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function allClosed() {
    expect([...sim.handles.values()].every((handle) => handle.closed)).toBe(true);
}

async function rejected(name = fileName) {
    const error: unknown = await loadExistingDeviceGuid(name).then(
        () => null,
        (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DirectLoginError);
    expect(error).toMatchObject({
        code: 'private-state',
        message: 'Direct QQ login: private-state',
    });
    expect(error).not.toHaveProperty('cause');
}

beforeEach(() => {
    inode = 1;
    root = entry('dir', 0o755, 0);
    trusted = entry('dir', 0o755);
    directory = entry('dir', 0o700);
    file = entry('file', 0o600);
    file.data = Buffer.from(JSON.stringify({ version: 1, guid }));
    root.children.set('trusted', trusted);
    trusted.children.set('profile', directory);
    directory.children.set('device.json', file);
    sim.root = root;
    sim.platform = 'linux';
    sim.uid = 1000;
    sim.handles.clear();
    sim.nextFd = 10;
    sim.operations.length = 0;
    sim.readBuffers.clear();
    sim.parsed.length = 0;
    sim.chunk = 1025;
    sim.stopAt = Infinity;
    sim.onOperation = undefined;
    const originalProcess = process;
    vi.stubGlobal(
        'process',
        new Proxy(originalProcess, {
            get(target, property, receiver) {
                if (property === 'platform') {
                    return sim.platform;
                }

                if (property === 'getuid') {
                    return sim.uid === undefined ? undefined : () => sim.uid;
                }

                return Reflect.get(target, property, receiver);
            },
        }),
    );
    const from = Buffer.from;
    vi.spyOn(Buffer, 'from').mockImplementation(((...args: unknown[]) => {
        const result = Reflect.apply(from, Buffer, args) as Buffer;

        if (args[0] === guid && args[1] === 'hex') {
            sim.parsed.push(result);
        }

        return result;
    }) as typeof Buffer.from);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(sim.operations.some(({ op }) => ['mkdir', 'writeFile', 'readFile'].includes(op))).toBe(
        false,
    );

    for (const bytes of sim.readBuffers) {
        expect(bytes).toEqual(Buffer.alloc(1025));
    }
});

describe('loadExistingDeviceGuid: real loader with descriptor-based filesystem faults', () => {
    it('loads independent GUID copies using read-only, nofollow directory/file handles', async () => {
        sim.chunk = 7;
        const first = await loadExistingDeviceGuid(fileName);
        const second = await loadExistingDeviceGuid(fileName);
        expect(Buffer.from(first).toString('hex')).toBe(guid);
        expect(Buffer.from(second).toString('hex')).toBe(guid);
        expect(first).not.toBe(second);
        first.fill(0);
        expect(Buffer.from(second).toString('hex')).toBe(guid);
        const opens = sim.operations.filter(({ op }) => op === 'open');
        expect(opens).toHaveLength(8);
        expect(
            opens
                .filter(({ name }) => name !== fileName)
                .every(({ flags }) => flags === (65536 | 131072 | 2048)),
        ).toBe(true);
        expect(
            opens
                .filter(({ name }) => name === fileName)
                .every(({ flags }) => flags === (131072 | 2048)),
        ).toBe(true);
        allClosed();
    });

    it.each(['file', 'directory'])('never initializes a missing %s', async (missing) => {
        if (missing === 'file') {
            directory.children.delete('device.json');
        } else {
            trusted.children.delete('profile');
        }

        await rejected();
        expect(
            missing === 'file'
                ? directory.children.has('device.json')
                : trusted.children.has('profile'),
        ).toBe(false);
        allClosed();
    });

    it.each([
        'null',
        '[]',
        'true',
        '1',
        '"text"',
        '{broken',
        JSON.stringify({ version: 2, guid }),
        JSON.stringify({ version: '1', guid }),
        JSON.stringify({ version: 1 }),
        JSON.stringify({ guid }),
        JSON.stringify({ version: 1, guid, extra: true }),
        JSON.stringify({ version: 1, guid: guid.toUpperCase() }),
        JSON.stringify({ version: 1, guid: guid.slice(1) }),
        JSON.stringify({ version: 1, guid: `${guid}0` }),
        JSON.stringify({ version: 1, guid: 'g'.repeat(32) }),
    ])('normalizes invalid JSON/schema without overwriting input: %s', async (text) => {
        file.data = Buffer.from(text);
        const before = Buffer.from(file.data);
        await rejected();
        expect(file.data).toEqual(before);
        allClosed();
    });

    it('rejects malformed UTF-8 and closes every descriptor', async () => {
        file.data = Buffer.concat([file.data, Buffer.from([0xc0, 0xaf])]);
        await rejected();
        allClosed();
    });

    it('accepts exactly 1024 bytes including JSON whitespace', async () => {
        file.data = Buffer.from(file.data.toString().padEnd(1024, ' '));
        expect(Buffer.from(await loadExistingDeviceGuid(fileName)).toString('hex')).toBe(guid);
        allClosed();
    });

    it('rejects oversized metadata before reading a payload', async () => {
        file.data = Buffer.alloc(1025, 32);
        await rejected();
        expect(sim.readBuffers.size).toBe(0);
        allClosed();
    });

    it('bounds the read to 1025 bytes when a file grows beyond its initial metadata', async () => {
        file.data = Buffer.from(file.data.toString().padEnd(1025, ' '));
        file.size = 1024;
        await rejected();
        expect([...sim.readBuffers].map((bytes) => bytes.length)).toEqual([1025]);
        allClosed();
    });

    it('rejects early EOF even if metadata still claims the original size', async () => {
        sim.stopAt = file.data.length - 1;
        await rejected();
        allClosed();
    });

    it.each([
        ['mode', 0o640],
        ['uid', 2000],
        ['nlink', 0],
        ['nlink', 2],
        ['kind', 'dir'],
        ['kind', 'link'],
        ['kind', 'fifo'],
    ] as const)('rejects initial file %s=%s', async (key, value) => {
        Object.assign(file, { [key]: value });
        await rejected();
        allClosed();
    });

    it.each([
        ['mode', 0o777],
        ['mode', 0o775],
        ['uid', 2000],
        ['nlink', 0],
        ['kind', 'file'],
        ['kind', 'link'],
    ] as const)('rejects untrusted ancestor %s=%s', async (key, value) => {
        Object.assign(directory, { [key]: value });
        await rejected();
        expect(sim.readBuffers.size).toBe(0);
        allClosed();
    });

    it.each(['relative/device.json', `/${'a'.repeat(8193)}`, `/${'a/'.repeat(129)}device.json`])(
        'rejects invalid Linux path shape before opening',
        async (name) => {
            await rejected(name);
            expect(sim.operations).toEqual([]);
        },
    );

    it('requires an available Linux user identity', async () => {
        sim.uid = undefined;
        await rejected();
        expect(sim.operations).toEqual([]);
    });

    it('keeps the Windows branch read-only without claiming POSIX mode checks', async () => {
        sim.platform = 'win32';
        file.mode = 0o666;
        file.uid = 2000;
        expect(Buffer.from(await loadExistingDeviceGuid(fileName)).toString('hex')).toBe(guid);
        expect(sim.operations.filter(({ op }) => op === 'open')).toEqual([
            { op: 'open', name: fileName, flags: 0 },
        ]);
        allClosed();
    });

    it.each([
        'mode',
        'uid',
        'nlink',
        'size',
        'mtime',
        'named-file',
        'parent-replacement',
        'parent-mode',
    ])('rejects %s changes while the file handle is being read', async (change) => {
        let changed = false;

        sim.onOperation = ({ op, name }) => {
            if (changed || op !== 'read' || name !== fileName) {
                return;
            }

            changed = true;

            if (change === 'mode') {
                file.mode = 0o644;
            } else if (change === 'uid') {
                file.uid = 2000;
            } else if (change === 'nlink') {
                file.nlink = 2;
            } else if (change === 'size') {
                file.data = file.data.subarray(0, file.data.length - 1);
            } else if (change === 'mtime') {
                file.mtimeMs++;
            } else if (change === 'named-file') {
                directory.children.set('device.json', entry('file', 0o600));
            } else if (change === 'parent-replacement') {
                trusted.children.set('profile', entry('dir', 0o700));
            } else {
                directory.mode = 0o777;
            }
        };

        await rejected();
        expect(changed).toBe(true);
        allClosed();
    });

    it.each([
        ['open', '/'],
        ['fstat', '/'],
        ['lstat', '/trusted'],
        ['lstat', fileName],
        ['open', fileName],
        ['read', fileName],
    ])('normalizes %s failure at %s and closes acquired handles', async (operation, target) => {
        sim.onOperation = ({ op, name }) => {
            if (op === operation && name === target) {
                throw new Error('synthetic secret path and filesystem details');
            }
        };

        await rejected();
        allClosed();
    });

    it.each(['/', '/trusted/profile', fileName])(
        'delivers nothing until %s close succeeds',
        async (target) => {
            const entered = deferred();
            const release = deferred();

            sim.onOperation = async ({ op, name }) => {
                if (op === 'close' && name === target) {
                    entered.resolve();
                    await release.promise;
                }
            };

            let settled = false;
            const pending = loadExistingDeviceGuid(fileName).finally(() => {
                settled = true;
            });

            try {
                await entered.promise;
                expect(settled).toBe(false);
                expect(sim.parsed).toHaveLength(1);
                expect(sim.parsed[0]!.toString('hex')).toBe(guid);
            } finally {
                release.resolve();
            }

            expect(Buffer.from(await pending).toString('hex')).toBe(guid);
            allClosed();
        },
    );

    it.each(['/', '/trusted/profile', fileName])(
        'wipes the already parsed GUID when %s close fails',
        async (target) => {
            let failures = 0;

            sim.onOperation = ({ op, name }) => {
                if (op === 'close' && name === target && failures++ === 0) {
                    throw new Error('synthetic close detail');
                }
            };

            await rejected();
            expect(sim.parsed).toHaveLength(1);
            expect(sim.parsed[0]).toEqual(Buffer.alloc(16));
            expect(
                sim.operations.filter(({ op, name }) => op === 'close' && name === target),
            ).toHaveLength(2);
            allClosed();
        },
    );

    it('attempts all descriptor closes despite a persistently failing close', async () => {
        sim.onOperation = ({ op, name }) => {
            if (op === 'close' && name === fileName) {
                throw new Error('persistent synthetic close failure');
            }
        };

        await rejected();
        expect(sim.parsed[0]).toEqual(Buffer.alloc(16));

        for (const [fd, handle] of sim.handles) {
            expect(
                sim.operations.filter((event) => event.op === 'close' && event.fd === fd),
            ).toHaveLength(2);
            expect(handle.closed).toBe(handle.name !== fileName);
        }
    });

    it('keeps concurrent calls independent while one close is held', async () => {
        const entered = deferred();
        const release = deferred();
        let held: number | undefined;

        sim.onOperation = async ({ op, name, fd }) => {
            if (op === 'close' && name === fileName && held === undefined) {
                held = fd;
                entered.resolve();
                await release.promise;
            }
        };

        const first = loadExistingDeviceGuid(fileName);
        await entered.promise;
        let second: Uint8Array;

        try {
            second = await loadExistingDeviceGuid(fileName);
            expect(Buffer.from(second).toString('hex')).toBe(guid);
            expect(sim.parsed).toHaveLength(2);
            expect(sim.parsed[0]).not.toBe(sim.parsed[1]);
        } finally {
            release.resolve();
        }

        const firstValue = await first;
        expect(firstValue).not.toBe(second!);
        expect(Buffer.from(firstValue).toString('hex')).toBe(guid);
        allClosed();
    });
});
