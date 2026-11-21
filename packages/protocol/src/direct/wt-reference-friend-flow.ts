import { isProxy } from 'node:util/types';
import {
    encodeLinuxFriendAddRequest,
    encodeLinuxFriendSettingRequest,
    LINUX_FRIEND_ADD_COMMAND,
    LINUX_FRIEND_SETTING_COMMAND,
    type LinuxFriendAddInput,
    type LinuxFriendSettingInput,
} from './linux-friend-request';
import {
    decodeLinuxFriendAddResponse,
    decodeLinuxFriendSettingResponse,
    disposeLinuxFriendAddResponse,
    type LinuxFriendAddResponse,
    type LinuxFriendOidbError,
    type LinuxFriendSettingProjection,
    type LinuxFriendSettingResponse,
} from './linux-friend-response';
import {
    createSsoReferenceExchange,
    type SsoReferenceExchangeOptions,
    type SsoReferenceExchangeCapability,
} from './sso-reference-exchange-internal';
import {
    beginReferenceFriendStep,
    endReferenceFriendStep,
    assertReferenceFriendStep,
} from './wt-reference-session-private';
import type { RawSessionLease } from './raw-session-broker';
import type { WtActiveReferenceSession } from './wt-reference-session';
import type { Sso12RawResult } from './sso12-packet-client';

export type WtReferenceFriendApplication = Omit<LinuxFriendAddInput, keyof LinuxFriendSettingInput>;
type FriendTarget = Omit<LinuxFriendSettingInput, 'selfUin'> & {
    /** Total monotonic budget shared by both steps, 1..0x7fffffff milliseconds. */
    readonly timeoutMs: number;
    /** Post-inflation acceptance cap per response, 0..65536 bytes. */
    readonly maxResponseBodyBytes: number;
};
export type WtReferenceFriendInput = FriendTarget &
    (
        | { readonly mode: 'inspect' }
        | {
              readonly mode: 'apply';
              readonly expectedSetting: number;
              readonly application: WtReferenceFriendApplication;
          }
    );
export type WtReferenceFriendNotAppliedReason =
    | 'oidb-error'
    | 'error-code'
    | 'setting-missing'
    | 'setting-mismatch'
    | 'questions-present'
    | 'peer-mismatch';
export type WtReferenceFriendApplicationResponse =
    | LinuxFriendOidbError
    | (Omit<Extract<LinuxFriendAddResponse, { kind: 'application' }>, 'sig' | 'verify'> & {
          readonly sigPresent: boolean;
          readonly sigLength: number;
          readonly verifyPresent: boolean;
          readonly verifyLength: number;
      });
export type WtReferenceFriendResult =
    | {
          readonly status: 'settings';
          readonly settings: LinuxFriendSettingResponse;
          readonly applicationAttempted: false;
          readonly applicationWriteState: 'not-written';
      }
    | {
          readonly status: 'not-applied';
          readonly settings: LinuxFriendSettingResponse;
          readonly reason: WtReferenceFriendNotAppliedReason;
          readonly applicationAttempted: false;
          readonly applicationWriteState: 'not-written';
      }
    | {
          readonly status: 'application-response';
          readonly settings: LinuxFriendSettingProjection;
          readonly response: WtReferenceFriendApplicationResponse;
          readonly applicationAttempted: true;
          readonly applicationWriteState: 'written';
      };
export type WtReferenceFriendStepId = 'settings' | 'application';
type WriteState = Sso12RawResult<unknown>['writeState'];
/** Internal mutable progress contains no credentials or request/response bytes. */
export interface ReferenceFriendProgress {
    stage: WtReferenceFriendStepId;
    applicationAttempted: boolean;
    applicationWriteState: WriteState;
}

/** Transport failure is not a protocol outcome. In particular, unknown writes are never replayed. */
export class WtReferenceFriendError extends Error {
    readonly stage: WtReferenceFriendStepId;
    readonly applicationAttempted: boolean;
    readonly applicationWriteState: WriteState;
    constructor(
        progress: Readonly<ReferenceFriendProgress>,
        readonly code: 'exchange-failed' | 'sso-error' | 'workflow-stopped',
    ) {
        super(`friend request ${code}`);
        this.name = 'WtReferenceFriendError';
        this.stage = progress.stage;
        this.applicationAttempted = progress.applicationAttempted;
        this.applicationWriteState = progress.applicationWriteState;
    }
}

/** Fixed business-step mapping; signer command strings never select a step. */
export function referenceFriendStepCommand(step: WtReferenceFriendStepId): string {
    if (step === 'settings') {
        return LINUX_FRIEND_SETTING_COMMAND;
    }

    if (step === 'application') {
        return LINUX_FRIEND_ADD_COMMAND;
    }

    throw new Error('invalid friend step');
}

export interface PreparedReferenceFriendInput {
    readonly mode: 'inspect' | 'apply';
    readonly peerUin: bigint;
    readonly expectedSetting?: number;
    readonly timeoutMs: number;
    readonly maxResponseBodyBytes: number;
    readonly settingsBody: Uint8Array;
    readonly applicationBody?: Uint8Array;
}
const fill = Uint8Array.prototype.fill;
const commonFields = ['peerUin', 'sourceId', 'sourceSub', 'name', 'name1'];
const applicationFields = [
    'addSetting',
    'myAllowFlag',
    'groupId',
    'answer',
    'srcFlag',
    'autoSend',
    'sig',
    'sourceDescription',
    'friendSourceDescription',
    'remark',
    'cardSwitch',
    'token',
    'verify',
    'secureTips',
    'supportAddRelief',
    'ext',
    'bytesSig',
    'clientExt',
];

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        throw new TypeError('invalid friend input');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    const keys = Reflect.ownKeys(value);

    if ((prototype !== Object.prototype && prototype !== null) || keys.length > allowed.length) {
        throw new TypeError('invalid friend input');
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid friend input');
        }

        result[key] = descriptor.value;
    }

    return result;
}

/** Synchronous public boundary: all foreign records and bytes end here, before any await. */
export function prepareReferenceFriendInput(
    input: unknown,
    selfUin: bigint,
): PreparedReferenceFriendInput {
    const value = record(input, [
        ...commonFields,
        'mode',
        'expectedSetting',
        'application',
        'timeoutMs',
        'maxResponseBodyBytes',
    ]);

    if (
        typeof value.timeoutMs !== 'number' ||
        !Number.isInteger(value.timeoutMs) ||
        value.timeoutMs < 1 ||
        value.timeoutMs > 0x7fffffff ||
        typeof value.maxResponseBodyBytes !== 'number' ||
        !Number.isSafeInteger(value.maxResponseBodyBytes) ||
        value.maxResponseBodyBytes < 0 ||
        value.maxResponseBodyBytes > 65536
    ) {
        throw new TypeError('invalid friend operation limits');
    }

    if (value.mode !== 'inspect' && value.mode !== 'apply') {
        throw new TypeError('invalid friend mode');
    }

    if (
        value.mode === 'inspect' &&
        (Object.hasOwn(value, 'application') || Object.hasOwn(value, 'expectedSetting'))
    ) {
        throw new TypeError('invalid inspect fields');
    }

    if (
        value.mode === 'apply' &&
        (typeof value.expectedSetting !== 'number' ||
            !Number.isInteger(value.expectedSetting) ||
            value.expectedSetting < -0x80000000 ||
            value.expectedSetting > 0x7fffffff)
    ) {
        throw new TypeError('invalid expected friend setting');
    }

    const target = {
        selfUin,
        peerUin: value.peerUin,
        sourceId: value.sourceId,
        sourceSub: value.sourceSub,
        name: value.name,
        name1: value.name1,
    } as LinuxFriendSettingInput;
    const settingsBody = encodeLinuxFriendSettingRequest(target);
    let applicationBody: Uint8Array | undefined;

    try {
        if (value.mode === 'apply') {
            const application = record(value.application, applicationFields);
            // The pure codec validates and owns every byte field synchronously. Only
            // its independently owned encoding survives into the workflow.
            applicationBody = encodeLinuxFriendAddRequest({ ...target, ...application });
        }

        return Object.freeze({
            mode: value.mode,
            peerUin: target.peerUin,
            expectedSetting: value.expectedSetting as number | undefined,
            timeoutMs: value.timeoutMs,
            maxResponseBodyBytes: value.maxResponseBodyBytes,
            settingsBody,
            applicationBody,
        });
    } catch (error) {
        fill.call(settingsBody, 0);

        if (applicationBody) {
            fill.call(applicationBody, 0);
        }

        throw error;
    }
}

export function disposePreparedReferenceFriendInput(
    input: PreparedReferenceFriendInput | undefined,
): void {
    if (input) {
        fill.call(input.settingsBody, 0);

        if (input.applicationBody) {
            fill.call(input.applicationBody, 0);
        }
    }
}

// Prepared bytes are private workflow-owned buffers, never an owner raw-input API.
type EncodedRequest = { body: Uint8Array };

const snapshotRequest = (input: unknown): EncodedRequest => {
    const value = record(input, ['body']);
    return { body: value.body as Uint8Array };
};

const encodeRequest = (input: EncodedRequest): Uint8Array => Uint8Array.from(input.body);
const settingsExchange = createSsoReferenceExchange({
    name: 'friend-settings',
    command: LINUX_FRIEND_SETTING_COMMAND,
    snapshotRequest,
    encodeRequest,
    decodeResponse: decodeLinuxFriendSettingResponse,
});
const applicationExchange = createSsoReferenceExchange({
    name: 'friend-application',
    command: LINUX_FRIEND_ADD_COMMAND,
    snapshotRequest,
    encodeRequest,
    decodeResponse: decodeLinuxFriendAddResponse,
    disposeResponse: disposeLinuxFriendAddResponse,
});

function notApplied(
    settings: LinuxFriendSettingResponse,
    prepared: PreparedReferenceFriendInput,
): WtReferenceFriendNotAppliedReason | undefined {
    if (settings.kind === 'oidb-error') {
        return 'oidb-error';
    }

    if (settings.peerUin !== undefined && settings.peerUin !== prepared.peerUin) {
        return 'peer-mismatch';
    }

    // Linux getBuddySetting (r_50618, array334/SFI333, bytecode 0x36ea)
    // checks the outer native callback result, not rsp.result (body tag 5).
    // SSO/OIDB errors are checked upstream; retain this inner field as data.
    // The application response has a separate result contract, not a query gate.
    if (settings.errorCode !== undefined && settings.errorCode !== 0) {
        return 'error-code';
    }

    if (settings.setting === undefined) {
        return 'setting-missing';
    }

    if (settings.setting !== prepared.expectedSetting) {
        return 'setting-mismatch';
    }

    if (settings.questions.length !== 0) {
        return 'questions-present';
    }

    return undefined;
}

/** Internal finite workflow. It neither retries nor infers any setting/source enum. */
export async function referenceFriendWithCapability(
    binding: Omit<SsoReferenceExchangeCapability, 'run' | 'lease'> & {
        lease: RawSessionLease;
        owner: WtActiveReferenceSession;
        workflowRun: object;
    },
    prepared: PreparedReferenceFriendInput,
    options: Omit<
        SsoReferenceExchangeOptions<EncodedRequest>,
        'request' | 'timeoutMs' | 'maxResponseBodyBytes'
    >,
    deadline: number,
    progress: ReferenceFriendProgress,
    checkOwner: () => void,
): Promise<WtReferenceFriendResult> {
    const check = (): number => {
        checkOwner();
        const remaining = Math.floor(deadline - performance.now());
        checkOwner();

        if (remaining < 1) {
            throw new WtReferenceFriendError(progress, 'workflow-stopped');
        }

        return remaining;
    };

    const step = async <P>(
        stepId: WtReferenceFriendStepId,
        body: Uint8Array,
        exchange: ReturnType<typeof createSsoReferenceExchange<EncodedRequest, P>>,
        dispose?: (projection: P) => void,
    ): Promise<P> => {
        const timeoutMs = check();
        const childRun = Object.freeze({});
        progress.stage = stepId;
        const stage = beginReferenceFriendStep(
            binding.token,
            binding.owner,
            binding.lease,
            binding.attempt,
            binding.workflowRun,
            childRun,
            stepId,
        );
        let pending: { value: P } | undefined;
        let ended = false;

        const checkStage = (): void => {
            check();
            assertReferenceFriendStep(
                binding.token,
                binding.owner,
                binding.lease,
                binding.attempt,
                stage,
            );
        };

        if (stepId === 'application') {
            // Burn before entering any callback or transport. Never retry this stage.
            progress.applicationAttempted = true;
            progress.applicationWriteState = 'unknown';
        }

        try {
            const result = await exchange(
                undefined,
                {
                    ...options,
                    request: { body },
                    timeoutMs,
                    maxResponseBodyBytes: prepared.maxResponseBodyBytes,
                    buildReserved: async (input) => {
                        checkStage();
                        const signed = await options.buildReserved(input);
                        checkStage();
                        return signed;
                    },
                    verifyRaw: async (input) => {
                        checkStage();
                        const verified = await options.verifyRaw(input);
                        checkStage();
                        return verified;
                    },
                },
                {
                    token: binding.token,
                    attempt: binding.attempt,
                    lease: binding.lease,
                    run: childRun,
                },
            );

            if (stepId === 'application') {
                progress.applicationWriteState = result.writeState;
            }

            if (result.kind !== 'response') {
                throw new WtReferenceFriendError(progress, 'exchange-failed');
            }

            if (result.value.status !== 'response') {
                throw new WtReferenceFriendError(progress, 'sso-error');
            }

            pending = { value: result.value.response };
            check();
            assertReferenceFriendStep(
                binding.token,
                binding.owner,
                binding.lease,
                binding.attempt,
                stage,
            );
            endReferenceFriendStep(
                binding.token,
                binding.owner,
                binding.lease,
                binding.attempt,
                stage,
            );
            ended = true;
            check();
            const projection = pending.value;
            pending = undefined;
            return projection;
        } finally {
            try {
                if (!ended) {
                    endReferenceFriendStep(
                        binding.token,
                        binding.owner,
                        binding.lease,
                        binding.attempt,
                        stage,
                    );
                }
            } finally {
                if (pending) {
                    dispose?.(pending.value);
                }
            }
        }
    };

    const settings = await step('settings', prepared.settingsBody, settingsExchange);
    check();

    if (prepared.mode === 'inspect') {
        return Object.freeze({
            status: 'settings',
            settings,
            applicationAttempted: false,
            applicationWriteState: 'not-written',
        });
    }

    const reason = notApplied(settings, prepared);

    if (reason) {
        return Object.freeze({
            status: 'not-applied',
            settings,
            reason,
            applicationAttempted: false,
            applicationWriteState: 'not-written',
        });
    }

    const application = await step(
        'application',
        prepared.applicationBody!,
        applicationExchange,
        disposeLinuxFriendAddResponse,
    );

    try {
        check();
        const response: WtReferenceFriendApplicationResponse =
            application.kind === 'oidb-error'
                ? application
                : Object.freeze({
                      kind: 'application',
                      friendSetting: application.friendSetting,
                      myAllowFlag: application.myAllowFlag,
                      groupId: application.groupId,
                      result: application.result,
                      errorCode: application.errorCode,
                      errorMessage: application.errorMessage,
                      sigPresent: application.sig !== undefined,
                      sigLength: application.sig?.byteLength ?? 0,
                      verifyPresent: application.verify !== undefined,
                      verifyLength: application.verify?.byteLength ?? 0,
                  });
        return Object.freeze({
            status: 'application-response',
            settings: settings as LinuxFriendSettingProjection,
            response,
            applicationAttempted: true,
            applicationWriteState: 'written',
        });
    } finally {
        disposeLinuxFriendAddResponse(application);
    }
}
