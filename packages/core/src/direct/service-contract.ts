import type {
    DirectAcceptedResponse,
    DirectAccountResponse,
    DirectAccountsResponse,
    DirectControlRequest,
    DirectOperationResponse,
    DirectStartRequest,
} from '@snowluma/common/direct-account';

/** Derived only after WebUI header authentication; never contains the session token. */
export interface DirectRequestScope {
    readonly owner: string;
    readonly expiresAt: number;
    /** Rechecks revocation, expiry and the original authenticated session identity. */
    isCurrent(): boolean;
}

export const DIRECT_SERVICE_ERRORS = {
    'unsupported-platform': { httpStatus: 503, message: '直连账号仅支持 Linux 服务端' },
    'not-configured': { httpStatus: 503, message: '直连账号尚未配置' },
    'account-not-found': { httpStatus: 404, message: '直连账号不存在' },
    'operation-not-found': { httpStatus: 404, message: '直连操作不存在或已失效' },
    'revision-conflict': { httpStatus: 409, message: '账号状态已变化，请刷新后重试' },
    'operation-key-conflict': { httpStatus: 409, message: '操作标识已用于其他请求' },
    'account-busy': { httpStatus: 409, message: '账号正在处理其他操作' },
    'operation-capacity': { httpStatus: 503, message: '当前操作记录已满，请稍后再试' },
    'needs-login': { httpStatus: 409, message: '账号需要重新扫码登录' },
    'renewal-unavailable': { httpStatus: 409, message: '当前账号尚未启用续期能力' },
    'scope-expired': { httpStatus: 401, message: '管理会话已失效，请重新登录' },
    'consent-required': { httpStatus: 403, message: '请先阅读并同意用户协议与隐私政策' },
    'password-change-required': { httpStatus: 403, message: '请先修改密码' },
    'qr-unavailable': { httpStatus: 404, message: '二维码不存在或已失效' },
    'invalid-request': { httpStatus: 400, message: '直连请求格式错误' },
    'body-too-large': { httpStatus: 413, message: '直连请求体过大' },
    'unsupported-media-type': { httpStatus: 415, message: '请求体必须为 JSON' },
    'cross-origin': { httpStatus: 403, message: '请求来源校验失败' },
    'method-not-allowed': { httpStatus: 405, message: '请求方法不受支持' },
    'not-found': { httpStatus: 404, message: '直连接口不存在' },
    'internal-error': { httpStatus: 500, message: '直连操作失败' },
} as const;

export type DirectServiceErrorCode = keyof typeof DIRECT_SERVICE_ERRORS;

/** Only these fixed codes/messages cross the HTTP boundary; raw causes stay private. */
export class DirectServiceError extends Error {
    readonly httpStatus: (typeof DIRECT_SERVICE_ERRORS)[DirectServiceErrorCode]['httpStatus'];

    constructor(readonly code: DirectServiceErrorCode) {
        const definition = DIRECT_SERVICE_ERRORS[code];
        super(definition.message);
        this.name = 'DirectServiceError';
        this.httpStatus = definition.httpStatus;
    }
}

export function assertDirectRequestScope(scope: DirectRequestScope): void {
    if (
        !Number.isSafeInteger(scope.expiresAt) ||
        scope.expiresAt <= Date.now() ||
        !scope.isCurrent()
    ) {
        throw new DirectServiceError('scope-expired');
    }
}

/**
 * Account views are admin-wide. Operations, deduplication keys and QR bytes are owner-scoped.
 * Mutations synchronously accept work; completion is reported by operation(), not HTTP 202.
 * Implementations check scope before effects and before returning. QR checks both sides of await.
 */
export interface DirectAccountService {
    list(scope: DirectRequestScope): DirectAccountsResponse;
    get(id: string, scope: DirectRequestScope): DirectAccountResponse;
    start(id: string, input: DirectStartRequest, scope: DirectRequestScope): DirectAcceptedResponse;
    stop(
        id: string,
        input: DirectControlRequest,
        scope: DirectRequestScope,
    ): DirectAcceptedResponse;
    renew(
        id: string,
        input: DirectControlRequest,
        scope: DirectRequestScope,
    ): DirectAcceptedResponse;
    operation(id: string, scope: DirectRequestScope): DirectOperationResponse;
    /** Returns the same original operation id, never a new cancel operation. */
    cancel(id: string, scope: DirectRequestScope): DirectAcceptedResponse;
    /** Transfers an owned snapshot to the route, which wipes it after copying or failure. */
    qr(
        id: string,
        scope: DirectRequestScope,
    ): Promise<{
        bytes: Uint8Array;
        contentType: 'image/png' | 'image/jpeg' | 'image/webp';
    }>;
    dispose(): Promise<void>;
}
