import { addAbortListener } from 'node:events';
import { isPromise, isProxy } from 'node:util/types';
import type { LinuxEasyLoginSessionResult } from './linux-easy-login-session';
import { decodeLinuxNTEasyLoginReferenceResponse } from './nt-linux-easy-login-reference';
import type { RawSessionLease } from './raw-session-broker';
import {
    referenceRegisterOnTransport,
    type SsoReferenceRegisterBorrowedOptions,
} from './sso-reference-register-flow';
import type { SsoRegisterOutcome } from './sso-register';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';

export interface LinuxEasyReferenceRegisterOptions {
    session: Extract<LinuxEasyLoginSessionResult, { kind: 'response' }>;
    uin: string;
    profile: SsoReferenceRegisterBorrowedOptions['profile'];
    registration: SsoReferenceRegisterBorrowedOptions['registration'];
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: SsoReferenceRegisterBorrowedOptions['buildReserved'];
    verifyRaw: SsoReferenceRegisterBorrowedOptions['verifyRaw'];
    acceptLogin: (input: { uin: string; uid: string; statusCode: bigint }) => boolean;
}

export type LinuxEasyReferenceRegisterResult =
    | {
          kind: 'response';
          sequence: number;
          value: SsoRegisterOutcome;
          poison: 'not-requested' | 'requested' | 'uncertain';
      }
    | {
          kind: 'failure';
          stage: 'configuration' | 'lease' | 'login' | 'policy' | 'register';
          code:
              | 'invalid-input'
              | 'lease-unavailable'
              | 'login-rejected'
              | 'invalid-tickets'
              | 'policy-rejected'
              | 'cancelled'
              | 'timeout'
              | 'register-failed';
          writeState: 'not-started' | 'not-written' | 'unknown' | 'written';
          poison: 'not-requested' | 'requested' | 'uncertain';
      };

type Failure = Extract<LinuxEasyReferenceRegisterResult, { kind: 'failure' }>;
const claimed = new WeakSet<object>();
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getTag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const getArrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const getAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const values = Uint8Array.prototype.values;
const setBytes = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;
const then = Promise.prototype.then;
const BODY_LIMIT = 1024 * 1024;
const FIELD_LIMIT = 65535;

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid record');
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid record');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid record');
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) {
            throw new TypeError('invalid record');
        }

        output[key] = descriptor.value;
    }

    return output;
}

function copyBytes(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || getTag.call(value) !== 'Uint8Array') {
        throw new TypeError('invalid bytes');
    }

    values.call(value);
    const storage = getBuffer.call(value) as ArrayBuffer;
    getArrayBufferLength.call(storage);

    if (getResizable?.call(storage)) {
        throw new TypeError('invalid bytes');
    }

    const length = getLength.call(value) as number;
    const offset = getOffset.call(value) as number;

    if (length > max) {
        throw new TypeError('invalid bytes');
    }

    const output = new Uint8Array(length);
    setBytes.call(output, new Uint8Array(storage, offset, length));
    return output;
}

function wipe(value: Uint8Array | null | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            /* best effort */
        }
    }
}

function observeUnexpectedPromise(value: unknown): boolean {
    if (isProxy(value) || !isPromise(value)) {
        return false;
    }

    try {
        void then.call(
            value,
            () => undefined,
            () => undefined,
        );
    } catch {
        /* same-process Promise species mutation is outside this boundary */
    }

    return true;
}

function validSignal(value: unknown): value is AbortSignal {
    if (
        typeof value !== 'object' ||
        value === null ||
        isProxy(value) ||
        Object.getPrototypeOf(value) !== AbortSignal.prototype ||
        Object.hasOwn(value, 'aborted') ||
        Object.hasOwn(value, 'addEventListener') ||
        Object.hasOwn(value, 'removeEventListener')
    ) {
        return false;
    }

    try {
        getAborted.call(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Composes one locally classified registration using an already-exclusive lease.
 * The exact-object claim is local to this module, not a lease brand or cross-module
 * lock. The caller establishes same-lease provenance, account binding, peer trust,
 * ticket freshness and successful quiescence; this function establishes none of them.
 * A response of success is only a local text classification, not proof of online state.
 * A non-success response causes a poison request and must not be treated as reusable.
 * Requiring an explicitly present zero status is stricter than decoders which treat
 * an omitted protobuf scalar as zero; such a response is rejected by this policy.
 * Cancellation is event-loop dependent; outstanding child/transport work and its
 * private copies can outlive settlement. The owner retains the lease on success.
 */
export async function registerLinuxEasyReference(
    lease: RawSessionLease,
    options: LinuxEasyReferenceRegisterOptions,
): Promise<LinuxEasyReferenceRegisterResult> {
    const started = performance.now();
    let stage: Failure['stage'] = 'configuration';
    let writeState: Failure['writeState'] = 'not-started';
    let poison: Failure['poison'] = 'not-requested';
    let hasClaim = false;
    let active = true;
    let deadline = Infinity;
    let stopCode: 'cancelled' | 'timeout' | 'lease-unavailable' | undefined;
    let poisonMethod: (() => void) | undefined;
    let watch: (() => void) | undefined;
    let listener: ReturnType<typeof addAbortListener> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    const controller = new AbortController();
    const owned = new Set<Uint8Array>();
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStop = resolve;
    });

    const own = (value: Uint8Array): Uint8Array => {
        owned.add(value);
        return value;
    };

    const fail = (code: Failure['code']): Failure => ({
        kind: 'failure',
        stage,
        code,
        writeState,
        poison,
    });

    const requestPoison = (): void => {
        if (!hasClaim || poison !== 'not-requested') {
            return;
        }

        poison = 'uncertain';

        try {
            const returned: unknown = Reflect.apply(poisonMethod!, lease, []);

            if (!observeUnexpectedPromise(returned)) {
                poison = 'requested';
            }
        } catch {
            /* invocation attempted; actual closure remains unknown */
        }
    };

    const stop = (code: 'cancelled' | 'timeout' | 'lease-unavailable'): void => {
        if (!active) {
            return;
        }

        active = false;
        stopCode = code;
        requestPoison();
        controller.abort();
        resolveStop();
    };

    const check = (): void => {
        if (active && signal && getAborted.call(signal)) {
            stop('cancelled');
        }

        if (active && performance.now() >= deadline) {
            stop('timeout');
        }

        if (!active) {
            throw new Error('stopped');
        }
    };

    const remaining = (): number => {
        check();
        return Math.min(0x7fffffff, Math.max(1, Math.ceil(deadline - performance.now())));
    };

    try {
        // Copy every supplied object and byte input before user callbacks or await.
        const input = record(options);
        const profile = record(input.profile);
        const registration = record(input.registration);
        const session = record(input.session);
        const response = record(session.value);
        const status = record(response.status);
        const uin = input.uin;
        const version = profile.version;
        const subAppId = profile.subAppId;
        const uid = registration.uid;
        const regVersion = registration.version;
        const deviceName = registration.deviceName;
        const deviceType = registration.deviceType;
        const vendorOs = registration.vendorOs;
        const random = registration.random;
        const timeout = input.timeoutMs;
        const signer = input.buildReserved;
        const verifier = input.verifyRaw;
        const accept = input.acceptLogin;
        const text = (v: unknown, nonempty: boolean, max: number): v is string =>
            typeof v === 'string' &&
            (!nonempty || v.length > 0) &&
            v.length <= max &&
            Buffer.byteLength(v) <= max &&
            !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);

        if (
            typeof uin !== 'string' ||
            !/^[1-9][0-9]{0,9}$/.test(uin) ||
            BigInt(uin) > 0xffffffffn ||
            !text(version, true, 0xfffd) ||
            !text(uid, true, 4096) ||
            !text(regVersion, true, 4096) ||
            !text(deviceName, false, 4096) ||
            !text(deviceType, false, 4096) ||
            !text(vendorOs, false, 4096) ||
            typeof subAppId !== 'number' ||
            !Number.isInteger(subAppId) ||
            subAppId < 0 ||
            subAppId > 0x7fffffff ||
            typeof random !== 'number' ||
            !Number.isInteger(random) ||
            random < 0 ||
            random >= 0x7fffffff ||
            typeof timeout !== 'number' ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            typeof signer !== 'function' ||
            isProxy(signer) ||
            typeof verifier !== 'function' ||
            isProxy(verifier) ||
            typeof accept !== 'function' ||
            isProxy(accept) ||
            (input.signal !== undefined && !validSignal(input.signal)) ||
            session.kind !== 'response'
        ) {
            return fail('invalid-input');
        }

        signal = input.signal as AbortSignal | undefined;
        deadline = started + timeout;
        const guid = own(copyBytes(profile.guid, FIELD_LIMIT));
        const body = response.body === null ? null : own(copyBytes(response.body, BODY_LIMIT));

        if (!guid.length) {
            return fail('invalid-input');
        }

        const statusKind = status.kind;
        const codePresent = status.codePresent;
        const statusCode = status.code;
        stage = 'lease';

        if (
            (typeof lease !== 'object' && typeof lease !== 'function') ||
            lease === null ||
            isProxy(lease)
        ) {
            return fail('lease-unavailable');
        }

        const transactDescriptor = Object.getOwnPropertyDescriptor(lease, 'transactRaw');
        const poisonDescriptor = Object.getOwnPropertyDescriptor(lease, 'poison');
        const closedDescriptor = Object.getOwnPropertyDescriptor(lease, 'whenClosed');

        if (
            !transactDescriptor ||
            !('value' in transactDescriptor) ||
            typeof transactDescriptor.value !== 'function' ||
            isProxy(transactDescriptor.value) ||
            !poisonDescriptor ||
            !('value' in poisonDescriptor) ||
            typeof poisonDescriptor.value !== 'function' ||
            isProxy(poisonDescriptor.value) ||
            !closedDescriptor ||
            !('value' in closedDescriptor) ||
            isProxy(closedDescriptor.value) ||
            !isPromise(closedDescriptor.value) ||
            claimed.has(lease)
        ) {
            return fail('lease-unavailable');
        }

        const transact = transactDescriptor.value as Sso12RawTransport['transactRaw'];
        poisonMethod = poisonDescriptor.value as () => void;
        claimed.add(lease);
        hasClaim = true;
        watch = () => stop('lease-unavailable');

        const closed = (): void => {
            try {
                watch?.();
            } catch {
                /* lifecycle observation only */
            }
        };

        void then.call(closedDescriptor.value, closed, closed);

        if (signal) {
            listener = addAbortListener(signal, () => stop('cancelled'));
        }

        check();
        timer = setTimeout(() => stop('timeout'), remaining());
        stage = 'login';

        if (statusKind !== 'code' || codePresent !== true || statusCode !== 0n || body === null) {
            requestPoison();
            return fail('login-rejected');
        }

        const tickets = decodeLinuxNTEasyLoginReferenceResponse(body);

        if (tickets.a1) {
            own(tickets.a1);
        }

        if (tickets.a2) {
            own(tickets.a2);
        }

        if (tickets.d2) {
            own(tickets.d2);
        }

        if (tickets.d2Key) {
            own(tickets.d2Key);
        }

        if (
            !tickets.ticketsPresent ||
            tickets.a1 === null ||
            tickets.a2 === null ||
            tickets.d2 === null ||
            tickets.d2Key === null ||
            tickets.a1.length > FIELD_LIMIT ||
            tickets.a2.length > FIELD_LIMIT ||
            tickets.d2.length === 0 ||
            tickets.d2.length > FIELD_LIMIT ||
            tickets.d2Key.length !== 16
        ) {
            requestPoison();
            return fail('invalid-tickets');
        }

        check();
        stage = 'policy';
        const accepted: unknown = Reflect.apply(accept, undefined, [{ uin, uid, statusCode }]);
        observeUnexpectedPromise(accepted);
        check();

        if (accepted !== true) {
            requestPoison();
            return fail('policy-rejected');
        }

        stage = 'register';
        const stable: Sso12RawTransport = {
            transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                check();
                const bounded: Sso12RawOptions<C, T> = {
                    ...raw,
                    buildRequest(identity) {
                        check();
                        const descriptor =
                            typeof identity === 'object' && identity !== null && !isProxy(identity)
                                ? Object.getOwnPropertyDescriptor(identity, 'uin')
                                : undefined;

                        if (!descriptor || !('value' in descriptor) || descriptor.value !== uin) {
                            throw new Error('invalid identity');
                        }

                        return raw.buildRequest(identity);
                    },
                };
                writeState = 'unknown';
                const pending = Promise.resolve(
                    Reflect.apply(transact, lease, [bounded]) as Promise<Sso12RawResult<T>>,
                );
                void then.call(
                    pending,
                    () => undefined,
                    () => undefined,
                );
                check();
                return pending;
            },
        };

        const buildReserved: SsoReferenceRegisterBorrowedOptions['buildReserved'] = async (
            args,
        ) => {
            check();
            const result = (await Reflect.apply(signer, undefined, [args])) as Uint8Array;
            check();
            return result;
        };

        const verifyRaw: SsoReferenceRegisterBorrowedOptions['verifyRaw'] = async (args) => {
            check();
            const result: unknown = await Reflect.apply(verifier, undefined, [args]);
            check();
            return result === true;
        };

        let child: Promise<Sso12RawResult<SsoRegisterOutcome>>;

        try {
            child = referenceRegisterOnTransport(stable, {
                login: {
                    status: 'tickets',
                    uin,
                    tickets: {
                        a1: tickets.a1,
                        a2: tickets.a2,
                        d2: tickets.d2,
                        d2Key: tickets.d2Key,
                    },
                },
                profile: { guid, version, subAppId },
                registration: {
                    uid,
                    version: regVersion,
                    deviceName,
                    deviceType,
                    vendorOs,
                    random,
                },
                timeoutMs: remaining(),
                signal: controller.signal,
                buildReserved,
                verifyRaw,
            });
        } finally {
            // The borrowed flow snapshots these synchronously before its first await.
            wipe(tickets.a1);
            wipe(tickets.a2);
            wipe(tickets.d2);
            wipe(tickets.d2Key);
            wipe(guid);
            wipe(body);
        }

        const observed = child.then(
            (result) => result,
            () => undefined,
        );
        const result = await Promise.race([observed, stopped.then(() => undefined)]);
        check();

        if (!result || result.kind !== 'response') {
            if (writeState === 'not-started') {
                writeState = result ? result.writeState : 'not-written';
            }

            requestPoison();
            return fail('register-failed');
        }

        writeState = 'written';

        if (result.value !== 'success') {
            requestPoison();
        }

        return { kind: 'response', sequence: result.sequence, value: result.value, poison };
    } catch {
        requestPoison();

        if (stopCode) {
            return fail(stopCode);
        }

        return fail(
            !hasClaim
                ? 'invalid-input'
                : stage === 'login'
                  ? 'invalid-tickets'
                  : stage === 'policy'
                    ? 'policy-rejected'
                    : 'register-failed',
        );
    } finally {
        active = false;
        watch = undefined;

        if (timer !== undefined) {
            clearTimeout(timer);
        }

        try {
            listener?.[Symbol.dispose]();
        } catch {
            /* best effort */
        }

        controller.abort();

        for (const value of owned) {
            wipe(value);
        }

        owned.clear();
    }
}
