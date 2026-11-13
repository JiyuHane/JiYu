import { isProxy } from 'node:util/types';
import type { ApiResponse, JsonObject, JsonValue } from '../types';
import type { V12CoreOptions, V12Response } from './types';
import {
    fromV11MessageId,
    isObject,
    isSelf,
    parseAccountId,
    parseMessageId,
    snapshotRequest,
} from './validation';

const ACTIONS = [
    'get_version',
    'get_status',
    'get_supported_actions',
    'get_self_info',
    'send_message',
    'delete_message',
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

    constructor(private readonly options: V12CoreOptions) {
        if (!isSelf(options.self) || !options.version.impl || !options.version.version) {
            throw new Error('invalid V12 core identity or version');
        }

        this.self = { ...options.self };
        this.version = { ...options.version };
    }

    async handle(input: unknown): Promise<V12Response> {
        let echo: string | undefined;

        try {
            if (isProxy(input)) {
                return response(10001, 'invalid action request');
            }

            if (typeof input === 'object' && input !== null) {
                const descriptor = Object.getOwnPropertyDescriptor(input, 'echo');

                if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
                    echo = descriptor.value;
                }
            }

            return await this.handleSnapshot(snapshotRequest(input));
        } catch {
            return response(10001, 'invalid action request', null, echo);
        }
    }

    private async handleSnapshot(input: unknown): Promise<V12Response> {
        if (!isObject(input)) {
            return response(10001, 'invalid action request');
        }

        const echo = typeof input.echo === 'string' ? input.echo : undefined;

        if (
            typeof input.action !== 'string' ||
            !input.action ||
            !isObject(input.params) ||
            (Object.hasOwn(input, 'echo') && typeof input.echo !== 'string') ||
            (Object.hasOwn(input, 'self') && !isSelf(input.self))
        ) {
            return response(10001, 'invalid action request', null, echo);
        }

        if (
            input.self !== undefined &&
            isSelf(input.self) &&
            (input.self.platform !== this.self.platform || input.self.user_id !== this.self.user_id)
        ) {
            return response(10102, 'unknown self', null, echo);
        }

        if (
            extraKeys(input, ['action', 'params', 'echo', 'self']) ||
            (isObject(input.self) && extraKeys(input.self, ['platform', 'user_id']))
        ) {
            return response(10004, 'unsupported request field', null, echo);
        }

        const { action, params } = input;

        if (!(ACTIONS as readonly string[]).includes(action)) {
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
                return response(0, '', [...ACTIONS], echo);
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

    private async callDelete(id: number, echo?: string): Promise<V12Response> {
        try {
            const result = await this.options.api.handle('delete_msg', { message_id: id });

            const failure = v11Failure(result, echo);

            if (failure) {
                return failure;
            }

            if (result.data !== null) {
                return response(
                    20001,
                    'action outcome unavailable; do not retry automatically',
                    null,
                    echo,
                );
            }

            return response(0, '', null, echo);
        } catch {
            return response(
                20002,
                'action outcome unavailable; do not retry automatically',
                null,
                echo,
            );
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

        for (const segment of segments) {
            if (!isObject(segment) || typeof segment.type !== 'string' || !isObject(segment.data)) {
                return response(10006, 'invalid message segment', null, echo);
            }

            if (segment.type !== 'text') {
                return response(10005, 'unsupported message segment', null, echo);
            }

            if (extraKeys(segment, ['type', 'data']) || extraKeys(segment.data, ['text'])) {
                return response(10007, 'unsupported message segment field', null, echo);
            }

            if (typeof segment.data.text !== 'string') {
                return response(10006, 'invalid text segment', null, echo);
            }

            message.push({ type: 'text', data: { text: segment.data.text } });
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

            if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
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
