import { ONEBOT_V12_ADAPTER_NAME, type NetworkBase, type OneBotV12Config } from '../types';

/** Shared with configuration validation; absent when v12 is disabled. */
export const V12_ADAPTER_NAME = ONEBOT_V12_ADAPTER_NAME;
export type V12ManagedConfig = OneBotV12Config & NetworkBase;

/** Only fixed, actionable classes cross the public status/log boundary. */
export function safeV12Error(error: unknown): string {
    const allowed = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'ENOTFOUND']);

    if (error instanceof Error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (typeof code === 'string' && allowed.has(code)) {
            return code;
        }

        if (allowed.has(error.message)) {
            return error.message;
        }

        if (error.message === 'v12 instance is disposing') {
            return error.message;
        }
    }

    return 'v12 operation failed';
}
