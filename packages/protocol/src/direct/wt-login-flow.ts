import {
    decodeServiceResponse,
    encodeServiceRequest,
    MAX_SERVICE_FRAME_BYTES,
} from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import { encodeWtLoginRequestBody, type WtLoginRequestBody } from './wt-login-request';
import { decodeWtLoginResponse } from './wt-login-response';
import { decodeWtOicqResponse, encodeWtPcLoginOicqRequest } from './wt-oicq';
import type { createWtEcdh } from './wt-ecdh';

export interface WtLoginFlowInput {
    /** These must describe the same account and device as login. */
    account: string;
    profile: { subAppId: number; guid: Uint8Array; version: string; a2: Uint8Array };
    login: WtLoginRequestBody;
    command: string;
    sequence: number;
    /** The static reference reuses the QR keystore's ECDH context and randomKey
     * after confirmation, on the same SocketContext. This separate transaction
     * cannot establish that continuity; the caller owns the association. */
    ecdh: ReturnType<typeof createWtEcdh>;
    peerPublicKey: Uint8Array;
    randomKey: Uint8Array;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Must sign/build metadata for these exact bytes. No signing policy is inferred. */
    buildReserved: (request: {
        uin: string;
        command: string;
        sequence: number;
        body: Uint8Array;
    }) => Promise<Uint8Array>;
    /** Exchanges exactly one whole protocol-12 service frame; never automatically retries. */
    exchange: (frame: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
    /** Required trust decision; bind the peer/channel to these frame snapshots.
     * The request snapshot is what was handed to exchange, not proof of a write.
     * TEA, account matching and callback metadata alone are not authentication. */
    verifyServer: (evidence: {
        account: string;
        command: string;
        sequence: number;
        requestFrame: Uint8Array;
        requestOicq: Uint8Array;
        responseFrame: Uint8Array;
    }) => boolean | Promise<boolean>;
    /** Explicit offsets in the decrypted OICQ body; wire boundary is not inferred. */
    selectBusinessBody: (body: Uint8Array) => { start: number; end: number };
}

export type WtLoginFlowResult =
    | {
          status: 'tickets';
          tickets: { d2: Uint8Array; d2Key: Uint8Array; a1: Uint8Array; a2: Uint8Array };
      }
    | {
          status: 'verification-required' | 'nonzero' | 'incomplete' | 'error146';
          state: number;
          code?: number;
      }
    | { status: 'cancelled' | 'timeout' | 'busy' | 'used' | 'failure'; reason?: string };

/** One-shot reference-format transaction, not proof of login or online state.
 * Callbacks are trust boundaries and may retain their own copies. JavaScript and
 * cryptographic providers do not guarantee secure erasure. No PID or session is created.
 */
export class WtLoginFlow {
    private active = false;
    private used = false;

    run(input: WtLoginFlowInput): Promise<WtLoginFlowResult> {
        const started = performance.now();

        if (this.active) {
            return Promise.resolve({ status: 'busy' });
        }

        if (this.used) {
            return Promise.resolve({ status: 'used' });
        }

        this.active = true;
        this.used = true;

        const owned: Uint8Array[] = [];

        const keep = (value: Uint8Array): Uint8Array => {
            if (!(value instanceof Uint8Array)) {
                throw new TypeError('invalid byte field');
            }

            // The typed-array constructor copies internal indexed bytes without invoking
            // a caller-defined iterator or overridden length getter.
            const copy = new Uint8Array(value);

            if (done) {
                try {
                    copy.fill(0);
                } catch {
                    /* Best effort after reentrant completion. */
                }
            } else {
                owned.push(copy);
            }

            return copy;
        };

        const wipe = (): void => {
            for (const value of owned) {
                try {
                    value.fill(0);
                } catch {
                    // A callback may have transferred a buffer; still clear the rest.
                }
            }
        };

        const adopt = (value: Uint8Array): Uint8Array => {
            if (done) {
                try {
                    value.fill(0);
                } catch {
                    /* Best effort after reentrant completion. */
                }
            } else {
                owned.push(value);
            }

            return value;
        };

        let parentSignal: AbortSignal | undefined;
        let controller: AbortController | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        let done = false;
        let resolve!: (result: WtLoginFlowResult) => void;
        const result = new Promise<WtLoginFlowResult>((r) => {
            resolve = r;
        });

        const finish = (outcome: WtLoginFlowResult): void => {
            if (done) {
                return;
            }

            done = true;

            if (timer) {
                clearTimeout(timer);
            }

            try {
                if (abort && parentSignal) {
                    parentSignal.removeEventListener('abort', abort);
                }
            } catch {
                // Listener failure must not prevent completion or other cleanup.
            }

            try {
                controller?.abort();
            } catch {
                // Continue wiping and settling even when a caller overrides a callback.
            }

            wipe();
            this.active = false;
            resolve(outcome);
        };

        try {
            if (!input || typeof input !== 'object') {
                throw new Error('invalid input');
            }

            // Read each field once before touching byte getters or invoking callbacks.
            // Any side-effecting getters affect only later reads in this snapshot;
            // all consistency checks and encoding use the captured values exclusively.
            const {
                account,
                command,
                sequence,
                timeoutMs,
                ecdh,
                buildReserved,
                exchange,
                verifyServer,
                selectBusinessBody,
                peerPublicKey,
                randomKey: randomKeyInput,
                signal: callerSignal,
                login: loginInput,
                profile: profileInput,
            } = input;

            if (!loginInput || !profileInput) {
                throw new Error('invalid input');
            }

            const {
                uin,
                appId,
                subAppId: loginSubAppId,
                appClientVersion,
                mainSigMap,
                miscBitMap,
                subSigMap,
                packageName,
                ptVersion,
                sdkVersion,
                os,
                deviceName,
                guid: loginGuid,
                apkSignature,
                temporaryA1,
                noPicSig,
                tgtgtKey,
                tlv124Value,
                randomSource,
            } = loginInput;
            const { subAppId, guid: profileGuid, version, a2: a2Input } = profileInput;

            if (
                typeof account !== 'string' ||
                !/^(0|[1-9][0-9]*)$/.test(account) ||
                !Number.isInteger(uin) ||
                uin < 0 ||
                uin > 0xffffffff ||
                account !== String(uin) ||
                subAppId !== loginSubAppId ||
                typeof version !== 'string' ||
                version.length === 0 ||
                typeof command !== 'string' ||
                command.length === 0 ||
                !Number.isInteger(sequence) ||
                sequence < 0 ||
                sequence > 0xffffffff ||
                !Number.isInteger(timeoutMs) ||
                timeoutMs < 1 ||
                timeoutMs > 0x7fffffff ||
                (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) ||
                typeof buildReserved !== 'function' ||
                typeof exchange !== 'function' ||
                typeof verifyServer !== 'function' ||
                typeof selectBusinessBody !== 'function'
            ) {
                throw new Error('invalid or mismatched account/profile');
            }

            const login: WtLoginRequestBody = {
                uin,
                appId,
                subAppId: loginSubAppId,
                appClientVersion,
                mainSigMap,
                miscBitMap,
                subSigMap,
                packageName,
                ptVersion,
                sdkVersion,
                os,
                deviceName,
                guid: keep(loginGuid),
                apkSignature: keep(apkSignature),
                temporaryA1: keep(temporaryA1),
                noPicSig: keep(noPicSig),
                tgtgtKey: keep(tgtgtKey),
                tlv124Value: keep(tlv124Value),
                randomSource,
            };
            const guid = keep(profileGuid),
                a2 = keep(a2Input);
            const peer = keep(peerPublicKey),
                randomKey = keep(randomKeyInput);

            if (!Buffer.from(guid).equals(Buffer.from(login.guid))) {
                throw new Error('invalid or mismatched account/profile');
            }

            parentSignal = callerSignal;
            controller = new AbortController();
            const signal = controller.signal;
            abort = () => finish({ status: 'cancelled' });
            parentSignal?.addEventListener('abort', abort, { once: true });

            if (done) {
                return result;
            }

            if (parentSignal?.aborted) {
                finish({ status: 'cancelled' });
                return result;
            }

            const deadline = started + timeoutMs;
            timer = setTimeout(
                () => finish({ status: 'timeout' }),
                Math.max(1, deadline - performance.now()),
            );

            const stopped = (): boolean => {
                if (!done && performance.now() >= deadline) {
                    finish({ status: 'timeout' });
                }

                return done;
            };

            void (async () => {
                try {
                    if (stopped()) {
                        return;
                    }

                    const business = adopt(encodeWtLoginRequestBody(login));

                    if (stopped()) {
                        return;
                    }

                    const oicq = adopt(
                        encodeWtPcLoginOicqRequest({
                            uin: BigInt(login.uin),
                            clientVersion: login.appClientVersion,
                            body: business,
                            randomKey,
                            ecdh,
                            peerPublicKey: peer,
                            randomSource: login.randomSource,
                        }),
                    );

                    if (stopped()) {
                        return;
                    }

                    const signingCopy = keep(oicq);
                    const reserved = await buildReserved({
                        uin: account,
                        command,
                        sequence,
                        body: signingCopy,
                    });

                    if (stopped()) {
                        return;
                    }

                    const metadata = keep(reserved);
                    const inner = adopt(
                        encodeSso12Request({
                            sequence: sequence | 0,
                            subAppId,
                            guid,
                            version,
                            a2,
                            command,
                            reserved: metadata,
                            body: oicq,
                        }),
                    );
                    const frame = adopt(
                        encodeServiceRequest({
                            protocol: 12,
                            uin: account,
                            encryption: { type: 'zero' },
                            d2: new Uint8Array(),
                            body: inner,
                        }),
                    );

                    if (stopped()) {
                        return;
                    }

                    const reply = await exchange(keep(frame), signal);

                    if (stopped()) {
                        return;
                    }

                    if (
                        !(reply instanceof Uint8Array) ||
                        reply.byteLength > MAX_SERVICE_FRAME_BYTES
                    ) {
                        throw new Error('invalid response frame size');
                    }

                    const response = keep(reply);
                    const verified = await verifyServer({
                        account,
                        command,
                        sequence,
                        requestFrame: keep(frame),
                        requestOicq: keep(oicq),
                        responseFrame: keep(response),
                    });

                    if (stopped()) {
                        return;
                    }

                    if (verified !== true) {
                        throw new Error('server verification failed');
                    }

                    const outer = decodeServiceResponse(response);
                    owned.push(outer.body);

                    if (
                        outer.protocol !== 12 ||
                        outer.encryption !== 'zero' ||
                        outer.uin !== account
                    ) {
                        throw new Error('service response mismatch');
                    }

                    const sso = decodeSsoResponse(outer.body);
                    owned.push(sso.body, sso.cookie, sso.reserved, sso.headerExtension);

                    if (
                        sso.sequence >>> 0 !== sequence ||
                        sso.command !== command ||
                        sso.retCode !== 0
                    ) {
                        throw new Error('SSO response mismatch or error');
                    }

                    const sharedKey = keep(ecdh.deriveTeaKey(peer));
                    const wt = decodeWtOicqResponse(sso.body, { sharedKey, randomKey, ecdh });
                    owned.push(wt.body);

                    // The request encoder writes sequence zero in its 0x810 envelope.
                    if (
                        wt.uin !== login.uin ||
                        wt.command !== 0x810 ||
                        wt.sequence !== 0 ||
                        wt.state !== 0
                    ) {
                        throw new Error('OICQ response mismatch or error');
                    }

                    const selected = selectBusinessBody(keep(wt.body));

                    if (stopped()) {
                        return;
                    }

                    if (
                        !selected ||
                        !Number.isInteger(selected.start) ||
                        !Number.isInteger(selected.end) ||
                        selected.start < 0 ||
                        selected.end <= selected.start ||
                        selected.end > wt.body.length
                    ) {
                        throw new Error('invalid business body boundaries');
                    }

                    const parsed = decodeWtLoginResponse(
                        wt.body.subarray(selected.start, selected.end),
                        login.tgtgtKey,
                    );

                    for (const entry of parsed.outerTlvs) {
                        owned.push(entry.value);
                    }

                    if (parsed.status === 'tickets') {
                        for (const entry of parsed.innerTlvs) {
                            owned.push(entry.value);
                        }

                        owned.push(
                            parsed.tickets.d2,
                            parsed.tickets.d2Key,
                            parsed.tickets.a1,
                            parsed.tickets.a2,
                        );
                    }

                    if (stopped()) {
                        return;
                    }

                    if (parsed.status === 'tickets') {
                        const tickets = {
                            d2: Uint8Array.from(parsed.tickets.d2),
                            d2Key: Uint8Array.from(parsed.tickets.d2Key),
                            a1: Uint8Array.from(parsed.tickets.a1),
                            a2: Uint8Array.from(parsed.tickets.a2),
                        };

                        if (stopped()) {
                            Object.values(tickets).forEach((v) => v.fill(0));
                            return;
                        }

                        finish({ status: 'tickets', tickets });
                    } else if (parsed.status === 'error') {
                        finish({
                            status: 'error146',
                            state: parsed.state,
                            code: parsed.error.code,
                        });
                    } else {
                        finish({ status: parsed.status, state: parsed.state });
                    }
                } catch {
                    if (!stopped()) {
                        finish({ status: 'failure', reason: 'transaction failed' });
                    }
                }
            })();
        } catch {
            finish({ status: 'failure', reason: 'invalid input or preparation failed' });
        }

        return result;
    }
}
