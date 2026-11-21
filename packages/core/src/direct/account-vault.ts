import { spawn } from 'node:child_process';
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    hkdfSync,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import path from 'node:path';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';

export const ACCOUNT_VAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const HEADER_BYTES = 164;
const TAG_BYTES = 16;
const MAX_FILE_BYTES = HEADER_BYTES + ACCOUNT_VAULT_MAX_PAYLOAD_BYTES + TAG_BYTES;
const MAX_GENERATION = (1n << 64n) - 1n;
const MAGIC = Buffer.from('JIYUVLT\0', 'ascii');
const PURPOSE = Buffer.from('jiyu-direct-account-vault-v1', 'ascii');
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const LOCK_NAME = '.vault.lock';
const META_NAME = '.vault.id';
const KEY_NAME = 'master.key';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

export type AccountVaultErrorCode =
    | 'platform-unsupported'
    | 'invalid-input'
    | 'path-policy'
    | 'key-unavailable'
    | 'initialization-conflict'
    | 'format-invalid'
    | 'auth-failed'
    | 'binding-mismatch'
    | 'lock-unavailable'
    | 'locked'
    | 'revision-conflict'
    | 'closed'
    | 'busy'
    | 'cancelled'
    | 'stale'
    | 'guard-failed'
    | 'crypto-failed'
    | 'commit-uncertain'
    | 'io';

/** Fixed diagnostics only: no filesystem error cause, path or plaintext is retained. */
export class AccountVaultError extends Error {
    constructor(readonly code: AccountVaultErrorCode) {
        super(`account vault: ${code}`);
        this.name = 'AccountVaultError';
    }
}
export interface VaultBinding {
    readonly uin: string;
    readonly profileDigest: Uint8Array;
    readonly deviceDigest: Uint8Array;
}
export interface VaultRevision {
    readonly generation: bigint;
    readonly recordHash: string;
}
export interface VaultGuard {
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
}
export interface AccountVaultOptions {
    readonly vaultRoot: string;
    readonly keyRoot: string;
    readonly slotId: string;
    readonly initialize: boolean;
}
export type VaultReadResult<T> =
    | { readonly kind: 'missing' }
    | { readonly kind: 'revoked'; readonly revision: VaultRevision }
    | { readonly kind: 'present'; readonly revision: VaultRevision; readonly value: T };
export interface AccountVault {
    /** consume is synchronous. Its borrowed bytes are erased before read settles. */
    read<T>(
        binding: VaultBinding,
        consume: (payload: Uint8Array, revision: VaultRevision) => T,
        guard?: VaultGuard,
    ): Promise<VaultReadResult<T>>;
    save(
        binding: VaultBinding,
        payload: Uint8Array,
        expectedRevision: VaultRevision | null,
        guard: VaultGuard,
    ): Promise<VaultRevision>;
    revoke(
        binding: VaultBinding,
        expectedRevision: VaultRevision,
        guard: VaultGuard,
    ): Promise<VaultRevision>;
    /** Removes only the authenticated exact revision. Missing or replaced state conflicts.
     * Optional for older injected providers; the Linux implementation always supplies it. */
    invalidate?(
        binding: VaultBinding,
        expectedRevision: VaultRevision,
        guard: VaultGuard,
    ): Promise<void>;
    close(): Promise<void>;
}
interface Directory {
    readonly name: string;
    readonly stat: Stats;
    readonly handle: FileHandle;
}
interface Loaded {
    readonly kind: 1 | 2;
    readonly revision: VaultRevision;
    readonly plaintext: Buffer;
}

function fail(code: AccountVaultErrorCode): never {
    throw new AccountVaultError(code);
}

function randomOwned(length: number): Buffer {
    const value = randomBytes(length);

    if (!Buffer.isBuffer(value) || value.length !== length) {
        if (Buffer.isBuffer(value)) {
            value.fill(0);
        }

        fail('crypto-failed');
    }

    return value;
}

function safeError(error: unknown): AccountVaultError {
    return error instanceof AccountVaultError ? error : new AccountVaultError('io');
}

function errno(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
        fail('invalid-input');
    }

    const proto = Object.getPrototypeOf(value);

    if (
        (proto !== Object.prototype && proto !== null) ||
        Reflect.ownKeys(value).length !== keys.length
    ) {
        fail('invalid-input');
    }

    const result: Record<string, unknown> = Object.create(null);

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            fail('invalid-input');
        }

        result[key] = descriptor.value;
    }

    return result;
}

function copyBytes(value: unknown, min: number, max: number): Buffer {
    if (isProxy(value) || !isUint8Array(value)) {
        fail('invalid-input');
    }

    try {
        const length: number = Reflect.apply(byteLengthGetter, value, []);
        const offset: number = Reflect.apply(byteOffsetGetter, value, []);
        const buffer: ArrayBufferLike = Reflect.apply(bufferGetter, value, []);

        if (
            length < min ||
            length > max ||
            isSharedArrayBuffer(buffer) ||
            (resizableGetter && Reflect.apply(resizableGetter, buffer, []))
        ) {
            fail('invalid-input');
        }

        return Buffer.from(new Uint8Array(buffer, offset, length));
    } catch {
        fail('invalid-input');
    }
}

function bindingSnapshot(value: VaultBinding): Buffer {
    const record = dataRecord(value, ['uin', 'profileDigest', 'deviceDigest']);
    const uin = record.uin;

    if (typeof uin !== 'string' || !/^[1-9][0-9]{0,9}$/.test(uin) || BigInt(uin) > 0xffffffffn) {
        fail('invalid-input');
    }

    let profile: Buffer | undefined;
    let device: Buffer | undefined;

    try {
        profile = copyBytes(record.profileDigest, 32, 32);
        device = copyBytes(record.deviceDigest, 32, 32);
        const encodedUin = Buffer.from(uin, 'ascii');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(encodedUin.length);
        return createHash('sha256')
            .update(PURPOSE)
            .update(length)
            .update(encodedUin)
            .update(profile)
            .update(device)
            .digest();
    } finally {
        profile?.fill(0);
        device?.fill(0);
    }
}

function revisionSnapshot(value: VaultRevision | null): VaultRevision | null {
    if (value === null) {
        return null;
    }

    const record = dataRecord(value, ['generation', 'recordHash']);

    if (
        typeof record.generation !== 'bigint' ||
        record.generation < 1n ||
        record.generation > MAX_GENERATION ||
        typeof record.recordHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.recordHash)
    ) {
        fail('invalid-input');
    }

    return Object.freeze({ generation: record.generation, recordHash: record.recordHash });
}

function guardSnapshot(value: VaultGuard | undefined): VaultGuard | undefined {
    if (value === undefined) {
        return undefined;
    }

    const record = dataRecord(value, ['signal', 'isCurrent']);

    if (typeof record.isCurrent !== 'function' || isProxy(record.signal)) {
        fail('invalid-input');
    }

    try {
        Reflect.apply(abortedGetter, record.signal, []);
    } catch {
        fail('invalid-input');
    }

    return { signal: record.signal as AbortSignal, isCurrent: record.isCurrent as () => boolean };
}

function privateFile(stat: Stats, uid: number): void {
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
        fail('path-policy');
    }
}

function sameInode(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function directoryStat(stat: Stats, uid: number, leaf: boolean): void {
    if (
        !stat.isDirectory() ||
        (stat.uid !== uid && stat.uid !== 0) ||
        (stat.mode & 0o022) !== 0 ||
        (leaf && (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700))
    ) {
        fail('path-policy');
    }
}

function absoluteRoot(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.length > 4096 ||
        value.includes('\0') ||
        !path.posix.isAbsolute(value) ||
        value === '/' ||
        path.posix.normalize(value) !== value ||
        value.endsWith('/')
    ) {
        fail('invalid-input');
    }

    return value;
}

async function checkTree(name: string, uid: number, create: boolean): Promise<Stats> {
    let current = '/';
    directoryStat(await lstat(current), uid, false);
    const components = name.slice(1).split('/');
    let result: Stats | undefined;

    for (let index = 0; index < components.length; index++) {
        const parent = current;
        current = path.posix.join(current, components[index]);
        let created = false;

        if (create) {
            try {
                await mkdir(current, { mode: 0o700 });
                created = true;
            } catch (error) {
                if (!errno(error, 'EEXIST')) {
                    throw error;
                }
            }
        }

        result = await lstat(current);
        directoryStat(result, uid, index === components.length - 1);

        if (created) {
            const parentHandle = await open(parent, READ_FLAGS | constants.O_DIRECTORY);

            try {
                directoryStat(await parentHandle.stat(), uid, false);
                await parentHandle.sync();
            } finally {
                await parentHandle.close();
            }
        }
    }

    return result!;
}

async function openDirectory(name: string, uid: number, create: boolean): Promise<Directory> {
    const stat = await checkTree(name, uid, create);
    const handle = await open(name, READ_FLAGS | constants.O_DIRECTORY);

    try {
        const actual = await handle.stat();
        directoryStat(actual, uid, true);

        if (!sameInode(stat, actual)) {
            fail('path-policy');
        }

        return { name, stat: actual, handle };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function checkDirectory(directory: Directory, uid: number): Promise<void> {
    const current = await checkTree(directory.name, uid, false);
    const opened = await directory.handle.stat();
    directoryStat(opened, uid, true);

    if (!sameInode(directory.stat, current) || !sameInode(directory.stat, opened)) {
        fail('path-policy');
    }
}

async function readPrivate(
    directory: Directory,
    name: string,
    uid: number,
    max: number,
): Promise<Buffer | null> {
    await checkDirectory(directory, uid);
    const file = path.posix.join(directory.name, name);
    let before: Stats;

    try {
        before = await lstat(file);
    } catch (error) {
        if (errno(error, 'ENOENT')) {
            return null;
        }

        throw error;
    }

    privateFile(before, uid);

    if (before.size > max) {
        fail('format-invalid');
    }

    const handle = await open(file, READ_FLAGS);
    let bytes: Buffer | undefined;
    let result: Buffer | undefined;
    let failed = false;
    let failure: unknown;

    try {
        const stat = await handle.stat();
        privateFile(stat, uid);

        if (!sameInode(before, stat) || stat.size > max) {
            fail('path-policy');
        }

        bytes = Buffer.alloc(max + 1);
        let length = 0;

        while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, length);

            if (
                !Number.isSafeInteger(read.bytesRead) ||
                read.bytesRead < 0 ||
                read.bytesRead > bytes.length - length
            ) {
                fail('io');
            }

            if (read.bytesRead === 0) {
                break;
            }

            length += read.bytesRead;
        }

        const after = await handle.stat();
        privateFile(after, uid);
        const named = await lstat(file);
        privateFile(named, uid);

        if (
            length > max ||
            length !== stat.size ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs ||
            !sameInode(stat, after) ||
            !sameInode(stat, named)
        ) {
            fail('path-policy');
        }

        await checkDirectory(directory, uid);
        result = Buffer.from(bytes.subarray(0, length));
    } catch (error) {
        failed = true;
        failure = error;
    } finally {
        bytes?.fill(0);
    }

    try {
        await handle.close();
    } catch (error) {
        failed = true;
        failure = error;
    }

    if (failed) {
        result?.fill(0);
        throw failure;
    }

    return result!;
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
    let offset = 0;

    while (offset < bytes.length) {
        const written = await handle.write(bytes, offset, bytes.length - offset, offset);

        if (
            !Number.isSafeInteger(written.bytesWritten) ||
            written.bytesWritten <= 0 ||
            written.bytesWritten > bytes.length - offset
        ) {
            fail('io');
        }

        offset += written.bytesWritten;
    }
}

async function writeImmutable(
    directory: Directory,
    name: string,
    bytes: Buffer,
    uid: number,
): Promise<void> {
    await checkDirectory(directory, uid);
    const handle = await open(path.posix.join(directory.name, name), CREATE_FLAGS, 0o600);

    try {
        const before = await handle.stat();
        privateFile(before, uid);
        await writeAll(handle, bytes);
        await handle.sync();
        const after = await handle.stat();
        const named = await lstat(path.posix.join(directory.name, name));
        privateFile(after, uid);
        privateFile(named, uid);

        if (!sameInode(before, after) || !sameInode(before, named) || after.size !== bytes.length) {
            fail('path-policy');
        }
    } finally {
        await handle.close();
    }

    await checkDirectory(directory, uid);
    await directory.handle.sync();
}

async function acquireLock(
    directory: Directory,
    uid: number,
    initialize: boolean,
): Promise<FileHandle> {
    const file = path.posix.join(directory.name, LOCK_NAME);
    let handle: FileHandle;

    try {
        handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if (!initialize || !errno(error, 'ENOENT')) {
            throw error;
        }

        try {
            handle = await open(
                file,
                constants.O_RDWR |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW |
                    constants.O_NONBLOCK,
                0o600,
            );
        } catch (createError) {
            if (!errno(createError, 'EEXIST')) {
                throw createError;
            }

            handle = await open(
                file,
                constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
        }
    }

    try {
        privateFile(await handle.stat(), uid);
        await new Promise<void>((resolve, reject) => {
            // flock duplicates this open-file-description as fd 3. Its successful
            // exit leaves our parent descriptor holding the kernel lock.
            const child = spawn('/usr/bin/flock', ['-n', '-E', '75', '3'], {
                shell: false,
                stdio: ['ignore', 'ignore', 'ignore', handle.fd],
            });
            let failed = false;
            const timer = setTimeout(() => {
                failed = true;
                child.kill('SIGKILL');
            }, 5000);
            child.once('error', () => {
                failed = true;
            });
            child.once('close', (code) => {
                clearTimeout(timer);

                if (failed || (code !== 0 && code !== 75)) {
                    reject(new AccountVaultError('lock-unavailable'));
                } else if (code === 75) {
                    reject(new AccountVaultError('locked'));
                } else {
                    resolve();
                }
            });
        });
        const opened = await handle.stat();
        privateFile(opened, uid);
        const named = await lstat(file);
        privateFile(named, uid);

        if (!sameInode(opened, named)) {
            fail('path-policy');
        }

        await checkDirectory(directory, uid);
        await directory.handle.sync();
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

function digestRecord(bytes: Buffer): VaultRevision {
    return Object.freeze({
        generation: bytes.readBigUInt64BE(12),
        recordHash: createHash('sha256').update(bytes).digest('hex'),
    });
}

function matches(left: VaultRevision | null, right: VaultRevision | null): boolean {
    return left === null || right === null
        ? left === right
        : left.generation === right.generation && left.recordHash === right.recordHash;
}

class LinuxAccountVault implements AccountVault {
    private readonly fileName: string;
    private readonly slot: Buffer;
    private readonly keyId: Buffer;
    private queue: Promise<void> = Promise.resolve();
    private pending = 0;
    private epoch = 0;
    private closing = false;
    private consuming = false;
    private closePromise: Promise<void> | undefined;

    constructor(
        private readonly directory: Directory,
        private readonly keys: Directory,
        private readonly lock: FileHandle,
        private readonly uid: number,
        private readonly id: Buffer,
        private readonly key: Buffer,
        slotId: string,
    ) {
        this.slot = Buffer.from(slotId, 'hex');
        this.fileName = `${slotId}.vault`;
        this.keyId = createHash('sha256').update(key).digest().subarray(0, 16);
    }

    private check(guard: VaultGuard | undefined, epoch: number): void {
        if (this.closing) {
            fail('closed');
        }

        if (this.epoch !== epoch) {
            fail('stale');
        }

        if (guard) {
            if (Reflect.apply(abortedGetter, guard.signal, [])) {
                fail('cancelled');
            }

            let current: unknown;

            try {
                current = guard.isCurrent();
            } catch {
                fail('guard-failed');
            }

            if (current !== true) {
                fail('stale');
            }

            if (this.closing || this.epoch !== epoch) {
                fail(this.closing ? 'closed' : 'stale');
            }

            if (Reflect.apply(abortedGetter, guard.signal, [])) {
                fail('cancelled');
            }
        }
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        if (this.closing) {
            fail('closed');
        }

        if (this.consuming || this.pending >= 2) {
            fail('busy');
        }

        this.pending++;
        const result = this.queue.then(operation).catch((error: unknown) => {
            throw safeError(error);
        });
        this.queue = result
            .then(
                () => {},
                () => {},
            )
            .finally(() => {
                this.pending--;
            });
        return result;
    }

    private async checkStorage(): Promise<void> {
        await checkDirectory(this.directory, this.uid);
        await checkDirectory(this.keys, this.uid);
        const lockStat = await this.lock.stat();
        privateFile(lockStat, this.uid);
        const namedLock = await lstat(path.posix.join(this.directory.name, LOCK_NAME));
        privateFile(namedLock, this.uid);

        if (!sameInode(lockStat, namedLock)) {
            fail('path-policy');
        }

        let storedId: Buffer | null = null;
        let storedKey: Buffer | null = null;

        try {
            storedId = await readPrivate(this.directory, META_NAME, this.uid, 32);
            storedKey = await readPrivate(this.keys, KEY_NAME, this.uid, 64);

            if (
                !storedId ||
                storedId.length !== 32 ||
                !storedKey ||
                storedKey.length !== 64 ||
                !timingSafeEqual(storedId, this.id) ||
                !timingSafeEqual(storedKey.subarray(0, 32), this.id) ||
                !timingSafeEqual(storedKey.subarray(32), this.key)
            ) {
                fail('key-unavailable');
            }
        } finally {
            storedId?.fill(0);
            storedKey?.fill(0);
        }
    }

    private seal(binding: Buffer, plaintext: Buffer, generation: bigint, kind: 1 | 2): Buffer {
        let derived: Buffer | undefined;
        let salt: Buffer | undefined;
        let nonce: Buffer | undefined;

        try {
            salt = randomOwned(32);
            nonce = randomOwned(12);
            const header = Buffer.alloc(HEADER_BYTES);
            MAGIC.copy(header);
            header[8] = 1;
            header[9] = kind;
            header.writeUInt16BE(HEADER_BYTES, 10);
            header.writeBigUInt64BE(generation, 12);
            this.id.copy(header, 20);
            this.slot.copy(header, 52);
            this.keyId.copy(header, 68);
            binding.copy(header, 84);
            salt.copy(header, 116);
            nonce.copy(header, 148);
            header.writeUInt32BE(plaintext.length, 160);
            derived = Buffer.from(
                hkdfSync('sha256', this.key, salt, Buffer.concat([PURPOSE, header]), 32),
            );
            const cipher = createCipheriv('aes-256-gcm', derived, nonce, {
                authTagLength: TAG_BYTES,
            });
            cipher.setAAD(header);
            return Buffer.concat([
                header,
                cipher.update(plaintext),
                cipher.final(),
                cipher.getAuthTag(),
            ]);
        } catch {
            return fail('crypto-failed');
        } finally {
            derived?.fill(0);
            salt?.fill(0);
            nonce?.fill(0);
        }
    }

    private unseal(bytes: Buffer, binding: Buffer): Loaded {
        if (
            bytes.length < HEADER_BYTES + TAG_BYTES ||
            bytes.length > MAX_FILE_BYTES ||
            !bytes.subarray(0, 8).equals(MAGIC) ||
            bytes[8] !== 1 ||
            (bytes[9] !== 1 && bytes[9] !== 2) ||
            bytes.readUInt16BE(10) !== HEADER_BYTES ||
            bytes.readBigUInt64BE(12) === 0n ||
            bytes.readUInt32BE(160) !== bytes.length - HEADER_BYTES - TAG_BYTES ||
            (bytes[9] === 2 ? bytes.readUInt32BE(160) !== 0 : bytes.readUInt32BE(160) === 0)
        ) {
            fail('format-invalid');
        }

        if (!timingSafeEqual(bytes.subarray(68, 84), this.keyId)) {
            fail('auth-failed');
        }

        if (
            !timingSafeEqual(bytes.subarray(20, 52), this.id) ||
            !timingSafeEqual(bytes.subarray(52, 68), this.slot) ||
            !timingSafeEqual(bytes.subarray(84, 116), binding)
        ) {
            fail('binding-mismatch');
        }

        let derived: Buffer | undefined;
        const parts: Buffer[] = [];

        try {
            const header = bytes.subarray(0, HEADER_BYTES);
            derived = Buffer.from(
                hkdfSync(
                    'sha256',
                    this.key,
                    bytes.subarray(116, 148),
                    Buffer.concat([PURPOSE, header]),
                    32,
                ),
            );
            const decipher = createDecipheriv('aes-256-gcm', derived, bytes.subarray(148, 160), {
                authTagLength: TAG_BYTES,
            });
            decipher.setAAD(header);
            decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
            parts.push(decipher.update(bytes.subarray(HEADER_BYTES, -TAG_BYTES)));
            parts.push(decipher.final());
            return {
                kind: bytes[9],
                revision: digestRecord(bytes),
                plaintext: Buffer.concat(parts),
            };
        } catch {
            return fail('auth-failed');
        } finally {
            derived?.fill(0);

            for (const part of parts) {
                part.fill(0);
            }
        }
    }

    private async load(binding: Buffer): Promise<Loaded | null> {
        const bytes = await readPrivate(this.directory, this.fileName, this.uid, MAX_FILE_BYTES);

        try {
            return bytes === null ? null : this.unseal(bytes, binding);
        } finally {
            bytes?.fill(0);
        }
    }

    async read<T>(
        binding: VaultBinding,
        consume: (payload: Uint8Array, revision: VaultRevision) => T,
        guard?: VaultGuard,
    ): Promise<VaultReadResult<T>> {
        const digest = bindingSnapshot(binding);

        try {
            if (typeof consume !== 'function') {
                fail('invalid-input');
            }

            const observedGuard = guardSnapshot(guard);
            const epoch = this.epoch;
            return await this.serial(async () => {
                this.check(observedGuard, epoch);
                await this.checkStorage();
                this.check(observedGuard, epoch);
                const loaded = await this.load(digest);

                try {
                    await this.checkStorage();
                    this.check(observedGuard, epoch);

                    if (!loaded) {
                        return { kind: 'missing' };
                    }

                    if (loaded.kind === 2) {
                        return { kind: 'revoked', revision: loaded.revision };
                    }

                    this.consuming = true;
                    const value = consume(loaded.plaintext, loaded.revision);

                    if (
                        value &&
                        (typeof value === 'object' || typeof value === 'function') &&
                        'then' in value
                    ) {
                        // Do not await or return a promise retaining the borrowed plaintext.
                        void Promise.resolve(value).catch(() => {});
                        fail('invalid-input');
                    }

                    this.check(observedGuard, epoch);
                    return { kind: 'present', revision: loaded.revision, value };
                } finally {
                    this.consuming = false;
                    loaded?.plaintext.fill(0);
                }
            });
        } finally {
            digest.fill(0);
        }
    }

    async save(
        binding: VaultBinding,
        payload: Uint8Array,
        expectedRevision: VaultRevision | null,
        guard: VaultGuard,
    ): Promise<VaultRevision> {
        const digest = bindingSnapshot(binding);
        let snapshot: Buffer | undefined;

        try {
            snapshot = copyBytes(payload, 1, ACCOUNT_VAULT_MAX_PAYLOAD_BYTES);
            const expected = revisionSnapshot(expectedRevision);
            const observedGuard = guardSnapshot(guard);

            if (!observedGuard) {
                fail('invalid-input');
            }

            const epoch = this.epoch;
            const bytes = snapshot;
            return await this.serial(() =>
                this.commit(digest, bytes, expected, observedGuard, epoch, 1),
            );
        } finally {
            digest.fill(0);
            snapshot?.fill(0);
        }
    }

    async revoke(
        binding: VaultBinding,
        expectedRevision: VaultRevision,
        guard: VaultGuard,
    ): Promise<VaultRevision> {
        const digest = bindingSnapshot(binding);

        try {
            const expected = revisionSnapshot(expectedRevision);
            const observedGuard = guardSnapshot(guard);

            if (
                !expected ||
                !observedGuard ||
                this.consuming ||
                this.pending >= 2 ||
                this.closing
            ) {
                fail('invalid-input');
            }

            const epoch = ++this.epoch;
            return await this.serial(() =>
                this.commit(digest, Buffer.alloc(0), expected, observedGuard, epoch, 2),
            );
        } finally {
            digest.fill(0);
        }
    }

    async invalidate(
        binding: VaultBinding,
        expectedRevision: VaultRevision,
        guard: VaultGuard,
    ): Promise<void> {
        const digest = bindingSnapshot(binding);

        try {
            const expected = revisionSnapshot(expectedRevision);
            const observedGuard = guardSnapshot(guard);

            if (!expected || !observedGuard) {
                fail('invalid-input');
            }

            if (this.closing) {
                fail('closed');
            }

            if (this.consuming || this.pending >= 2) {
                fail('busy');
            }

            // A delayed writer that started before invalidation must not resurrect tickets.
            const epoch = ++this.epoch;
            await this.serial(() => this.removeRecord(digest, expected, observedGuard, epoch));
        } finally {
            digest.fill(0);
        }
    }

    private async removeRecord(
        binding: Buffer,
        expected: VaultRevision,
        guard: VaultGuard,
        epoch: number,
    ): Promise<void> {
        this.check(guard, epoch);
        await this.checkStorage();
        this.check(guard, epoch);
        const name = path.posix.join(this.directory.name, this.fileName);
        // Anchor the unlink to the already checked directory inode, not a freshly
        // resolved ancestor path. The stable flock and queue serialize our writers.
        const anchored = `/proc/self/fd/${this.directory.handle.fd}/${this.fileName}`;
        let handle: FileHandle | undefined;
        let committing = false;
        let failed = false;
        let failure: unknown;

        try {
            let before: Stats;

            try {
                before = await lstat(name);
            } catch (error) {
                if (errno(error, 'ENOENT')) {
                    fail('revision-conflict');
                }

                throw error;
            }

            privateFile(before, this.uid);
            handle = await open(anchored, READ_FLAGS);
            const opened = await handle.stat();
            privateFile(opened, this.uid);

            if (!sameInode(before, opened)) {
                fail('path-policy');
            }

            const initial = await this.load(binding);
            initial?.plaintext.fill(0);

            if (!matches(initial?.revision ?? null, expected)) {
                fail('revision-conflict');
            }

            await this.checkStorage();
            this.check(guard, epoch);
            const current = await this.load(binding);
            current?.plaintext.fill(0);

            if (!matches(current?.revision ?? null, expected)) {
                fail('revision-conflict');
            }

            await this.checkStorage();
            this.check(guard, epoch);
            const held = await handle.stat();
            const named = await lstat(anchored);
            privateFile(held, this.uid);
            privateFile(named, this.uid);

            if (
                !sameInode(opened, held) ||
                !sameInode(opened, named) ||
                held.size !== opened.size ||
                held.mtimeMs !== opened.mtimeMs ||
                held.ctimeMs !== opened.ctimeMs ||
                named.size !== held.size ||
                named.mtimeMs !== held.mtimeMs ||
                named.ctimeMs !== held.ctimeMs
            ) {
                fail('path-policy');
            }

            this.check(guard, epoch);
            // Once unlink has been dispatched its effect may be uncertain on an IO
            // failure. Never report a rollback or silently retry against a new record.
            committing = true;
            await unlink(anchored);
            await this.directory.handle.sync();
            await this.checkStorage();
            this.check(guard, epoch);
        } catch (error) {
            failed = true;
            failure = error;
        } finally {
            try {
                await handle?.close();
            } catch (error) {
                failed = true;
                failure = error;
            }
        }

        if (failed) {
            throw committing ? new AccountVaultError('commit-uncertain') : safeError(failure);
        }
    }

    private async commit(
        binding: Buffer,
        plaintext: Buffer,
        expected: VaultRevision | null,
        guard: VaultGuard,
        epoch: number,
        kind: 1 | 2,
    ): Promise<VaultRevision> {
        this.check(guard, epoch);
        await this.checkStorage();
        this.check(guard, epoch);
        const previous = await this.load(binding);
        previous?.plaintext.fill(0);

        if (!matches(previous?.revision ?? null, expected)) {
            fail('revision-conflict');
        }

        const generation = (previous?.revision.generation ?? 0n) + 1n;

        if (generation > MAX_GENERATION) {
            fail('revision-conflict');
        }

        this.check(guard, epoch);
        const bytes = this.seal(binding, plaintext, generation, kind);
        const temporary = `.tmp-${randomOwned(16).toString('hex')}`;
        const temporaryPath = path.posix.join(this.directory.name, temporary);
        let handle: FileHandle | undefined;
        let ownedStat: Stats | undefined;
        let installed = false;
        let completed = false;
        let failure: unknown;

        try {
            await checkDirectory(this.directory, this.uid);
            this.check(guard, epoch);
            handle = await open(temporaryPath, CREATE_FLAGS, 0o600);
            ownedStat = await handle.stat();
            privateFile(ownedStat, this.uid);
            await writeAll(handle, bytes);
            await handle.sync();
            await handle.close();
            handle = undefined;
            this.check(guard, epoch);
            const verifiedBytes = await readPrivate(
                this.directory,
                temporary,
                this.uid,
                MAX_FILE_BYTES,
            );

            try {
                if (!verifiedBytes || !verifiedBytes.equals(bytes)) {
                    fail('io');
                }

                const verified = this.unseal(verifiedBytes, binding);
                verified.plaintext.fill(0);
            } finally {
                verifiedBytes?.fill(0);
            }

            await this.checkStorage();
            const current = await this.load(binding);
            current?.plaintext.fill(0);

            if (!matches(current?.revision ?? null, expected)) {
                fail('revision-conflict');
            }

            const namedTemp = await lstat(temporaryPath);
            privateFile(namedTemp, this.uid);

            if (!sameInode(ownedStat, namedTemp)) {
                fail('path-policy');
            }

            this.check(guard, epoch);
            await rename(temporaryPath, path.posix.join(this.directory.name, this.fileName));
            installed = true;
            await this.directory.handle.sync();
            await this.checkStorage();
            this.check(guard, epoch);
            completed = true;
            return digestRecord(bytes);
        } catch (error) {
            failure = error;
        } finally {
            bytes.fill(0);

            try {
                await handle?.close();

                if (!installed && ownedStat) {
                    const named = await lstat(temporaryPath);

                    if (sameInode(ownedStat, named)) {
                        privateFile(named, this.uid);
                        await unlink(temporaryPath);
                    }
                }
            } catch (error) {
                if (!errno(error, 'ENOENT')) {
                    failure = new AccountVaultError('io');
                }
            }

            if (!completed && installed) {
                failure = new AccountVaultError('commit-uncertain');
            }
        }

        throw safeError(failure);
    }

    close(): Promise<void> {
        if (this.closePromise) {
            return this.closePromise;
        }

        this.closing = true;
        this.epoch++;
        this.closePromise = this.queue.then(async () => {
            this.key.fill(0);
            this.keyId.fill(0);
            this.id.fill(0);
            this.slot.fill(0);
            const settled = await Promise.allSettled([
                this.lock.close(),
                this.directory.handle.close(),
                this.keys.handle.close(),
            ]);

            if (settled.some((result) => result.status === 'rejected')) {
                fail('io');
            }
        });
        return this.closePromise;
    }
}

/** Explicit Linux-only entry. Importing this module never reads or creates state. */
export async function openAccountVault(options: AccountVaultOptions): Promise<AccountVault> {
    if (platform() !== 'linux') {
        fail('platform-unsupported');
    }

    const record = dataRecord(options, ['vaultRoot', 'keyRoot', 'slotId', 'initialize']);
    const vaultRoot = absoluteRoot(record.vaultRoot);
    const keyRoot = absoluteRoot(record.keyRoot);

    if (
        vaultRoot === keyRoot ||
        vaultRoot.startsWith(`${keyRoot}/`) ||
        keyRoot.startsWith(`${vaultRoot}/`) ||
        typeof record.slotId !== 'string' ||
        !/^[a-f0-9]{32}$/.test(record.slotId) ||
        typeof record.initialize !== 'boolean'
    ) {
        fail('invalid-input');
    }

    const uid = userInfo().uid;

    if (!Number.isSafeInteger(uid) || uid < 0) {
        fail('platform-unsupported');
    }

    let directory: Directory | undefined;
    let keys: Directory | undefined;
    let lock: FileHandle | undefined;
    let id: Buffer | null = null;
    let material: Buffer | null = null;
    let master: Buffer | undefined;
    let transferred = false;

    try {
        directory = await openDirectory(vaultRoot, uid, record.initialize);
        lock = await acquireLock(directory, uid, record.initialize);
        keys = await openDirectory(keyRoot, uid, record.initialize);
        id = await readPrivate(directory, META_NAME, uid, 32);
        material = await readPrivate(keys, KEY_NAME, uid, 64);

        if (id === null && material === null && record.initialize) {
            const names = await readdir(directory.name);
            const keyNames = await readdir(keys.name);

            if (names.some((name) => name !== LOCK_NAME) || keyNames.length !== 0) {
                fail('initialization-conflict');
            }

            id = randomOwned(32);
            master = randomOwned(32);
            material = Buffer.concat([id, master]);
            await writeImmutable(directory, META_NAME, id, uid);
            await writeImmutable(keys, KEY_NAME, material, uid);
        }

        if (
            !id ||
            id.length !== 32 ||
            !material ||
            material.length !== 64 ||
            !timingSafeEqual(id, material.subarray(0, 32))
        ) {
            fail('key-unavailable');
        }

        master?.fill(0);
        master = Buffer.from(material.subarray(32));
        const vault = new LinuxAccountVault(directory, keys, lock, uid, id, master, record.slotId);
        // Only bound methods escape. Serializing/inspecting this facade exposes
        // neither TypeScript-private buffers nor paths/FileHandles.
        const facade: AccountVault = Object.freeze({
            read: vault.read.bind(vault),
            save: vault.save.bind(vault),
            revoke: vault.revoke.bind(vault),
            invalidate: vault.invalidate.bind(vault),
            close: vault.close.bind(vault),
        });
        transferred = true;
        return facade;
    } catch (error) {
        throw safeError(error);
    } finally {
        material?.fill(0);

        if (!transferred) {
            master?.fill(0);
            id?.fill(0);
            await Promise.allSettled([
                lock?.close(),
                directory?.handle.close(),
                keys?.handle.close(),
            ]);
        }
    }
}
