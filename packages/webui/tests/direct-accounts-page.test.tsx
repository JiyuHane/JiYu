import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DirectAccountsState } from '../src/lib/direct-accounts';
import { DirectAccountsPage } from '../src/components/pages/direct-accounts-page';
import { reconcileLayoutItems, DEFAULT_LAYOUT } from '../src/contexts/LayoutContext';
import { directAccount } from './fixtures/direct-accounts';

const view = {
    state: {
        data: { supported: true, configured: false, reason: null, accounts: [] },
        ready: true,
        refreshing: false,
        error: null,
        errors: {},
        pending: {},
        uncertain: {},
        operations: {},
        selectedOperation: null,
        qrUrl: null,
    } as DirectAccountsState,
    controller: {
        refresh: vi.fn(),
        run: vi.fn(),
        selectQr: vi.fn(),
        retry: vi.fn(),
        retryQr: vi.fn(),
        cancel: vi.fn(),
    },
};
vi.mock('../src/hooks/use-direct-accounts', () => ({ useDirectAccounts: () => view }));
vi.mock('../src/contexts/AppStateContext', () => ({
    useAppState: () => ({ setSelectedUin: vi.fn() }),
}));
vi.mock('../src/contexts/ActionFeedbackContext', () => ({
    useActionFeedback: () => ({ runAction: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({
    Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

describe('direct account page and navigation', () => {
    it('renders the unconfigured explanation, without private-path editors or account creation', () => {
        view.state.data = { supported: true, configured: false, reason: null, accounts: [] };
        const html = renderToStaticMarkup(<DirectAccountsPage />);
        expect(html).toContain('尚未登记直连账号');
        expect(html).toContain('JIYU_DIRECT_QQ_CONFIG');
        expect(html).not.toContain('<input');
        expect(html).not.toContain('创建账号');
    });

    it('renders Linux-only state and keeps real renewal capability gated', () => {
        view.state.data = {
            supported: false,
            configured: true,
            reason: 'linux-only',
            accounts: [
                {
                    ...directAccount,
                    online: true,
                    phase: 'online',
                    uin: '123456',
                    onebotReady: true,
                },
            ],
        };
        const html = renderToStaticMarkup(<DirectAccountsPage />);
        expect(html).toContain('Linux 直连运行环境');
        expect(html).toContain('实现尚未可用');
        expect(html).toContain('恢复时校验加密记录');
        const buttons = [...html.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((match) => match[0]);
        expect(buttons.find((button) => button.includes('立即续票'))).toContain('disabled');
        expect(html).toContain('href="/debug"');
        expect(html).toContain('href="/config"');
        expect(html).not.toContain('vaultRoot');
    });

    it('appends the new item while retaining existing order and hidden preferences', () => {
        expect(DEFAULT_LAYOUT.navItems).toContainEqual({ id: '/accounts', visible: true });
        expect(
            reconcileLayoutItems(
                [
                    { id: '/logs', visible: false },
                    { id: '/', visible: true },
                ],
                ['/', '/logs', '/accounts'],
            ),
        ).toEqual([
            { id: '/logs', visible: false },
            { id: '/', visible: true },
            { id: '/accounts', visible: true },
        ]);
    });

    it('uses a lazy route and the existing reactive debug account resource', () => {
        const router = readFileSync(new URL('../src/router/index.tsx', import.meta.url), 'utf8');
        const debug = readFileSync(
            new URL('../src/components/pages/debug-page.tsx', import.meta.url),
            'utf8',
        );
        expect(router).toContain("path: '/accounts'");
        expect(router).toContain("import('@/components/pages/direct-accounts-page')");
        expect(debug).toContain('qqList: accounts');
        expect(debug).not.toContain('api.qqList()');
        expect(debug).toContain('preferredUin={selectedUin}');
    });
});
