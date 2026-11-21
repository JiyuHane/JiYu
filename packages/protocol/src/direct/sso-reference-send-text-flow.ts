import type { SsoReferenceRegisterBorrowedOptions } from './sso-reference-register-flow';
import type { Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';
import {
    createSsoReferenceExchange,
    type SsoReferenceExchangeRecord,
    type SsoReferenceExchangeSpec,
} from './sso-reference-exchange-internal';
import {
    encodeDirectSendMessageRequest,
    type DirectSendMessageRequestInput,
} from './send-message-request';
import {
    decodeDirectSendMessageResponse,
    type DirectSendMessageResponseProjection,
} from './send-message-response';

export interface SsoReferenceSendTextOptions {
    login: SsoReferenceRegisterBorrowedOptions['login'];
    profile: SsoReferenceRegisterBorrowedOptions['profile'];
    uid: string;
    request: DirectSendMessageRequestInput;
    /** Post-decompression response business-body acceptance limit, 0 through 65536. */
    maxResponseBodyBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: SsoReferenceRegisterBorrowedOptions['buildReserved'];
    verifyRaw: SsoReferenceRegisterBorrowedOptions['verifyRaw'];
}

export type SsoSendTextOutcome =
    | { status: 'response'; response: DirectSendMessageResponseProjection }
    | { status: 'sso-error'; retCode: number };
export type SsoReferenceSendTextResult = Sso12RawResult<SsoSendTextOutcome>;

const SEND_TEXT_SPEC: SsoReferenceExchangeSpec<
    DirectSendMessageRequestInput,
    DirectSendMessageResponseProjection
> = Object.freeze({
    name: 'send-text',
    command: 'MessageSvc.PbSendMsg',
    snapshotRequest(
        input: unknown,
        record: SsoReferenceExchangeRecord,
    ): DirectSendMessageRequestInput {
        const request = record(input, ['route', 'text', 'clientSequence', 'random']);
        request.route = record(request.route, ['kind', 'peerUin', 'peerUid', 'groupUin']);
        return request as unknown as DirectSendMessageRequestInput;
    },
    encodeRequest: encodeDirectSendMessageRequest,
    decodeResponse: decodeDirectSendMessageResponse,
});
const sendTextCore = createSsoReferenceExchange(SEND_TEXT_SPEC);

/**
 * Reference-only borrowed transaction for synthetic transports and login fixtures.
 * Transport allocates the outer sequence; the protobuf clientSequence is independent.
 * This flow requires transport identity UIN to exactly equal login UIN as local policy;
 * unlike borrowed registration it does not accept a transport UIN of '0' for another
 * account. Callers must supply a transport bound to the target account; this local
 * equality check does not authenticate the peer.
 * Callback metadata is opaque local policy, not proof of signing or binding. The
 * verification policy does not authenticate a peer. A response, including result zero,
 * is not evidence of delivery or acceptance. Response errMsg is untrusted text and may
 * contain sensitive data; callers own its confidentiality. This function does not log it.
 * Response projection uses Proton's UTF-8 replacement decoding for errMsg, not raw wire
 * bytes, and known field numbers with wrong wire types are discarded as unknown fields.
 * The response clientSequence is not compared to the request's clientSequence.
 * maxResponseBodyBytes is a post-decompression acceptance limit: decodeSsoResponse can
 * first inflate up to its fixed 16 MiB limit, even for a nonzero SSO return code.
 * On this public entry, reading transport.transactRaw happens before the options
 * snapshot and can invoke a getter with side effects, including mutation of options.
 * The owner controls exclusivity, transport settlement and poisoning, including an outer
 * guard rejection after a broker reports success. Non-settling transports and callbacks
 * may outlive the deadline; external callback effects and retained copies remain theirs.
 * Cleanup is best effort and does not promise erasure of codec-internal pooled allocations.
 */
export function referenceSendTextOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceSendTextOptions,
): Promise<SsoReferenceSendTextResult> {
    if (new.target) {
        throw new TypeError('referenceSendTextOnTransport is not a constructor');
    }

    return sendTextCore(transport, options);
}

/** Deep internal composition only; capability coordination is not peer authentication. */
export function referenceSendTextWithCapability(
    capability: { token: object; attempt: object; lease: Sso12RawTransport; run: object },
    options: SsoReferenceSendTextOptions,
): Promise<SsoReferenceSendTextResult> {
    return sendTextCore(undefined, options, capability);
}
