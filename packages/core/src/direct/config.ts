import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalQqSignWorkerOptions } from '@snowluma/protocol/direct/local-qq-sign-worker';
import { DirectLoginError } from './errors';

export const REFERENCE_COMMIT = 'e1bd4baa16fa86ef000154e3eecb7816a29b63a7';
export const MAX_ONLINE_HOLD_MS = 15 * 60 * 1000;
export type Provenance = 'reference' | 'target-metadata' | 'local-policy';
export interface LoginProfile {
    appId: number;
    subAppId: number;
    clientVersion: number;
    currentVersion: string;
    packageName: string;
    ptVersion: string;
    ssoVersion: number;
    mainSigMap: number;
    miscBitMap: number;
    subSigMap: number;
    sdkVersion: string;
    os: string;
    deviceName: string;
    deviceType: string;
    vendorOs: string;
    apkSignatureHex: string;
    unknown21Hex: string;
    tlv124Hex: string;
    peerPublicKeyHex: string;
    qrCommand: string;
    loginCommand: string;
}
export interface DirectLoginConfig {
    version: 1;
    referenceCommit: typeof REFERENCE_COMMIT;
    gateway: { host: string; port: number; family: 4 | 6 };
    signer: LocalQqSignWorkerOptions;
    statePath: string;
    outDir: string;
    attemptTimeoutMs: number;
    transactionTimeoutMs: number;
    connectTimeoutMs: number;
    /** Explicit holding window up to 15 minutes; no automatic heartbeat or permanent Bridge. */
    onlineHoldMs: number;
    reserve: { msgType: number | null; ntCoreVersion: number | null; signCommands: string[] };
    profile: LoginProfile;
    provenance: Record<keyof LoginProfile, Provenance>;
}

function fail(): never {
    throw new DirectLoginError('configuration');
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail();
    }

    return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
    const record = object(value);

    if (
        Object.keys(record).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(record, key))
    ) {
        fail();
    }

    return record;
}

function text(value: unknown, max = 256): string {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.length > max) {
        fail();
    }

    return value;
}

function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        fail();
    }

    return value;
}

function hex(value: unknown, size: number): string {
    const output = text(value, size * 2);

    if (output.length !== size * 2 || !/^[a-fA-F0-9]+$/.test(output)) {
        fail();
    }

    return output.toLowerCase();
}

const profileKeys = [
    'appId',
    'subAppId',
    'clientVersion',
    'currentVersion',
    'packageName',
    'ptVersion',
    'ssoVersion',
    'mainSigMap',
    'miscBitMap',
    'subSigMap',
    'sdkVersion',
    'os',
    'deviceName',
    'deviceType',
    'vendorOs',
    'apkSignatureHex',
    'unknown21Hex',
    'tlv124Hex',
    'peerPublicKeyHex',
    'qrCommand',
    'loginCommand',
] as const;

/** JSON is an explicit trusted operator configuration, never a remote profile discovery input. */
export function parseConfig(value: unknown, baseDirectory: string): DirectLoginConfig {
    const root = exact(value, [
        'version',
        'referenceCommit',
        'gateway',
        'signer',
        'statePath',
        'outDir',
        'attemptTimeoutMs',
        'transactionTimeoutMs',
        'connectTimeoutMs',
        'onlineHoldMs',
        'reserve',
        'profile',
        'provenance',
    ]);

    if (root.version !== 1 || root.referenceCommit !== REFERENCE_COMMIT) {
        fail();
    }

    const gateway = exact(root.gateway, ['host', 'port', 'family']);

    if (gateway.family !== 4 && gateway.family !== 6) {
        fail();
    }

    const signer = exact(root.signer, [
        'executable',
        'args',
        'cwd',
        'initialUin',
        'expectedBuild',
        'expectedSha256',
        'startupTimeoutMs',
        'requestTimeoutMs',
        'maxPending',
    ]);

    if (signer.initialUin !== '0' || !Array.isArray(signer.args) || signer.args.length > 128) {
        fail();
    }

    const args = signer.args.map((arg) => {
        if (typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192) {
            fail();
        }

        return arg;
    });
    const p = exact(root.profile, profileKeys);
    const signature = text(p.apkSignatureHex, 2048);

    if (signature.length % 2 !== 0 || !/^[a-fA-F0-9]+$/.test(signature)) {
        fail();
    }

    const command = (value: unknown) => {
        const output = text(value);

        if (!/^[\x21-\x7e]+$/.test(output)) {
            fail();
        }

        return output;
    };

    const profile: LoginProfile = {
        appId: integer(p.appId, 0, 0x7fffffff),
        subAppId: integer(p.subAppId, 0, 0x7fffffff),
        clientVersion: integer(p.clientVersion, 0, 0xffff),
        currentVersion: text(p.currentVersion),
        packageName: text(p.packageName),
        ptVersion: text(p.ptVersion),
        ssoVersion: integer(p.ssoVersion, 0, 0xffffffff),
        mainSigMap: integer(p.mainSigMap, 0, 0xffffffff),
        miscBitMap: integer(p.miscBitMap, 0, 0xffffffff),
        subSigMap: integer(p.subSigMap, 0, 0xffffffff),
        sdkVersion: text(p.sdkVersion),
        os: text(p.os),
        deviceName: text(p.deviceName),
        deviceType: text(p.deviceType),
        vendorOs: text(p.vendorOs),
        apkSignatureHex: signature.toLowerCase(),
        unknown21Hex: hex(p.unknown21Hex, 21),
        tlv124Hex: hex(p.tlv124Hex, 12),
        peerPublicKeyHex: hex(p.peerPublicKeyHex, 49),
        qrCommand: command(p.qrCommand),
        loginCommand: command(p.loginCommand),
    };
    const provenanceInput = exact(root.provenance, profileKeys);
    const provenance = {} as Record<keyof LoginProfile, Provenance>;

    for (const key of profileKeys) {
        const source = provenanceInput[key];

        if (source !== 'reference' && source !== 'target-metadata' && source !== 'local-policy') {
            fail();
        }

        provenance[key] = source;
    }

    const reserve = exact(root.reserve, ['msgType', 'ntCoreVersion', 'signCommands']);

    if (!Array.isArray(reserve.signCommands) || reserve.signCommands.length > 16) {
        fail();
    }

    const signCommands = reserve.signCommands.map(command);

    if (new Set(signCommands).size !== signCommands.length) {
        fail();
    }

    const host = text(gateway.host);

    if (/\s/.test(host)) {
        fail();
    }

    return {
        version: 1,
        referenceCommit: REFERENCE_COMMIT,
        gateway: { host, port: integer(gateway.port, 1, 65535), family: gateway.family },
        signer: {
            executable: text(signer.executable, 8192),
            args,
            cwd: path.resolve(baseDirectory, text(signer.cwd, 8192)),
            initialUin: '0',
            expectedBuild: text(signer.expectedBuild),
            expectedSha256: hex(signer.expectedSha256, 32),
            startupTimeoutMs: integer(signer.startupTimeoutMs, 1, 120000),
            requestTimeoutMs: integer(signer.requestTimeoutMs, 1, 120000),
            maxPending: integer(signer.maxPending, 1, 1024),
        },
        statePath: path.resolve(baseDirectory, text(root.statePath, 8192)),
        outDir: path.resolve(baseDirectory, text(root.outDir, 8192)),
        attemptTimeoutMs: integer(root.attemptTimeoutMs, 1000, 600000),
        transactionTimeoutMs: integer(root.transactionTimeoutMs, 100, 120000),
        connectTimeoutMs: integer(root.connectTimeoutMs, 100, 120000),
        onlineHoldMs: integer(root.onlineHoldMs, 0, MAX_ONLINE_HOLD_MS),
        reserve: {
            msgType: reserve.msgType === null ? null : integer(reserve.msgType, 0, 0xffffffff),
            ntCoreVersion:
                reserve.ntCoreVersion === null
                    ? null
                    : integer(reserve.ntCoreVersion, 0, 0xffffffff),
            signCommands,
        },
        profile,
        provenance,
    };
}

export async function readConfig(file: string): Promise<DirectLoginConfig> {
    try {
        const bytes = await readFile(file);

        if (bytes.length > 65536) {
            fail();
        }

        return parseConfig(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
            path.dirname(path.resolve(file)),
        );
    } catch {
        throw new DirectLoginError('configuration');
    }
}
