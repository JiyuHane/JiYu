import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityPlugin } from '../src/lib/api/types';
import { filterPlugins } from '../src/lib/plugin-index';

function fake(overrides: Partial<CommunityPlugin> = {}): CommunityPlugin {
    return {
        id: '',
        name: '',
        description: '',
        author: '',
        version: '',
        homepage: '',
        downloadUrl: '',
        minVersion: '',
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('community search Unicode fallback (synthetic data)', () => {
    it.each(['id', 'name', 'description', 'author'] as const)(
        'matches compatibility characters independently in %s',
        (key) => {
            const plugin = fake({ [key]: 'ＴＯＯＬＳ' });
            expect(filterPlugins([plugin], ' tools ')).toEqual([plugin]);
        },
    );

    it('matches fullwidth tags and mathematical bold capitals before lowercasing', () => {
        const tag = fake({ tags: ['ＴＯＯＬＳ'] });
        const bold = fake({ name: '𝐀' });
        expect(filterPlugins([tag], 'tools')).toEqual([tag]);
        expect(filterPlugins([bold], 'a')).toEqual([bold]);
        expect(tag.tags).toEqual(['ＴＯＯＬＳ']);
        expect(bold.name).toBe('𝐀');
    });

    it('matches composed and decomposed accents in either direction', () => {
        const composed = fake({ name: 'Café' });
        const decomposed = fake({ name: 'cafe\u0301' });
        expect(filterPlugins([composed], 'cafe\u0301')).toEqual([composed]);
        expect(filterPlugins([decomposed], 'Café')).toEqual([decomposed]);
    });

    it('preserves raw substring matches that NFKC alone would lose', () => {
        const plugin = fake({ name: 'e\u0301' });
        expect(filterPlugins([plugin], 'e')).toEqual([plugin]);
    });

    it('preserves input identity and order without mutating fields or requesting data', () => {
        const fetch = vi.fn();
        const webSocket = vi.fn();
        vi.stubGlobal('fetch', fetch);
        vi.stubGlobal('WebSocket', webSocket);
        const first = fake({ name: 'ＴＯＯＬＳ', tags: [] });
        const second = fake({ name: 'unmatched' });
        const third = fake({ description: 'tools', tags: ['keep'] });
        const plugins = [first, second, third];
        const snapshot = structuredClone(plugins);
        expect(filterPlugins(plugins, ' \t ')).toBe(plugins);
        const found = filterPlugins(plugins, 'tools');
        expect(found).toEqual([first, third]);
        expect(found[0]).toBe(first);
        expect(found[1]).toBe(third);
        expect(plugins).toEqual(snapshot);
        expect(fetch).not.toHaveBeenCalled();
        expect(webSocket).not.toHaveBeenCalled();
    });

    it('never joins separate fields or tags to form a match', () => {
        const splitFields = fake({ id: 'ＴＯ', name: 'ＯＬＳ' });
        const splitTags = fake({ tags: ['ＴＯ', 'ＯＬＳ'] });
        const splitNameAuthor = fake({ name: 'ＴＯ', author: 'ＯＬＳ' });
        expect(filterPlugins([splitFields, splitTags, splitNameAuthor], 'tools')).toEqual([]);
        expect(filterPlugins([fake({ tags: [] }), fake()], 'tools')).toEqual([]);
    });

    it('preserves long queries without truncation in both matching paths', () => {
        const long = 'x'.repeat(100_000);
        const raw = fake({ name: `${long}y` });
        const wide = fake({ name: `${long}Ｔ` });
        expect(filterPlugins([raw], `${long}y`)).toEqual([raw]);
        expect(filterPlugins([raw], `${long}z`)).toEqual([]);
        expect(filterPlugins([wide], `${long}t`)).toEqual([wide]);
    });
});
