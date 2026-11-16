import { isProxy } from 'node:util/types';
import type { ApiResponse, JsonObject, JsonValue } from '../types';
import type { V12CoreOptions, V12FileLease, V12Response } from './types';
import { classifyFileUrl } from './file-url';
import { isV12ImageToken, isV12VoiceToken } from './image-file-token';
import { isV12UploadToken, V12_UPLOAD_TOKEN_PREFIX } from './uploaded-data-store';
import {
    MAX_REQUEST_STRING_LENGTH,
    fromV11MessageId,
    isObject,
    isSelf,
    parseAccountId,
    parseMessageId,
    snapshotRequest,
} from './validation';

const apply = Reflect.apply;

type PreparedRequest = {
    input: Record<string, unknown>;
    fallbackEcho: string | undefined;
};

type PreparedOrdinary = {
    request: PreparedRequest;
    fileLease: V12FileLease | undefined;
};

type FragmentProviders = {
    upload: NonNullable<V12CoreOptions['uploadDataFile']>;
    get: NonNullable<V12CoreOptions['getUploadedDataFile']>;
    metadata: NonNullable<V12CoreOptions['getUploadedDataFileMetadata']>;
    chunk: NonNullable<V12CoreOptions['getUploadedDataFileChunk']>;
    readiness: V12CoreOptions['isUploadDataSupported'];
};

type Preflight =
    { kind: 'error'; response: V12Response } | { kind: 'ready'; request: PreparedRequest };

type HttpPreflight =
    | { readonly kind: 'error'; readonly response: V12Response }
    | { readonly kind: 'ordinary'; readonly token: object }
    | {
          readonly kind: 'poll';
          readonly limit: number;
          readonly timeoutSeconds: number;
          readonly echo?: string;
      };

const ACTIONS = [
    'get_version',
    'get_status',
    'get_supported_actions',
    'get_self_info',
    'get_user_info',
    'get_friend_list',
    'get_group_info',
    'get_group_list',
    'get_group_member_list',
    'get_group_member_info',
    'set_group_name',
    'leave_group',
    'send_message',
    'delete_message',
    'get_file',
] as const;

function response(
    retcode: number,
    message: string,
    data: JsonValue = null,
    echo?: string,
): V12Response {
    return {
        status: retcode === 0 ? 'ok' : 'failed',
        retcode,
        data,
        message,
        ...(echo !== undefined ? { echo } : {}),
    };
}

function extraKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).some((key) => !allowed.includes(key));
}

// This bounds one local success envelope for the default transport, including
// the maximum WebSocket framing overhead. It does not guarantee delivery or
// account for smaller configured limits or already-queued WebSocket messages.
const MAX_FILE_SUCCESS_JSON_BYTES = 1024 * 1024 - 14;
const MAX_UPLOAD_BASE64_LENGTH = 349528;
const MAX_UPLOAD_DATA_BYTES = 256 * 1024;

function fileSuccessFits(data: JsonObject, echo?: string): boolean {
    return (
        Buffer.byteLength(JSON.stringify(response(0, '', data, echo)), 'utf8') <=
        MAX_FILE_SUCCESS_JSON_BYTES
    );
}

function fileLeaseCurrent(lease?: V12FileLease): boolean {
    try {
        // Direct, transport-independent core callers own their own lifecycle.
        return lease === undefined || lease() === true;
    } catch {
        return false;
    }
}

/** Inspect only own data properties of a non-Proxy provider result. */
function ownData(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Fragment provider fields must also survive ordinary JSON enumeration. */
function ownEnumerableData(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

function isProviderRecord(value: unknown): value is object {
    return typeof value === 'object' && value !== null && !isProxy(value) && !Array.isArray(value);
}

function isCanonicalUploadId(value: unknown): value is string {
    if (
        typeof value !== 'string' ||
        !isV12UploadToken(value) ||
        value.length !== V12_UPLOAD_TOKEN_PREFIX.length + 43
    ) {
        return false;
    }

    const encoded = value.slice(V12_UPLOAD_TOKEN_PREFIX.length);
    // 32-byte base64url has 42 unrestricted characters and two zero pad bits.
    return /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(encoded);
}

function isCanonicalUploadData(value: unknown): value is string {
    if (
        typeof value !== 'string' ||
        value.length > MAX_UPLOAD_BASE64_LENGTH ||
        value.length % 4 !== 0
    ) {
        return false;
    }

    const length = value.length;
    const padding =
        length > 0 && value[length - 1] === '=' ? (value[length - 2] === '=' ? 2 : 1) : 0;

    for (let index = 0; index < length - padding; index += 1) {
        const code = value.charCodeAt(index);

        if (!(
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            (code >= 48 && code <= 57) ||
            code === 43 ||
            code === 47
        )) {
            return false;
        }
    }

    if (padding === 2 && !'AQgw'.includes(value[length - 3]!)) {
        return false;
    }

    if (padding === 1 && !'AEIMQUYcgkosw048'.includes(value[length - 2]!)) {
        return false;
    }

    return (length / 4) * 3 - padding <= MAX_UPLOAD_DATA_BYTES;
}

/** Only call on an already bounded snapshot, never on caller-owned objects. */
function freezeSnapshot(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
        return;
    }

    for (const child of Object.values(value)) {
        freezeSnapshot(child);
    }

    Object.freeze(value);
}

/** V11's generic execution failure can cover both platform and internal errors;
 * avoid claiming a platform error without evidence. The action may have taken effect. */
function v11Failure(result: ApiResponse, echo?: string): V12Response | null {
    const unknownOutcome = 'action outcome unavailable; do not retry automatically';

    if (!isObject(result)) {
        return response(20001, unknownOutcome, null, echo);
    }

    if (result.status === 'ok' && result.retcode === 0) {
        return null;
    }

    if (
        result.status !== 'failed' ||
        !Number.isSafeInteger(result.retcode) ||
        result.retcode <= 0
    ) {
        return response(20001, unknownOutcome, null, echo);
    }

    if (result.retcode === 1400) {
        return response(
            10003,
            'invalid action input; outcome may be uncertain; do not retry automatically',
            null,
            echo,
        );
    }

    if (result.retcode === 1404) {
        return response(20001, unknownOutcome, null, echo);
    }

    return response(20002, unknownOutcome, null, echo);
}

/** Per-account V12 dispatcher. Transport admission/authentication is the caller's responsibility. */
export class V12Dispatcher {
    private readonly self: V12CoreOptions['self'];
    private readonly version: V12CoreOptions['version'];
    readonly #preparedOrdinary = new WeakMap<object, PreparedOrdinary>();
    // A provider/readiness callback may synchronously reenter this dispatcher.
    #fragmentBusy = false;

    constructor(private readonly options: V12CoreOptions) {
        let self: unknown;

        try {
            self = snapshotRequest(options.self);
        } catch {
            throw new Error('invalid V12 core identity or version');
        }

        if (!isSelf(self) || !options.version.impl || !options.version.version) {
            throw new Error('invalid V12 core identity or version');
        }

        freezeSnapshot(self);
        this.self = self;
        this.version = { ...options.version };
    }

    /** A transport supplies its listener lease; direct core users own callback lifetime. */
    async handle(input: unknown, fileLease?: V12FileLease): Promise<V12Response> {
        const checked = this.preflight(input);
        return checked.kind === 'error'
            ? checked.response
            : this.runPrepared(checked.request, fileLease);
    }

    /** Internal future HTTP integration seam. It does not register or run a poll.
     * A trusted caller binds its listener's lease here, not when consuming a token.
     * The lease is a lifetime check, not authentication of the caller or source. */
    createInternalHttpPreflight(
        fileLease?: V12FileLease,
    ): Readonly<{ classify(input: unknown): HttpPreflight }> {
        return Object.freeze({
            classify: (input: unknown) => this.classifyHttpRequest(input, fileLease),
        });
    }

    /** Consume only a token issued by this dispatcher's HTTP preflight, at most once. */
    async handlePreparedOrdinary(token: object): Promise<V12Response> {
        const prepared = this.#preparedOrdinary.get(token);

        if (!prepared) {
            return response(10001, 'invalid action request');
        }

        this.#preparedOrdinary.delete(token);
        return this.runPrepared(prepared.request, prepared.fileLease ?? (() => false));
    }

    private classifyHttpRequest(
        input: unknown,
        fileLease: V12FileLease | undefined,
    ): HttpPreflight {
        const checked = this.preflight(input);

        if (checked.kind === 'error') {
            return Object.freeze(checked);
        }

        const { request } = checked;
        const { action, params, echo } = request.input;

        if (action !== 'get_latest_events') {
            const token = Object.freeze(Object.create(null) as object);
            this.#preparedOrdinary.set(token, { request, fileLease });
            return Object.freeze({ kind: 'ordinary', token });
        }

        // preflight has already verified params is an object and echo is a string if present.
        const pollParams = params as Record<string, unknown>;
        const requestEcho = typeof echo === 'string' ? echo : undefined;

        if (extraKeys(pollParams, ['limit', 'timeout'])) {
            return Object.freeze({
                kind: 'error',
                response: response(10004, 'unsupported parameter', null, requestEcho),
            });
        }

        const limit = Object.hasOwn(pollParams, 'limit') ? pollParams.limit : 0;
        const timeout = Object.hasOwn(pollParams, 'timeout') ? pollParams.timeout : 0;

        if (
            typeof limit !== 'number' ||
            !Number.isSafeInteger(limit) ||
            limit < 0 ||
            typeof timeout !== 'number' ||
            !Number.isSafeInteger(timeout) ||
            timeout < 0 ||
            timeout > 10
        ) {
            return Object.freeze({
                kind: 'error',
                response: response(10003, 'invalid poll parameters', null, requestEcho),
            });
        }

        return Object.freeze({
            kind: 'poll',
            limit,
            timeoutSeconds: timeout,
            ...(requestEcho !== undefined ? { echo: requestEcho } : {}),
        });
    }

    private preflight(input: unknown): Preflight {
        let fallbackEcho: string | undefined;

        try {
            if (isProxy(input)) {
                return { kind: 'error', response: response(10001, 'invalid action request') };
            }

            if (typeof input === 'object' && input !== null) {
                const descriptor = Object.getOwnPropertyDescriptor(input, 'echo');

                if (
                    descriptor &&
                    'value' in descriptor &&
                    typeof descriptor.value === 'string' &&
                    descriptor.value.length <= MAX_REQUEST_STRING_LENGTH
                ) {
                    fallbackEcho = descriptor.value;
                }
            }

            const snapshot = snapshotRequest(input);

            if (!isObject(snapshot)) {
                return { kind: 'error', response: response(10001, 'invalid action request') };
            }

            const echo = typeof snapshot.echo === 'string' ? snapshot.echo : undefined;

            if (
                typeof snapshot.action !== 'string' ||
                !snapshot.action ||
                !isObject(snapshot.params) ||
                (Object.hasOwn(snapshot, 'echo') && typeof snapshot.echo !== 'string') ||
                (Object.hasOwn(snapshot, 'self') && !isSelf(snapshot.self))
            ) {
                return {
                    kind: 'error',
                    response: response(10001, 'invalid action request', null, echo),
                };
            }

            if (
                snapshot.self !== undefined &&
                isSelf(snapshot.self) &&
                (snapshot.self.platform !== this.self.platform ||
                    snapshot.self.user_id !== this.self.user_id)
            ) {
                return { kind: 'error', response: response(10102, 'unknown self', null, echo) };
            }

            if (
                extraKeys(snapshot, ['action', 'params', 'echo', 'self']) ||
                (isObject(snapshot.self) && extraKeys(snapshot.self, ['platform', 'user_id']))
            ) {
                return {
                    kind: 'error',
                    response: response(10004, 'unsupported request field', null, echo),
                };
            }

            return { kind: 'ready', request: { input: snapshot, fallbackEcho } };
        } catch {
            return {
                kind: 'error',
                response: response(10001, 'invalid action request', null, fallbackEcho),
            };
        }
    }

    private async runPrepared(
        request: PreparedRequest,
        fileLease?: V12FileLease,
    ): Promise<V12Response> {
        try {
            return await this.handleSnapshot(request.input, fileLease);
        } catch {
            return response(10001, 'invalid action request', null, request.fallbackEcho);
        }
    }

    private supportsUploadData(fileLease?: V12FileLease): boolean {
        try {
            if (
                typeof this.options.uploadDataFile !== 'function' ||
                typeof this.options.getUploadedDataFile !== 'function'
            ) {
                return false;
            }

            const readiness = this.options.isUploadDataSupported;

            if (readiness === undefined) {
                return fileLeaseCurrent(fileLease);
            }

            return (
                typeof readiness === 'function' &&
                apply(readiness, this.options, [fileLease]) === true &&
                typeof this.options.uploadDataFile === 'function' &&
                typeof this.options.getUploadedDataFile === 'function' &&
                fileLeaseCurrent(fileLease)
            );
        } catch {
            return false;
        }
    }

    /** Read only own data descriptors: no provider getter or Proxy trap runs. */
    private fragmentProviders(): FragmentProviders | null {
        if (isProxy(this.options)) {
            return null;
        }

        const prototype = Object.getPrototypeOf(this.options);

        if (prototype !== Object.prototype && prototype !== null) {
            return null;
        }

        const upload = ownData(this.options, 'uploadDataFile');
        const get = ownData(this.options, 'getUploadedDataFile');
        const metadata = ownData(this.options, 'getUploadedDataFileMetadata');
        const chunk = ownData(this.options, 'getUploadedDataFileChunk');
        const readinessDescriptor = Object.getOwnPropertyDescriptor(
            this.options,
            'isUploadDataSupported',
        );

        if (readinessDescriptor && !('value' in readinessDescriptor)) {
            return null;
        }

        const readiness: unknown = readinessDescriptor?.value;

        if (
            typeof upload !== 'function' ||
            typeof get !== 'function' ||
            typeof metadata !== 'function' ||
            typeof chunk !== 'function' ||
            (readiness !== undefined && typeof readiness !== 'function')
        ) {
            return null;
        }

        return { upload, get, metadata, chunk, readiness } as FragmentProviders;
    }

    /** Compare after potentially reentrant callbacks, without invoking getters. */
    private sameFragmentProviders(expected: FragmentProviders): boolean {
        const current = this.fragmentProviders();
        return (
            current !== null &&
            current.upload === expected.upload &&
            current.get === expected.get &&
            current.metadata === expected.metadata &&
            current.chunk === expected.chunk &&
            current.readiness === expected.readiness
        );
    }

    private fragmentProvidersCurrent(
        providers: FragmentProviders,
        fileLease?: V12FileLease,
    ): boolean {
        try {
            if (!this.sameFragmentProviders(providers)) {
                return false;
            }

            if (
                providers.readiness !== undefined &&
                apply(providers.readiness, this.options, [fileLease]) !== true
            ) {
                return false;
            }

            return fileLeaseCurrent(fileLease) && this.sameFragmentProviders(providers);
        } catch {
            return false;
        }
    }

    private validatedFragmentProviders(fileLease?: V12FileLease): FragmentProviders | null {
        try {
            const providers = this.fragmentProviders();
            return providers && this.fragmentProvidersCurrent(providers, fileLease)
                ? providers
                : null;
        } catch {
            return null;
        }
    }

    private async handleSnapshot(
        input: Record<string, unknown>,
        fileLease?: V12FileLease,
    ): Promise<V12Response> {
        const echo = typeof input.echo === 'string' ? input.echo : undefined;
        const action = input.action as string;
        const params = input.params as Record<string, unknown>;

        if (action === 'get_file_fragmented') {
            if (this.#fragmentBusy) {
                return response(20002, 'file unavailable', null, echo);
            }

            this.#fragmentBusy = true;

            try {
                const providers = this.validatedFragmentProviders(fileLease);
                return providers
                    ? this.getFileFragmented(params, echo, fileLease, providers)
                    : response(10002, 'unsupported action', null, echo);
            } finally {
                this.#fragmentBusy = false;
            }
        }

        if (action === 'upload_file') {
            if (!this.supportsUploadData(fileLease)) {
                return response(10002, 'unsupported action', null, echo);
            }
        } else if (!(ACTIONS as readonly string[]).includes(action)) {
            return response(10002, 'unsupported action', null, echo);
        }

        if (
            action === 'get_version' ||
            action === 'get_status' ||
            action === 'get_supported_actions'
        ) {
            if (Object.keys(params).length !== 0) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            if (action === 'get_version') {
                return response(0, '', { ...this.version, onebot_version: '12' }, echo);
            }

            if (action === 'get_supported_actions') {
                const actions: string[] = [...ACTIONS];

                const wasFragmentBusy = this.#fragmentBusy;
                this.#fragmentBusy = true;

                try {
                    const uploadSupported = this.supportsUploadData(fileLease);
                    const providers =
                        uploadSupported && !wasFragmentBusy
                            ? this.validatedFragmentProviders(fileLease)
                            : null;

                    // The final lease callback may reenter or alter providers;
                    // compare their identities once more without callbacks.
                    if (uploadSupported && fileLeaseCurrent(fileLease)) {
                        actions.push('upload_file');

                        if (providers && this.sameFragmentProviders(providers)) {
                            actions.push('get_file_fragmented');
                        }
                    }
                } finally {
                    this.#fragmentBusy = wasFragmentBusy;
                }

                return response(0, '', actions, echo);
            }

            try {
                const status = await this.options.getStatus();

                if (typeof status.good !== 'boolean' || typeof status.online !== 'boolean') {
                    return response(20001, 'invalid status result', null, echo);
                }

                return response(
                    0,
                    '',
                    {
                        good: status.good,
                        bots: [{ self: { ...this.self }, online: status.online }],
                    },
                    echo,
                );
            } catch {
                return response(20002, 'status unavailable', null, echo);
            }
        }

        if (action === 'get_self_info') {
            if (Object.keys(params).length !== 0) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            return this.getSelfInfo(echo);
        }

        if (action === 'get_user_info') {
            if (extraKeys(params, ['user_id'])) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            const userId = parseAccountId(params.user_id);

            // OidbUserInfoRequest.uin is uint32; the encoder truncates larger values.
            if (userId === null || userId > 0xffffffff) {
                return response(10003, 'invalid user_id', null, echo);
            }

            return this.getUserInfo(userId, echo);
        }

        if (action === 'get_friend_list') {
            if (Object.keys(params).length !== 0) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            return this.getFriendList(echo);
        }

        if (action === 'get_group_info') {
            if (extraKeys(params, ['group_id'])) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            const groupId = parseAccountId(params.group_id);

            if (groupId === null) {
                return response(10003, 'invalid group_id', null, echo);
            }

            return this.getGroupInfo(groupId, echo);
        }

        if (action === 'get_group_list') {
            if (Object.keys(params).length !== 0) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            return this.getGroupList(echo);
        }

        if (action === 'get_group_member_list' || action === 'get_group_member_info') {
            const isInfo = action === 'get_group_member_info';

            if (extraKeys(params, isInfo ? ['group_id', 'user_id'] : ['group_id'])) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            const groupId = parseAccountId(params.group_id);
            const userId = isInfo ? parseAccountId(params.user_id) : null;

            // Both downstream group and member identifiers are encoded as uint32.
            if (
                groupId === null ||
                groupId > 0xffffffff ||
                (isInfo && (userId === null || userId > 0xffffffff))
            ) {
                return response(10003, 'invalid group_id or user_id', null, echo);
            }

            return this.getGroupMembers(groupId, userId, echo);
        }

        if (action === 'set_group_name') {
            if (extraKeys(params, ['group_id', 'group_name'])) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            const groupId = parseAccountId(params.group_id);

            // OidbRenameGroup.groupUin is uint32; larger IDs would be truncated downstream.
            if (groupId === null || groupId > 0xffffffff || typeof params.group_name !== 'string') {
                return response(10003, 'invalid group_id or group_name', null, echo);
            }

            return this.setGroupName(groupId, params.group_name, echo);
        }

        if (action === 'leave_group') {
            if (extraKeys(params, ['group_id'])) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            const groupId = parseAccountId(params.group_id);

            // OidbLeaveGroup.groupUin is uint32; larger IDs would be truncated downstream.
            if (groupId === null || groupId > 0xffffffff) {
                return response(10003, 'invalid group_id', null, echo);
            }

            return this.leaveGroup(groupId, echo);
        }

        if (action === 'delete_message') {
            if (extraKeys(params, ['message_id'])) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            const id = parseMessageId(params.message_id);

            if (id === null) {
                return response(10003, 'invalid message_id', null, echo);
            }

            return this.callDelete(id, echo);
        }

        if (action === 'upload_file') {
            return this.uploadFile(params, echo, fileLease);
        }

        if (action === 'get_file') {
            if (extraKeys(params, ['file_id', 'type'])) {
                return response(10004, 'unsupported parameter', null, echo);
            }

            if (
                typeof params.file_id !== 'string' ||
                params.file_id.length === 0 ||
                params.file_id.length > 4096 ||
                typeof params.type !== 'string'
            ) {
                return response(10003, 'invalid file parameters', null, echo);
            }

            if (params.type === 'data' && isV12UploadToken(params.file_id)) {
                return this.getUploadedFile(params.file_id, echo, fileLease);
            }

            if (params.type !== 'url' || isV12UploadToken(params.file_id)) {
                // The reserved upload prefix shadows any v11 alias only through
                // v12 get_file; direct v11 actions and lookups are unchanged.
                return response(10004, 'unsupported file type', null, echo);
            }

            return this.getFile(params.file_id, echo);
        }

        return this.send(params, echo);
    }

    private async getSelfInfo(echo?: string): Promise<V12Response> {
        const invalid = () => response(20001, 'invalid self info result', null, echo);

        try {
            const result: unknown = await this.options.api.handle('get_login_info', {});

            // Inspect only own data properties, without invoking external getters or Proxy traps.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalid();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalid();
            }

            if (
                status.value === 'failed' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0
            ) {
                return retcode.value === 1400 || retcode.value === 1404
                    ? invalid()
                    : response(20002, 'self info unavailable', null, echo);
            }

            if (status.value !== 'ok' || retcode.value !== 0) {
                return invalid();
            }

            const data = Object.getOwnPropertyDescriptor(result, 'data');
            const value: unknown = data && 'value' in data ? data.value : undefined;

            if (
                isProxy(value) ||
                typeof value !== 'object' ||
                value === null ||
                Array.isArray(value)
            ) {
                return invalid();
            }

            const id = Object.getOwnPropertyDescriptor(value, 'user_id');
            const nickname = Object.getOwnPropertyDescriptor(value, 'nickname');

            if (
                !id ||
                !('value' in id) ||
                typeof id.value !== 'number' ||
                !Number.isSafeInteger(id.value) ||
                id.value <= 0 ||
                String(id.value) !== this.self.user_id ||
                !nickname ||
                !('value' in nickname) ||
                typeof nickname.value !== 'string'
            ) {
                return invalid();
            }

            return response(
                0,
                '',
                { user_id: String(id.value), user_name: nickname.value, user_displayname: '' },
                echo,
            );
        } catch {
            return response(20002, 'self info unavailable', null, echo);
        }
    }

    private uploadFile(
        params: Record<string, unknown>,
        echo?: string,
        fileLease?: V12FileLease,
    ): V12Response {
        const invalid = () => response(10003, 'invalid upload parameters', null, echo);
        const unavailable = () => response(20002, 'upload unavailable', null, echo);

        if (extraKeys(params, ['type', 'name', 'data', 'sha256'])) {
            return response(10004, 'unsupported parameter', null, echo);
        }

        if (typeof params.type !== 'string') {
            return invalid();
        }

        if (params.type !== 'data') {
            return response(10004, 'unsupported file type', null, echo);
        }

        if (
            typeof params.name !== 'string' ||
            params.name.length > 4096 ||
            !isCanonicalUploadData(params.data) ||
            (Object.hasOwn(params, 'sha256') &&
                (typeof params.sha256 !== 'string' ||
                    params.sha256.length !== 64 ||
                    !/^[0-9a-f]{64}$/.test(params.sha256)))
        ) {
            return invalid();
        }

        try {
            // Every accepted result ID has this exact encoded length, so this
            // preflight bounds the precise success envelope before any upload.
            if (!fileSuccessFits({ file_id: V12_UPLOAD_TOKEN_PREFIX + 'A'.repeat(43) }, echo)) {
                return invalid();
            }

            const upload = this.options.uploadDataFile;

            if (typeof upload !== 'function' || !fileLeaseCurrent(fileLease)) {
                return unavailable();
            }

            const args: unknown[] = [params.name, params.data, params.sha256];

            if (fileLease !== undefined) {
                args.push(fileLease);
            }

            const result: unknown = apply(upload, this.options, args);

            if (!fileLeaseCurrent(fileLease) || !isProviderRecord(result)) {
                return unavailable();
            }

            const kind = ownData(result, 'kind');

            if (kind === 'invalid') {
                return invalid();
            }

            if (kind !== 'ok') {
                return unavailable();
            }

            const fileId = ownData(result, 'fileId');
            return isCanonicalUploadId(fileId)
                ? response(0, '', { file_id: fileId }, echo)
                : unavailable();
        } catch {
            return unavailable();
        }
    }

    private getFileFragmented(
        params: Record<string, unknown>,
        echo: string | undefined,
        fileLease: V12FileLease | undefined,
        providers: FragmentProviders,
    ): V12Response {
        const invalid = () => response(10003, 'invalid file parameters', null, echo);
        const notFound = () => response(20001, 'invalid file result', null, echo);
        const unavailable = () => response(20002, 'file unavailable', null, echo);

        if (typeof params.stage !== 'string') {
            return invalid();
        }

        if (params.stage !== 'prepare' && params.stage !== 'transfer') {
            return response(10004, 'unsupported file stage', null, echo);
        }

        if (
            extraKeys(
                params,
                params.stage === 'prepare'
                    ? ['stage', 'file_id']
                    : ['stage', 'file_id', 'offset', 'size'],
            )
        ) {
            return response(10004, 'unsupported parameter', null, echo);
        }

        const fileId = params.file_id;

        if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 4096) {
            return invalid();
        }

        let offset: number | undefined;
        let size: number | undefined;

        if (params.stage === 'transfer') {
            if (
                typeof params.offset !== 'number' ||
                !Number.isSafeInteger(params.offset) ||
                params.offset < 0 ||
                typeof params.size !== 'number' ||
                !Number.isSafeInteger(params.size) ||
                params.size < 0
            ) {
                return invalid();
            }

            offset = params.offset;
            size = params.size;

            // All supported local files fit this byte bound. Reject impossible
            // ranges before invoking a custom provider, without adding integers
            // that could overflow the JavaScript safe-integer range.
            if (offset > MAX_UPLOAD_DATA_BYTES || size > MAX_UPLOAD_DATA_BYTES - offset) {
                return response(10004, 'unsupported file range', null, echo);
            }
        }

        // Do not redeem image/voice handles or fall back to the v11 file lookup.
        if (!isV12UploadToken(fileId)) {
            return response(10004, 'unsupported file source', null, echo);
        }

        if (!isCanonicalUploadId(fileId)) {
            return notFound();
        }

        try {
            if (params.stage === 'prepare') {
                if (!this.fragmentProvidersCurrent(providers, fileLease)) {
                    return unavailable();
                }

                const args: unknown[] = [fileId];

                if (fileLease !== undefined) {
                    args.push(fileLease);
                }

                const result: unknown = apply(providers.metadata, this.options, args);

                if (
                    !this.fragmentProvidersCurrent(providers, fileLease) ||
                    !isProviderRecord(result)
                ) {
                    return unavailable();
                }

                const kind = ownEnumerableData(result, 'kind');

                if (kind === 'not_found') {
                    return notFound();
                }

                if (kind !== 'ok') {
                    return unavailable();
                }

                const name = ownEnumerableData(result, 'name');
                const totalSize = ownEnumerableData(result, 'totalSize');
                const sha256 = ownEnumerableData(result, 'sha256');

                // The account-local store computes the digest on upload. This
                // validates a custom callback's shape, not its content identity.
                if (
                    typeof name !== 'string' ||
                    name.length > 4096 ||
                    typeof totalSize !== 'number' ||
                    !Number.isSafeInteger(totalSize) ||
                    totalSize < 0 ||
                    totalSize > MAX_UPLOAD_DATA_BYTES ||
                    typeof sha256 !== 'string' ||
                    sha256.length !== 64 ||
                    !/^[0-9a-f]{64}$/.test(sha256)
                ) {
                    return unavailable();
                }

                const payload = { name, total_size: totalSize, sha256 };

                if (!fileSuccessFits(payload, echo)) {
                    return response(10003, 'file response too large', null, echo);
                }

                return this.fragmentProvidersCurrent(providers, fileLease)
                    ? response(0, '', payload, echo)
                    : unavailable();
            }

            // Both values were checked above before reaching the transfer branch.
            if (offset === undefined || size === undefined) {
                return invalid();
            }

            // All Base64 characters, including padding, occupy one JSON byte.
            // Bound the complete envelope before asking the provider for bytes.
            const encodedLength = 4 * Math.ceil(size / 3);

            if (!fileSuccessFits({ data: 'A'.repeat(encodedLength) }, echo)) {
                return response(10003, 'file response too large', null, echo);
            }

            if (!this.fragmentProvidersCurrent(providers, fileLease)) {
                return unavailable();
            }

            const args: unknown[] = [fileId, offset, size];

            if (fileLease !== undefined) {
                args.push(fileLease);
            }

            const result: unknown = apply(providers.chunk, this.options, args);

            if (!this.fragmentProvidersCurrent(providers, fileLease) || !isProviderRecord(result)) {
                return unavailable();
            }

            const kind = ownEnumerableData(result, 'kind');

            if (kind === 'not_found') {
                return notFound();
            }

            if (kind === 'invalid_range') {
                return response(10004, 'unsupported file range', null, echo);
            }

            if (kind !== 'ok') {
                return unavailable();
            }

            const data = ownEnumerableData(result, 'data');

            if (!isCanonicalUploadData(data)) {
                return unavailable();
            }

            const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
            const decodedLength = (data.length / 4) * 3 - padding;

            if (decodedLength !== size) {
                return unavailable();
            }

            const payload = { data };

            if (!fileSuccessFits(payload, echo)) {
                return response(10003, 'file response too large', null, echo);
            }

            return this.fragmentProvidersCurrent(providers, fileLease)
                ? response(0, '', payload, echo)
                : unavailable();
        } catch {
            return unavailable();
        }
    }

    private getUploadedFile(fileId: string, echo?: string, fileLease?: V12FileLease): V12Response {
        const unavailable = () => response(20002, 'file unavailable', null, echo);

        try {
            const get = this.options.getUploadedDataFile;

            if (typeof get !== 'function' || !fileLeaseCurrent(fileLease)) {
                return unavailable();
            }

            const args: unknown[] = [fileId];

            if (fileLease !== undefined) {
                args.push(fileLease);
            }

            const result: unknown = apply(get, this.options, args);

            if (!fileLeaseCurrent(fileLease) || !isProviderRecord(result)) {
                return unavailable();
            }

            const kind = ownData(result, 'kind');

            if (kind === 'not_found') {
                return response(20001, 'invalid file result', null, echo);
            }

            if (kind !== 'ok') {
                return unavailable();
            }

            const name = ownData(result, 'name');
            const data = ownData(result, 'data');
            const sha256 = ownData(result, 'sha256');

            // This bounds provider data; it does not authenticate a custom
            // callback or independently prove that its digest matches its bytes.
            if (
                typeof name !== 'string' ||
                name.length > 4096 ||
                !isCanonicalUploadData(data) ||
                typeof sha256 !== 'string' ||
                sha256.length !== 64 ||
                !/^[0-9a-f]{64}$/.test(sha256)
            ) {
                return unavailable();
            }

            const payload = { name, data, sha256 };

            if (!fileSuccessFits(payload, echo)) {
                return response(10003, 'file response too large', null, echo);
            }

            return response(0, '', payload, echo);
        } catch {
            return unavailable();
        }
    }

    private async getFile(fileId: string, echo?: string): Promise<V12Response> {
        const invalid = () => response(20001, 'invalid file result', null, echo);
        const unavailable = () => response(20002, 'file unavailable', null, echo);
        const unsupported = () => response(10004, 'file URL unavailable', null, echo);

        if (isV12ImageToken(fileId)) {
            // The reserved namespace is never retried as a legacy alias: doing
            // so could turn a damaged or foreign handle into a different file.
            try {
                const url = this.options.resolveImageFileUrl?.(fileId);
                const checked = classifyFileUrl(url);
                return checked.kind === 'valid'
                    ? response(0, '', { name: '', url: checked.url }, echo)
                    : invalid();
            } catch {
                return unavailable();
            }
        }

        if (isV12VoiceToken(fileId)) {
            // Reserved voice handles have an independent issuer and must not
            // fall back to a v11 alias, even when malformed or unredeemable.
            try {
                const url = this.options.resolveVoiceFileUrl?.(fileId);
                const checked = classifyFileUrl(url);
                return checked.kind === 'valid'
                    ? response(0, '', { name: '', url: checked.url }, echo)
                    : invalid();
            } catch {
                return unavailable();
            }
        }

        try {
            const result: unknown = await this.options.api.handle('get_file', { file_id: fileId });

            // Await may inspect a thenable before these proxy and descriptor checks.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalid();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalid();
            }

            if (
                status.value === 'failed' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0
            ) {
                return retcode.value === 1400 || retcode.value === 1404 ? invalid() : unavailable();
            }

            if (status.value !== 'ok' || retcode.value !== 0) {
                return invalid();
            }

            const data = Object.getOwnPropertyDescriptor(result, 'data');
            const value: unknown = data && 'value' in data ? data.value : undefined;

            if (
                isProxy(value) ||
                typeof value !== 'object' ||
                value === null ||
                Array.isArray(value)
            ) {
                return invalid();
            }

            const name = Object.getOwnPropertyDescriptor(value, 'file_name');
            const url = Object.getOwnPropertyDescriptor(value, 'url');

            if (
                !name ||
                !('value' in name) ||
                typeof name.value !== 'string' ||
                name.value.length > 1024 ||
                !url ||
                !('value' in url) ||
                typeof url.value !== 'string' ||
                url.value.length > 8192
            ) {
                return invalid();
            }

            const checked = classifyFileUrl(url.value);

            if (checked.kind === 'unsupported') {
                return unsupported();
            }

            if (checked.kind !== 'valid') {
                return invalid();
            }

            const address = checked.url;

            // A v11 fallback can place a source URL or path in file_name.
            // Neither '/' nor NUL can occur in a Linux filename, so do not
            // present such a label as a known name or duplicate its URL query.
            const rawName: string = name.value;
            const projectedName =
                rawName === '.' ||
                rawName === '..' ||
                rawName.includes('/') ||
                rawName.includes('\0')
                    ? ''
                    : rawName;

            // A syntactically valid URL does not establish client reachability.
            return response(0, '', { name: projectedName, url: address }, echo);
        } catch {
            return unavailable();
        }
    }

    private async getUserInfo(userId: number, echo?: string): Promise<V12Response> {
        const invalid = () => response(20001, 'invalid user info result', null, echo);
        const unavailable = () => response(20002, 'user info unavailable', null, echo);

        try {
            const result: unknown = await this.options.api.handle('get_stranger_info', {
                user_id: userId,
            });

            // Await may inspect a thenable before these proxy and descriptor checks.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalid();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalid();
            }

            if (
                status.value === 'failed' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0
            ) {
                return retcode.value === 1400 || retcode.value === 1404 ? invalid() : unavailable();
            }

            if (status.value !== 'ok' || retcode.value !== 0) {
                return invalid();
            }

            const data = Object.getOwnPropertyDescriptor(result, 'data');
            const value: unknown = data && 'value' in data ? data.value : undefined;

            if (
                isProxy(value) ||
                typeof value !== 'object' ||
                value === null ||
                Array.isArray(value)
            ) {
                return invalid();
            }

            const id = Object.getOwnPropertyDescriptor(value, 'user_id');
            const nickname = Object.getOwnPropertyDescriptor(value, 'nickname');
            const remark = Object.getOwnPropertyDescriptor(value, 'remark');

            if (
                !id ||
                !('value' in id) ||
                typeof id.value !== 'number' ||
                !Number.isSafeInteger(id.value) ||
                id.value <= 0 ||
                id.value !== userId ||
                !nickname ||
                !('value' in nickname) ||
                typeof nickname.value !== 'string' ||
                nickname.value.length > 1024 ||
                !remark ||
                !('value' in remark) ||
                typeof remark.value !== 'string' ||
                remark.value.length > 1024
            ) {
                return invalid();
            }

            return response(
                0,
                '',
                {
                    user_id: String(id.value),
                    user_name: nickname.value,
                    user_displayname: '',
                    user_remark: remark.value,
                },
                echo,
            );
        } catch {
            return unavailable();
        }
    }

    private async getFriendList(echo?: string): Promise<V12Response> {
        const invalid = () => response(20001, 'invalid friend list result', null, echo);
        const unavailable = () => response(20002, 'friend list unavailable', null, echo);

        try {
            const result: unknown = await this.options.api.handle('get_friend_list', {});

            // Await may inspect a thenable before these proxy and descriptor checks.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalid();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalid();
            }

            if (
                status.value === 'failed' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0
            ) {
                return retcode.value === 1400 || retcode.value === 1404 ? invalid() : unavailable();
            }

            if (status.value !== 'ok' || retcode.value !== 0) {
                return invalid();
            }

            const data = Object.getOwnPropertyDescriptor(result, 'data');
            const rows: unknown = data && 'value' in data ? data.value : undefined;

            if (isProxy(rows) || !Array.isArray(rows)) {
                return invalid();
            }

            const length = Object.getOwnPropertyDescriptor(rows, 'length');

            if (
                !length ||
                !('value' in length) ||
                typeof length.value !== 'number' ||
                !Number.isSafeInteger(length.value) ||
                length.value < 0 ||
                length.value > 10000
            ) {
                return invalid();
            }

            const output: JsonObject[] = [];
            let stringUnits = 0;

            for (let i = 0; i < length.value; i += 1) {
                const item = Object.getOwnPropertyDescriptor(rows, String(i));
                const row: unknown = item && 'value' in item ? item.value : undefined;

                if (isProxy(row) || typeof row !== 'object' || row === null || Array.isArray(row)) {
                    return invalid();
                }

                const id = Object.getOwnPropertyDescriptor(row, 'user_id');
                const nickname = Object.getOwnPropertyDescriptor(row, 'nickname');
                const remark = Object.getOwnPropertyDescriptor(row, 'remark');

                if (
                    !id ||
                    !('value' in id) ||
                    typeof id.value !== 'number' ||
                    !Number.isSafeInteger(id.value) ||
                    id.value <= 0 ||
                    !nickname ||
                    !('value' in nickname) ||
                    typeof nickname.value !== 'string' ||
                    !remark ||
                    !('value' in remark) ||
                    typeof remark.value !== 'string' ||
                    nickname.value.length > 1024 ||
                    remark.value.length > 1024
                ) {
                    return invalid();
                }

                stringUnits += nickname.value.length + remark.value.length;

                if (stringUnits > 262144) {
                    return invalid();
                }

                // Define an own element directly; do not invoke inherited array setters.
                Object.defineProperty(output, String(i), {
                    value: {
                        user_id: String(id.value),
                        user_name: nickname.value,
                        user_displayname: '',
                        user_remark: remark.value,
                    },
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }

            return response(0, '', output, echo);
        } catch {
            return unavailable();
        }
    }

    private async getGroupInfo(groupId: number, echo?: string): Promise<V12Response> {
        const invalid = () => response(20001, 'invalid group info result', null, echo);
        const unavailable = () => response(20002, 'group info unavailable', null, echo);

        try {
            const result: unknown = await this.options.api.handle('get_group_info', {
                group_id: groupId,
            });

            // Await may inspect a thenable before these proxy and descriptor checks.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalid();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalid();
            }

            if (
                status.value === 'failed' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0
            ) {
                return retcode.value === 1400 || retcode.value === 1404 ? invalid() : unavailable();
            }

            if (status.value !== 'ok' || retcode.value !== 0) {
                return invalid();
            }

            const data = Object.getOwnPropertyDescriptor(result, 'data');
            const value: unknown = data && 'value' in data ? data.value : undefined;

            if (
                isProxy(value) ||
                typeof value !== 'object' ||
                value === null ||
                Array.isArray(value)
            ) {
                return invalid();
            }

            const id = Object.getOwnPropertyDescriptor(value, 'group_id');
            const name = Object.getOwnPropertyDescriptor(value, 'group_name');

            if (
                !id ||
                !('value' in id) ||
                typeof id.value !== 'number' ||
                !Number.isSafeInteger(id.value) ||
                id.value <= 0 ||
                id.value !== groupId ||
                !name ||
                !('value' in name) ||
                typeof name.value !== 'string' ||
                name.value.length > 1024
            ) {
                return invalid();
            }

            return response(0, '', { group_id: String(groupId), group_name: name.value }, echo);
        } catch {
            return unavailable();
        }
    }

    private async getGroupList(echo?: string): Promise<V12Response> {
        const invalid = () => response(20001, 'invalid group list result', null, echo);
        const unavailable = () => response(20002, 'group list unavailable', null, echo);

        try {
            const result: unknown = await this.options.api.handle('get_group_list', {});

            // Await may inspect a thenable before these proxy and descriptor checks.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalid();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalid();
            }

            if (
                status.value === 'failed' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0
            ) {
                return retcode.value === 1400 || retcode.value === 1404 ? invalid() : unavailable();
            }

            if (status.value !== 'ok' || retcode.value !== 0) {
                return invalid();
            }

            const data = Object.getOwnPropertyDescriptor(result, 'data');
            const rows: unknown = data && 'value' in data ? data.value : undefined;

            if (isProxy(rows) || !Array.isArray(rows)) {
                return invalid();
            }

            const length = Object.getOwnPropertyDescriptor(rows, 'length');

            if (
                !length ||
                !('value' in length) ||
                typeof length.value !== 'number' ||
                !Number.isSafeInteger(length.value) ||
                length.value < 0 ||
                length.value > 10000
            ) {
                return invalid();
            }

            const output: JsonObject[] = [];
            let stringUnits = 0;

            for (let i = 0; i < length.value; i += 1) {
                const item = Object.getOwnPropertyDescriptor(rows, String(i));
                const row: unknown = item && 'value' in item ? item.value : undefined;

                if (isProxy(row) || typeof row !== 'object' || row === null || Array.isArray(row)) {
                    return invalid();
                }

                const id = Object.getOwnPropertyDescriptor(row, 'group_id');
                const name = Object.getOwnPropertyDescriptor(row, 'group_name');

                if (
                    !id ||
                    !('value' in id) ||
                    typeof id.value !== 'number' ||
                    !Number.isSafeInteger(id.value) ||
                    id.value <= 0 ||
                    !name ||
                    !('value' in name) ||
                    typeof name.value !== 'string' ||
                    name.value.length > 1024
                ) {
                    return invalid();
                }

                stringUnits += name.value.length;

                if (stringUnits > 262144) {
                    return invalid();
                }

                // Define an own element directly; do not invoke inherited array setters.
                Object.defineProperty(output, String(i), {
                    value: { group_id: String(id.value), group_name: name.value },
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }

            return response(0, '', output, echo);
        } catch {
            return unavailable();
        }
    }

    /**
     * Both v12 member reads use the v11 list: its info action can synthesize a
     * member. The list may itself be cached or an empty placeholder, so neither
     * a match nor an empty list proves current membership or freshness.
     */
    private async getGroupMembers(
        groupId: number,
        userId: number | null,
        echo?: string,
    ): Promise<V12Response> {
        const kind = userId === null ? 'group member list' : 'group member info';
        const invalid = () => response(20001, `invalid ${kind} result`, null, echo);
        const unavailable = () => response(20002, `${kind} unavailable`, null, echo);

        try {
            const result: unknown = await this.options.api.handle('get_group_member_list', {
                group_id: groupId,
            });

            // Await can inspect a thenable before these proxy and descriptor checks.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalid();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalid();
            }

            if (
                status.value === 'failed' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0
            ) {
                return retcode.value === 1400 || retcode.value === 1404 ? invalid() : unavailable();
            }

            if (status.value !== 'ok' || retcode.value !== 0) {
                return invalid();
            }

            const data = Object.getOwnPropertyDescriptor(result, 'data');
            const rows: unknown = data && 'value' in data ? data.value : undefined;

            if (isProxy(rows) || !Array.isArray(rows)) {
                return invalid();
            }

            const length = Object.getOwnPropertyDescriptor(rows, 'length');

            if (
                !length ||
                !('value' in length) ||
                typeof length.value !== 'number' ||
                !Number.isSafeInteger(length.value) ||
                length.value < 0 ||
                length.value > 10000
            ) {
                return invalid();
            }

            const output: JsonObject[] = [];
            let stringUnits = 0;
            let matchCount = 0;
            let match: JsonObject | null = null;

            for (let i = 0; i < length.value; i += 1) {
                const item = Object.getOwnPropertyDescriptor(rows, String(i));
                const row: unknown = item && 'value' in item ? item.value : undefined;

                if (isProxy(row) || typeof row !== 'object' || row === null || Array.isArray(row)) {
                    return invalid();
                }

                // Inspect only required own data properties; unknown v11 fields stay unread.
                const rowGroupId = Object.getOwnPropertyDescriptor(row, 'group_id');
                const id = Object.getOwnPropertyDescriptor(row, 'user_id');
                const nickname = Object.getOwnPropertyDescriptor(row, 'nickname');
                const card = Object.getOwnPropertyDescriptor(row, 'card');

                if (
                    !rowGroupId ||
                    !('value' in rowGroupId) ||
                    typeof rowGroupId.value !== 'number' ||
                    rowGroupId.value !== groupId ||
                    !id ||
                    !('value' in id) ||
                    typeof id.value !== 'number' ||
                    !Number.isSafeInteger(id.value) ||
                    id.value <= 0 ||
                    id.value > 0xffffffff ||
                    !nickname ||
                    !('value' in nickname) ||
                    typeof nickname.value !== 'string' ||
                    nickname.value.length > 1024 ||
                    !card ||
                    !('value' in card) ||
                    typeof card.value !== 'string' ||
                    card.value.length > 1024
                ) {
                    return invalid();
                }

                stringUnits += nickname.value.length + card.value.length;

                if (stringUnits > 262144) {
                    return invalid();
                }

                const member: JsonObject = {
                    user_id: String(id.value),
                    user_name: nickname.value,
                    user_displayname: card.value,
                };

                // Define an own element directly; do not invoke inherited array setters.
                Object.defineProperty(output, String(i), {
                    value: member,
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });

                if (userId !== null && id.value === userId) {
                    matchCount += 1;
                    match = member;
                }
            }

            if (userId === null) {
                return response(0, '', output, echo);
            }

            // Decide only after validating the complete list, including later rows.
            if (matchCount !== 1 || match === null) {
                return response(35000, 'group member match unavailable or ambiguous', null, echo);
            }

            return response(0, '', match, echo);
        } catch {
            return unavailable();
        }
    }

    private async setGroupName(groupId: number, name: string, echo?: string): Promise<V12Response> {
        const unknownOutcome = 'action outcome unavailable; do not retry automatically';
        const invalidResult = () => response(20001, unknownOutcome, null, echo);

        try {
            const result: unknown = await this.options.api.handle('set_group_name', {
                group_id: groupId,
                group_name: name,
            });

            // After await's thenable assimilation, inspect only own data properties
            // without invoking response getters or Proxy traps.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalidResult();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalidResult();
            }

            if (status.value === 'ok' && retcode.value === 0) {
                const data = Object.getOwnPropertyDescriptor(result, 'data');
                return data && 'value' in data && data.value === null
                    ? response(0, '', null, echo)
                    : invalidResult();
            }

            if (
                status.value !== 'failed' ||
                !Number.isSafeInteger(retcode.value) ||
                retcode.value <= 0
            ) {
                return invalidResult();
            }

            if (retcode.value === 1400) {
                return response(
                    10003,
                    'invalid action input; outcome may be uncertain; do not retry automatically',
                    null,
                    echo,
                );
            }

            return response(retcode.value === 1404 ? 20001 : 20002, unknownOutcome, null, echo);
        } catch {
            return response(20002, unknownOutcome, null, echo);
        }
    }

    private async leaveGroup(groupId: number, echo?: string): Promise<V12Response> {
        const unknownOutcome = 'action outcome unavailable; do not retry automatically';
        const invalidResult = () => response(20001, unknownOutcome, null, echo);

        try {
            const result: unknown = await this.options.api.handle('set_group_leave', {
                group_id: groupId,
            });

            // Await may inspect a thenable; afterward inspect only own data properties.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalidResult();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');
            const data = Object.getOwnPropertyDescriptor(result, 'data');

            if (
                !status ||
                !('value' in status) ||
                !retcode ||
                !('value' in retcode) ||
                !data ||
                !('value' in data) ||
                data.value === undefined
            ) {
                return invalidResult();
            }

            if (status.value === 'ok' && retcode.value === 0) {
                return data.value === null ? response(0, '', null, echo) : invalidResult();
            }

            if (
                status.value !== 'failed' ||
                !Number.isSafeInteger(retcode.value) ||
                retcode.value <= 0
            ) {
                return invalidResult();
            }

            if (retcode.value === 1400) {
                return response(
                    10003,
                    'invalid action input; outcome may be uncertain; do not retry automatically',
                    null,
                    echo,
                );
            }

            return response(retcode.value === 1404 ? 20001 : 20002, unknownOutcome, null, echo);
        } catch {
            return response(20002, unknownOutcome, null, echo);
        }
    }

    private async callDelete(id: number, echo?: string): Promise<V12Response> {
        const unknownOutcome = 'action outcome unavailable; do not retry automatically';
        const invalidResult = () => response(20001, unknownOutcome, null, echo);

        try {
            const result: unknown = await this.options.api.handle('delete_msg', { message_id: id });

            // Await may inspect a thenable; afterward inspect only own data properties.
            if (
                isProxy(result) ||
                typeof result !== 'object' ||
                result === null ||
                Array.isArray(result)
            ) {
                return invalidResult();
            }

            const status = Object.getOwnPropertyDescriptor(result, 'status');
            const retcode = Object.getOwnPropertyDescriptor(result, 'retcode');

            if (!status || !('value' in status) || !retcode || !('value' in retcode)) {
                return invalidResult();
            }

            if (status.value === 'ok' && retcode.value === 0) {
                const data = Object.getOwnPropertyDescriptor(result, 'data');
                return data && 'value' in data && data.value === null
                    ? response(0, '', null, echo)
                    : invalidResult();
            }

            if (
                status.value !== 'failed' ||
                !Number.isSafeInteger(retcode.value) ||
                retcode.value <= 0
            ) {
                return invalidResult();
            }

            if (retcode.value === 1400) {
                return response(
                    10003,
                    'invalid action input; outcome may be uncertain; do not retry automatically',
                    null,
                    echo,
                );
            }

            return response(retcode.value === 1404 ? 20001 : 20002, unknownOutcome, null, echo);
        } catch {
            return response(20002, unknownOutcome, null, echo);
        }
    }

    private async send(params: Record<string, unknown>, echo?: string): Promise<V12Response> {
        if (extraKeys(params, ['detail_type', 'user_id', 'group_id', 'message'])) {
            return response(10004, 'unsupported parameter', null, echo);
        }

        if (params.detail_type !== 'private' && params.detail_type !== 'group') {
            return response(
                typeof params.detail_type === 'string' ? 10004 : 10003,
                'unsupported or invalid detail_type',
                null,
                echo,
            );
        }

        const targetKey = params.detail_type === 'private' ? 'user_id' : 'group_id';
        const otherKey = params.detail_type === 'private' ? 'group_id' : 'user_id';

        if (Object.hasOwn(params, otherKey)) {
            return response(10004, 'unsupported parameter', null, echo);
        }

        const target = parseAccountId(params[targetKey]);
        const inputMessage = params.message;
        const segments: unknown[] | null =
            typeof inputMessage === 'string'
                ? [{ type: 'text', data: { text: inputMessage } }]
                : Array.isArray(inputMessage)
                  ? inputMessage
                  : isObject(inputMessage)
                    ? [inputMessage]
                    : null;

        if (target === null || segments === null || segments.length === 0) {
            return response(10003, 'invalid target or message', null, echo);
        }

        const message: JsonObject[] = [];
        let hasLocation = false;

        for (const segment of segments) {
            if (!isObject(segment) || typeof segment.type !== 'string' || !isObject(segment.data)) {
                return response(10006, 'invalid message segment', null, echo);
            }

            if (
                segment.type !== 'text' &&
                segment.type !== 'mention' &&
                segment.type !== 'mention_all' &&
                segment.type !== 'location'
            ) {
                return response(10005, 'unsupported message segment', null, echo);
            }

            const allowedData =
                segment.type === 'text'
                    ? ['text']
                    : segment.type === 'mention'
                      ? ['user_id']
                      : segment.type === 'location'
                        ? ['latitude', 'longitude', 'title', 'content']
                        : [];

            if (extraKeys(segment, ['type', 'data']) || extraKeys(segment.data, allowedData)) {
                return response(10007, 'unsupported message segment field', null, echo);
            }

            if (segment.type === 'text') {
                if (typeof segment.data.text !== 'string') {
                    return response(10006, 'invalid text segment', null, echo);
                }

                message.push({ type: 'text', data: { text: segment.data.text } });
            } else if (segment.type === 'location') {
                const { latitude, longitude, title, content } = segment.data;

                if (
                    typeof latitude !== 'number' ||
                    !Number.isFinite(latitude) ||
                    latitude < -90 ||
                    latitude > 90 ||
                    typeof longitude !== 'number' ||
                    !Number.isFinite(longitude) ||
                    longitude < -180 ||
                    longitude > 180 ||
                    typeof title !== 'string' ||
                    typeof content !== 'string'
                ) {
                    return response(10006, 'invalid location segment', null, echo);
                }

                const maxLocationTextBytes = 64 * 1024;

                if (
                    title.length + content.length > maxLocationTextBytes ||
                    Buffer.byteLength(title, 'utf8') + Buffer.byteLength(content, 'utf8') >
                        maxLocationTextBytes
                ) {
                    return response(10006, 'invalid location segment', null, echo);
                }

                hasLocation = true;
                message.push({
                    type: 'location',
                    data: { lat: latitude, lon: longitude, title, content },
                });
            } else if (segment.type === 'mention') {
                const userId = parseAccountId(segment.data.user_id);

                // MentionExtraSend.uin is uint32; larger IDs would be truncated downstream.
                if (userId === null || userId > 0xffffffff) {
                    return response(10006, 'invalid mention segment', null, echo);
                }

                // Check this segment before rejecting private mentions, preserving field errors.
                if (params.detail_type === 'private') {
                    return response(10005, 'unsupported message segment', null, echo);
                }

                message.push({ type: 'at', data: { qq: String(userId) } });
            } else {
                if (params.detail_type === 'private') {
                    return response(10005, 'unsupported message segment', null, echo);
                }

                message.push({ type: 'at', data: { qq: 'all' } });
            }
        }

        // A v11 location becomes a JSON card; mixed or multiple cards have unknown behavior.
        if (hasLocation && message.length !== 1) {
            return response(10005, 'unsupported segment combination', null, echo);
        }

        // RoutingC2C.uin is uint32; preserve segment validation before blocking truncation.
        if (params.detail_type === 'private' && target > 0xffffffff) {
            return response(10003, 'invalid target or message', null, echo);
        }

        try {
            const result = await this.options.api.handle(
                params.detail_type === 'private' ? 'send_private_msg' : 'send_group_msg',
                { [targetKey]: target, message, auto_escape: false },
            );

            const failure = v11Failure(result, echo);

            if (failure) {
                return failure;
            }

            const id = isObject(result.data) ? fromV11MessageId(result.data.message_id) : null;

            if (id === null) {
                return response(
                    20001,
                    'message sent but result metadata is invalid; do not retry automatically',
                    null,
                    echo,
                );
            }

            let timestamp: number | null;

            try {
                timestamp = await this.options.getSentMessageTime(Number(id));
            } catch {
                return response(
                    20002,
                    'message sent but result metadata is unavailable; do not retry automatically',
                    null,
                    echo,
                );
            }

            if (
                typeof timestamp !== 'number' ||
                !Number.isFinite(timestamp) ||
                timestamp <= 0 ||
                timestamp > Number.MAX_SAFE_INTEGER
            ) {
                return response(
                    20001,
                    'message sent but result metadata is unavailable; do not retry automatically',
                    null,
                    echo,
                );
            }

            return response(0, '', { message_id: id, time: timestamp }, echo);
        } catch {
            // The action may have completed before its result or metadata failed.
            return response(
                20002,
                'message outcome unavailable; do not retry automatically',
                null,
                echo,
            );
        }
    }
}
