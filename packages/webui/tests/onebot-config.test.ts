import { describe, expect, it } from 'vitest';
import { normalizeOneBotConfig } from '../src/lib/onebot-config';

describe('normalizeOneBotConfig history sync', () => {
    it('defaults older payloads to disabled', () => {
        expect(normalizeOneBotConfig({}).historySync).toEqual({ enabled: false });
    });

    it('omits v12 from old editor snapshots so they cannot overwrite newer settings', () => {
        const normalized = normalizeOneBotConfig({
            v12: {
                enabled: true,
                host: '127.0.0.1',
                port: 3012,
                accessToken: 'token',
                allowNonLoopback: false,
            },
        });
        expect(normalized).not.toHaveProperty('v12');
        expect(JSON.stringify(normalized)).not.toContain('token');
    });

    it('preserves an explicit per-account opt-in', () => {
        expect(
            normalizeOneBotConfig({
                historySync: { enabled: true },
            }).historySync,
        ).toEqual({ enabled: true });
    });
});
