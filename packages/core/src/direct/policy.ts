import { decodeServiceResponse } from '@snowluma/protocol/direct/service-frame';
import { decodeSsoResponse } from '@snowluma/protocol/direct/sso';
import {
    createSsoReserveBuilder,
    type SsoSigningRequest,
} from '@snowluma/protocol/direct/sso-reserve';
import type { LocalQqSignWorker } from '@snowluma/protocol/direct/local-qq-sign-worker';
import type { WtReferenceSessionOptions } from '@snowluma/protocol/direct/wt-reference-session';
import type { WtMultiplexReferenceOptions } from '@snowluma/protocol/direct/wt-multiplex-reference';
import { SSO_INFO_SYNC_COMMAND } from '@snowluma/protocol/direct/sso-register';
import { isWtReferencePushCommand } from '@snowluma/protocol/direct/wt-reference-push-commands';
import type { DirectLoginConfig } from './config';
import { ObservedConnection, frameHash } from './connection';
import { DirectLoginError } from './errors';

type Phase = 'fetch' | 'poll' | 'login';
type Pending = {
    uin: string;
    command: string;
    sequence: number;
    bodyHash: string;
    wt: boolean;
    rawAccepted: boolean;
    complete: boolean;
};
const uint32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const NATIVE_RENEWAL_SIGN_COMMANDS = new Set([
    'trpc.login.ecdh.EcdhService.SsoKeyExchange',
    'trpc.login.ecdh.EcdhService.SsoNTLoginRefreshTicket',
]);

/** Association policy for the pinned reference codecs. No server-authentication claim:
 * socket provenance + exact sent bytes + cmd/seq/account, followed by the owner's decoder.
 * In particular, D2 remains private to the owner; its mux verifies the decrypted tuple. */
export class LoginPolicy {
    phase: Phase = 'fetch';
    confirmedUin?: string;
    failure?: 'association' | 'sso-response' | 'context';
    ssoCode?: number;
    private pending?: Pending;
    private restored = false;

    constructor(
        private readonly connection: ObservedConnection,
        private readonly signer: LocalQqSignWorker,
        private readonly config: DirectLoginConfig,
    ) {}

    /** A saved local identity selects the account; only a subsequent verified
     * SsoInfoSync response establishes that this new connection is registered. */
    initializeRestoredAccount(uin: string): void {
        if (
            this.restored ||
            this.pending ||
            this.confirmedUin ||
            this.phase !== 'fetch' ||
            !this.connection.live ||
            typeof uin !== 'string' ||
            !/^[1-9][0-9]{0,9}$/.test(uin) ||
            BigInt(uin) > 0xffffffffn
        ) {
            throw new DirectLoginError('restored-account-binding');
        }

        this.restored = true;
        this.confirmedUin = uin;
        this.phase = 'login';
    }

    private reject(code: NonNullable<LoginPolicy['failure']>): false {
        this.failure = code;
        return false;
    }
    private async reserve(
        input: SsoSigningRequest,
        wt: boolean,
        uid?: string,
    ): Promise<Uint8Array> {
        const expected = wt && this.phase !== 'login' ? '0' : this.confirmedUin;

        if (
            !this.connection.live ||
            (this.restored && wt) ||
            !expected ||
            input.uin !== expected ||
            !uint32(input.sequence) ||
            (this.pending && !this.pending.complete)
        ) {
            throw new DirectLoginError('request-association');
        }

        if (
            wt &&
            input.command !==
                (this.phase === 'login'
                    ? this.config.profile.loginCommand
                    : this.config.profile.qrCommand)
        ) {
            throw new DirectLoginError('request-association');
        }

        const current: Pending = {
            uin: input.uin,
            command: input.command,
            sequence: input.sequence,
            bodyHash: frameHash(input.body),
            wt,
            rawAccepted: false,
            complete: false,
        };
        this.pending = current;
        const builder = createSsoReserveBuilder({
            uin: input.uin,
            uid,
            msgType: this.config.reserve.msgType ?? undefined,
            ntCoreVersion: this.config.reserve.ntCoreVersion ?? undefined,
            // Renewal commands are a code-owned, fixed capability. Keeping them out of the
            // mutable config list preserves the encrypted account's existing profile binding.
            classifySigning: (command) =>
                this.config.reserve.signCommands.includes(command) ||
                NATIVE_RENEWAL_SIGN_COMMANDS.has(command)
                    ? 'sign'
                    : 'unsigned',
            sign: (request) => this.signer.sign(request),
        });
        // Registration inputs also carry uid. Pass exactly SsoSigningRequest to the signer path.
        return builder({
            uin: input.uin,
            command: input.command,
            sequence: input.sequence,
            body: input.body,
        });
    }
    readonly buildWtReserved: WtReferenceSessionOptions['buildWtReserved'] = (input) =>
        this.reserve(input, true);
    readonly buildRegisterReserved: WtReferenceSessionOptions['buildRegisterReserved'] = (input) =>
        this.reserve(input, false, input.uid);

    readonly verifyRaw: WtReferenceSessionOptions['verifyRaw'] = (evidence) => {
        const pending = this.pending;

        if (
            this.restored ||
            !pending ||
            !pending.wt ||
            pending.rawAccepted ||
            pending.complete ||
            evidence.operation !== this.phase ||
            evidence.transportUin !== '0' ||
            evidence.requestUin !== pending.uin ||
            evidence.command !== pending.command ||
            evidence.sequence !== pending.sequence ||
            frameHash(evidence.requestOicq) !== pending.bodyHash ||
            !this.connection.verifyExchange(evidence.requestFrame, evidence.responseFrame)
        ) {
            return this.reject('association');
        }

        let outer: ReturnType<typeof decodeServiceResponse> | undefined;
        let sso: ReturnType<typeof decodeSsoResponse> | undefined;

        try {
            outer = decodeServiceResponse(evidence.responseFrame);
            sso = decodeSsoResponse(outer.body);

            if (
                outer.protocol !== 12 ||
                outer.encryption !== 'zero' ||
                outer.uin !== pending.uin ||
                sso.sequence >>> 0 !== pending.sequence ||
                sso.command !== pending.command ||
                sso.retCode !== 0
            ) {
                this.ssoCode = sso.retCode;
                return this.reject('sso-response');
            }

            pending.rawAccepted = true;
            return this.connection.live;
        } catch {
            return this.reject('sso-response');
        } finally {
            outer?.body.fill(0);
            sso?.body.fill(0);
            sso?.cookie.fill(0);
            sso?.reserved.fill(0);
            sso?.headerExtension.fill(0);
        }
    };

    readonly verifyContext: WtReferenceSessionOptions['verifyContext'] = (context) => {
        const p = this.pending;

        if (
            this.restored ||
            !p ||
            !p.wt ||
            !p.rawAccepted ||
            p.complete ||
            !this.connection.live ||
            context.operation !== this.phase ||
            context.transportUin !== '0' ||
            context.requestUin !== p.uin ||
            context.responseUin !== p.uin ||
            context.command !== p.command ||
            context.sequence !== p.sequence ||
            context.oicqSequence !== 0 ||
            !uint32(context.oicqUin)
        ) {
            return this.reject('context');
        }

        if (context.operation === 'login') {
            if (
                context.oicqCommand !== 0x810 ||
                String(context.oicqUin) !== this.confirmedUin ||
                context.code2dCommand !== undefined ||
                context.code2dSequence !== undefined ||
                context.code2dUin !== undefined ||
                context.businessUin !== undefined ||
                context.businessAppId !== undefined
            ) {
                return this.reject('context');
            }
        } else {
            if (
                context.oicqCommand !== 0x812 ||
                context.code2dCommand !== (context.operation === 'fetch' ? 0x31 : 0x12) ||
                context.code2dSequence === undefined ||
                !uint32(context.code2dSequence) ||
                typeof context.code2dUin !== 'bigint' ||
                context.code2dUin < -0x8000000000000000n ||
                context.code2dUin > 0x7fffffffffffffffn ||
                context.businessAppId === undefined ||
                !Number.isInteger(context.businessAppId) ||
                context.businessAppId < -0x80000000 ||
                context.businessAppId > 0x7fffffff
            ) {
                return this.reject('context');
            }

            // These QR envelope values are opaque in the reference, not account echoes.
            // Only the confirmed business UIN establishes the subsequent login identity.
            if (context.businessUin !== undefined) {
                if (
                    context.operation !== 'poll' ||
                    context.businessUin < 1n ||
                    context.businessUin > 0xffffffffn ||
                    this.confirmedUin
                ) {
                    return this.reject('context');
                }

                this.confirmedUin = context.businessUin.toString();
            }
        }

        p.complete = true;
        return true;
    };

    readonly sliceBusiness: WtReferenceSessionOptions['sliceBusiness'] = ({
        operation,
        bodyLength,
        trailingByte,
    }) => {
        if (
            this.restored ||
            operation !== this.phase ||
            !Number.isInteger(bodyLength) ||
            bodyLength < (operation === 'login' ? 5 : 8)
        ) {
            throw new DirectLoginError('business-boundary');
        }

        // Live Linux QR responses retain one Code2d 0x03 terminator after the complete
        // business TLVs. Validate that byte before selecting the exact business range;
        // the generic TLV decoder still rejects every extra or missing byte.
        if (operation !== 'login') {
            if (trailingByte !== 3) {
                throw new DirectLoginError('code2d-terminator');
            }

            return { start: 0, end: bodyLength - 1 };
        }

        return { start: 0, end: bodyLength };
    };

    readonly verifyRegisterRaw: WtReferenceSessionOptions['verifyRegisterRaw'] = (evidence) => {
        const p = this.pending;

        if (
            !p ||
            p.wt ||
            p.complete ||
            evidence.uin !== this.confirmedUin ||
            evidence.uin !== p.uin ||
            evidence.command !== p.command ||
            evidence.sequence !== p.sequence ||
            !this.connection.verifyExchange(evidence.requestFrame, evidence.responseFrame)
        ) {
            return this.reject('association');
        }

        // createWtMultiplexReference has already checked protocol/UIN/cmd/seq and either
        // D2 or Linux SsoInfoSync's fixed-zero-key response envelope. The register decoder
        // additionally requires business success.
        p.rawAccepted = true;
        p.complete = true;
        return this.connection.live;
    };

    readonly verifyPushRaw: WtMultiplexReferenceOptions['verifyPushRaw'] = (frame, meta) =>
        isWtReferencePushCommand(meta.command) &&
        meta.uin === this.confirmedUin &&
        uint32(meta.sequence) &&
        this.connection.takeReceived(frame);

    assertRegistrationCommand(): void {
        if (this.pending?.command !== SSO_INFO_SYNC_COMMAND || !this.pending.complete) {
            throw new DirectLoginError('registration-association');
        }
    }
}
